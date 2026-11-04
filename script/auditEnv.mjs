// script/auditEnv.mjs
// 浏览器端审计脚本（a11y-audit / contrast-audit）共用的那部分：找 Chrome、
// 起一个「静态产物 + 只读 API 桩」的本地服务、连 CDP。
//
// 为什么要自己起服务而不是复用 harness 里的 stub：harness/ 在仓库外（没进 git），
// CI 上根本不存在，审计就没法自动回归。这里只实现审计需要的**只读**接口，
// 交互类接口（建站/删站）一概不实现 —— 审计只看渲染结果，不需要写操作。
//
// ⚠️ public/_headers 必须照 ci-smoke 那样原样下发：CSP 真的生效时 emotion 才
// 用内联 <style> 注入，样式全靠它。少了 CSP 反而可能与线上不一致，但**下了
// 错的 CSP 会把样式挡掉** —— 那时候量出来的尺寸/对比度全是假的。

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const DIST = path.join(ROOT, "dist", "client");

// ---------------- 找 Chrome ----------------
export function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    /**
     * ⚠️ 2026-07 修：原来只按 darwin / linux 分支列候选，**Windows 落到了
     * linux 那一档**，于是 `process.platform === "win32"` 时会去 `fs.existsSync`
     * 检查 `/usr/bin/google-chrome` —— Windows 上不存在，函数返回 null，
     * 但**如果 PATH 里恰好有个同名包装脚本**，`which/where` 兜底会返回它，
     * 结果就是「Chrome: /usr/bin/google-chrome」然后连不上调试端口。
     */
    const candidates =
        process.platform === "win32"
            ? [
                  `${home}/AppData/Local/Google/Chrome/Application/chrome.exe`,
                  "C:/Program Files/Google/Chrome/Application/chrome.exe",
                  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
                  `${home}/AppData/Local/Chromium/Application/chrome.exe`,
              ]
            : process.platform === "darwin"
              ? [
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    "/Applications/Chromium.app/Contents/MacOS/Chromium",
                ]
              : [
                    "/usr/bin/google-chrome",
                    "/usr/bin/google-chrome-stable",
                    "/usr/bin/chromium",
                    "/usr/bin/chromium-browser",
                    "/snap/bin/chromium",
                ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    const lookup = process.platform === "win32" ? "where" : "which";
    for (const name of ["google-chrome", "chrome", "chromium", "chromium-browser"]) {
        const found = spawnSync(lookup, [name], { encoding: "utf8" });
        if (found.status === 0 && found.stdout.trim()) {
            const p = found.stdout.trim().split("\n")[0];
            // ⚠️ 兜底结果必须**真的存在**，否则又会被包装脚本/别名骗到
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
};

// ---------------- 压缩（2026-11-04 加，审查项 R14） ----------------
//
// 为什么必须压在**本地服务**这一层：线上走 Cloudflare / Nginx，文本资源一律 gzip 传输；
// 而这里的静态服务原来是把文件原样吐给浏览器 —— 量到的是「未压缩」的口径。
// 后果不是「数字难看」，而是**数字不可比**：`perf-audit.mjs` 拿这份 FCP/LCP 去和
// 线上体感、和云端 Lighthouse 对照，中间差着一整个压缩比（实测首屏 JSON/JS 约 3:1）。
// 首屏体感审计要回答的问题是「用户第一次看到内容要多久」，那条链路上的字节是**压缩后**的，
// 所以本地服务必须按同一口径下发。
//
// 只压文本类（html/js/css/json/svg/webmanifest）。图片、字体、ico 本身已压缩，
// 压了只会变大，线上也不会那样下发 —— 这条要跟线上一致，不是「压了总比不压强」。
export const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);

/**
 * 客户端接受 gzip 的意愿（RFC 9110 的 q 值语义），> 0 表示可以下发 gzip。
 *
 * 三条必须做对的事（写错会静默地「偶尔不压缩」，比不压缩更难查）：
 *   ① `gzip;q=0` 是**明确拒绝**，不能因为出现了 "gzip" 这几个字就当接受；
 *   ② `q` 写坏了（`q=abc`）按 0 处理 —— 宁可下发未压缩的原文（一定正确），
 *      也不要赌一个读不懂的协商头；
 *   ③ 没提 gzip 时看 `*`（`Accept-Encoding: *;q=1` 表示什么编码都收）。
 *      两者都没提 = 不接受（HTTP 里没写 `Accept-Encoding` 的客户端只保证认 identity）。
 *
 * @param {{ headers?: Record<string, string | string[] | undefined> } | null | undefined} req
 * @returns {number} q 值（0 = 不下发 gzip）
 */
export function gzipQuality(req) {
    const raw = req && req.headers ? req.headers["accept-encoding"] : undefined;
    const header = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
    if (!header.trim()) return 0;
    /** 显式声明的 gzip q 值（null = 没提） */
    let explicit = null;
    /** `*` 的 q 值（null = 没提） */
    let star = null;
    for (const part of header.split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const [nameRaw, ...params] = seg.split(";");
        const name = nameRaw.trim().toLowerCase();
        let q = 1;
        for (const param of params) {
            const p = param.trim().toLowerCase();
            if (!p.startsWith("q=")) continue;
            const value = Number(p.slice(2));
            q = Number.isFinite(value) ? value : 0;
        }
        if (name === "gzip") explicit = q;
        else if (name === "*") star = q;
    }
    if (explicit !== null) return explicit > 0 ? explicit : 0;
    if (star !== null) return star > 0 ? star : 0;
    return 0;
}

function parseHeadersFile() {
    const rules = [];
    const file = path.join(ROOT, "public", "_headers");
    if (!fs.existsSync(file)) return rules;
    let current = null;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        if (!/^\s/.test(line)) {
            current = { pattern: line.trim(), headers: {} };
            rules.push(current);
        } else if (current) {
            const idx = line.indexOf(":");
            if (idx > 0) current.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    }
    return rules;
}

const HEADER_RULES = parseHeadersFile();

const headersFor = pathname => {
    const out = {};
    for (const rule of HEADER_RULES) {
        const re = new RegExp(
            "^" +
                rule.pattern
                    .split("*")
                    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join(".*") +
                "$"
        );
        if (re.test(pathname)) Object.assign(out, rule.headers);
    }
    return out;
};

// 审计只需要「页面上有东西可量」：两个分组 + 每张卡 2~3 个站点，
// 分组栏（含折叠后的圆点）与卡片浮层控件就都在 DOM 里了。
const GROUPS = [
    { id: 1, name: "常用工具", order_num: 0 },
    { id: 2, name: "开发", order_num: 1 },
];
const SITES = [
    { id: 11, group_id: 1, name: "示例一", url: "https://example.com/", icon: "", description: "示例站点一", notes: "", username: "", password: "", order_num: 0 },
    { id: 12, group_id: 1, name: "示例二", url: "https://example.org/", icon: "", description: "示例站点二", notes: "", username: "", password: "", order_num: 1 },
    { id: 13, group_id: 2, name: "示例三", url: "https://example.net/", icon: "", description: "示例站点三", notes: "", username: "", password: "", order_num: 0 },
];

// ---------------- 记事本（2026-10-24 加） ----------------
//
// 为什么必须铺数据而不是留空：记事本的**空态**与「有内容」是两条完全不同的渲染分支
// （空态只有一个插画 + 一句话，列表 / 分组标题 / 标签栏 / 状态栏全都不挂）。
// 只铺空态就量，等于整类控件漏测 —— 站点审计里踩过同一个坑（「一条都没有」那档看不见）。
//
// 数据刻意覆盖三种渲染形态：
//   · 置顶 / 收藏（列表项左侧的标记位）
//   · 归入文件夹 vs 未归类（左栏两段分组标题）
//   · 有标签 vs 无标签（标签栏与列表项的标签 chip）
const NOTE_FOLDERS = [
    { id: 1, parent_id: null, name: "工作", order_num: 0, icon: "folder", color: null, count: 2 },
    { id: 2, parent_id: 1, name: "周报", order_num: 0, icon: null, color: null, count: 1 },
];
const NOTE_TAGS = [
    { id: 1, name: "待办", color: "#1976d2", count: 2 },
    { id: 2, name: "资料", color: null, count: 1 },
];
const NOTES = [
    {
        id: 1,
        uuid: "00000000-0000-4000-8000-000000000001",
        title: "会议纪要",
        content: "# 会议纪要\n\n- 第一条待办\n- 第二条待办\n",
        pinned: true,
        starred: false,
        rev: 3,
        order_num: 0,
        folder_id: 1,
        site_id: null,
        archived: false,
        created_at: "2026-10-01T09:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
    },
    {
        id: 2,
        uuid: "00000000-0000-4000-8000-000000000002",
        title: "读书笔记",
        content: "## 第三章\n\n摘录若干。\n",
        pinned: false,
        starred: true,
        rev: 1,
        order_num: 1,
        folder_id: null,
        site_id: 11,
        archived: false,
        created_at: "2026-10-02T09:00:00.000Z",
        updated_at: "2026-10-19T09:00:00.000Z",
    },
    {
        id: 3,
        uuid: "00000000-0000-4000-8000-000000000003",
        title: "随手记",
        content: "一句话。\n",
        pinned: false,
        starred: false,
        rev: 2,
        order_num: 2,
        folder_id: 2,
        site_id: null,
        archived: false,
        created_at: "2026-10-03T09:00:00.000Z",
        updated_at: "2026-10-18T09:00:00.000Z",
    },
];
/** 笔记 id → 标签 id[]（GET /api/notes/tag-links 的形状） */
const NOTE_TAG_LINKS = { 1: [1], 2: [1, 2], 3: [] };

// ---------------- 附件列表（2026-11-01 从 contrast-audit 下沉到共用桩） ----------------
//
// 为什么必须有这份桩：附件抽屉（`src/components/AttachmentManager.tsx`）一打开就拉
// `GET /api/notes/attachments/list`。原先桩里没有这个分支，请求落回末尾那个通用的
// `{ success: true }`，组件拿着这个对象去 `.slice()` 直接抛
// `TypeError: D.slice is not a function` —— 抽屉连挂都挂不上（四档筛选一起消失），
// 那一刻审计量到的「0 处不合格」是彻底的假绿。
//
// 之前 contrast-audit 在**自己脚本里**内联过一份 `window.fetch` 补丁（只对自己生效、
// 且必须赶在点开抽屉之前注入），a11y-audit 拿不到就一直崩在抽屉上。下沉到这里之后
// 两个脚本走同一条路：桩在服务端，与「谁先注入」无关。
//
// 三条数据刻意覆盖抽屉的三种渲染分支：图片（走缩略图 fetch 三态）、
// 文本/文档（走文档图标占位）、octet-stream（落到「其他」筛选）；
// ref_count 同时覆盖「引用 N 次」与「未引用」两种文案与配色。
const ATTACHMENT_ROWS = [
    { id: "audit-a1", note_id: 1, filename: "白板草图.png", mime: "image/png", size: 184320, width: 800, height: 600, storage: "r2", created_at: "2026-10-05T09:00:00.000Z", ref_count: 2 },
    { id: "audit-a2", note_id: 1, filename: "会议记录.txt", mime: "text/plain", size: 2048, width: null, height: null, storage: "r2", created_at: "2026-10-04T09:00:00.000Z", ref_count: 0 },
    { id: "audit-a3", note_id: 2, filename: "归档备份.zip", mime: "application/octet-stream", size: 7340032, width: null, height: null, storage: "r2", created_at: "2026-10-03T09:00:00.000Z", ref_count: 0 },
];

/**
 * 附件列表的桩态（2026-11-01 加）。
 *
 * 抽屉除了「有 N 条」这一态，还有三条**独立的渲染分支**，各自有各自的文字与配色：
 *   - `rows`（默认）：正常列表
 *   - `empty`：「还没有上传过任何附件。」
 *   - `error`：拉取失败，`{ error }` 走 `text` + `error.main`
 * 这些分支以前从没进过任何审计面 —— 而它们恰恰是最容易被忘掉的地方
 * （空态/失败态的说明文字，写的人通常不会去核对对比度）。
 *
 * ⚠️ 必须在**重新拉取之前**改，抽屉打开时才请求；改完关掉再开一次才会生效。
 */
let attachmentMode = "rows";
export function setAttachmentMode(mode) {
    if (!["rows", "empty", "error", "images"].includes(mode)) {
        throw new Error(`未知的附件桩态：${mode}`);
    }
    attachmentMode = mode;
}

// ---------------- 分享页（2026-10-24 加） ----------------
const SHARE_NOTE_TOKEN = "a".repeat(64);
const SHARE_GROUP_TOKEN = "b".repeat(64);
const SHARED_NOTE = {
    title: "公开分享的笔记",
    content: "# 公开分享\n\n这段正文出现在公开页上。\n\n- 列表项一\n- 列表项二\n",
    updated_at: "2026-10-20T09:00:00.000Z",
};
/**
 * 桩里那两个分享的 token —— 审计脚本拼公开页 URL 要用。
 * 形如 `/s/<token>`（笔记）与 `/g/<token>`（分组），见 src/main.tsx 的路由。
 */
export const SHARE_TOKENS = { note: SHARE_NOTE_TOKEN, group: SHARE_GROUP_TOKEN };


/**
 * 起本地服务（静态产物 + 只读 API 桩），返回 { url, close }。
 *
 * 端口传 0（默认）由系统分配：固定端口在 CI 上撞到别的进程就是一次
 * EADDRINUSE 崩溃，而崩溃时没人去关已经起来的 Chrome —— 留一个孤儿进程。
 */
export async function startSiteServer(port = 0) {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
        const extra = headersFor(pathname);
        for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);

        if (pathname.startsWith("/api/")) {
            res.setHeader("Content-Type", MIME[".json"]);
            if (pathname === "/api/bootstrap") {
                res.end(JSON.stringify({ groups: GROUPS, sites: SITES, configs: {} }));
                return;
            }
            if (pathname === "/api/init") {
                res.end(JSON.stringify({ ok: true, initialized: true }));
                return;
            }
            // 图标必须回**真的图片字节**：返回 JSON 会被当成破图，
            // 「破图」判据立刻假红（stub 缺接口的经典坑）。
            if (pathname === "/api/icon") {
                res.setHeader("Content-Type", "image/png");
                res.end(
                    Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
                        "base64"
                    )
                );
                return;
            }
            // 给个 owner：否则菜单里的 owner 入口会被守卫藏掉，
            // 一部分控件量不到（stub 缺接口造成过假红，这里是同一个坑）
            if (pathname === "/api/auth/me") {
                res.end(JSON.stringify({ id: 0, username: "guest", role: "owner" }));
                return;
            }

            // ---- 记事本（2026-10-24）：顺序要求 —— 更具体的路径必须排在 /api/notes 之前 ----
            if (pathname === "/api/notes/count") {
                res.end(JSON.stringify({ count: NOTES.length }));
                return;
            }
            if (pathname === "/api/notes/folders") {
                res.end(JSON.stringify(NOTE_FOLDERS));
                return;
            }
            if (pathname === "/api/notes/tags") {
                res.end(JSON.stringify(NOTE_TAGS));
                return;
            }
            if (pathname === "/api/notes/tag-links") {
                res.end(JSON.stringify(NOTE_TAG_LINKS));
                return;
            }
            if (pathname === "/api/notes/stats") {
                res.end(JSON.stringify({ versions: 4, links: 2 }));
                return;
            }
            if (pathname === "/api/notes/changes") {
                // 增量轮询：审计只跑静态快照，回一个空变更就够了
                res.end(JSON.stringify({ notes: [], deleted: [], cursor: "" }));
                return;
            }
            if (pathname === "/api/note-orders") {
                res.end(JSON.stringify({ success: true }));
                return;
            }
            if (pathname === "/api/notes/shares") {
                res.end(JSON.stringify([]));
                return;
            }
            // 附件抽屉的列表（见上面 ATTACHMENT_ROWS / attachmentMode 的说明）。
            // ⚠️ 顺序：更具体的路径必须排在 /api/notes 之前 —— 这条是精确匹配，
            //    但保持与全节一致的书写顺序，免得后来人把它挪到后面时被 /api/notes 吃掉。
            if (pathname === "/api/notes/attachments/list") {
                if (attachmentMode === "error") {
                    res.statusCode = 500;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ success: false, message: "附件列表读取失败（审计桩）" }));
                    return;
                }
                // `images`：只给图片那一条 —— 用来制造抽屉的 `none-match` 态
                // （files 非空、filtered 为空），那条分支靠「点文档筛选」才走得到。
                const rows =
                    attachmentMode === "empty" ? [] : attachmentMode === "images" ? ATTACHMENT_ROWS.slice(0, 1) : ATTACHMENT_ROWS;
                res.end(JSON.stringify(rows));
                return;
            }
            if (pathname === "/api/notes") {
                // ?fields=list 时服务端会把正文截短；审计只需要「列表能渲染」，
                // 全文照给也不会让界面变形（列表只用标题 + 摘要）。
                res.end(JSON.stringify(NOTES));
                return;
            }
            // 单条笔记（正文面板 / 附件引用会读）
            const noteOne = /^\/api\/notes\/(\d+)$/.exec(pathname);
            if (noteOne) {
                const found = NOTES.find(n => n.id === Number(noteOne[1]));
                res.end(JSON.stringify(found ?? null));
                return;
            }

            // ---- 分享页（2026-10-24）----
            // 公开笔记：GET 无口令时直接给正文（无口令分享就是这个形状）
            if (pathname === `/api/note-shares/${SHARE_NOTE_TOKEN}`) {
                res.end(JSON.stringify(SHARED_NOTE));
                return;
            }
            // 公开分组：前端按 status 字段分支，ok 时读 `data.group.name` + `data.sites`
            // ⚠️ 分组名是**嵌在 group 里**的，不是顶层 name（PublicGroupAccess 的类型形状）
            if (pathname === `/api/group-shares/${SHARE_GROUP_TOKEN}`) {
                res.end(
                    JSON.stringify({
                        status: "ok",
                        group: { name: "常用工具" },
                        sites: SITES.filter(s => s.group_id === 1),
                        views: 12,
                    })
                );
                return;
            }
            // 不存在的分享：按各自真实的契约回（笔记路 404 错误体 / 分组路 200 + not-found）
            if (pathname.startsWith("/api/note-shares/")) {
                res.statusCode = 404;
                res.end(
                    JSON.stringify({
                        success: false,
                        error: "分享不存在、已过期或已撤销",
                        code: "not_found",
                    })
                );
                return;
            }
            if (pathname.startsWith("/api/group-shares/")) {
                res.end(JSON.stringify({ status: "not-found" }));
                return;
            }

            // ---- 密码保险库 / 审计日志 / 回收站（2026-11-03 D4 加） ----
            //
            // 为什么必须补这三组：末尾那条兜底 `{ success: true }` 对它们是**非法形状** ——
            //   · `getVaultKeys` 把任何真值对象当成「已建过库」，面板会停在解锁屏
            //     （真解锁要跑 PBKDF2 + 真密文，桩做不到）→ 量到的是一屏点不动的表单；
            //   · `getAuditLog` 读 `log`、`getRecycleBin` 读 `items`，兜底体里都没有，
            //     组件各自 `|| []` 兜成空数组 → 面板永远是「没有记录 / 回收站是空的」，
            //     那是最容易「全绿」的假态（和附件抽屉那次的坑一模一样）。
            // 三组都只读、不写库，与本节其余部分同一底线。
            if (pathname === "/api/vault/keys") {
                // null = 还没建库。VaultPanel 的 phase 于是落到 setup，
                // 渲染「建库」屏（这是本任务覆盖的那一屏，见报告里的边界说明）
                res.end("null");
                return;
            }
            if (pathname === "/api/vault/entries") {
                // 没解锁就没有条目；只给形状，不给密文
                res.end("[]");
                return;
            }
            if (pathname === "/api/audit") {
                // getAuditLog 的返回形状：{ success, log: [{id, action, actor, ip, detail, created_at}], hasMore }
                res.end(
                    JSON.stringify({
                        success: true,
                        hasMore: false,
                        log: [
                            { id: 3, action: "login_success", actor: "owner", ip: "127.0.0.1", detail: "登录成功", created_at: "2026-11-03T09:00:00.000Z" },
                            { id: 2, action: "site_create", actor: "owner", ip: "127.0.0.1", detail: "新增站点", created_at: "2026-11-03T08:30:00.000Z" },
                            { id: 1, action: "backup_config", actor: "owner", ip: "127.0.0.1", detail: "改备份配置", created_at: "2026-11-03T08:00:00.000Z" },
                        ],
                    })
                );
                return;
            }
            if (pathname === "/api/recycle") {
                // getRecycleBin 的返回形状：{ success, items: [{id, kind, name, deletedAt}] }
                // ⚠️ deletedAt 是 **unix 秒**（界面里 fmtDateTime(deletedAt * 1000)），
                //    不是毫秒。给毫秒会让每行显示成「57770 年」那种假日期 ——
                //    桩不该凭空造出一个现实中不存在的状态。
                const at = iso => Math.floor(Date.parse(iso) / 1000);
                res.end(
                    JSON.stringify({
                        success: true,
                        items: [
                            { id: 101, kind: "site", name: "旧站点", deletedAt: at("2026-11-02T10:00:00Z") },
                            { id: 102, kind: "group", name: "归档分组", deletedAt: at("2026-11-02T09:00:00Z") },
                            { id: 103, kind: "site", name: "测试卡片", deletedAt: at("2026-11-01T09:00:00Z") },
                        ],
                    })
                );
                return;
            }

            res.end(JSON.stringify({ success: true }));
            return;
        }

        let filePath = path.join(DIST, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
        if (!filePath.startsWith(DIST) || !fs.existsSync(filePath)) {
            filePath = path.join(DIST, "index.html"); // SPA 兜底
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");

        // 文本资源按线上口径 gzip 下发（见上面 COMPRESSIBLE_EXTS / gzipQuality 的说明）。
        //
        // ⚠️ 刻意**不设** Content-Length：压缩后的长度要么先压完拿到缓冲（多占内存、多一次
        //    全量拷贝），要么算错 —— 而算错比不设糟得多（短了浏览器截断、长了永远等不到结尾）。
        //    不设就走 chunked，浏览器照样能正常收、正常解压。
        // ⚠️ `Vary: Accept-Encoding` 必须发：缓存里同一条 URL 的压缩与未压缩版本要能被区分，
        //    否则带/不带压缩的响应会被错误合并（线上 CDN 也是这么做的）。
        if (COMPRESSIBLE_EXTS.has(ext) && gzipQuality(req) > 0) {
            res.setHeader("Content-Encoding", "gzip");
            res.setHeader("Vary", "Accept-Encoding");
            res.removeHeader("Content-Length");
            const gz = createGzip({ level: 6 }); // level 6：Cloudflare 默认档，比 9 快、比 1 小
            // 管道错误不能吞：压缩流 / 文件流任一炸掉时，不接 error 会变成一个
            // 没人处理的 'error' 事件 —— 整个审计进程直接崩，看不到是哪一步出的事。
            const onError = err => {
                res.destroy(err);
            };
            fs.createReadStream(filePath).on("error", onError).pipe(gz).on("error", onError).pipe(res);
            return;
        }
        fs.createReadStream(filePath).pipe(res);
    });
    await new Promise((resolve, reject) => {
        // listen 的 error（端口被占）不会走 reject：不挂它，EADDRINUSE 会变成
        // 一个没人接的 uncaughtException，脚本崩在半路、Chrome 留在后台
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    const actualPort = server.address()?.port ?? port;
    return { url: `http://127.0.0.1:${actualPort}`, close: () => server.close() };
}

/**
 * 端口能不能 bind 在 127.0.0.1 上（能就说明没人独占）。
 *
 * ⚠️ 为什么需要这个：CDP 端口原先在各脚本里写死一个（9516/9517/9521/…）。
 *    Windows 上端口被别的进程独占时，Chrome 的 devtools http server 直接
 *    `bind() returned an error: 0x271D (WSAEACCES)`，脚本只会看到
 *    「连不上 Chrome 的调试端口」—— 于是**代码明明是好的，审计整条红**。
 *    2026-10-22 就是这么误判了一次（9516 被占，换 9633 立刻全过）。
 *    审计是用来判断代码的，不该被本机端口状况干扰，所以这里自己挑一个。
 */
function canBind(port) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once("error", () => resolve(false));
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen(port, "127.0.0.1");
    });
}

/**
 * 从首选端口往后找一个能用的（默认最多试 40 个）。
 * @param {number} preferred 各脚本原本写死的端口，作为起点
 */
export async function pickCdpPort(preferred, span = 40) {
    const start = Number.isInteger(preferred) && preferred > 0 ? preferred : 9516;
    for (let p = start; p < start + span && p <= 65535; p++) {
        if (await canBind(p)) return p;
    }
    throw new Error(
        `找不到可用的调试端口：从 ${start} 起试了 ${span} 个全被占用。` +
            `可以关掉占用端口的进程，或用 AUDIT_CDP_PORT 指定别的起点。`
    );
}

/**
 * 起 headless Chrome 并连上 CDP。
 * 返回 { evaluate, done }：done(code) 会收掉浏览器并退出进程。
 *
 * ⚠️ cdpPort 现在只是**起点**：真正用哪个由 pickCdpPort 决定（见上面的说明）。
 */
export async function openBrowser({ cdpPort, windowSize = "1440,950", hideScrollbars = true }) {
    const chrome = findChrome();
    if (!chrome) {
        console.error("没找到 Chrome，可用 CHROME_PATH 指定");
        process.exit(1);
    }
    // 真正用哪个端口由这里决定：传进来那个只是起点（见 pickCdpPort 的说明）
    const listenPort = await pickCdpPort(cdpPort);
    if (listenPort !== cdpPort) {
        console.log(`[audit] 调试端口 ${cdpPort} 被占用，改用 ${listenPort}`);
    }
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-audit-"));
    // ⚠️ 这两条是照抄 ci-smoke 的：CI 容器里多半是 root，没有 --no-sandbox
    // Chrome 根本起不来；/dev/shm 太小会让渲染进程随机崩。
    const proc = spawn(
        chrome,
        [
            "--headless=new",
            `--remote-debugging-port=${listenPort}`,
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            ...(hideScrollbars ? ["--hide-scrollbars"] : ["--disable-features=OverlayScrollbar"]),
            "--no-sandbox",
            "--disable-dev-shm-usage",
            `--window-size=${windowSize}`,
            "about:blank",
        ],
        // stderr 不能丢：Chrome 自己为什么起不来只写在这儿，丢了就只剩一句
        // 「连不上调试端口」，排查时什么都看不到（ci-smoke 2026-10-08 撞过）
        { stdio: ["ignore", "ignore", "pipe"] }
    );
    let chromeErr = "";
    proc.stderr?.on("data", d => {
        chromeErr += d.toString();
    });

    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
        await sleep(300);
        try {
            const list = await (await fetch(`http://127.0.0.1:${listenPort}/json/list`)).json();
            target = list.find(t => t.type === "page");
        } catch {
            // 还没起来
        }
    }
    if (!target) {
        proc.kill();
        throw new Error(
            `连不上 Chrome 的调试端口（${chrome}）\nChrome stderr:\n${chromeErr.slice(-1500)}`
        );
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener("open", r));
    let id = 1;
    const pending = new Map();
    // 页面自己的报错也收下来：页面是坏的（缺数据、抛异常）时量出来的
    // 尺寸与对比度一样能「全绿」，那是假绿 —— 两个审计脚本都拿它当判据。
    const pageErrors = [];
    ws.addEventListener("message", ev => {
        const m = JSON.parse(ev.data);
        if (m.method === "Runtime.exceptionThrown") {
            const d = m.params?.exceptionDetails ?? {};
            pageErrors.push(d.exception?.description || d.text || "unknown exception");
            return;
        }
        if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
            const text = (m.params.args ?? [])
                .map(a => a.value ?? a.description ?? a.type ?? "")
                .join(" ")
                .trim();
            pageErrors.push(text || "console.error");
            return;
        }
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
    });
    const send = (method, params = {}) => {
        const i = id++;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((resolve, reject) => pending.set(i, { resolve, reject }));
    };
    await send("Page.enable");
    await send("Runtime.enable");

    const evaluate = async expression => {
        const r = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
        return r.result.value;
    };

    const done = code => {
        try {
            ws.close();
        } catch {
            // 已经关了
        }
        proc.kill();
        // profile 目录几十 MB，不删的话每跑一次在系统临时目录积一份
        try {
            fs.rmSync(profile, { recursive: true, force: true });
        } catch {
            // Chrome 还锁着文件就算了，系统临时目录自己会清
        }
        process.exit(code);
    };

    return { evaluate, send, done, ws, chromePath: chrome, getErrors: () => pageErrors.slice() };
}

/**
 * 等页面真正渲染完再动手。
 *
 * 固定 sleep 是「点了没反应 / 量到空页面」这类假红的头号来源：骨架态时
 * 按钮还没挂上，量出来全是 0。判据用**全页 button 数**而不是顶栏数 ——
 * 顶栏那几个按钮比整页少一个数量级，很容易误判。
 */
export async function waitRendered(evaluate, { minButtons = 25, timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const n = await evaluate("document.querySelectorAll('button').length");
            if (typeof n === "number" && n >= minButtons) return n;
        } catch {
            // 导航中，下一轮再试
        }
        await sleep(250);
    }
    throw new Error(`页面在 ${timeoutMs}ms 内没渲染出 ${minButtons} 个按钮（骨架态？）`);
}

/**
 * 对比度测量的**核心**（页面内执行的一段代码，注入到扫描脚本里）。
 *
 * 为什么下沉到这里（2026-11-01）：原来这段数学内联在 `contrast-audit.mjs` 的 `SCAN`
 * 里，只能整页扫一遍。要量**单个元素**（悬停态、焦点态）就必须能单独调 —— 复制一份
 * 等于给自己埋「两套数学慢慢漂开」的坑，所以抽成共享字符串，由调用方包进自己的 IIFE：
 *
 *     const SCAN = `(() => { ${CONTRAST_CORE} ... NH.measure(el) ... })()`;
 *
 * 注入后页面里得到一个 `NH` 对象：
 *   - `NH.refresh()`    重扫一遍 opacity / filter 表（**改过样式之后必须调**）
 *   - `NH.measure(el)`  量一个元素；不该参与测量时返回 null
 *   - `NH.ratio(a,b)` / `NH.parse(c)` / `NH.bgBehind(el)` 供特殊场景复用
 *
 * ⚠️ 这段是**模板字符串**：里面绝不能出现裸反引号（注释里也不行），会截断字符串。
 *    守卫在 `tests/scriptSyntax.test.ts`（`node --check` 全量扫 script/*.mjs）。
 */
export const CONTRAST_CORE = `
  const NH = (() => {
    // ⚠️ color-mix() 的背景色（如 --accent-wash = color-mix(主色 10%, transparent)）会被
    //    Chrome 序列化成 color(srgb 0.098 0.4627 0.8235 / 0.1) —— 分量是 **0~1 的浮点**。
    //    照 rgb() 那样当 0~255 解析，等于把一层 10% 的淡蓝当成「接近纯黑」，
    //    合成出来的底色会假性变暗、比值假性变低（实测同一条文字会从 4.04 报成 3.67）。
    const parse = c => {
      const m = c.match(/-?[\\d.]+/g);
      if (!m) return null;
      const nums = m.map(Number);
      const rgb = nums.slice(0, 3);
      const isColorFn = /^color\\(/.test(c.trim());
      return isColorFn && rgb.every(v => v <= 1) ? rgb.map(v => Math.round(v * 255)) : rgb;
    };
    const alphaOf = c => { const m = c.match(/-?[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (fg, bg) => {
      const L1 = lum(fg), L2 = lum(bg);
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    };

    // 往上找背景色，从 startEl（含）开始，遇到第一个「够不透明」的层就停，半透明层依次混进来
    const bgBehind = startEl => {
      let n = startEl, layers = [];
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const p = parse(c);
        if (p && alphaOf(c) > 0) {
          layers.push({ rgb: p, a: alphaOf(c) });
          if (alphaOf(c) >= 0.999) break;
        }
        n = n.parentElement;
      }
      let base = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) {
        const { rgb, a } = layers[i];
        base = base.map((v, k) => rgb[k] * a + v * (1 - a));
      }
      return base;
    };

    // filter: opacity(x) 与 opacity 等效（同样整组淡化、同样建层叠上下文），而且相乘。
    // filter: blur() 不影响 alpha，不在这里管。
    const filterOpacity = f => {
      if (!f || f === 'none') return 1;
      let a = 1;
      for (const m of f.matchAll(/opacity\\(([\\d.]+)(%?)\\)/g)) {
        a *= m[2] ? Number(m[1]) / 100 : Number(m[1]);
      }
      return a;
    };

    // opacity 是**分组**属性：整个元素（含底色与子内容）当一张图混到身后的底上，
    // 所以要沿祖先链累乘。每个元素都查一次 getComputedStyle 会退化成 O(n·depth)：
    // 先扫一遍建表，measure 里只查表。
    let opMap = new Map();
    const refresh = () => {
      opMap = new Map();
      for (const n of document.querySelectorAll('body, body *')) {
        const cs = getComputedStyle(n);
        const o = Number(cs.opacity) * filterOpacity(cs.filter);
        if (o < 0.999) opMap.set(n, o);
      }
    };
    const groupAlpha = el => {
      let a = 1, n = el;
      while (n && n.nodeType === 1) {
        const o = opMap.get(n);
        if (o !== undefined) a *= o;
        if (a <= 0.02) return a;
        n = n.parentElement;
      }
      return a;
    };

    /**
     * 量一个元素。不该参与测量时返回 null。
     * 返回值里的 ratio 已经 toFixed(2) —— **判据和打印用的是同一个数**，
     * 不会出现「打印 4.50、却判不合格」这种没法复现的结论。
     */
    const measure = el => {
      // 只统计直接承载文字的元素
      const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      if (!text) return null;
      const s = getComputedStyle(el);
      // ⚠️ 这里**不再**判 Number(s.opacity) < 0.5（2026-11-01 删）：
      //   opacity 与 filter: opacity() 是等效的同一件事，可老写法只对前者提前放弃、
      //   对后者照算 —— 同样「淡化到 30%」的文字，走 opacity 直接不量、走 filter 量出 1.5:1。
      //   两条路给两个结论，等于判据不同源。现在一律交给下面的 groupAlpha + A<=0.02
      //   （真正看不见才跳过），两种写法结果一致。
      if (s.visibility === 'hidden' || s.display === 'none') return null;
      // 停用的控件豁免：WCAG 1.4.3 明确不要求「inactive UI component」的文字达标。
      // 实测设置中心「清除访问记录」用 MUI 的 text.disabled（rgba(0,0,0,.26)），
      // 压白 1.88:1 —— 规范允许，不是缺陷。不豁免的话全站每颗禁用按钮都是一条红。
      if (el.closest('[disabled], .Mui-disabled, [aria-disabled="true"]')) return null;
      // 整组已经淡到看不见（悬停才出现的工具条恒为 opacity 0、退出后仍留着的浮层）：
      // 看不见的东西没有「对比度」可言。以前只判自己那一个 opacity，这类元素被当成
      // 完全不透明量过 —— 绿得没有意义。
      const A = groupAlpha(el);
      if (A <= 0.02) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const fgRaw = parse(s.color);
      if (!fgRaw) return null;

      // ---- 背景分两层：自己画出的那层、身后的那层 ----
      // 元素带 opacity 时「自己画的底」也被一起淡化；只算最终底色会把这个效果算丢
      // （文字和底色一起变淡、彼此对比度反而掉下来，正是最容易漏的那类）。
      const ownC = s.backgroundColor;
      const ownRgb = parse(ownC);
      const ownA = ownRgb ? alphaOf(ownC) : 0;
      const behind = bgBehind(el.parentElement);
      const bgPainted =
        !ownRgb || ownA <= 0 ? behind : ownRgb.map((v, k) => v * ownA + behind[k] * (1 - ownA));

      // 前景色自身也可能带 alpha（text.disabled 就是 rgba(0,0,0,.38)）：
      // 只取 RGB 等于当纯黑，实测 2.66:1 会被报成 19.89:1。
      const fgA = alphaOf(s.color);
      const fgPainted =
        fgA >= 0.999 ? fgRaw : fgRaw.map((v, k) => v * fgA + bgPainted[k] * (1 - fgA));

      // 最后把「整组」按 opacity 混到身后的底上：文字和底色一起淡。A≈1 是恒等变换。
      const mixDown = c => (A >= 0.999 ? c : c.map((v, k) => v * A + behind[k] * (1 - A)));
      const fg = mixDown(fgPainted);
      const bg = mixDown(bgPainted);

      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      return {
        cls: el.className.toString().slice(0, 46),
        text: text.slice(0, 18),
        color: s.color,
        fontSize: size,
        bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
        ratio: +ratio(fg, bg).toFixed(2),
        need: large ? 3 : 4.5,
        // 只有真的被淡化时才打出这个字段：其余行的输出保持不变
        ...(A < 0.999 ? { opacity: +A.toFixed(2) } : {}),
      };
    };

    return { refresh, measure, ratio, parse, alphaOf, bgBehind };
  })();
`;

// ---------------- 可访问名（accessible name）判据 ----------------
//
// 为什么要有这一节（2026-11-04，R16）：`a11y-audit.mjs` 原来的判据是
//
//     const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title')
//                           || el.textContent || '').trim();
//
// 三处都不合规范，而且**两个方向都错**：
//   ① 完全不认 `aria-labelledby` —— 用委托标签（弹窗 / 表单最常用的写法）
//      命名的控件一律被判「无名」，那是假红；
//   ② `title` 排在文本内容**前面**，而规范里 name-from-content 高于 title ——
//      一个既有文案又有 title 的按钮，读屏念出来的和我量的不是同一个；
//   ③ `<img alt="">` 是**合法**的装饰图写法（WCAG 明确允许），旧判据
//      `!getAttribute('alt')` 把 `alt=""` 和「压根没写 alt」混成一件事，判成违规。
//
// 修法：把「可访问名」做成**一份实现**，由 `A11Y_NAME_CORE` 注入页面使用；
// 单测（`tests/a11yNamedRules.dom.test.tsx`）直接把同一份源码放进 jsdom 里跑。
// 判据只有一份 —— 页面里一份、测试里一份的写法，早晚会漂成两个结论。
//
// 判据顺序（对齐 accname / HTML-AAM 的常用部分）：
//   ① `aria-labelledby`：**递归**解析（引用目标自己也有 labelledby 就继续往下），
//      多个 id 用空格连接，跳过 `aria-hidden="true"` / `display:none` 的引用目标，
//      带环检测（a → b → a 不会无限递归）；引用目标不存在就跳过那一条。
//   ② `aria-label`
//   ③ 原生：button / a / 任意元素取**文本内容**（img 子节点取它的 alt）；
//      input / select / textarea 取 `label[for]` / `closest('label')` /
//      按钮型 input 的 value / placeholder；img 取 alt。
//   ④ `title`（最后兜底 —— 规范里它排在内容之后）
//
// 另外两件必须做对的事：
//   · 元素若处在 `aria-hidden="true"`（或 display:none / hidden 属性）的子树里，
//     它**不在可访问树上**，根本不参与「有没有名字」的统计 —— 但必须返回**明确的
//     标记**而不是空串：空串在调用方眼里和「没名字」长得一模一样，混用必然出错。
//     所以这里用 `exclusionReason(el)` 返回原因、`isUnnamed(el)` 对排除项返回 false。
//   · img 的判据换成 `!img.hasAttribute('alt')`（区分「没写 alt」与「写了 alt=""」），
//     唯一例外是**实际可交互**的图（`role="button"`、在 button/a 里、`tabindex>=0`）：
//     那种图的 `alt=""` 等于让读屏念出一个没有名字的按钮，仍算无名。

/**
 * 可访问名核心（工厂）。
 *
 * ⚠️ 这个函数会被 `toString()` 序列化后注入页面执行，所以：
 *   · **不许**引用模块作用域里的任何东西（闭包在页面里不存在，会 ReferenceError）；
 *   · **不许**在函数体里用模板字符串（源码里出现反引号会把外层模板字符串截断，
 *     这个坑 `contrast-audit.mjs` 已经踩过三次）；
 *   · 只用 DOM 标准 API（`getComputedStyle` / `closest` / `getElementById`），
 *     这样同一份源码在 `jsdom` 里也跑得动，单测测的就是页面里跑的那份。
 *
 * @returns {{accessibleName: Function, nameFromLabelledBy: Function, contentName: Function,
 *            exclusionReason: Function, isExcluded: Function, isUnnamed: Function,
 *            imgFails: Function, isInteractive: Function}}
 */
export function accessibleNameCore() {
    /** 祖先链深度上限：正常 DOM 十几层，64 是「绝不可能是真实结构」的兜底 */
    const MAX_DEPTH = 64;
    /** labelledby 递归链的长度上限（环检测之外的第二道闸） */
    const MAX_REFS = 32;

    /** 归一化：把各类空白压成一个空格并去首尾（读屏念的也是这样） */
    const norm = value => String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();

    /** `aria-hidden` 只认字符串 "true"（大小写 / 空格都容忍） */
    const ariaHidden = el => {
        if (!el || typeof el.getAttribute !== "function") return false;
        const raw = el.getAttribute("aria-hidden");
        return raw !== null && String(raw).trim().toLowerCase() === "true";
    };

    /** 排除原因的缓存：一次扫描里同一个元素只算一遍 */
    const exclCache = new WeakMap();

    /**
     * 元素为什么不在可访问树上；在树上则返回 null。
     *
     * 口径（刻意区分「自己」与「祖先」）：
     *   · 自己：`display:none` / `visibility:hidden|collapse` 直接判掉；
     *   · 自己 + 祖先：`aria-hidden="true"`、`hidden` 属性、祖先的 `display:none`。
     *   · **不**查祖先的 `visibility`：`visibility` 是继承的，元素自己的计算值已经
     *     包含继承结果；再查祖先会误伤「祖先 visibility:hidden、子元素显式 visible」
     *     这种合法写法。
     */
    const exclusionReason = el => {
        if (!el || el.nodeType !== 1) return null;
        if (exclCache.has(el)) return exclCache.get(el);
        let reason = null;
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < MAX_DEPTH) {
            if (ariaHidden(node)) {
                reason = "aria-hidden";
                break;
            }
            if (typeof node.hasAttribute === "function" && node.hasAttribute("hidden")) {
                reason = "hidden-attr";
                break;
            }
            const cs = getComputedStyle(node);
            if (cs.display === "none") {
                reason = "display-none";
                break;
            }
            if (node === el && (cs.visibility === "hidden" || cs.visibility === "collapse")) {
                reason = "visibility-hidden";
                break;
            }
            node = node.parentElement;
            depth++;
        }
        exclCache.set(el, reason);
        return reason;
    };

    const isExcluded = el => exclusionReason(el) !== null;

    /**
     * 名字来自内容（name from content）：文本节点直接取，元素递归。
     *
     * img / area 取 alt（没有 alt 时退到它的 aria-label）—— 按规范，图片的
     * 「文本替代」就是 alt，不去念它内部的（也不会有）子文本。
     * `aria-hidden` 的子树**不贡献**名字：那是装饰。
     */
    const contentName = el => {
        if (!el || el.nodeType !== 1) return "";
        const parts = [];
        const children = el.childNodes || [];
        for (let i = 0; i < children.length; i++) {
            const node = children[i];
            if (node.nodeType === 3) {
                parts.push(node.textContent || "");
                continue;
            }
            if (node.nodeType !== 1) continue;
            if (isExcluded(node)) continue;
            const tag = node.tagName ? node.tagName.toLowerCase() : "";
            if (tag === "img" || tag === "area") {
                const alt = norm(node.getAttribute("alt"));
                parts.push(alt || norm(node.getAttribute("aria-label")));
                continue;
            }
            const own = norm(node.getAttribute("aria-label"));
            if (own) {
                parts.push(own);
                continue;
            }
            parts.push(contentName(node));
        }
        return norm(parts.join(" "));
    };

    /** 按钮型 input（submit / reset / button / image）的文本替代 */
    const inputValueName = el => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "submit" || type === "reset" || type === "button") {
            const value = norm(el.getAttribute("value"));
            if (value) return value;
            // 没写 value 的 submit / reset 有浏览器默认文案，这里按规范补上
            if (type === "submit") return "提交";
            if (type === "reset") return "重置";
            return "";
        }
        if (type === "image") return norm(el.getAttribute("alt"));
        return "";
    };

    /** 表单控件的原生名字：label[for] → 祖先 label → value（按钮型）→ placeholder */
    const nativeFieldName = el => {
        const doc = el.ownerDocument || document;
        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        const id = el.getAttribute("id");
        if (id) {
            // 刻意不拼选择器（id 里可能有引号 / 冒号）：遍历比对属性最稳
            const labels = doc.querySelectorAll("label[for]");
            for (let i = 0; i < labels.length; i++) {
                if (labels[i].getAttribute("for") !== id) continue;
                const text = contentName(labels[i]);
                if (text) return text;
            }
        }
        const wrapper = typeof el.closest === "function" ? el.closest("label") : null;
        if (wrapper) {
            // 包住控件的 label，其内容里常混着控件自己的值（select 的选项文本），
            // 这里只取文字节点 + 非控件元素，避免把选项清单当成名字读一遍
            const text = norm(
                Array.prototype.filter
                    .call(wrapper.childNodes, node => {
                        if (node.nodeType === 3) return true;
                        if (node.nodeType !== 1) return false;
                        const t = node.tagName ? node.tagName.toLowerCase() : "";
                        return t !== "input" && t !== "select" && t !== "textarea";
                    })
                    .map(node => (node.nodeType === 3 ? node.textContent || "" : contentName(node)))
                    .join(" ")
            );
            if (text) return text;
        }
        if (tag === "input") {
            const byValue = inputValueName(el);
            if (byValue) return byValue;
        }
        const placeholder = norm(el.getAttribute("placeholder"));
        if (placeholder) return placeholder;
        return "";
    };

    /**
     * `aria-labelledby` 解析（递归 + 环检测）。
     *
     * @param el 取名字的元素
     * @param seen 已经走过的 id 集合（环检测；undefined 表示新建）
     */
    const nameFromLabelledBy = (el, seen) => {
        if (!el || el.nodeType !== 1) return "";
        const raw = norm(el.getAttribute("aria-labelledby"));
        if (!raw) return "";
        const doc = el.ownerDocument || document;
        const visited = seen || new Set();
        const ids = raw.split(/\s+/).filter(Boolean);
        const parts = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (visited.has(id)) continue;
            visited.add(id);
            if (visited.size > MAX_REFS) break;
            const ref = doc.getElementById(id);
            if (!ref) continue;
            // 引用目标不可见（aria-hidden / display:none）→ 名字里不出现（规范如此）
            if (isExcluded(ref)) continue;
            const name = refName(ref, visited);
            if (name) parts.push(name);
        }
        return norm(parts.join(" "));
    };

    /** 引用目标自己的名字：它可能又有 labelledby / aria-label / 是表单控件 / 是图 */
    const refName = (ref, visited) => {
        const byLabel = nameFromLabelledBy(ref, visited);
        if (byLabel) return byLabel;
        const own = norm(ref.getAttribute("aria-label"));
        if (own) return own;
        const tag = ref.tagName ? ref.tagName.toLowerCase() : "";
        if (tag === "img" || tag === "area") return norm(ref.getAttribute("alt"));
        if (tag === "input" || tag === "select" || tag === "textarea") return nativeFieldName(ref);
        return contentName(ref);
    };

    /**
     * 取可访问名。
     *
     * @param el 目标元素
     * @param opts `{ content?: boolean, title?: boolean }`
     *   · `content:false`：**不许**用「文本内容」当名字。`role="dialog"` 这类
     *     角色按 ARIA 规范必须有作者提供的名字（aria-label / aria-labelledby），
     *     拿正文文字当名字会让「弹窗没有可访问名」这条判据静默失效。
     *   · `title:false`：连 title 也不认。
     * @returns {string} 名字（可能是空串）；元素被排除在可访问树外时返回 `null`
     */
    const accessibleName = (el, opts) => {
        if (!el || el.nodeType !== 1) return "";
        // ⚠️ 排除项返回 **null**（明确标记），不是空串 —— 空串和「没名字」无法区分
        if (isExcluded(el)) return null;
        const options = opts || {};
        const allowContent = options.content !== false;
        const allowTitle = options.title !== false;

        const byLabel = nameFromLabelledBy(el, null);
        if (byLabel) return byLabel;

        const label = norm(el.getAttribute("aria-label"));
        if (label) return label;

        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        let native = "";
        if (tag === "img" || tag === "area") native = norm(el.getAttribute("alt"));
        else if (tag === "input" || tag === "select" || tag === "textarea") native = nativeFieldName(el);
        else if (allowContent) native = contentName(el);
        if (native) return native;

        return allowTitle ? norm(el.getAttribute("title")) : "";
    };

    /**
     * 这个元素算不算「无名」。
     *
     * 不在可访问树上的元素返回 **false**（不参与统计）—— 这是 R16 的核心修正：
     * 装饰用的 `aria-hidden` 子树里那些没有名字的图标按钮，旧判据全算成违规。
     */
    const isUnnamed = el => {
        if (isExcluded(el)) return false;
        return accessibleName(el) === "";
    };

    /** 元素是否实际可交互（决定 `alt=""` 的图算不算「无名按钮」） */
    const isInteractive = el => {
        if (!el || el.nodeType !== 1) return false;
        const role = (el.getAttribute("role") || "").trim().toLowerCase();
        if (role === "button" || role === "link" || role === "checkbox" || role === "switch" || role === "tab") {
            return true;
        }
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) >= 0) return true;
        if (typeof el.closest !== "function") return false;
        return !!el.closest('button, a[href], [role="button"], [role="link"]');
    };

    /**
     * img 是否违规（缺文本替代）。
     *
     * 判据：`!hasAttribute('alt')` —— 「没写 alt」与「写了 alt=""」是两件事，
     * 后者是**合法**的装饰图（WCAG 1.1.1 / H67），旧判据把两者混为一谈。
     * 例外：实际可交互的图 `alt=""` 仍算无名（读屏会念出一个没有名字的按钮），
     * 除非它另外有 aria-label / aria-labelledby / title 撑住。
     */
    const imgFails = img => {
        if (!img || img.nodeType !== 1) return false;
        if (isExcluded(img)) return false;
        if (typeof img.hasAttribute !== "function") return false;
        if (!img.hasAttribute("alt")) return true;
        if (norm(img.getAttribute("alt")) !== "") return false;
        if (!isInteractive(img)) return false;
        return accessibleName(img) === "";
    };

    return {
        accessibleName,
        nameFromLabelledBy: el => nameFromLabelledBy(el, null),
        contentName,
        exclusionReason,
        isExcluded,
        isUnnamed,
        imgFails,
        isInteractive,
    };
}

/**
 * 注入页面用的源码：`const NHNAME = (…工厂…)();`
 *
 * 用 `toString()` 从上面那一个函数生成，而不是再手写一份字符串 —— 两份实现是
 * 「判据静默漂开」的唯一成因。用字符串拼接而不是模板字符串：工厂的源码里
 * 一旦出现反引号，模板字符串会被当场截断（`contrast-audit.mjs` 踩过三次）。
 */
export const A11Y_NAME_CORE = "const NHNAME = (" + accessibleNameCore.toString() + ")();";
