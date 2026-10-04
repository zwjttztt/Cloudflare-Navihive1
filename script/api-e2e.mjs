// script/api-e2e.mjs
// 后端 API 的真实端到端：起一个 wrangler dev（本地 D1），按人手操作的顺序打一遍接口。
//
// 和 npm run smoke 的分工：
// - smoke 是**前端**冒烟（起静态服务 + Chrome，看页面能不能渲染、卡片浮层对不对）；
// - 这个脚本是**后端**端到端，专门盯那些「只有部署上去点到了才会发现」的契约。
//
// 要盯的三件事，都是踩过的坑：
//   1. 新库首次登录会返回 mustChangePassword，必须先 PUT /api/auth/credentials 改密，
//      否则所有非 GET 请求一律 403（且报错看不出是改密的问题）；
//   2. 改密会 bump tokenVersion，**当前令牌当场失效**，得重新登录 —— 脚本里忘了这步
//      会表现为「改密成功之后什么都做不了」；
//   3. /api/init 只返回 {ok, initialized}，数据在 /api/groups 与 /api/sites。
//
// 用法：npm run e2e      （需要先 npm run build，跑的是 dist/ 下构建出来的那份产物）

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ROOT, isWin, resolveWorkerConfig, warnIfStale } from "./e2eEnv.mjs";
const resolved = resolveWorkerConfig();
if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
}
const CONFIG = resolved.config;
for (const old of resolved.stale ?? []) {
    console.warn(
        `注意：${old.path} 也在 dist 下，但比正在用的这份旧（多半是改 worker 名之前的\n` +
            `遗留产物，不会被新构建覆盖）。要清干净就删掉 ${path.dirname(old.path)} 后再 build。`
    );
}
if (warnIfStale(CONFIG)) {
    console.warn(
        "注意：dist 里的 worker 产物比 worker/ 下的源码还旧 —— 现在跑的是上一版代码，先跑 npm run build"
    );
}

// 端口默认随机：连着跑两次时，上一次的 wrangler 未必已经把端口放干净，
// 撞上就是一场「登录失败」的误报。指定 E2E_PORT 时按指定的来，撞了就直接报错。
const FIXED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0;
const portBusy = async port => {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/init`);
        return res.ok || res.status === 404;
    } catch {
        return false;
    }
};
let PORT = FIXED_PORT;
for (let i = 0; i < 10; i++) {
    const candidate = FIXED_PORT || 8800 + Math.floor(Math.random() * 400);
    if (!(await portBusy(candidate))) {
        PORT = candidate;
        break;
    }
    if (FIXED_PORT) {
        console.error(
            `端口 ${FIXED_PORT} 上已经有服务在跑了（多半是上一次没退干净的 wrangler）。\n` +
                "先结束它，或者不设 E2E_PORT 让脚本自己挑一个空闲端口。"
        );
        process.exit(1);
    }
}
if (!PORT) {
    console.error("试了 10 次都没找到空闲端口");
    process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}/api`;
const READY_TIMEOUT_MS = 120_000;

// 每次跑都用一套全新的凭据与独立的持久化目录，互不干扰
const ADMIN = "e2e-admin";
const OLD_PW = "E2e-old-password-1";
const NEW_PW = "E2e-new-password-2";
const SECRET = "e2e".padEnd(64, "0").slice(0, 64);

let failures = 0;
let checks = 0;

function check(label, ok, detail = "") {
    checks += 1;
    if (ok) {
        console.log(`  PASS ${label}${detail ? `  ${detail}` : ""}`);
    } else {
        failures += 1;
        console.log(`  FAIL ${label}${detail ? `  ${detail}` : ""}`);
    }
}

// ---------------- 起 wrangler dev ----------------


// 每次跑都必须从**空库**开始：上一次跑会把管理员密码改掉，库要是复用，
// 第二次登录就会「用户名或密码错误」，而且失败原因看不出是数据没清。
//
// 做法是每次新建一个子目录，**不删旧的**：本机环境里 fs.rmSync 被包了一层
// 「安全删除」shim（走回收站），删带 sqlite 文件的目录会直接抛错，脚本跑不起来。
// 旧目录留给系统自己清（.wrangler-e2e/ 已进 .gitignore）。
const persistBase = path.join(ROOT, ".wrangler-e2e");
fs.mkdirSync(persistBase, { recursive: true });
const persistDir = fs.mkdtempSync(path.join(persistBase, "run-"));

const wrangler = spawn(
    isWin ? "npx.cmd" : "npx",
    [
        "wrangler",
        "dev",
        "-c",
        CONFIG,
        "--local",
        "--port",
        String(PORT),
        "--persist-to",
        persistDir,
        "--var",
        `AUTH_ENABLED:true`,
        "--var",
        `AUTH_USERNAME:${ADMIN}`,
        "--var",
        `AUTH_PASSWORD:${OLD_PW}`,
        "--var",
        `AUTH_SECRET:${SECRET}`,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: isWin }
);

let wranglerLog = "";
// 日志同时落盘：偶发的 5xx 只有靠它才能定位（worker 内部吞掉的异常不会回到响应体）
const logFile = path.join(os.tmpdir(), "navihive-e2e.log");
fs.writeFileSync(logFile, ""); // 每次跑覆盖，保证拿到的是本次的日志
function appendLog(text) {
    wranglerLog += text;
    try {
        fs.appendFileSync(logFile, text);
    } catch {
        // 落盘失败不影响跑
    }
}
wrangler.stdout?.on("data", d => {
    appendLog(d.toString());
});
wrangler.stderr?.on("data", d => {
    appendLog(d.toString());
});

/**
 * 停掉 wrangler。
 *
 * 必须杀**整棵进程树**：shell 模式下 kill 掉的是 cmd.exe，真正的 wrangler 进程
 * 会留下来占着端口、锁着 sqlite，下一次跑就表现为「登录失败 + 数据跨次累积」。
 */
function stop() {
    try {
        if (isWin) {
            spawnSync("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"]);
        } else {
            wrangler.kill("SIGTERM");
        }
    } catch {
        // 已经退了
    }
}

/** stop() 之后再等它真退出，否则下一次跑会撞上没放开的端口与 sqlite 锁 */
async function stopAndWait() {
    stop();
    await Promise.race([
        new Promise(resolve => wrangler.once("exit", resolve)),
        sleep(3000),
    ]);
}
process.on("exit", () => {
    stop();
    // 尽力而为：清不掉不影响结论（本机 rmSync 走回收站 shim，锁着的 sqlite 删不掉）
    try {
        fs.rmSync(persistDir, { recursive: true, force: true });
    } catch {
        // 忽略
    }
});

async function waitReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/init`);
            if (res.ok) return true;
        } catch {
            // 还没起来
        }
        await sleep(500);
    }
    return false;
}

// ---------------- 会话：手动管 cookie ----------------

let cookie = "";

function rememberCookie(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const c of raw) {
        const pair = c.split(";")[0];
        if (pair.startsWith("navihive_token=")) {
            cookie = pair;
        }
    }
}

/**
 * 打一个接口。
 *
 * 带一层重试是**必要的**，不是为了掩盖业务错误：wrangler dev 的 ProxyWorker 与
 * UserWorker 之间会偶发 "Network connection lost"（日志里能看到
 * "recovered on attempt N after a dropped connection"），连着打一串请求时尤其容易撞上。
 * 表现是 500 + 空响应体，看着像改密接口炸了，其实是本地 dev 服务器的抖动。
 * 所以只对「连接丢失 / 空响应体的 500」重试，业务错误（4xx 或带 JSON 体的 5xx）直接返回。
 */
async function call(pathAndQuery, method = "GET", body, attempt = 0) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
        res = await fetch(`${BASE}/${pathAndQuery}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    } catch (err) {
        if (attempt < 2) {
            await sleep(300);
            return call(pathAndQuery, method, body, attempt + 1);
        }
        throw err;
    }
    rememberCookie(res);

    let data = null;
    try {
        data = await res.json();
    } catch {
        // 204 / 非 JSON 响应
    }

    // 空响应体的 5xx = 连接被 drop，重试；带体的 5xx 是真错，原样返回
    if (res.status >= 500 && data === null && attempt < 2) {
        await sleep(300);
        return call(pathAndQuery, method, body, attempt + 1);
    }
    return { status: res.status, data, headers: res.headers };
}

// ---------------- 主流程 ----------------

console.log(`wrangler dev 起在 ${BASE}（持久化目录 ${persistDir}）…`);
const ready = await waitReady();
if (!ready) {
    console.error("wrangler dev 没能在超时前就绪。日志尾部：\n" + wranglerLog.slice(-2000));
    await stopAndWait();
    process.exit(1);
}
console.log("已就绪，开始跑端到端…");
console.log(`wrangler 日志：${logFile}\n`);

// 1) 新库
//
// 注意：initialized 这时已经是 true —— 配了 AUTH_USERNAME / AUTH_PASSWORD 时，
// 种子管理员在首次请求时就建好了，所以「未初始化」指的是**没有账号**，
// 不是「还没点过第一次设置」。别照着界面流程想当然地断言 false。
{
    const { status, data } = await call("init");
    check(
        "GET /api/init 只回 {ok, initialized}，数据在 /api/groups 与 /api/sites",
        status === 200 && typeof data?.initialized === "boolean" && data?.ok === true,
        JSON.stringify(data)
    );
}

// 2) 首次登录：拿到 mustChangePassword
{
    const { status, data } = await call("login", "POST", { username: ADMIN, password: OLD_PW });
    check("首次登录成功", status === 200 && data?.success === true, data?.message || "");
    check(
        "首次登录要求改密（mustChangePassword）",
        data?.mustChangePassword === true,
        `mustChangePassword=${data?.mustChangePassword}`
    );
}

// 3) 未改密时写接口一律被挡（这是最容易误判成「接口坏了」的一步）
{
    const { status } = await call("groups", "POST", { name: "不该建成" });
    check("未改密时建分组被挡（403）", status === 403, `实际 ${status}`);
}

// 4) 改密
{
    // 字段名是 password，不是 newPassword（传错了不会报错，只是密码没改，
    // 表现得就像「改密成功但新密码登不进去」）
    const { status, data } = await call("auth/credentials", "PUT", {
        username: ADMIN,
        password: NEW_PW,
        currentPassword: OLD_PW,
    });
    check(
        "改密成功",
        status === 200 && data?.success === true,
        `status=${status} body=${JSON.stringify(data)}`
    );
}

// 5) 改密后当前令牌失效 —— 忘了这步就会表现为「改密成功之后什么都做不了」
{
    const stale = await call("groups", "GET");
    check("改密后旧令牌失效", stale.status === 401 || stale.status === 403, `实际 ${stale.status}`);

    cookie = "";
    const again = await call("login", "POST", { username: ADMIN, password: NEW_PW });
    check("用新密码重新登录成功", again.status === 200 && again.data?.success === true);
    check("重新登录后不再要求改密", again.data?.mustChangePassword === false);
}

// 6) 分组 / 站点 CRUD
let groupId = 0;
let siteId = 0;
{
    const created = await call("groups", "POST", { name: "e2e 分组", order_num: 0 });
    groupId = created.data?.id ?? 0;
    check("建分组成功", created.status === 200 && groupId > 0, `id=${groupId}`);

    const site = await call("sites", "POST", {
        name: "e2e 站点",
        url: "https://example.com",
        description: "",
        icon: "",
        group_id: groupId,
        order_num: 0,
    });
    siteId = site.data?.id ?? 0;
    check("建站点成功", site.status === 200 && siteId > 0, `id=${siteId}`);

    const list = await call("groups", "GET");
    check(
        "GET /api/groups 能读回刚建的分组",
        (list.data || []).some(g => g.id === groupId),
        `分组数 ${(list.data || []).length}`
    );
    // 注意：/api/groups 是**不带 sites**的分组列表（前端靠 /api/bootstrap 一次拉全），
    // 想看站点得单独问 /api/sites
    const sites = await call("sites", "GET");
    const siteList = Array.isArray(sites.data) ? sites.data : sites.data?.sites ?? [];
    check(
        "GET /api/sites 能读回刚建的站点且挂在正确分组下",
        siteList.some(s => s.id === siteId && Number(s.group_id) === groupId),
        `站点数 ${siteList.length}`
    );

    const renamed = await call(`sites/${siteId}`, "PUT", { ...site.data, name: "e2e 站点改名" });
    const after = await call(`sites/${siteId}`, "GET");
    check("改站点名生效", renamed.status === 200 && after.data?.name === "e2e 站点改名", after.data?.name);
}

// 7) 删除 → 回收站 → 恢复
{
    const del = await call(`sites/${siteId}`, "DELETE");
    check("删站点成功", del.status === 200, `status=${del.status}`);

    const bin = await call("recycle", "GET");
    const items = Array.isArray(bin.data) ? bin.data : bin.data?.items ?? [];
    check("删掉的站点进了回收站", items.some(i => Number(i.site_id ?? i.id) === siteId), `回收站 ${items.length} 条`);
}

// 8) 安全头（和 tests/responseHeaders.test.ts 对齐的那几个）
{
    const res = await fetch(`${BASE}/definitely-not-a-route`);
    check("404 也带 X-Content-Type-Options: nosniff", res.headers.get("X-Content-Type-Options") === "nosniff");
    check("404 也带 X-Frame-Options: DENY", res.headers.get("X-Frame-Options") === "DENY");
    check("404 也带 Referrer-Policy: no-referrer", res.headers.get("Referrer-Policy") === "no-referrer");
    check("没有暴露 x-powered-by", !res.headers.get("x-powered-by"));
}

// 9) 登出之后令牌作废
{
    await call("logout", "POST");
    const after = await call("groups", "GET");
    check("登出后带旧令牌访问被拒", after.status === 401 || after.status === 403, `实际 ${after.status}`);
}

// ---------------- 收尾 ----------------

console.log(`\n${checks - failures}/${checks} 通过`);
await stopAndWait();
if (failures > 0) {
    console.error(`\n端到端失败 ${failures} 项。wrangler 日志尾部：\n${wranglerLog.slice(-3000)}`);
    process.exit(1);
}
console.log("后端端到端全部通过");
process.exit(0);
