// 数据主干路由：首屏 bootstrap、分组 CRUD、站点 CRUD、批量删除、批量排序。
//
// 从 worker/index.ts 拆出来。这是站点日常读写量最大的一组，
// 读到的数据已经按 ctx.api 上绑定的账号过滤过（见 NavigationAPI.setCurrentUser）。
import type { Group, Note, NoteFolder, NoteTag, Site } from "../../src/API/http";
import { NoteConflictError } from "../../src/utils/noteConflict";
import { ApiError, API_ERROR_CODES, errorResponse, type ApiErrorStatus } from "../lib/apiError";
import { segmentCJK, FTS_CONTENT_LIMIT } from "../../src/utils/ftsQuery";
import { enforceWriteGuard, writeBucket } from "../loginGuard";
import { weakEtag } from "../util";
import { readImageSize } from "../imageSize";
import type { GroupInput, SiteInput } from "../types";
import { validateGroup, validateSite, validateGroupPatch, validateSitePatch } from "../validate";
import { readIdempotencyKey, withIdempotency } from "../idempotency";
import { currentUserIdentity } from "./account";
import {
    ATTACHMENT_MAX_BYTES,
    attachmentObjectKey,
    checkReplaceQuota,
    checkUploadQuota,
    finishAttachmentDeletion,
    imageExtension,
    putAttachmentObject,
    readAttachmentObject,
    recordUpload,
    sniffImageMime,
    sniffTextMime,
    textExtension,
} from "../attachments";
import type { RouteCtx } from "./types";
import { readJsonArray, readJsonBody, readJsonValue } from "./jsonBody";

/**
 * 图片上传（2026-07）。
 *
 * 请求体是**原始二进制**（前端 `fetch(url, {method:"POST", body: file, headers})`），
 * 不是 multipart、也不是 base64 ——
 *   base64 会把体积撑大 33%，而单文件上限就是 KV 单条的 25MB，base64 之后必然超；
 *   multipart 要在 Worker 里手写解析（`request.formData()` 对 25MB 的体很吃内存），
 *   而我们只需要一个文件 + 一个文件名，用不上那么多表单字段。
 * 元数据（文件名 / 归属笔记）走 query 或 header，不塞进 body。
 *
 * 类型**不信 Content-Type**：客户端可以随便写。我们嗅探文件头
 * （sniffImageMime），只放行 PNG/JPEG/GIF/WebP/AVIF。
 * SVG 故意不在白名单里 —— 它能带脚本，正文里的 `<img src=…svg>` 由浏览器原生解析，
 * 绕过我们的渲染层。
 * 2026-10-18 起追加纯文本（sniffTextMime）：txt / json，按内容判定
 * （UTF-8 + 无 NUL + 控制字符占比；JSON 还要整体 parse 通过）。文本附件
 * 下载时按 text/plain;charset=utf-8 出，浏览器只当纯文本，不构成 XSS 面。
 */
async function handleUploadAttachment(ctx: RouteCtx): Promise<Response> {
    const { request, api, env } = ctx;

    // ⚠️ 先按 Content-Length 拒掉超大请求体（省得真去读 100MB 进内存）：
    // Workers 的请求体有上限，超了会直接 413/500，报错还不友好。
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > ATTACHMENT_MAX_BYTES) {
        throw ApiError.tooLarge(
            `单个文件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`
        );
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    // 配额三道闸（存储通道 / 租约 / 每小时次数 / 总量）。租约让同一用户的上传串行化，
    // 否则并发下「都读到已用 900MB、都觉得还能塞 100MB」→ 实际写了 1.1GB。
    const quota = await checkUploadQuota(env, currentUserIdOf(ctx), bytes.byteLength);
    if (!quota.ok) throw quotaError(quota);

    // 嗅探文件头定类型：先试图片，再试纯文本（txt/json，2026-10-18）
    let mime = sniffImageMime(bytes);
    let ext = mime ? imageExtension(mime) : null;
    if (!mime || !ext) {
        const textMime = sniffTextMime(bytes);
        const textExt = textMime ? textExtension(textMime) : null;
        if (textMime && textExt) {
            mime = textMime;
            ext = textExt;
        }
    }
    if (!mime || !ext) {
        throw ApiError.unsupportedMedia("只支持 PNG / JPEG / GIF / WebP / AVIF 图片与 txt / json 纯文本（按文件内容判定，不看文件名）");
    }

    const id = crypto.randomUUID();
    const key = attachmentObjectKey(currentUserIdOf(ctx), id);
    // 文件名只用于展示与下载；剥掉路径分隔符与控制字符，避免它出现在响应头里时出问题
    const rawName = new URL(request.url).searchParams.get("filename") ?? "";
    // ⚠️ 不拼扩展名（对齐 inkstone）：`probe.png` 就该是 `probe.png`，
    // 拼了会变成 `probe.png.png`。ext 只用于对象 key，不进展示名。
    const filename = sanitizeFilename(rawName);
    const noteIdRaw = new URL(request.url).searchParams.get("noteId");
    const noteId = noteIdRaw ? Number(noteIdRaw) : null;

    try {
        await putAttachmentObject(env, quota.storage, key, bytes, {
            userId: currentUserIdOf(ctx),
            mime,
        });
    } catch (error) {
        // ⚠️ 对象写失败**不能**写 D1 记录 —— 否则留下一条指向不存在对象的元数据，
        // 用户刷新后图裂了却删不掉。
        console.error("附件对象写入失败", error);
        throw ApiError.badGateway("图片写入存储失败，请稍后重试");
    }

    await api.createAttachment({
        id,
        note_id: Number.isInteger(noteId) && (noteId as number) > 0 ? noteId : null,
        filename,
        mime,
        size: bytes.byteLength,
        storage: quota.storage,
        object_key: key,
    });
    const dimensions = readImageSize(bytes, mime);
    if (dimensions) await env.DB.prepare("UPDATE attachments SET width = ?, height = ? WHERE id = ?").bind(dimensions.width, dimensions.height, id).run();
    await recordUpload(env, currentUserIdOf(ctx));

    // 回 URL 而不是字节：前端拿到 URL 就能插进正文。
    // ⚠️ 这个 URL 走鉴权，所以 <img> 不能直接用它 —— 前端要 fetch 成 blob 再 set src
    // （见 NotesPage 的 attachImage 流程）。
    return Response.json({
        id,
        url: `/api/notes/attachments/${id}`,
        filename,
        mime,
        size: bytes.byteLength,
    }, { status: 201 });
}

/** 当前账号 id。单账号部署下可能是 null —— attachments 的 key 用 0 占位 */
function currentUserIdOf(ctx: RouteCtx): number {
    return (ctx.api as unknown as { currentUserId: number | null }).currentUserId ?? 0;
}

/**
 * 文件名净化（对齐 inkstone `sanitizeAttachmentFilename`）。
 *
 * ⚠️ 三个细节都是照抄的，别自己发挥：
 *  1. 危险字符是**替换成 `-`** 不是删除 —— 删掉会让 `a/b.png` 变成 `ab.png`，
 *     用户看不出自己原来的分隔符在哪；inkstone 用 `-` 保住可读性。
 *  2. **不追加扩展名**。原始文件名通常自带 `.png`；我们之前追加 `.${ext}`
 *     会产出 `probe.png.png`。真没后缀的文件就让它没后缀 —— 后缀只影响
 *     下载时的「另存为」名字，不影响显示（Content-Type 由 mime 决定）。
 *  3. 剥掉前导点（`..` / `.hidden`），防它落到对象 key 里被当成相对路径。
 *
 * ⚠️ 控制字符不能直接写进正则字面量 —— eslint 的 no-control-regex 会拦
 * （它防的是「正则里混入终端控制序列」欺骗日志/终端）。用字符码过滤，
 * 同样效果且不触规则。
 */
function sanitizeFilename(name: string): string {
    const cleaned = Array.from(name)
        .map(ch => ("[\\/:*?\"<>|]".includes(ch) ? "-" : ch))
        .filter(ch => (ch.codePointAt(0) ?? 0) > 0x1f)
        .join("")
        .replace(/^\.+/, "")
        .trim();
    return (cleaned || "file").slice(0, 180);
}

/**
 * 重命名用的文件名归一（2026-10-19）：先按上传那套净化，再**锁定扩展名**。
 *
 * 为什么锁扩展名：附件类型是上传那一刻按内容嗅探定死的（mime 存在 D1 里），
 * 用户把 `data.json` 改成 `data.txt` 并不会让正文变文本、也不会让下载类型改掉，
 * 只会让「名字说的」和「实际是」对不上 —— 下次打开就是「明明是 txt 却按 json 解析」。
 * 所以扩展名跟着 mime 走，用户只改主名。
 */
function normalizeAttachmentFilename(raw: string, mime: string): string {
    const locked = textExtension(mime) ?? imageExtension(mime) ?? "";
    // sanitizeFilename 已经处理了路径分隔符 / 控制字符 / 前导点，并兜了空名
    const base = sanitizeFilename(raw).replace(/\.[A-Za-z0-9]+$/, "").trim() || "file";
    if (!locked) return base.slice(0, 120);
    // 先给扩展名留位置再截断，否则长名字会把 `.json` 切掉
    return `${base.slice(0, 120 - locked.length - 1)}.${locked}`;
}

/**
 * 重命名附件（2026-10-19，用户要「上传后的 txt / json 能重命名」）。
 *
 * 只改 D1 里的 `filename`，对象 key 与附件 id 都不动 —— 正文里的链接是
 * `/api/notes/attachments/<id>`，所以笔记里的链接不会失效（这是整个方案的地基）。
 * 正文里那行链接的**显示名**由 api.renameAttachment 顺手同步。
 *
 * 带确认过的原文件名回来（可能被净化 / 锁定扩展名），UI 直接显示返回值，
 * 不要拿用户输入的字符串当结果。
 */
async function handleRenameAttachment(ctx: RouteCtx, id: string): Promise<Response> {
    const { request, api } = ctx;
    const body = (await request.json().catch(() => ({}))) as { filename?: unknown };
    if (typeof body.filename !== "string" || !body.filename.trim()) {
        throw ApiError.badRequest("文件名不能为空");
    }
    // 先查一条拿 mime（决定扩展名锁哪个），顺便做归属校验（scopeSql 在 api 层）
    const found = await api.getAttachment(id);
    if (!found) throw ApiError.notFound("附件不存在");

    const filename = normalizeAttachmentFilename(body.filename, found.mime);
    const result = await api.renameAttachment(id, filename);
    if (!result.ok) throw ApiError.notFound(result.error);
    return Response.json({ id, filename: result.filename, updatedNotes: result.updatedNotes.length });
}

/**
 * 原地改写文本附件的内容（2026-10-19 附件预览弹窗的「编辑」）。
 *
 * 只在 **txt / json** 上开放：图片改内容没有意义（改完也不是合法图片），
 * 而类型边界不能靠「前端只对文本显示编辑按钮」——必须后端拒绝。
 *
 * 写的是**同一个对象 key**（覆盖），所以附件 id、正文链接全都不变。
 * 大小按增量算配额：改大才检查（改小永远放行）。
 */
async function handleUpdateAttachmentContent(ctx: RouteCtx, id: string): Promise<Response> {
    const { request, api, env } = ctx;
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > ATTACHMENT_MAX_BYTES) {
        throw ApiError.tooLarge(
            `单个文件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`
        );
    }

    const found = await api.getAttachment(id);
    if (!found) throw ApiError.notFound("附件不存在");
    // 只有纯文本可以编辑（扩展名白名单与上传同一份，不另立一套）
    const lockedExt = textExtension(found.mime);
    if (!lockedExt) throw ApiError.badRequest("只有 txt / json 附件可以直接编辑");
    if (!found.object_key) {
        throw new ApiError(500, API_ERROR_CODES.internal, "附件记录不完整");
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw ApiError.badRequest("内容不能为空");
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
        throw ApiError.tooLarge(
            `单个文件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`
        );
    }
    // ⚠️ 编辑后的内容也要过嗅探：否则能把二进制塞进一个 txt 附件里，
    // 于是「文本附件只当纯文本出」这条边界被从后门绕开。
    const sniffed = sniffTextMime(bytes);
    if (!sniffed) throw ApiError.unsupportedMedia("内容不是合法的 UTF-8 文本");

    const quota = await checkReplaceQuota(env, currentUserIdOf(ctx), bytes.byteLength - Number(found.size ?? 0));
    if (!quota.ok) throw quotaError(quota);

    try {
        await putAttachmentObject(env, found.storage, found.object_key, bytes, {
            userId: currentUserIdOf(ctx),
            mime: found.mime,
        });
    } catch (error) {
        console.error("附件内容改写失败", error);
        throw ApiError.badGateway("内容写入存储失败，请稍后重试");
    }

    // 对象已换，元数据跟进（size 影响配额与列表显示）。
    // mime 故意保持原值：扩展名锁定了，类型不能因为「这次内容长得像 json」就漂移。
    await env.DB.prepare("UPDATE attachments SET size = ?1 WHERE id = ?2")
        .bind(bytes.byteLength, id)
        .run();
    return Response.json({ id, size: bytes.byteLength, mime: found.mime });
}

/**
 * 附件下载头（2026-10-19）。
 *
 * `inline` 保持原样（点开链接直接在标签页里看文本，而不是掉进下载栏）——
 * 前端的预览弹窗走 fetch，不依赖这个头；它只负责「另存为」时的默认文件名。
 *
 * ⚠️ 三处细节：
 *  1. `filename*` 是 RFC 5987 的百分号编码形式，中文名靠它；
 *  2. 同时给纯 ASCII 的 `filename="..."` 兜底：不认识 `filename*` 的老客户端
 *     会退回这一份，总比拿到 uuid 强；
 *  3. `encodeURIComponent` 不转义 `!'()*`，而 RFC 5987 的 attr-char 不允许
 *     `'()*` —— 文件名里带个括号就会让整个头被解析器丢弃，这里手动补转义。
 */
function contentDisposition(filename: string): string {
    const name = (filename || "file").slice(0, 120);
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 幂等闸门只对写方法开：GET / HEAD 没有副作用，认重没有意义，只会白占一行记录 */
const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 笔记绑定站点前，先确认这张卡片是自己的（#477）。
 *
 * 与 `POST /api/sites` 里「目标分组必须是自己的」是同一个洞：绑定关系存在
 * 笔记那一侧（`notes.site_id`），如果这里不校验，任何人都能把自己的笔记挂到
 * **别人的站点 id** 上。危害不只是脏数据 —— 那位用户在自��的卡片上会看到
 * 一篇莫名其妙的笔记标题，点开还能读到正文，等于一个反向的信息泄露口。
 *
 * getSite 走 scopeSql，读不到（不存在 / 不是自己的）一律 400：
 * 用 404 会把「这个 id 存在但不属于你」和「压根没有」区分开。
 */
async function assertOwnedSiteForNote(api: RouteCtx["api"], siteId: number): Promise<void> {
    const site = await api.getSite(siteId);
    if (!site) throw ApiError.badRequest("目标站点不存在");
}

/**
 * 上传配额那三道闸（worker/attachments.ts 的 checkUploadQuota）返回的是
 * `{ status: number; error: string }` —— status 有 501 / 400 / 409 / 413 / 429 五种，
 * 而 ApiError 只收白名单里的状态号。这里按状态号挑对应的 code：
 * 状态号**照原样回**（迁移前后行为一致，客户端拿到的状态码一个没变），
 * 认不出的落 bad_request。
 */
function quotaError(quota: { status: number; error: string }): ApiError {
    const code =
        quota.status === 413
            ? API_ERROR_CODES.payloadTooLarge
            : quota.status === 409
              ? API_ERROR_CODES.conflict
              : quota.status === 429
                ? API_ERROR_CODES.rateLimited
                : quota.status === 501
                  ? API_ERROR_CODES.notImplemented
                  : API_ERROR_CODES.badRequest;
    return new ApiError(quota.status as ApiErrorStatus, code, quota.error);
}

/**
 * 对外入口：写请求（带 Idempotency-Key 的）先过一遍幂等闸门，再进真正的分发。
 *
 * 为什么不逐个分支包：这些分支是一条 `if / else if` 链，每个分支的收尾 `}` 同时
 * 是下一个分支的开头 `else if`，包一层箭头函数就得在链中间动刀，极易改坏。
 * 放在这里统一包一层，一个字都不用动链本身。
 *
 * endpoint 取「方法 + 路径首段」（sites/123 归成 sites）：幂等记录的作用域只需要
 * 区分开不同端点，具体 id 不进作用域 —— 那条记录是靠 op_id 认的，不是靠路径。
 */
export async function handleDataRoutes(ctx: RouteCtx): Promise<Response | null> {
    if (!IDEMPOTENT_METHODS.has(ctx.method)) return await dispatchDataRoutes(ctx);
    const key = readIdempotencyKey(ctx.request);
    if (!key) return await dispatchDataRoutes(ctx);

    const endpoint = `${ctx.method} ${ctx.path.split("/")[0]}`;
    return await withIdempotency(ctx.api, endpoint, key, () => dispatchDataRoutes(ctx));
}

async function dispatchDataRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        url,
        path,
        method,
        api,
        ip,
        trustXFF,
    } = ctx;

    /**
     * 写操作限速闸门：分组 / 站点的增删改与批量操作都要先过这一道。
     * 放行返回 null，撞上限速返回已经填好 Retry-After 的 429，调用处直接 return 出去。
     * GET 一律不过闸 —— 读不消耗 D1 写入配额，也不该因为「翻了几页」就把人锁住。
     */
    const writeGate = (): Promise<Response | null> =>
        enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));

    // 路由匹配
    if (path === "bootstrap" && method === "GET") {
        // 一次请求返回分组 + 站点 + 配置，供前端首屏与刷新使用。
        // 带上弱 ETag：浏览器下次会在 If-None-Match 里回传，
        // 数据没变就只回一个 304 空包，省掉整份 JSON 的下载与解析
        // （站点多的时候这一份能到几百 KB）。
        const data = await api.getBootstrap();

        // ?full=1：顺带把「我是谁」与「恢复密钥配没配」一起回给前端。
        //
        // 这两问原本是 bootstrap 之后**并发**发出的两个请求（auth/me 与
        // auth/recovery-status，见 src/hooks/useAccountSession）。并发归并发，
        // 在这条链路上每个请求还是要各付一次 1~3 秒的固定往返，能省就省。
        //
        // 不带 full 的旧客户端拿到的还是原来那个形状 —— 所以前后端不需要同时上线：
        // 老前端照常发那两个请求，新前端省掉它们。
        // 两处身份取值共用 account.ts 的 currentUserIdentity，避免形状漂移。
        const full = url.searchParams.get("full") === "1";
        const payload: Record<string, unknown> = full
            ? {
                  ...(data as unknown as Record<string, unknown>),
                  me: (await currentUserIdentity(api).catch(() => null)) ?? undefined,
                  recovery: {
                      configured: await api.hasRecoveryKey().catch(() => false),
                  },
              }
            : (data as unknown as Record<string, unknown>);

        const body = JSON.stringify(payload);
        const etag = weakEtag(body);
        // no-cache（每次都要问一趟服务器）而不是 no-store（不许存），
        // 否则浏览器手头没有副本，ETag 也就无从比较
        const headers = {
            "Content-Type": "application/json; charset=utf-8",
            ETag: etag,
            "Cache-Control": "no-cache",
        };
        if (request.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers });
        }
        return new Response(body, { headers });
    } else if (/^groups\/\d+\/share$/.test(path)) {
        // 分组分享（2026-10-11 阶段④）：与 note share 同一套语义
        //（POST 创建并轮换令牌 / PUT 更新保留令牌 / DELETE 撤销 / GET 查配置）。
        //
        // ⚠️ 必须排在 `path.startsWith("groups/")` 那三条（GET/PUT/DELETE）之前。
        // 2026-10-15 修：之前它排在后面，被前缀分支整条吞掉 —— 表现是
        //   DELETE /api/groups/{id}/share（撤销分享）落到了「删分组」上，
        //   用户点一下「撤销分享」，整个分组连同里面的卡片一起进了回收站；
        //   GET 查分享配置返回的是分组对象（没有 token/expires），前端以为没分享过；
        //   PUT 更新有效期则变成了改分组。
        // 前缀分支的 id 取 `parseInt(path.split("/")[1])`，"1/share" 会被 parseInt
        // 读成 1 且不报 NaN，所以这类冲突**不会报错**，只是静默走错分支 ——
        // 新增 groups/ 子资源时，一律把更具体的分支放在前缀分支之前。
        const id = Number(path.split("/")[1]);
        const headers = { "Cache-Control": "no-store" };
        if (!Number.isSafeInteger(id) || id <= 0) return errorResponse(ApiError.badRequest("无效的ID"), { headers });
        if (method === "GET") return Response.json(await api.getGroupShareConfig(id), { headers });
        if (method === "PUT") {
            const limited = await writeGate();
            if (limited) return limited;
            const { days, password } = await readJsonBody<{ days?: unknown; password?: unknown }>(request);
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return errorResponse(ApiError.badRequest("有效期仅支持1、7、30天或永久"), { headers });
            }
            const pw = password === undefined ? undefined
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.updateGroupShare(id, days, pw);
            if (!share) return errorResponse(ApiError.notFound("分享不存在"), { headers });
            return Response.json(share, { headers });
        }
        if (method === "POST" || method === "DELETE") {
            const limited = await writeGate();
            if (limited) return limited;
            if (method === "DELETE") return Response.json(await api.revokeGroupShare(id), { headers });
            const { days, password } = await readJsonBody<{ days?: unknown; password?: unknown }>(request);
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return errorResponse(ApiError.badRequest("有效期仅支持1、7、30天或永久"), { headers });
            }
            const pw = password === undefined ? null
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.createGroupShare(id, days, pw);
            if (!share) return errorResponse(ApiError.notFound("分组不存在"), { headers });
            return Response.json(share, { headers });
        }
        return errorResponse(ApiError.methodNotAllowed(), { headers });
    } else if (path === "groups" && method === "GET") {
        const groups = await api.getGroups();
        return Response.json(groups);
    } else if (path.startsWith("groups/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }
        const group = await api.getGroup(id);
        // 与 GET /api/notes/{id} 同语义：不存在就 404，不回 200 + null
        //（200 + null 会让调用方把「没有」当「有了一个空对象」）
        if (!group) throw ApiError.notFound("分组不存在");
        return Response.json(group);
    } else if (path === "groups" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonBody<GroupInput>(request);

        // 验证分组数据
        const validation = validateGroup(data);
        if (!validation.valid) {
            return errorResponse(ApiError.badRequest(`验证失败: ${validation.errors?.join(", ")}`));
        }

        const result = await api.createGroup(validation.sanitizedData as Group);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }

        const data = await readJsonBody<Partial<Group>>(request);
        // PATCH 化校验：与 POST 同一套规则（trim + 截断 100），只校验传了的字段。
        // 以前只查「非空串」，name 没有长度上限 —— 与 POST 不对称。
        const validation = validateGroupPatch(data);
        if (!validation.valid) {
            return errorResponse(ApiError.badRequest(`验证失败: ${validation.errors?.join(", ")}`));
        }

        const result = await api.updateGroup(id, validation.sanitizedData as Partial<Group>);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }

        const result = await api.deleteGroup(id, {
            action: "group.delete",
            actor: "",
            ip,
            detail: `分组 ${id}`,
        });
        // 软删除：结果含 recycleId，前端撤销时据此精确还原（审计已并入删除事务）
        return Response.json(result);

    // ---- 记事本 ----
    // 与分组/站点同一套：写操作走 writeGate 限速，账号隔离在 api 层用 scopeSql 做。
    } else if (path === "notes/shares" && method === "GET") {
        // ⚠️ 必须排在 /^notes\/\d+\/share$/ 之前，也在 notes/folders 那一堆之前：
        // 「notes/shares」不匹配数字正则，但绝不能被后面的前缀分支抢走。
        return Response.json(await api.listNoteShares());
    } else if (path === "notes/reindex" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        await api.migrate();
        await api.migrateNotesFtsTable();
        if (!api.notesFtsReady) throw ApiError.serviceUnavailable("当前数据库不支持全文索引，搜索已使用备用模式");
        const notes = await api.listNotes();
        // 每条只重建读取后未被其他请求改写的版本，不能用旧快照覆盖并发保存的新索引。
        const statements = [ctx.env.DB.prepare(
            "DELETE FROM notes_fts WHERE user_id IS ? AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = notes_fts.note_id AND n.user_id IS notes_fts.user_id)"
        ).bind(api.currentUserId)];
        for (const note of notes) {
            statements.push(ctx.env.DB.prepare(
                "DELETE FROM notes_fts WHERE user_id IS ? AND note_id = ? AND EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id IS ? AND rev IS ?)"
            ).bind(api.currentUserId, note.id, note.id, api.currentUserId, note.rev ?? null));
            statements.push(ctx.env.DB.prepare(
                "INSERT INTO notes_fts (note_id, user_id, title, body) SELECT id, user_id, ?, ? FROM notes WHERE id = ? AND user_id IS ? AND rev IS ?"
            ).bind(segmentCJK(note.title ?? ""), segmentCJK((note.content ?? "").slice(0, FTS_CONTENT_LIMIT)), note.id, api.currentUserId, note.rev ?? null));
        }
        // D1 batch 保证同一条删除与插入原子化；控制单批大小，避免大型笔记库超限。
        for (let i = 1; i < statements.length; i += 80) await ctx.env.DB.batch(statements.slice(i, i + 80));
        await statements[0].run();
        return Response.json({ success: true, count: notes.length });
    } else if (path === "notes/stats" && method === "GET") {
        // 数据页概览「双链 / 版本历史」两格的全站计数（只读，不走 writeGate）
        return Response.json(await api.notesStats());
    } else if (path === "notes/changes" && method === "GET") {
        // 跨设备变更轮询（2026-10-11）：自 since 以来的变更计数 + 文件夹/标签快照。
        // 只读、轻量（不回正文），客户端发现变更后自己走 reload()。
        // no-store：轮询响应带游标，缓存了会让其它设备永远看不见变更。
        const since = ctx.url.searchParams.get("since") || undefined;
        return Response.json(await api.notesChanges(since || undefined), {
            headers: { "Cache-Control": "no-store" },
        });
    } else if (path === "notes/search" && method === "POST") {
        // 服务端全文检索（2026-10-09）：有 FTS5 就走索引 + bm25 排序，
        // 没有就退回 LIKE 全表扫 —— 前端拿到的是同一份形状（id + 摘要 + 分数）。
        // 只读，不走 writeGate；但它确实查库，所以还是过一次登录守卫。
        // 请求体可能压根不是 JSON（老客户端 / 探测请求）：解析失败就当空查询，
        // 别把 500 抛给用户 —— 搜索失败的结果是「列表照常显示」，不是「页面报错」
        let body: { query?: unknown; limit?: unknown };
        try {
            body = await readJsonBody<{ query?: unknown; limit?: unknown }>(request);
        } catch {
            body = {};
        }
        const query = typeof body?.query === "string" ? body.query : "";
        const limit = typeof body?.limit === "number" ? body.limit : 50;
        if (!query.trim()) return Response.json({ mode: "like", results: [] });
        return Response.json(await api.searchNotes(query, limit), {
            headers: { "Cache-Control": "no-store" },
        });
    } else if (path === "notes/import" && method === "POST") {
        // 导入「记事本导出」JSON：只动记事本，按 uuid 合并（文件较新才覆盖）。
        // 是写操作，走 writeGate 限速；失败由 api 层整批回滚。
        const limited = await writeGate();
        if (limited) return limited;
        const body = await readJsonBody<{ kind?: unknown; notes?: unknown }>(request);
        if (!body || !Array.isArray(body.notes)) {
            throw ApiError.badRequest("文件里没有笔记数据（这不是记事本导出的 JSON）");
        }
        return Response.json(await api.importNotesData(body as never));
    } else if (/^notes\/\d+\/share$/.test(path)) {
        const id = Number(path.split("/")[1]);
        const headers = { "Cache-Control": "no-store" };
        if (!Number.isSafeInteger(id) || id <= 0) return errorResponse(ApiError.badRequest("无效的ID"), { headers });
        if (method === "GET") return Response.json(await api.getNoteShare(id), { headers });
        if (method === "PUT") {
            // 更新有效期但保留 token（链接不变）—— inkstone 的「更新设置」同语义
            const limited = await writeGate();
            if (limited) return limited;
            const { days, password } = await readJsonBody<{ days?: unknown; password?: unknown }>(request);
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return errorResponse(ApiError.badRequest("有效期仅支持1、7、30天或永久"), { headers });
            }
            // password：string = 重设口令；null = 清除口令；不传 = 保持
            const pw = password === undefined ? undefined
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.updateNoteShare(id, days, pw);
            if (!share) return errorResponse(ApiError.notFound("分享不存在"), { headers });
            return Response.json(share, { headers });
        }
        if (method === "POST" || method === "DELETE") {
            const limited = await writeGate();
            if (limited) return limited;
            if (method === "DELETE") return Response.json(await api.revokeNoteShare(id), { headers });
            const { days, password } = await readJsonBody<{ days?: unknown; password?: unknown }>(request);
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return errorResponse(ApiError.badRequest("有效期仅支持1、7、30天或永久"), { headers });
            }
            // password：非空 string = 设访问口令；null/空/不传 = 不设（公开）
            const pw = password === undefined ? null
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.createNoteShare(id, days, pw);
            if (!share) return errorResponse(ApiError.notFound("笔记不存在"), { headers });
            return Response.json(share, { headers });
        }
        return errorResponse(ApiError.methodNotAllowed(), { headers });
    } else if (path === "notes" && method === "GET") {
        // ?fields=list：列表只要摘要，不回正文（笔记多了以后这一份能到 MB 级）。
        // 不带这个参数就是原来的全量形状，老客户端不受影响。
        // 前端**现在默认不开**：几十条笔记时列表带正文才 2 KB，开了反而让
        // 每次点开笔记多一次往返。这是给「笔记涨到几百条」那天准备的阀门。
        const summary = url.searchParams.get("fields") === "list";
        const notes = await api.listNotes({ summary });
        return Response.json(notes);
    } else if (path === "notes/count" && method === "GET") {
        return Response.json({ count: await api.countNotes() });

    // ---- 阶段三收尾：笔记文件夹 / 标签 ----
    // ⚠️ 这一整块必须排在下面那些 `path.startsWith("notes/")` 分支**之前**：
    // 「notes/folders」/「notes/tags」也满足 startsWith("notes/")，而那几个分支是
    // `parseInt(path.split("/")[1])` —— 解析 "folders" 得到 NaN，直接返回 400「无效的ID」。
    // 顺序反了的表现就是：接口一直 400，本地新库却正常（那边根本不进这条链）。
    } else if (path === "notes/folders" && method === "GET") {
        return Response.json(await api.listFolders());
    // ---- 图片附件（2026-07）----
    //
    // ⚠️ 三条路由必须排在下面那些 `path.startsWith("notes/")` 分支**之前**，
    // 顺序照 inkstone 的做法（data.ts:183 那段注释讲的是同一类坑）：
    // 「notes/attachments」也满足 startsWith("notes/")，被抢走就会走错分支。
    //
    // ⚠️ 上传用 **raw body**（不是 multipart、不是 base64）：
    // base64 会把体积撑大 33%，而我们单文件上限就是 KV 单条的 25MB ——
    // base64 之后必然超。前端用 `fetch(url, { method:"POST", body: file })`
    // 直接把二进制送上来，服务端只读 Content-Type 定类型、**不解析** body 结构。
    // 真正的类型判定靠**嗅探文件头**（sniffImageMime），不信客户端说的。
    } else if (path === "notes/attachments" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        return await handleUploadAttachment(ctx);
    } else if (path === "notes/attachments/list" && method === "GET") {
        return Response.json(await api.listAttachments());
    } else if (/^notes\/attachments\/[0-9a-z-]+$/.test(path) && method === "GET") {
        // 取图。⚠️ 会走鉴权（整条 /api 都在鉴权后面），所以前端 <img> 不能直接
        // 用这个 URL —— 要么走 fetch + blob，要么由后端对公开笔记的图片走免鉴权通道。
        // 现在的做法见 public.ts（笔记分享页的图片走 /api/public/... ）。
        const id = path.split("/")[2];
        const headers = { "Cache-Control": "private, no-store" };
        const found = await api.getAttachment(id);
        if (!found) return errorResponse(ApiError.notFound("附件不存在"), { headers });
        // ⚠️ object_key 在 listAttachments 里是**故意剥掉**的（暴露它等于泄漏存储布局），
        // 但单条查询拿得到 —— 这里取不到就说明记录异常，直接判 404 而不是硬传 undefined。
        if (!found.object_key) {
            return errorResponse(new ApiError(500, API_ERROR_CODES.internal, "附件记录不完整"), { headers });
        }
        const bytes = await readAttachmentObject(ctx.env, found.storage, found.object_key);
        if (!bytes) return errorResponse(ApiError.gone("附件数据已丢失"), { headers });
        // ⚠️ Response 的 BodyInit 在 Worker 类型里不含 Uint8Array，
        // 用它的 .buffer（零拷贝，不多复制一份 25MB）。
        // 文本附件（txt/json）补 charset=utf-8：不补的话中文按浏览器默认编码
        // 猜，UTF-8 的文件会显示成乱码（2026-10-18 加纯文本附件时一并修）。
        const contentType = found.mime.startsWith("text/")
            ? `${found.mime}; charset=utf-8`
            : found.mime;
        return new Response(bytes.buffer as ArrayBuffer, {
            headers: {
                "Content-Type": contentType,
                "Content-Length": String(bytes.byteLength),
                // private, no-store：附件是登录后才可见的，走任何中间缓存都会
                // 把它发给别人。
                //
                // ⚠️ 2026-10-19 补上文件名（原来只有裸 `inline`）：用户点「另存为」
                // 拿到的是 uuid，重命名功能等于白做。RFC 6266 的标准写法是
                // `filename*=UTF-8''<百分号编码>`，再给一个纯 ASCII 兜底名
                // 给不认识 filename* 的老客户端。两者都只出现文件名，
                // 不含 object_key（存储布局照旧不外泄）。
                "Content-Disposition": contentDisposition(found.filename),
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } else if (/^notes\/attachments\/[0-9a-z-]+$/.test(path) && method === "PATCH") {
        const limited = await writeGate();
        if (limited) return limited;
        return await handleRenameAttachment(ctx, path.split("/")[2]);
    } else if (/^notes\/attachments\/[0-9a-z-]+\/content$/.test(path) && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;
        return await handleUpdateAttachmentContent(ctx, path.split("/")[2]);
    } else if (/^notes\/attachments\/[0-9a-z-]+$/.test(path) && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const id = path.split("/")[2];
        const ok = await api.deleteAttachment(id);
        if (!ok.ok) throw ApiError.notFound(ok.error);
        // 先删 D1 记录再删对象：反过来会出现「记录还在、对象没了」，
        // 用户刷新后看到图裂了却删不掉。
        await finishAttachmentDeletion(ctx.env, id, ok.storage, ok.objectKey);
        return Response.json({ ok: true });
    } else if (path === "notes/attachments/prune" && method === "POST") {
        // 清理未引用附件（2026-10-08，设置 → 数据 → 维护，照 inkstone）：
        // 先删 D1 记录再删对象，与单条 DELETE 同一约定（反了会泄漏或悬空）。
        const limited = await writeGate();
        if (limited) return limited;
        const { removed } = await api.pruneAttachments();
        for (const a of removed) {
            await finishAttachmentDeletion(ctx.env, a.id, a.storage, a.object_key);
        }
        return Response.json(
            { removed: removed.length, freedBytes: removed.reduce((s, a) => s + a.size, 0) }
        );
    } else if (path === "notes/folders" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonBody<Partial<NoteFolder>>(request);
        // 白名单：只有 name / 外观两列是文件夹的字段，其它（id / user_id / count）一律不收
        const name = typeof data.name === "string" ? data.name.trim().slice(0, 80) : "";
        if (!name) throw ApiError.badRequest("文件夹名不能为空");
        if (data.parent_id !== undefined && data.parent_id !== null && (!Number.isInteger(data.parent_id) || data.parent_id <= 0)) {
            throw ApiError.badRequest("父文件夹 ID 无效");
        }
        return Response.json(
            await api.createFolder({
                name,
                parent_id: data.parent_id ?? null,
                icon: typeof data.icon === "string" ? data.icon.slice(0, 32) : null,
                color: typeof data.color === "string" ? data.color.slice(0, 32) : null,
            })
        );
    } else if (path.startsWith("notes/folders/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");

        const data = await readJsonBody<Partial<NoteFolder>>(request);
        const patch: Partial<NoteFolder> = {};
        if (typeof data.name === "string") patch.name = data.name.trim().slice(0, 80) || "";
        if (data.order_num !== undefined) patch.order_num = Number(data.order_num) || 0;
        // 文件夹外观：可空字符串 = 恢复默认样式；只收短串，防脏数据撑大行
        if (data.icon !== undefined) patch.icon = typeof data.icon === "string" ? data.icon.slice(0, 32) : null;
        if (data.color !== undefined) patch.color = typeof data.color === "string" ? data.color.slice(0, 32) : null;
        if (data.parent_id !== undefined) {
            if (data.parent_id !== null && (!Number.isInteger(data.parent_id) || data.parent_id <= 0)) {
                throw ApiError.badRequest("父文件夹 ID 无效");
            }
            patch.parent_id = data.parent_id;
        }
        const folder = await api.updateFolder(id, patch);
        if (!folder) throw ApiError.notFound("文件夹不存在");
        return Response.json(folder);
    } else if (path.startsWith("notes/folders/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");
        // 回收到「未归类」，orphaned 给 UI 提示用
        return Response.json(await api.deleteFolder(id));
    } else if (path === "notes/tag-links" && method === "GET") {
        // 全量标签关联，形如 { "12": [3, 5] }：列表页算每个标签的条数要用到，
        // 逐条查会是 N+1，而这点数据一次拿到最省事。
        return Response.json(await api.listNoteTags());
    } else if (path === "notes/tags" && method === "GET") {
        return Response.json(await api.listTags());
    } else if (path === "notes/tags" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonBody<Partial<NoteTag>>(request);
        const name = typeof data.name === "string" ? data.name.trim().slice(0, 40) : "";
        if (!name) throw ApiError.badRequest("标签名不能为空");
        return Response.json(
            await api.createTag({ name, color: typeof data.color === "string" ? data.color : null })
        );
    } else if (path.startsWith("notes/tags/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");

        const data = await readJsonBody<Partial<NoteTag>>(request);
        const patch: Partial<NoteTag> = {};
        if (typeof data.name === "string") patch.name = data.name.trim().slice(0, 40) || "";
        if (data.color !== undefined) patch.color = typeof data.color === "string" ? data.color : null;
        const tag = await api.updateTag(id, patch);
        if (!tag) throw ApiError.notFound("标签不存在");
        return Response.json(tag);
    } else if (path.startsWith("notes/tags/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");
        return Response.json(await api.deleteTag(id));
    } else if (path.startsWith("notes/") && path.endsWith("/tags") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");

        const body = await readJsonBody<{ tagIds?: unknown }>(request);
        const tagIds = Array.isArray((body as { tagIds?: unknown })?.tagIds)
            ? ((body as { tagIds?: unknown[] }).tagIds as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0)
            : [];
        return Response.json(await api.setNoteTags(id, tagIds));
    } else if (path.startsWith("notes/") && path.endsWith("/revisions") && method === "GET") {
        // 版本历史列表。⚠️ 必须排在下面那个 `notes/{id}` 的 GET 分支**之前** ——
        //   否则 "notes/5/revisions" 会被当成 id=parseInt("5/revisions") 走掉。
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) throw ApiError.badRequest("无效的ID");
        return Response.json(await api.listNoteRevisions(id));
    } else if (path.startsWith("notes/") && path.endsWith("/revisions/") && method === "GET") {
        const [rawNoteId, rawRevId] = path.split("/");
        const noteId = parseInt(rawNoteId);
        const revisionId = parseInt(rawRevId);
        if (isNaN(noteId) || isNaN(revisionId)) {
            throw ApiError.badRequest("无效的ID");
        }
        const revision = await api.getNoteRevision(noteId, revisionId);
        if (!revision) throw ApiError.notFound("该版本不存在");
        return Response.json(revision);
    } else if (path.startsWith("notes/") && path.endsWith("/revisions/") && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const [rawNoteId, rawRevId] = path.split("/");
        const noteId = parseInt(rawNoteId);
        const revisionId = parseInt(rawRevId);
        if (isNaN(noteId) || isNaN(revisionId)) {
            throw ApiError.badRequest("无效的ID");
        }
        const note = await api.restoreNoteRevision(noteId, revisionId);
        if (!note) throw ApiError.notFound("该版本不存在");
        return Response.json(note);
    } else if (path.startsWith("notes/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }
        const note = await api.getNote(id);
        if (!note) throw ApiError.notFound("笔记不存在");
        return Response.json(note);
    } else if (path === "notes" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonBody<Partial<Note>>(request);
        // 绑定的站点必须是自己的（#477，见 assertOwnedSiteForNote）
        if (typeof data.site_id === "number") await assertOwnedSiteForNote(api, data.site_id);
        // 只留认识的字段：请求体是用户可控的，不能让它决定往哪几列写值
        const draft: Partial<Note> = {
            title: typeof data.title === "string" ? data.title : "",
            content: typeof data.content === "string" ? data.content : "",
            pinned: Boolean(data.pinned),
            site_id: typeof data.site_id === "number" ? data.site_id : null,
            // 只对**正整数**认文件夹，其余（字符串、0、负数、数组）一律落 NULL = 未归类。
            // 不拿 `data.folder_id ?? null` 直传：0 会被当成「id 为 0 的文件夹」写进库里。
            folder_id:
                typeof data.folder_id === "number" && Number.isInteger(data.folder_id) && data.folder_id > 0
                    ? data.folder_id
                    : null,
        };
        return Response.json(await api.createNote(draft));
    } else if (path === "note-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        // ⚠️ 这个接口两种形状都认（顶层数组 / { orders }），所以不能用 readJsonBody
        // （它会把数组形状挡掉，等于把原来能用的请求改成 400 —— 改错过一次）。
        const body = await readJsonValue(request);
        const orders = Array.isArray(body)
            ? body
            : (body as { orders?: unknown }).orders;
        if (!Array.isArray(orders)) {
            throw ApiError.badRequest("无效的排序数据");
        }
        // 与 group-orders / site-orders 同一道逐项校验：元素缺 id/order_num 时
        // undefined 会直接进 bind，D1 报错变成 500 —— 应该是 400。
        for (const item of orders) {
            const row = item as { id?: unknown; order_num?: unknown } | null;
            if (
                !row ||
                typeof row.id !== "number" ||
                !Number.isSafeInteger(row.id) ||
                row.order_num === undefined ||
                typeof row.order_num !== "number"
            ) {
                throw ApiError.badRequest("排序数据格式无效，每个项目必须包含id和order_num");
            }
        }
        return Response.json({
            success: await api.updateNoteOrder(orders as { id: number; order_num: number }[]),
        });
    } else if (path.startsWith("notes/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }
        const data = await readJsonBody<Partial<Note>>(request);
        const patch: Partial<Note> = {};
        if (typeof data.title === "string") patch.title = data.title;
        if (typeof data.content === "string") patch.content = data.content;
        if (data.pinned !== undefined) patch.pinned = Boolean(data.pinned);
        // 收藏（2026-10-09 与置顶分离）
        if (data.starred !== undefined) patch.starred = Boolean(data.starred);
        // 乐观并发：客户端带上「我改的是哪一版」。老客户端不传 → 不校验（照旧覆盖）
        if (typeof data.rev === "number" && Number.isInteger(data.rev) && data.rev >= 0) {
            patch.rev = data.rev;
        }
        // 显式传 null 才解除与站点的关联
        if (data.site_id !== undefined) {
            patch.site_id = typeof data.site_id === "number" ? data.site_id : null;
            // 绑定的站点必须是自己的（#477，见 assertOwnedSiteForNote）
            if (typeof patch.site_id === "number") await assertOwnedSiteForNote(api, patch.site_id);
        }
        // ⚠️ 阶段三的归档列。**漏了这一行就是「点了归档按钮，刷新又变回来」**：
        // 路由层白名单是照抄字段的，notes.ts 里认 archived 这里没认，
        // 请求不报错、HTTP 200，只是字段被静默丢掉（实测 archived: true → 回显 0）。
        if (data.archived !== undefined) patch.archived = Boolean(data.archived);
        // 阶段三收尾：归入 / 移出文件夹（显式传 null = 移到未归类，这和站点 site_id 一个语义）
        if (data.folder_id !== undefined) {
            patch.folder_id =
                typeof data.folder_id === "number" &&
                Number.isInteger(data.folder_id) &&
                data.folder_id > 0
                    ? data.folder_id
                    : null;
        }
        try {
            const note = await api.updateNote(id, patch);
            if (!note) throw ApiError.notFound("笔记不存在");
            return Response.json(note);
        } catch (error) {
            // 乐观并发冲突：不是错误，是「有人在别处改过」这句话。
            // 带上当前内容，前端才能让用户现场决定「覆盖 / 看别人的版本」。
            if (error instanceof NoteConflictError) {
                // 走统一的 ApiError：code 是机器可读的，对方的版本放 details.note。
                // 旧形状（顶层 note + error 是字符串）客户端也仍然认，所以这次替换
                // 不需要前后端同时上线 —— 老客户端读到新形状照样能弹出冲突框。
                return errorResponse(
                    ApiError.conflict(error.message, { note: error.note })
                );
            }
            throw error;
        }
    } else if (path.startsWith("notes/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }
        // 审计并入删除事务（api 层同一个 batch）：少一次串行往返，
        // 且「删了」与「记了审计」同生同死
        return Response.json(
            await api.deleteNote(id, {
                action: "note.delete",
                actor: "",
                ip,
                detail: `笔记 ${id}`,
            })
        );
    }
    // 站点相关API
    // ⚠️ sites/changes 必须排在 `path.startsWith("sites/")` 那一条**之前**：
    // 否则会被当成 id=parseInt("changes")（NaN）→ 直接 400「无效的ID」。
    // 与 notes/shares 排在 notes/{id} 之前是同一类坑。
    if (path === "sites/changes" && method === "GET") {
        // 卡片侧增量同步（2026-10-13）：只回「自 since 以来删掉了哪些」。
        // 增删改里的改与增客户端比对 bootstrap 就能发现，只有删除是物理删行、看不见。
        // no-store：轮询带游标，缓存了会让其它设备永远看不见变更。
        const since = url.searchParams.get("since") || undefined;
        return Response.json(await api.siteChanges(since), {
            headers: { "Cache-Control": "no-store" },
        });
    } else if (path === "sites" && method === "GET") {
        const groupId = url.searchParams.get("groupId");
        // 非法值不能放过去：parseInt("abc") 是 NaN，NaN 进 bind 的行为未定义
        if (groupId !== null && !Number.isSafeInteger(Number(groupId))) {
            throw ApiError.badRequest("无效的分组ID");
        }
        const sites = await api.getSites(groupId ? parseInt(groupId) : undefined);
        return Response.json(sites);
    } else if (path.startsWith("sites/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }

        const site = await api.getSite(id);
        // 与 GET /api/notes/{id} 同语义：不存在就 404，不回 200 + null
        if (!site) throw ApiError.notFound("站点不存在");
        return Response.json(site);
    } else if (path === "sites" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonBody<SiteInput>(request);

        // 验证站点数据
        const validation = validateSite(data);
        if (!validation.valid) {
            return errorResponse(ApiError.badRequest(`验证失败: ${validation.errors?.join(", ")}`));
        }

        // 目标分组必须是自己的：批量排序路径修过同一个洞（updateSiteOrder 的
        // filterOwnedGroupIds），POST 这条路不能漏 —— 否则卡片能建进别人的分组，
        // 从自己视图里消失。
        const owned = await api.filterOwnedGroupIds([validation.sanitizedData!.group_id]);
        if (!owned.has(validation.sanitizedData!.group_id)) {
            return errorResponse(ApiError.badRequest("目标分组不存在"));
        }

        const result = await api.createSite(validation.sanitizedData as Site);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }

        const data = await readJsonBody<Partial<Site>>(request);

        // PATCH 化校验：与 POST 同一套规则（trim / 截断 / URL 规范化 / 图标清洗），
        // 只校验传了的字段。以前只有「URL 能不能 new URL」几条 —— name 可以改成
        // 空串、description/notes 没有上限、icon 不过 sanitizeIconUrl。
        const validation = validateSitePatch(data);
        if (!validation.valid) {
            return errorResponse(ApiError.badRequest(`验证失败: ${validation.errors?.join(", ")}`));
        }
        const sanitized = validation.sanitizedData as Partial<Site>;

        // 目标分组必须是自己的（同 POST；批量排序路径早已修过，这里是补单条编辑这条路）
        if (sanitized.group_id !== undefined) {
            const owned = await api.filterOwnedGroupIds([sanitized.group_id]);
            if (!owned.has(sanitized.group_id)) {
                return errorResponse(ApiError.badRequest("目标分组不存在"));
            }
        }

        const result = await api.updateSite(id, sanitized);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            throw ApiError.badRequest("无效的ID");
        }

        // 审计并入删除事务（api 层同一个 batch）：少一次串行往返
        const result = await api.deleteSite(id, {
            action: "site.delete",
            actor: "",
            ip,
            detail: `站点 ${id}`,
        });
        // 软删除：结果含 recycleId，前端撤销时据此精确还原
        return Response.json(result);
    }
    // 批量删除站点：多选删除一次请求搬完（逐个 DELETE 在 20 张卡时要等十几秒）
    else if (path === "sites/batch-delete" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return errorResponse(ApiError.badRequest("缺少要删除的 id"));
        }
        // 一次删太多会把 D1 单次请求顶满，也给误操作留个上限
        if (ids.length > 500) {
            return errorResponse(ApiError.badRequest("一次最多删除 500 个"));
        }
        // 审计并入删除事务（api 层同一个 batch）
        const result = await api.deleteSites(ids, {
            action: "site.batchDelete",
            actor: "",
            ip,
            detail: `站点 ${ids.length} 个`,
        });
        return Response.json(result);
    }
    // 批量更新排序
    else if (path === "group-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = await readJsonArray<{ id: number; order_num: number }>(request);

        // 验证排序数据
        if (!Array.isArray(data)) {
            return errorResponse(ApiError.badRequest("排序数据必须是数组"));
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return errorResponse(ApiError.badRequest("排序数据格式无效，每个项目必须包含id和order_num"));
            }
        }

        const result = await api.updateGroupOrder(data);
        return Response.json({ success: result });
    } else if (path === "site-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        // 支持一次提交「顺序 + 所属分组」，拖拽跨组移动不必再逐个请求
        const data = await readJsonArray<{
            id: number;
            order_num: number;
            group_id?: number;
        }>(request);

        // 验证排序数据
        if (!Array.isArray(data)) {
            return errorResponse(ApiError.badRequest("排序数据必须是数组"));
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return errorResponse(ApiError.badRequest("排序数据格式无效，每个项目必须包含id和order_num"));
            }

            if (item.group_id !== undefined && typeof item.group_id !== "number") {
                return errorResponse(ApiError.badRequest("分组ID必须是数字"));
            }
        }

        // 结果里带着「成了哪几个、没成哪几个」：D1 没有跨语句事务，
        // 一批里挂掉几条是真实存在的，前端要按实际结果更新（见 App 的 bulkMove）
        const result = await api.updateSiteOrder(data);
        return Response.json(result);
    }

    return null;
}
