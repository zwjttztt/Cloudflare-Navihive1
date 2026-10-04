// script/cron-e2e.mjs
// 定时任务的**真**链路：用 wrangler dev --test-scheduled 真的派发一次 scheduled 事件。
//
// 为什么值得单独一条：wrangler 本地模式下 cron **不生效**，所以「每周自动备份」
// 这条路径此前从来没被真正跑过 —— cronLogic 的单测只覆盖了纯判定，
// 「定时任务真的会调起备份、真的会滚动清理自己那一份、真的不动手动备份」
// 这三件事全靠人肉记着。
//
// 用法：npm run e2e:cron   （需要先 npm run build）

import fs from "node:fs";
import path from "node:path";

import {
    ROOT,
    createChecker,
    pickPort,
    resolveWorkerConfig,
    startMockWebDav,
    startWrangler,
    waitReady,
} from "./e2eEnv.mjs";

const { state, check } = createChecker();

/** 复制一份产物配置并去掉 no_bundle（理由见下面 startWrangler 那段注释） */
function makeBundleableConfig(configPath) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    delete raw.no_bundle;
    // 这两个是插件写进去的路径元信息，wrangler 读到会去找源码目录
    delete raw.configPath;
    delete raw.userConfigPath;
    const out = path.join(path.dirname(configPath), "__cron_e2e_wrangler.json");
    fs.writeFileSync(out, JSON.stringify(raw, null, 2));
    return out;
}

const resolved = resolveWorkerConfig();
if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
}

const DAV_USER = "cron-user";
const DAV_PASS = "cron-pass";
const dav = await startMockWebDav({ username: DAV_USER, password: DAV_PASS });
console.log(`mock WebDAV 起在 ${dav.url}`);

const PORT = await pickPort("E2E_CRON_PORT");
const BASE = `http://127.0.0.1:${PORT}/api`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const persistDir = path.join(ROOT, ".wrangler-cron-e2e", `run-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(path.dirname(persistDir), { recursive: true });

// --test-scheduled 让 wrangler 把 scheduled 事件挂到 /__scheduled 上，
// 这是本地唯一能真正触发定时任务的办法（本地模式下 crons 不会自己跑）。
//
// 但**不能直接用构建产物那份配置**：@cloudflare/vite-plugin 生成的是
// no_bundle: true（产物已经是打包好的 index.js），而 wrangler 的 /__scheduled
// 是靠打包时在入口外面套一层 middleware 实现的 —— 不打包就没有那层，
// 请求会直接落到我们的 fetch 上变成 404（踩过：日志里只有 GET /__scheduled 404）。
// 所以复制一份配置、去掉 no_bundle，让 wrangler 把 index.js 再包一次。
const cronConfig = makeBundleableConfig(resolved.config);
const wrangler = startWrangler({
    config: cronConfig,
    port: PORT,
    persistDir,
    logName: "navihive-cron-e2e.log",
    extraArgs: ["--test-scheduled"],
    vars: {
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "e2e-admin",
        AUTH_PASSWORD: "E2e-old-password-1",
        AUTH_SECRET: "e2e".padEnd(64, "0").slice(0, 64),
    },
});
process.on("exit", () => {
    wrangler.stop();
    try {
        fs.rmSync(persistDir, { recursive: true, force: true });
    } catch {
        // 忽略
    }
});

console.log(`wrangler dev 起在 ${BASE}（持久化目录 ${persistDir}）…`);
if (!(await waitReady(BASE))) {
    console.error("wrangler 一直没就绪，日志见 " + wrangler.logFile);
    await wrangler.stopAndWait();
    await dav.close();
    process.exit(1);
}
console.log("已就绪，开始跑定时任务端到端…\n");

// ---------------- 会话 ----------------

let cookie = "";
const call = async (apiPath, method = "GET", body) => {
    const res = await fetch(`${BASE}/${apiPath}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(";")[0];
        if (pair.startsWith("navihive_token=")) cookie = pair;
    }
    let json = null;
    try {
        json = await res.json();
    } catch {
        // 非 JSON
    }
    return { status: res.status, json };
};

let login = await call("login", "POST", { username: "e2e-admin", password: "E2e-old-password-1" });
check("首次登录成功", login.json?.success === true, login.json?.message ?? String(login.status));
await call("auth/credentials", "PUT", {
    username: "e2e-admin",
    password: "E2e-new-password-2",
    currentPassword: "E2e-old-password-1",
});
login = await call("login", "POST", { username: "e2e-admin", password: "E2e-new-password-2" });
check("改密后重新登录成功", login.json?.success === true);

for (const [key, value] of Object.entries({
    "webdav.url": dav.url,
    "webdav.username": DAV_USER,
    "webdav.password": DAV_PASS,
    "webdav.path": "navihive-backup",
    "webdav.allowPrivateNetwork": "1",
})) {
    const res = await call(`configs/${key}`, "PUT", { value });
    check(`写入配置 ${key}`, res.status < 400, `status=${res.status}`);
}

// ---------------- 真的派发一次定时任务 ----------------

const trigger = async () => {
    // wrangler 的 --test-scheduled 把 scheduled 事件挂在 /__scheduled 上，
    // 但必须带上 cron 表达式参数（它会拿这个表达式去构造 CronEvent），
    // 缺了就是 404 —— 光看路径会以为这个开关没生效。
    const res = await fetch(`${ORIGIN}/__scheduled?cron=*%20*%20*%20*%20*`);
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
};

const waitFor = async (predicate, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    console.log(`  （等「${label}」超时）`);
    return false;
};

// 自动备份只留最新一份（跑完就把上一份删了），所以**不能**用「网盘上有几个
// auto 文件」判断跑没跑 —— 它永远是 1。数 PUT 次数才对。
const autoPuts = () =>
    dav.requests.filter(r => r.startsWith("PUT") && r.includes("navihive-backup-auto-"));
const autoFiles = () => [...dav.files.keys()].filter(n => n.startsWith("navihive-backup-auto-"));

const first = await trigger();
check(
    "/__scheduled 能被触发（--test-scheduled 生效）",
    first.status < 400,
    `status=${first.status} ${first.text.slice(0, 80)}`
);

const firstArrived = await waitFor(() => autoPuts().length >= 1, "第一次自动备份上传");
check("定时任务真的调起了自动备份", firstArrived, `网盘上：${[...dav.files.keys()].join(" | ") || "（空）"}`);

const firstName = autoFiles()[0] ?? "";
check(
    "自动备份的文件名带 auto 前缀（清理时靠它区分来源）",
    /^navihive-backup-auto-\d{8}-\d{6}-\d{3}\.json\.gz$/.test(firstName),
    firstName
);

const lastAuto = await call("configs/webdav.lastAutoBackup");
check(
    "库里记下了这次自动备份的文件名（下次清理靠它）",
    lastAuto.json?.value === firstName || lastAuto.json?.data?.value === firstName,
    `实际 ${JSON.stringify(lastAuto.json)?.slice(0, 120)}`
);

// ---------------- 第二次：滚动清理自己那一份 ----------------

await trigger();
const secondArrived = await waitFor(() => autoPuts().length >= 2, "第二次自动备份上传");
check("再触发一次会再传一份", secondArrived, autoFiles().join(" | "));

const deletes = dav.requests.filter(r => r.startsWith("DELETE"));
check(
    "第二次备份后把上一份自动备份删掉了（自动备份只留最新一份）",
    deletes.some(r => r.includes(firstName)),
    `DELETE 记录：${deletes.join(" | ") || "（没有 DELETE）"}`
);

// ---------------- 关键：手动备份不能被定时任务清掉 ----------------

const manual = await call("webdav/upload", "POST", {});
const manualName = manual.json?.data?.filename ?? "";
check("上传一份手动备份", manual.json?.success === true && manualName.startsWith("navihive-backup-"), manualName);

await trigger();
await waitFor(() => autoPuts().length >= 3, "第三次自动备份上传", 30_000);

check(
    "定时任务跑完后手动备份还在（手动备份是存档，被清掉就是数据丢失）",
    dav.files.has(manualName),
    `网盘上现在有：${[...dav.files.keys()].join(" | ")}`
);
check(
    "清理只删了自动备份，没碰手动那份",
    !dav.requests.some(r => r.startsWith("DELETE") && r.includes(manualName)),
    dav.requests.filter(r => r.startsWith("DELETE")).join(" | ")
);

// ---------------- 兜底清理分支：按文件名判来源的那条路 ----------------
//
// pruneAutoBackups 有两条路：
//   - 库里有 webdav.lastAutoBackup 记录 → 直接删那一份（快路径，**不做文件名判断**）；
//   - 没记录（老库升级 / 记录被清过）→ 列目录，靠 isAutoBackupFileName 挑。
// 上面三次触发全走的快路径，也就是说「手动备份不会被删」这条规则真正生效的
// 那段代码一次都没跑到 —— 把记录清掉再触发一次，才是这条规则的真覆盖。
// 用 DELETE 而不是 PUT 空串：PUT 会被 validateConfig 按「配置值不能为空」挡下（400），
// 只有真删掉记录，stored["webdav.lastAutoBackup"] 才会是 undefined。
const cleared = await call("configs/webdav.lastAutoBackup", "DELETE");
check("删掉 lastAutoBackup 记录，逼出列目录兜底分支", cleared.status < 400, `status=${cleared.status}`);

const beforeFallback = autoPuts().length;
await trigger();
await waitFor(() => autoPuts().length >= beforeFallback + 1, "第四次自动备份上传", 30_000);

// 光看「手动备份还在」是不够的：万一兜底分支压根没被走到，这条断言就是白绿。
// 上传（PUT）之后还发过 PROPFIND，才证明真的列了目录。
const lastPutAt = dav.requests.reduce((acc, r, i) => (r.startsWith("PUT") ? i : acc), -1);
const listedAfterUpload = dav.requests.slice(lastPutAt).some(r => r.startsWith("PROPFIND"));
check(
    "兜底分支确实列了目录（否则下面两条是在测空气）",
    listedAfterUpload,
    dav.requests.slice(lastPutAt).join(" | ") || "（上传后没有任何请求）"
);

check(
    "兜底清理分支也不会删手动备份（按文件名判来源的那条路）",
    dav.files.has(manualName),
    `网盘上现在有：${[...dav.files.keys()].join(" | ")}`
);
check(
    "兜底清理没有对手动备份发过 DELETE",
    !dav.requests.some(r => r.startsWith("DELETE") && r.includes(manualName)),
    dav.requests.filter(r => r.startsWith("DELETE")).join(" | ")
);

// ---------------- 收尾 ----------------

console.log(`\nwrangler 日志：${wrangler.logFile}`);
await wrangler.stopAndWait();
await dav.close();

console.log(`\n${state.checks - state.failures}/${state.checks} 通过`);
if (state.failures) {
    console.error(`有 ${state.failures} 条没过`);
    process.exit(1);
}
console.log("定时任务端到端全部通过");
process.exit(0);
