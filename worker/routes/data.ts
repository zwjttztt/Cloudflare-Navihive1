// 数据主干路由：首屏 bootstrap、分组 CRUD、站点 CRUD、批量删除、批量排序。
//
// 从 worker/index.ts 拆出来。这是站点日常读写量最大的一组，
// 读到的数据已经按 ctx.api 上绑定的账号过滤过（见 NavigationAPI.setCurrentUser）。
import type { Group, Note, NoteFolder, NoteTag, Site } from "../../src/API/http";
import { enforceWriteGuard, writeBucket } from "../loginGuard";
import { weakEtag } from "../util";
import type { GroupInput, SiteInput } from "../types";
import { validateGroup, validateSite } from "../validate";
import { readIdempotencyKey, withIdempotency } from "../idempotency";
import {
    ATTACHMENT_MAX_BYTES,
    attachmentObjectKey,
    checkUploadQuota,
    deleteAttachmentObject,
    imageExtension,
    putAttachmentObject,
    readAttachmentObject,
    recordUpload,
    sniffImageMime,
} from "../attachments";
import type { RouteCtx } from "./types";

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
 */
async function handleUploadAttachment(ctx: RouteCtx): Promise<Response> {
    const { request, api, env } = ctx;

    // ⚠️ 先按 Content-Length 拒掉超大请求体（省得真去读 100MB 进内存）：
    // Workers 的请求体有上限，超了会直接 413/500，报错还不友好。
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > ATTACHMENT_MAX_BYTES) {
        return Response.json(
            { error: `单个文件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB` },
            { status: 413 }
        );
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    // 配额三道闸（存储通道 / 租约 / 每小时次数 / 总量）。租约让同一用户的上传串行化，
    // 否则并发下「都读到已用 900MB、都觉得还能塞 100MB」→ 实际写了 1.1GB。
    const quota = await checkUploadQuota(env, currentUserIdOf(ctx), bytes.byteLength);
    if (!quota.ok) return Response.json({ error: quota.error }, { status: quota.status });

    // 嗅探文件头定类型
    const mime = sniffImageMime(bytes);
    const ext = mime ? imageExtension(mime) : null;
    if (!mime || !ext) {
        return Response.json(
            { error: "只支持 PNG / JPEG / GIF / WebP / AVIF 图片（按文件内容判定，不看文件名）" },
            { status: 415 }
        );
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
        return Response.json({ error: "图片写入存储失败，请稍后重试" }, { status: 502 });
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

/** 幂等闸门只对写方法开：GET / HEAD 没有副作用，认重没有意义，只会白占一行记录 */
const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
        const body = JSON.stringify(data);
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
    } else if (path === "groups" && method === "GET") {
        const groups = await api.getGroups();
        return Response.json(groups);
    } else if (path.startsWith("groups/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const group = await api.getGroup(id);
        return Response.json(group);
    } else if (path === "groups" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as GroupInput;

        // 验证分组数据
        const validation = validateGroup(data);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        const result = await api.createGroup(validation.sanitizedData as Group);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const data = (await request.json()) as Partial<Group>;
        // 对修改的字段进行验证
        if (
            data.name !== undefined &&
            (typeof data.name !== "string" || data.name.trim() === "")
        ) {
            return Response.json(
                {
                    success: false,
                    message: "分组名称不能为空且必须是字符串",
                },
                { status: 400 }
            );
        }

        if (data.order_num !== undefined && typeof data.order_num !== "number") {
            return Response.json(
                {
                    success: false,
                    message: "排序号必须是数字",
                },
                { status: 400 }
            );
        }

        const result = await api.updateGroup(id, data);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const result = await api.deleteGroup(id);
        // 软删除：结果含 recycleId，前端撤销时据此精确还原
        return Response.json(result);

    // ---- 记事本 ----
    // 与分组/站点同一套：写操作走 writeGate 限速，账号隔离在 api 层用 scopeSql 做。
    } else if (path === "notes/shares" && method === "GET") {
        // ⚠️ 必须排在 /^notes\/\d+\/share$/ 之前，也在 notes/folders 那一堆之前：
        // 「notes/shares」不匹配数字正则，但绝不能被后面的前缀分支抢走。
        return Response.json(await api.listNoteShares());
    } else if (path === "notes/stats" && method === "GET") {
        // 数据页概览「双链 / 版本历史」两格的全站计数（只读，不走 writeGate）
        return Response.json(await api.notesStats());
    } else if (path === "notes/import" && method === "POST") {
        // 导入「记事本导出」JSON：只动记事本，按 uuid 合并（文件较新才覆盖）。
        // 是写操作，走 writeGate 限速；失败由 api 层整批回滚。
        const limited = await writeGate();
        if (limited) return limited;
        const body = await request.json() as { kind?: unknown; notes?: unknown };
        if (!body || !Array.isArray(body.notes)) {
            return Response.json({ error: "文件里没有笔记数据（这不是记事本导出的 JSON）" }, { status: 400 });
        }
        return Response.json(await api.importNotesData(body as never));
    } else if (/^notes\/\d+\/share$/.test(path)) {
        const id = Number(path.split("/")[1]);
        const headers = { "Cache-Control": "no-store" };
        if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "无效的ID" }, { status: 400, headers });
        if (method === "GET") return Response.json(await api.getNoteShare(id), { headers });
        if (method === "PUT") {
            // 更新有效期但保留 token（链接不变）—— inkstone 的「更新设置」同语义
            const limited = await writeGate();
            if (limited) return limited;
            const { days, password } = await request.json() as { days?: unknown; password?: unknown };
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return Response.json({ error: "有效期仅支持1、7、30天或永久" }, { status: 400, headers });
            }
            // password：string = 重设口令；null = 清除口令；不传 = 保持
            const pw = password === undefined ? undefined
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.updateNoteShare(id, days, pw);
            return Response.json(share ?? { error: "分享不存在" }, { status: share ? 200 : 404, headers });
        }
        if (method === "POST" || method === "DELETE") {
            const limited = await writeGate();
            if (limited) return limited;
            if (method === "DELETE") return Response.json(await api.revokeNoteShare(id), { headers });
            const { days, password } = await request.json() as { days?: unknown; password?: unknown };
            if (days !== null && days !== 1 && days !== 7 && days !== 30) {
                return Response.json({ error: "有效期仅支持1、7、30天或永久" }, { status: 400, headers });
            }
            // password：非空 string = 设访问口令；null/空/不传 = 不设（公开）
            const pw = password === undefined ? null
                : (typeof password === "string" && password.length > 0 ? password : null);
            const share = await api.createNoteShare(id, days, pw);
            return Response.json(share ?? { error: "笔记不存在" }, { status: share ? 200 : 404, headers });
        }
        return Response.json({ error: "不支持的方法" }, { status: 405, headers });
    } else if (path === "notes" && method === "GET") {
        const notes = await api.listNotes();
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
        if (!found) return Response.json({ error: "附件不存在" }, { status: 404, headers });
        // ⚠️ object_key 在 listAttachments 里是**故意剥掉**的（暴露它等于泄漏存储布局），
        // 但单条查询拿得到 —— 这里取不到就说明记录异常，直接判 404 而不是硬传 undefined。
        if (!found.object_key) {
            return Response.json({ error: "附件记录不完整" }, { status: 500, headers });
        }
        const bytes = await readAttachmentObject(ctx.env, found.storage, found.object_key);
        if (!bytes) return Response.json({ error: "附件数据已丢失" }, { status: 410, headers });
        // ⚠️ Response 的 BodyInit 在 Worker 类型里不含 Uint8Array，
        // 用它的 .buffer（零拷贝，不多复制一份 25MB）。
        return new Response(bytes.buffer as ArrayBuffer, {
            headers: {
                "Content-Type": found.mime,
                "Content-Length": String(bytes.byteLength),
                // private, no-store：图片是登录后才可见的，走任何中间缓存都会
                // 把它发给别人。文件名不外泄，所以用 inline + 通用类型。
                "Content-Disposition": "inline",
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } else if (/^notes\/attachments\/[0-9a-z-]+$/.test(path) && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const id = path.split("/")[2];
        const ok = await api.deleteAttachment(id);
        if (!ok.ok) return Response.json({ error: ok.error }, { status: ok.status });
        // 先删 D1 记录再删对象：反过来会出现「记录还在、对象没了」，
        // 用户刷新后看到图裂了却删不掉。
        await deleteAttachmentObject(ctx.env, ok.storage, ok.objectKey);
        return Response.json({ ok: true });
    } else if (path === "notes/attachments/prune" && method === "POST") {
        // 清理未引用附件（2026-10-08，设置 → 数据 → 维护，照 inkstone）：
        // 先删 D1 记录再删对象，与单条 DELETE 同一约定（反了会泄漏或悬空）。
        const limited = await writeGate();
        if (limited) return limited;
        const { removed } = await api.pruneAttachments();
        for (const a of removed) {
            await deleteAttachmentObject(ctx.env, a.storage, a.object_key);
        }
        return Response.json(
            { removed: removed.length, freedBytes: removed.reduce((s, a) => s + a.size, 0) }
        );
    } else if (path === "notes/folders" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as Partial<NoteFolder>;
        // 白名单：只有 name / 外观两列是文件夹的字段，其它（id / user_id / count）一律不收
        const name = typeof data.name === "string" ? data.name.trim().slice(0, 80) : "";
        if (!name) return Response.json({ error: "文件夹名不能为空" }, { status: 400 });
        if (data.parent_id !== undefined && data.parent_id !== null && (!Number.isInteger(data.parent_id) || data.parent_id <= 0)) {
            return Response.json({ error: "父文件夹 ID 无效" }, { status: 400 });
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
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });

        const data = (await request.json()) as Partial<NoteFolder>;
        const patch: Partial<NoteFolder> = {};
        if (typeof data.name === "string") patch.name = data.name.trim().slice(0, 80) || "";
        if (data.order_num !== undefined) patch.order_num = Number(data.order_num) || 0;
        // 文件夹外观：可空字符串 = 恢复默认样式；只收短串，防脏数据撑大行
        if (data.icon !== undefined) patch.icon = typeof data.icon === "string" ? data.icon.slice(0, 32) : null;
        if (data.color !== undefined) patch.color = typeof data.color === "string" ? data.color.slice(0, 32) : null;
        if (data.parent_id !== undefined) {
            if (data.parent_id !== null && (!Number.isInteger(data.parent_id) || data.parent_id <= 0)) {
                return Response.json({ error: "父文件夹 ID 无效" }, { status: 400 });
            }
            patch.parent_id = data.parent_id;
        }
        const folder = await api.updateFolder(id, patch);
        if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });
        return Response.json(folder);
    } else if (path.startsWith("notes/folders/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });
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

        const data = (await request.json()) as Partial<NoteTag>;
        const name = typeof data.name === "string" ? data.name.trim().slice(0, 40) : "";
        if (!name) return Response.json({ error: "标签名不能为空" }, { status: 400 });
        return Response.json(
            await api.createTag({ name, color: typeof data.color === "string" ? data.color : null })
        );
    } else if (path.startsWith("notes/tags/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });

        const data = (await request.json()) as Partial<NoteTag>;
        const patch: Partial<NoteTag> = {};
        if (typeof data.name === "string") patch.name = data.name.trim().slice(0, 40) || "";
        if (data.color !== undefined) patch.color = typeof data.color === "string" ? data.color : null;
        const tag = await api.updateTag(id, patch);
        if (!tag) return Response.json({ error: "标签不存在" }, { status: 404 });
        return Response.json(tag);
    } else if (path.startsWith("notes/tags/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[2]);
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });
        return Response.json(await api.deleteTag(id));
    } else if (path.startsWith("notes/") && path.endsWith("/tags") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });

        const body = (await request.json()) as { tagIds?: unknown };
        const tagIds = Array.isArray((body as { tagIds?: unknown })?.tagIds)
            ? ((body as { tagIds?: unknown[] }).tagIds as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0)
            : [];
        return Response.json(await api.setNoteTags(id, tagIds));
    } else if (path.startsWith("notes/") && path.endsWith("/revisions") && method === "GET") {
        // 版本历史列表。⚠️ 必须排在下面那个 `notes/{id}` 的 GET 分支**之前** ——
        //   否则 "notes/5/revisions" 会被当成 id=parseInt("5/revisions") 走掉。
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) return Response.json({ error: "无效的ID" }, { status: 400 });
        return Response.json(await api.listNoteRevisions(id));
    } else if (path.startsWith("notes/") && path.endsWith("/revisions/") && method === "GET") {
        const [rawNoteId, rawRevId] = path.split("/");
        const noteId = parseInt(rawNoteId);
        const revisionId = parseInt(rawRevId);
        if (isNaN(noteId) || isNaN(revisionId)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const revision = await api.getNoteRevision(noteId, revisionId);
        if (!revision) return Response.json({ error: "该版本不存在" }, { status: 404 });
        return Response.json(revision);
    } else if (path.startsWith("notes/") && path.endsWith("/revisions/") && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const [rawNoteId, rawRevId] = path.split("/");
        const noteId = parseInt(rawNoteId);
        const revisionId = parseInt(rawRevId);
        if (isNaN(noteId) || isNaN(revisionId)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const note = await api.restoreNoteRevision(noteId, revisionId);
        if (!note) return Response.json({ error: "该版本不存在" }, { status: 404 });
        return Response.json(note);
    } else if (path.startsWith("notes/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const note = await api.getNote(id);
        if (!note) return Response.json({ error: "笔记不存在" }, { status: 404 });
        return Response.json(note);
    } else if (path === "notes" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as Partial<Note>;
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

        const body = (await request.json()) as unknown;
        const orders = Array.isArray(body)
            ? body
            : (body as { orders?: unknown })?.orders;
        if (!Array.isArray(orders)) {
            return Response.json({ error: "无效的排序数据" }, { status: 400 });
        }
        return Response.json({
            success: await api.updateNoteOrder(
                orders as { id: number; order_num: number }[]
            ),
        });
    } else if (path.startsWith("notes/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const data = (await request.json()) as Partial<Note>;
        const patch: Partial<Note> = {};
        if (typeof data.title === "string") patch.title = data.title;
        if (typeof data.content === "string") patch.content = data.content;
        if (data.pinned !== undefined) patch.pinned = Boolean(data.pinned);
        // 显式传 null 才解除与站点的关联
        if (data.site_id !== undefined) {
            patch.site_id = typeof data.site_id === "number" ? data.site_id : null;
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
        const note = await api.updateNote(id, patch);
        if (!note) return Response.json({ error: "笔记不存在" }, { status: 404 });
        return Response.json(note);
    } else if (path.startsWith("notes/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        return Response.json(await api.deleteNote(id));
    }
    // 站点相关API
    if (path === "sites" && method === "GET") {
        const groupId = url.searchParams.get("groupId");
        const sites = await api.getSites(groupId ? parseInt(groupId) : undefined);
        return Response.json(sites);
    } else if (path.startsWith("sites/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const site = await api.getSite(id);
        return Response.json(site);
    } else if (path === "sites" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as SiteInput;

        // 验证站点数据
        const validation = validateSite(data);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        const result = await api.createSite(validation.sanitizedData as Site);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const data = (await request.json()) as Partial<Site>;

        // 验证更新的站点数据
        if (data.url !== undefined) {
            try {
                new URL(data.url);
            } catch {
                return Response.json(
                    {
                        success: false,
                        message: "无效的URL格式",
                    },
                    { status: 400 }
                );
            }
        }

        if (data.icon !== undefined && data.icon !== "") {
            try {
                new URL(data.icon);
            } catch {
                return Response.json(
                    {
                        success: false,
                        message: "无效的图标URL格式",
                    },
                    { status: 400 }
                );
            }
        }

        if (data.username !== undefined && typeof data.username !== "string") {
            return Response.json(
                {
                    success: false,
                    message: "账号必须是字符串",
                },
                { status: 400 }
            );
        }

        if (data.password !== undefined && typeof data.password !== "string") {
            return Response.json(
                {
                    success: false,
                    message: "密码必须是字符串",
                },
                { status: 400 }
            );
        }

        const result = await api.updateSite(id, data);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const result = await api.deleteSite(id);
        await api.writeAudit("site.delete", "", ip, `站点 ${id}`);
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
            return Response.json({ success: false, message: "缺少要删除的 id" }, { status: 400 });
        }
        // 一次删太多会把 D1 单次请求顶满，也给误操作留个上限
        if (ids.length > 500) {
            return Response.json({ success: false, message: "一次最多删除 500 个" }, { status: 400 });
        }
        const result = await api.deleteSites(ids);
        await api.writeAudit("site.batchDelete", "", ip, `站点 ${ids.length} 个`);
        return Response.json(result);
    }
    // 批量更新排序
    else if (path === "group-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as Array<{ id: number; order_num: number }>;

        // 验证排序数据
        if (!Array.isArray(data)) {
            return Response.json(
                {
                    success: false,
                    message: "排序数据必须是数组",
                },
                { status: 400 }
            );
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return Response.json(
                    {
                        success: false,
                        message: "排序数据格式无效，每个项目必须包含id和order_num",
                    },
                    { status: 400 }
                );
            }
        }

        const result = await api.updateGroupOrder(data);
        return Response.json({ success: result });
    } else if (path === "site-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        // 支持一次提交「顺序 + 所属分组」，拖拽跨组移动不必再逐个请求
        const data = (await request.json()) as Array<{
            id: number;
            order_num: number;
            group_id?: number;
        }>;

        // 验证排序数据
        if (!Array.isArray(data)) {
            return Response.json(
                {
                    success: false,
                    message: "排序数据必须是数组",
                },
                { status: 400 }
            );
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return Response.json(
                    {
                        success: false,
                        message: "排序数据格式无效，每个项目必须包含id和order_num",
                    },
                    { status: 400 }
                );
            }

            if (item.group_id !== undefined && typeof item.group_id !== "number") {
                return Response.json(
                    {
                        success: false,
                        message: "分组ID必须是数字",
                    },
                    { status: 400 }
                );
            }
        }

        // 结果里带着「成了哪几个、没成哪几个」：D1 没有跨语句事务，
        // 一批里挂掉几条是真实存在的，前端要按实际结果更新（见 App 的 bulkMove）
        const result = await api.updateSiteOrder(data);
        return Response.json(result);
    }

    return null;
}
