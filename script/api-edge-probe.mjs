// script/api-edge-probe.mjs
// 接口边界探针：往自托管服务打一批**畸形 / 超限 / 异常输入**，只找 5xx。
//
// 为什么值得单独一条：5xx 是「服务端自己崩了」，和 4xx（正确地拒绝）性质完全不同 ——
// 500 会触发告警、客户端会当故障重试、日志里还占一个堆栈。而这类崩溃几乎都来自
// 同一个形状：`const data = await request.json(); data.title` —— 请求体是 `null` 时
// `null.title` 抛 TypeError，一路冒泡到入口就成了 500。
//
// 首次落地（2026-10-23）实测命中 9 处 500（POST /api/notes、/api/login、/api/groups、
// /api/sites、/api/notes/folders、/api/notes/tags、PUT /api/notes/:id、PUT /api/configs），
// 外加「传字符串 / 数字时静默建出一条全空笔记」。修法是请求体统一走
// worker/routes/jsonBody.ts 的 readJsonBody / readJsonArray，入口就拒绝非对象。
//
// 跑在自托管 server/ 上而不是 workerd：Windows 本地 workerd 起不来（access violation），
// 而 server/ 打包的就是同一套 worker 路由，测的是同一份逻辑。
//
// 用法：npm run probe:edge（自己起服务、自己收，需要 dist-server/）

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 8821 + (process.pid % 100); // 并发跑批时避让
const BASE = `http://127.0.0.1:${PORT}`;

let cookie = "";
const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 160) };
};

async function waitForServer(deadlineMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const r = await fetch(`${BASE}/api/init`);
            if (r.ok) return;
        } catch {
            /* 还没起来 */
        }
        await new Promise(s => setTimeout(s, 300));
    }
    throw new Error("自托管服务 20 秒内没起来");
}

const scratch = mkdtempSync(join(tmpdir(), "navihive-edge-probe-"));
const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "dist-server/entry.mjs"],
    {
        cwd: here,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            NAVIHIVE_PORT: String(PORT),
            NAVIHIVE_HOST: "127.0.0.1",
            NAVIHIVE_DB: join(scratch, "navihive.db"),
            NAVIHIVE_FILES: join(scratch, "files"),
            NAVIHIVE_CRON: "0",
            AUTH_ENABLED: "true",
            AUTH_USERNAME: "root",
            AUTH_PASSWORD: "seed-password",
            AUTH_SECRET: "edge-probe-secret",
        },
    }
);
child.stdout.on("data", () => { /* 静默，结论靠下面的断言 */ });
child.stderr.on("data", d => process.stderr.write(d));

const shutdown = () => {
    try {
        child.kill();
    } catch {
        /* 已经退了 */
    }
    rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", shutdown);
process.on("SIGINT", () => {
    shutdown();
    process.exit(1);
});

// 10 万字符：远超任何字段的长度上限，用来试探「超长输入会不会把服务端搞崩」
const LONG = "x".repeat(100_000);

/** [方法, 路径, 请求体] —— 期望是 4xx（正确地拒绝）或 2xx，**绝不能是 5xx** */
const cases = [
    ["GET", "/api/notes?fields=list&limit=-1", undefined],
    ["GET", "/api/notes?fields=list&limit=99999999", undefined],
    ["GET", "/api/notes?fields=list&limit=abc", undefined],
    ["GET", "/api/notes/-1", undefined],
    ["GET", "/api/notes/NaN", undefined],
    ["GET", "/api/notes/1e999", undefined],
    ["GET", "/api/notes/99999999999999999999", undefined],
    ["GET", "/api/notes/%20", undefined],
    ["GET", "/api/notes/..", undefined],
    ["GET", "/api/notes/folders/../../etc", undefined],
    ["POST", "/api/notes/search", { query: LONG, limit: 10 }],
    ["POST", "/api/notes/search", { query: "", limit: -5 }],
    ["POST", "/api/notes/search", { query: null, limit: "x" }],
    ["POST", "/api/notes/search", null],
    ["POST", "/api/notes", { title: LONG, content: "a" }],
    ["POST", "/api/notes", { title: "边界", content: LONG }],
    ["POST", "/api/notes", { title: " 控制字符", content: "" }],
    ["POST", "/api/notes", { title: "emoji \u{1F600}\u{1F1FA}\u{1F1F8}", content: "" }],
    ["POST", "/api/notes", { title: 12345, content: {} }],
    ["POST", "/api/notes", "不是对象"],
    ["POST", "/api/notes", null],
    ["POST", "/api/groups", { name: LONG, order_num: 0 }],
    ["POST", "/api/groups", { name: "", order_num: 0 }],
    ["POST", "/api/groups", { name: "分组", order_num: "abc" }],
    ["POST", "/api/groups", { name: "分组", order_num: 1e999 }],
    ["POST", "/api/groups", null],
    ["POST", "/api/groups", "字符串"],
    ["POST", "/api/groups", 12345],
    ["POST", "/api/groups", [1, 2]],
    ["POST", "/api/sites", { group_id: 999999, name: "孤立", url: "https://e.com" }],
    ["POST", "/api/sites", { group_id: 1, name: "坏 URL", url: "javascript:alert(1)" }],
    ["POST", "/api/sites", { group_id: 1, name: "坏 URL2", url: "not-a-url" }],
    ["POST", "/api/sites", { group_id: 1, name: "坏 URL3", url: "" }],
    ["POST", "/api/sites", null],
    ["POST", "/api/notes/tags", { name: LONG }],
    ["POST", "/api/notes/tags", null],
    ["POST", "/api/notes/folders", { name: LONG, order_num: 0 }],
    ["POST", "/api/notes/folders", null],
    ["PUT", "/api/notes/1", { content: "x", rev: -1 }],
    ["PUT", "/api/notes/1", { content: "x", rev: 99999999 }],
    ["PUT", "/api/notes/1", { rev: "abc" }],
    ["PUT", "/api/notes/1", null],
    ["PUT", "/api/notes/1/tags", null],
    ["PUT", "/api/notes/folders/1", { name: LONG }],
    ["PUT", "/api/configs/x", { value: LONG }],
    ["PUT", "/api/configs/x", { value: null }],
    ["PUT", "/api/configs/x", null],
    ["POST", "/api/notes/import", { data: "not-json" }],
    ["POST", "/api/notes/import", { data: "{}" }],
    ["POST", "/api/notes/import", null],
    ["PUT", "/api/note-orders", { orders: "not-an-array" }],
    ["PUT", "/api/note-orders", { orders: [{ id: "x", order_num: 1 }] }],
    ["PUT", "/api/note-orders", null],
    // 反向：这个接口**两种形状都认**，探针也得钉住「有效的形状不能被挡掉」——
    // 只验「坏的被拒」会漏掉「好的也被拒」那一类回归（改错过一次）。
    ["PUT", "/api/note-orders", [{ id: 1, order_num: 0 }]],
    ["PUT", "/api/note-orders", { orders: [{ id: 1, order_num: 0 }] }],
    ["PUT", "/api/group-orders", null],
    ["PUT", "/api/site-orders", null],
    ["GET", "/api/notes/attachments/..%2F..%2Fetc%2Fpasswd", undefined],
    // 登录在鉴权链之外，单独一条：`null` 体曾让 validateLogin 去读 .username 抛 500
    ["POST", "/api/login", null],
];

let bad = 0;
try {
    await waitForServer();
    console.log(`# 接口边界探针（自托管通道 ${BASE}）`);

    const init = await api("GET", "/api/init");
    if (init.status !== 200) {
        console.error(`服务没起来：${init.status}`);
        process.exit(2);
    }
    // 写接口要登录才有意义（未登录时它们统一 401，量不出边界行为）
    for (const pw of ["seed-password", "edge-probe-pw-2026"]) {
        const r = await api("POST", "/api/login", { username: "root", password: pw });
        if (r.status === 200 && !JSON.parse(r.text || "{}").mustChangePassword) break;
        await api("PUT", "/api/auth/credentials", {
            username: "root",
            currentPassword: pw,
            password: "edge-probe-pw-2026",
        });
    }

    for (const [m, p, b] of cases) {
        let r;
        try {
            r = await api(m, p, b);
        } catch (e) {
            console.log(`ERR  ${m} ${p.slice(0, 70)}  ${e?.message}`);
            bad++;
            continue;
        }
        const flag = r.status >= 500 ? "5xx " : r.status >= 400 ? "4xx " : "2xx ";
        if (r.status >= 500) bad++;
        console.log(
            `${flag} ${m} ${p.slice(0, 70)}  ${r.status}  ${r.text.replace(/\s+/g, " ").slice(0, 90)}`
        );
    }
} finally {
    shutdown();
}

console.log(`\n5xx / 连接错误：${bad} 条（共 ${cases.length} 项）`);
process.exit(bad ? 1 : 0);
