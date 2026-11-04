// script/api-edge-probe.mjs
// 接口边界探针：往自托管服务打一批**畸形 / 超限 / 异常输入**，逐条核对状态码是否符合**声明的期望**。
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
// ---------------------------------------------------------------------------
// 判据（重做）：从「只找 5xx」改成「逐条核对声明过的期望」
// ---------------------------------------------------------------------------
// 旧版唯一判据是 `status >= 500` 才算坏 —— 于是 **401 / 404 全算「好」**：
// 登录没成功（写接口全 401）照样全绿，路由写错成 404 也全绿，`note-orders`
// 两条本该 2xx 的有效请求被挡成 400 还是全绿。绿不绿和能力对不对无关。
//
// 现在：case 表（script/api-edge-probe-cases.mjs）里每条都带 `expect: number[]`，
//   · `>= 500` **永远判失败**（旧判据保留，它抓的是一类独立的故障）；
//   · 其余状态必须在 `expect` 里；
//   · 故意探「未鉴权 / 不存在」的 case 显式写 `[401]` / `[404]`，不靠默认值蒙。
//
// 另外补了两道前置闸：
//   1. **登录前置**：必须真的拿到会话（Set-Cookie 里的 token 或响应里的 token/session
//      字段），并且一个受保护接口回 200。拿不到就以**独立退出码 2** 中止 ——
//      「未登录态把 61 条 case 全跑一遍、全是 401、然后报绿」是最没意义的一种绿。
//   2. **响应体留全**：以前截到 160 字符，失败时看不到原因；现在正常行留 800 字符，
//      失败时把（整理过的）全文打出来。
//
// 跑在自托管 server/ 上而不是 workerd：Windows 本地 workerd 起不来（access violation），
// 而 server/ 打包的就是同一套 worker 路由，测的是同一份逻辑。
//
// 用法：npm run probe:edge（自己起服务、自己收，需要 dist-server/）
// 退出码：0 = 全部符合期望；1 = 有 case 不符合；2 = 登录没成功（后续 case 无意义）

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_NONE, BODY_PREVIEW_CHARS, buildCases } from "./api-edge-probe-cases.mjs";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 8821 + (process.pid % 100); // 并发跑批时避让
const BASE = `http://127.0.0.1:${PORT}`;

/** 登录没成功时的独立退出码：与「有 case 不符合期望」区分开，两者要修的东西完全不同 */
const EXIT_NO_SESSION = 2;

/**
 * 失败时打印响应体的上限。
 *
 * 为什么不是「无条件全文」：好几条 case 故意发 10 万字符，服务端会把它们原样回显在
 * 报文里 —— 真失败时把 10 万字倒进 CI 日志，真正要看的那句 `{"error":{...}}`
 * 反而被淹掉。真实的错误体都在 200 字符量级（结构化 `error` 对象），所以 20000
 * 这个上限对「看清原因」没有任何损失；超了会显式标出「仅打印前 N 字符」。
 */
const FULL_BODY_LIMIT = 20_000;

let cookie = "";

/**
 * 发一个请求。
 *
 * @param {string} method
 * @param {string} path
 * @param {unknown} body `undefined` = 不带体；`null` = 带 JSON `null`
 * @param {{ auth?: "none" }} [opts]
 * @returns {Promise<{ status: number, text: string }>} `text` 是**完整**响应体（由调用方决定截多长）
 */
const api = async (method, path, body, opts) => {
    const withAuth = opts?.auth !== AUTH_NONE;
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(withAuth && cookie ? { Cookie: cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // 探「未鉴权」的 case 不能污染会话：不带 cookie 的请求，它的 Set-Cookie 一律不采信
    if (withAuth) {
        const sc = res.headers.getSetCookie?.() ?? [];
        if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
    }
    return { status: res.status, text: await res.text() };
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

/** 把响应体压成一行，便于日志对齐 */
const oneLine = s => s.replace(/\s+/g, " ").trim();

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

/**
 * 登录，并**证明**真的登上了。
 *
 * 返回 `{ ok, reason, checks, status, text }`；`ok === false` 时调用方用 EXIT_NO_SESSION 中止。
 * 判据四条同时成立才算登上了（只看其中一条都会被「看起来登上了」骗过）：
 *   1. 最后一次登录响应的状态是 200；
 *   2. 响应体说 `success: true`；
 *   3. 不带 `mustChangePassword`（带 = 还停在强制改密页，后续写接口会被闸挡住）；
 *   4. 拿得到会话凭据：Set-Cookie 里的 token，或响应体里的 token / session 字段。
 * 之后还会用一个受保护接口实测一次（见调用处）。
 */
async function login() {
    let last = { status: 0, text: "" };
    let parsed = {};
    for (const pw of ["seed-password", "edge-probe-pw-2026"]) {
        last = await api("POST", "/api/login", { username: "root", password: pw });
        try {
            parsed = JSON.parse(last.text || "{}");
        } catch {
            parsed = {};
        }
        if (last.status === 200 && !parsed.mustChangePassword) break;
        // 强制改密：先把口令换成第二个，再回到循环头重新登录一次
        await api("PUT", "/api/auth/credentials", {
            username: "root",
            currentPassword: pw,
            password: "edge-probe-pw-2026",
        });
    }

    const tokenInBody =
        (typeof parsed.token === "string" && parsed.token.length > 0) ||
        (typeof parsed.session === "string" && parsed.session.length > 0);
    const tokenInCookie = /(^|;\s*)navihive_token=[^;\s]+/.test(cookie);
    const checks = {
        "登录状态 200": last.status === 200,
        "响应体 success: true": parsed.success === true,
        "没有 mustChangePassword": !parsed.mustChangePassword,
        "拿到会话凭据（Set-Cookie token 或响应 token/session）": tokenInBody || tokenInCookie,
    };
    const broken = Object.keys(checks).filter(k => !checks[k]);
    return {
        ok: broken.length === 0,
        checks,
        reason: broken.length === 0 ? "" : broken.join("、"),
        status: last.status,
        text: last.text,
    };
}

/**
 * 判定一条 case。
 *
 * @param {{ expect: number[] }} c
 * @param {number} status
 * @returns {{ ok: boolean, reason: string }}
 */
const judge = (c, status) => {
    // 旧判据保留且优先级最高：5xx 是「服务端崩了」，与期望里写没写 500 无关
    if (status >= 500) return { ok: false, reason: `5xx：服务端自己崩了（期望 ${c.expect.join("/")}）` };
    if (!c.expect.includes(status)) {
        return { ok: false, reason: `状态码不符：期望 ${c.expect.join("/")}，实际 ${status}` };
    }
    return { ok: true, reason: "" };
};

const cases = buildCases();
let confirmed = 0;
let failed = 0;
/** @type {Array<{ label: string, expect: string, actual: string, verdict: "confirmed" | "FAILED", reason: string }>} */
const verdicts = [];

try {
    await waitForServer();
    console.log(`# 接口边界探针（自托管通道 ${BASE}）`);
    console.log(`# case 表：script/api-edge-probe-cases.mjs，共 ${cases.length} 条\n`);

    const init = await api("GET", "/api/init");
    if (init.status !== 200) {
        console.error(`服务没起来：/api/init 返回 ${init.status}`);
        process.exit(2);
    }

    // ---- 登录前置：未登录态跑完全部 case 等于什么都没测 ----
    const session = await login();
    for (const [name, ok] of Object.entries(session.checks)) {
        console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
    }
    const probeRes = await api("GET", "/api/notes?fields=list");
    const probeOk = probeRes.status === 200;
    console.log(`${probeOk ? "  ok" : "FAIL"}  受保护接口实测 GET /api/notes（实际 ${probeRes.status}）`);

    if (!session.ok || !probeOk) {
        console.error(
            `\n未登录，后续 case 无意义 —— 中止（退出码 ${EXIT_NO_SESSION}）。\n` +
                `  卡在：${probeOk ? session.reason : `受保护接口返回 ${probeRes.status}`}\n` +
                `  登录响应：${session.status} ${oneLine(session.text).slice(0, BODY_PREVIEW_CHARS)}\n` +
                `  当前 cookie：${cookie ? oneLine(cookie).slice(0, 120) : "（空）"}`
        );
        process.exit(EXIT_NO_SESSION);
    }
    console.log("");

    // ---- 逐条执行 ----
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const label = `${c.method} ${c.path}`;
        const tag = String(i + 1).padStart(2, " ");
        const expectText = `[${c.expect.join("/")}]`;

        let res;
        try {
            res = await api(c.method, c.path, c.body, { auth: c.auth });
        } catch (e) {
            failed++;
            verdicts.push({
                label,
                expect: expectText,
                actual: "ERR",
                verdict: "FAILED",
                reason: `连接/请求失败：${e?.message ?? e}`,
            });
            console.log(`FAIL ${tag} ${label}  期望 ${expectText}  实际 ERR`);
            console.log(`     why   ${c.why}`);
            console.log(`     error ${e?.message ?? e}`);
            continue;
        }

        const verdict = judge(c, res.status);
        if (verdict.ok) confirmed++;
        else failed++;
        verdicts.push({
            label,
            expect: expectText,
            actual: String(res.status),
            verdict: verdict.ok ? "confirmed" : "FAILED",
            reason: verdict.reason,
        });

        console.log(
            `${verdict.ok ? "ok  " : "FAIL"} ${tag} ${label}  期望 ${expectText}  实际 ${res.status}`
        );
        if (!verdict.ok) {
            console.log(`     why    ${c.why}`);
            if (c.note) console.log(`     note   ${c.note}`);
            console.log(`     reason ${verdict.reason}`);
        }
        // 正常行留 800 字符（旧版 160 太短，连一条结构化 error 都看不全）；
        // 失败时把全文打出来，超长部分显式标出截断位置。
        const flat = oneLine(res.text);
        const shown = flat.slice(0, verdict.ok ? BODY_PREVIEW_CHARS : FULL_BODY_LIMIT);
        const truncated = !verdict.ok && flat.length > FULL_BODY_LIMIT;
        console.log(
            `     body   ${shown}${truncated ? ` …（仅打印前 ${FULL_BODY_LIMIT} 字符，全文 ${flat.length} 字符）` : ""}`
        );
    }

    // ---- 汇总：逐条「期望 vs 实际 + 判定」 ----
    console.log(`\n## 汇总（期望 vs 实际）`);
    for (const v of verdicts) {
        const mark = v.verdict === "confirmed" ? "confirmed" : "FAILED   ";
        console.log(
            `  ${mark}  ${v.label.padEnd(56, " ")} 期望 ${v.expect.padEnd(7, " ")} 实际 ${v.actual.padEnd(4, " ")}${v.reason ? `  ← ${v.reason}` : ""}`
        );
    }
} finally {
    shutdown();
}

console.log(`\nconfirmed：${confirmed} 条    failed：${failed} 条    共 ${cases.length} 项`);
if (failed) {
    console.log("失败项逐条看了上面的 `why` / `reason` / `body` 三行 —— 那三行就是全部上下文。");
}
process.exit(failed ? 1 : 0);
