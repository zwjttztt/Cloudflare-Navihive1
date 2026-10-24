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

            res.end(JSON.stringify({ success: true }));
            return;
        }

        let filePath = path.join(DIST, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
        if (!filePath.startsWith(DIST) || !fs.existsSync(filePath)) {
            filePath = path.join(DIST, "index.html"); // SPA 兜底
        }
        res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
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
