// 可移植的冒烟测试：只依赖 Node 标准库 + 本机已装的 Chrome，不装 puppeteer / playwright。
//
// 和本机那套 harness/*.mjs 的分工：
// - harness 里的 ui-smoke.mjs 是「全量」的（两百多条断言），但它绑在这台机器的目录结构上；
// - 这个脚本是给 CI 用的「最小可移植版」，只挑几条最要命的：页面能不能渲染、
//   地标在不在、安全头有没有真的下发、卡片浮层显隐对不对、键盘焦点环有没有丢。
// 一旦它挂了，说明是结构性回归，值得拦下 PR。
//
// 用法：node script/ci-smoke.mjs
//   CHROME_PATH=/usr/bin/google-chrome 指定浏览器
//   需要先 `npm run build`（要读 dist/client）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist", "client");
const PORT = Number(process.env.SMOKE_PORT || 5310);
const CDP_PORT = Number(process.env.CDP_PORT || 9515);

if (!fs.existsSync(DIST)) {
    console.error(`找不到 ${DIST}，先跑 npm run build`);
    process.exit(1);
}

// ---------------- 找 Chrome ----------------
function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const candidates =
        process.platform === "win32"
            ? [
                  "C:/Program Files/Google/Chrome/Application/chrome.exe",
                  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
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
    for (const c of candidates) if (fs.existsSync(c)) return c;
    // 最后试一下 PATH
    for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
        const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
            encoding: "utf8",
        });
        if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split("\n")[0];
    }
    return null;
}

const CHROME = findChrome();
if (!CHROME) {
    console.error("没找到 Chrome，可用 CHROME_PATH 指定");
    process.exit(1);
}
console.log(`Chrome: ${CHROME}`);

// ---------------- 静态服务 + API 打桩 ----------------
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

// 把 public/_headers 原样下发：CSP 写错了只有在真的下发之后才测得出来
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

const GROUPS = [
    { id: 1, name: "常用工具", order_num: 0 },
    { id: 2, name: "开发", order_num: 1 },
];
const SITES = [
    {
        id: 11,
        group_id: 1,
        name: "示例一",
        url: "https://example.com/",
        icon: "",
        description: "示例站点一",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
    },
    {
        id: 12,
        group_id: 1,
        name: "示例二",
        url: "https://example.org/",
        icon: "",
        description: "示例站点二",
        notes: "",
        username: "",
        password: "",
        order_num: 1,
    },
    {
        id: 13,
        group_id: 2,
        name: "示例三",
        url: "https://example.net/",
        icon: "",
        description: "示例站点三",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
    },
];

const server = http.createServer((req, res) => {
    const p = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;

    if (p.startsWith("/api/")) {
        res.setHeader("Content-Type", MIME[".json"]);
        if (p === "/api/bootstrap") {
            res.end(JSON.stringify({ groups: GROUPS, sites: SITES, configs: {} }));
            return;
        }
        if (p === "/api/login") {
            res.end(JSON.stringify({ success: true, token: "ci-token" }));
            return;
        }
        if (p === "/api/icon") {
            res.setHeader("Content-Type", "image/png");
            res.end(
                Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
                    "base64"
                )
            );
            return;
        }
        res.end(JSON.stringify({ success: true }));
        return;
    }

    let file = path.join(DIST, p === "/" ? "index.html" : decodeURIComponent(p));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, "index.html");
    }
    for (const [k, v] of Object.entries(headersFor(p))) res.setHeader(k, v);
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
});

await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));
console.log(`静态服务: http://127.0.0.1:${PORT}`);

// ---------------- 起 Chrome，连 CDP ----------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ci-smoke-"));
const chrome = spawn(
    CHROME,
    [
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        // CI 容器里多半是 root，不加这条 Chrome 起不来
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1440,950",
        "about:blank",
    ],
    { stdio: "ignore" }
);

let ws;
let msgId = 1;
const pending = new Map();
const send = (method, params = {}) => {
    const id = msgId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const cleanup = () => {
    try {
        ws && ws.close();
    } catch {}
    try {
        chrome.kill();
    } catch {}
    try {
        server.close();
    } catch {}
    try {
        fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
};

let fails = 0;
const check = (name, ok, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
    if (!ok) fails++;
};

let target = null;
for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find(t => t.type === "page");
    } catch {}
}
if (!target) {
    console.error("连不上 Chrome 的调试端口");
    cleanup();
    process.exit(1);
}

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener("open", resolve));
ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
});

const consoleErrors = [];
await send("Runtime.enable");
await send("Page.enable");
// 收集页面里的 error 级日志（CSP 拦截、资源 404 都会在这里冒出来）
ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
    }
});

const evaluate = async expr => {
    const r = await send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
};

// 登录态是存在 localStorage 里的令牌：先在文档创建前塞进去，
// 否则首屏会渲染登录页，下面所有关于卡片的断言都不成立
await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem('auth_token', 'ci-token'); } catch (e) {}`,
});

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?t=${Date.now()}` });
await sleep(3000);

// ---------------- 断言 ----------------
// 1) 渲染
const rendered = await evaluate(`(() => ({
  cards: document.querySelectorAll('.nav-card-in').length,
  groups: document.querySelectorAll('.nav-group, .nav-card-in').length > 0,
  title: document.title,
}))()`);
check("页面渲染出卡片", rendered.cards >= 3, `${rendered.cards} 张`);
check("标题不是 Vite 默认值", rendered.title.includes("Navihive"), rendered.title);

// 2) 地标与跳转链接（读屏 / 键盘用户能不能定位到页面结构）
const landmarks = await evaluate(`(() => ({
  main: document.querySelectorAll('main').length,
  nav: document.querySelectorAll('nav').length,
  header: document.querySelectorAll('header').length,
  skip: document.querySelectorAll('.nav-skip-link').length,
  mainId: !!document.querySelector('main#main-content'),
}))()`);
check("有 main 地标且带 id", landmarks.main === 1 && landmarks.mainId, JSON.stringify(landmarks));
check("有 header / nav 地标", landmarks.header >= 1 && landmarks.nav >= 1, JSON.stringify(landmarks));
check("有跳过导航的跳转链接", landmarks.skip === 1);

// 3) 安全响应头真的下发了
const headers = await evaluate(`fetch('/').then(r => ({
  csp: r.headers.get('content-security-policy') || '',
  nosniff: r.headers.get('x-content-type-options') || '',
  frame: r.headers.get('x-frame-options') || '',
  referrer: r.headers.get('referrer-policy') || '',
}))`);
check("下发了 CSP", headers.csp.includes("default-src"), headers.csp.slice(0, 48) + "…");
check("下发了 nosniff", headers.nosniff === "nosniff");
check("下发了 frame-ancestors / X-Frame-Options", headers.frame === "DENY");
check("下发了 Referrer-Policy", !!headers.referrer);

// 4) 卡片浮层显隐：悬停才出现，鼠标移开必须收回
const cardBox = await evaluate(`(() => {
  const c = document.querySelector('.nav-card-in');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
const overlay = () =>
    evaluate(`(() => {
      const c = document.querySelector('.nav-card-in');
      if (!c) return null;
      const g = s => { const el = c.querySelector(s); return el ? +getComputedStyle(el).opacity : null; };
      return { bar: g('.nav-card-actions'), settings: g('.nav-settings-btn') };
    })()`);

const overlayBefore = await overlay();
check("鼠标不在卡片上时浮层是隐形的", overlayBefore?.bar === 0, JSON.stringify(overlayBefore));
if (cardBox) {
    await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: cardBox.x,
        y: cardBox.y,
        buttons: 0,
    });
    await sleep(500);
    check("悬停卡片后浮层出现", (await overlay()).bar === 1);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
    await sleep(500);
    check("鼠标移开后浮层收回", (await overlay()).bar === 0);
}

// 5) 键盘焦点环：真的按 Tab，不用 el.focus()（后者在 headless 里不触发 :focus-visible）
let sawSearchRing = false;
let focusRingLost = "";
for (let i = 0; i < 12; i++) {
    for (const type of ["rawKeyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
            type,
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
        });
    }
    await sleep(60);
    const ring = await evaluate(`(() => {
      const a = document.activeElement;
      if (!a) return null;
      const target = a.closest('.MuiInputBase-root') || a;
      const cs = getComputedStyle(target);
      return {
        tag: a.tagName,
        label: a.getAttribute('aria-label') || a.getAttribute('placeholder') || '',
        outline: cs.outlineStyle === 'none' ? 'none' : cs.outlineWidth,
        boxShadow: cs.boxShadow === 'none' ? 'none' : 'yes',
      };
    })()`);
    if (!ring) continue;
    if (String(ring.label).includes("搜索")) {
        sawSearchRing = true;
        if (ring.outline === "none" && ring.boxShadow === "none") {
            focusRingLost = "搜索框";
        }
    }
}
check("Tab 到搜索框时有焦点环", sawSearchRing && !focusRingLost, focusRingLost || "");

// 6) 控制台不能有 error（CSP 拦资源、图标 404 都会在这里现形）
const realErrors = consoleErrors.filter(
    e => !e.includes("favicon") && !e.includes("Failed to load resource: net::ERR")
);
check("页面无控制台 error", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\n${fails === 0 ? "全部通过" : fails + " 条失败"}`);
cleanup();
process.exit(fails === 0 ? 0 : 1);
