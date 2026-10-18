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
 * 起 headless Chrome 并连上 CDP。
 * 返回 { evaluate, done }：done(code) 会收掉浏览器并退出进程。
 */
export async function openBrowser({ cdpPort, windowSize = "1440,950" }) {
    const chrome = findChrome();
    if (!chrome) {
        console.error("没找到 Chrome，可用 CHROME_PATH 指定");
        process.exit(1);
    }
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-audit-"));
    // ⚠️ 这两条是照抄 ci-smoke 的：CI 容器里多半是 root，没有 --no-sandbox
    // Chrome 根本起不来；/dev/shm 太小会让渲染进程随机崩。
    const proc = spawn(
        chrome,
        [
            "--headless=new",
            `--remote-debugging-port=${cdpPort}`,
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--hide-scrollbars",
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
            const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
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
