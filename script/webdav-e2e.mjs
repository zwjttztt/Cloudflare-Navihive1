// script/webdav-e2e.mjs
// WebDAV 备份的**真**端到端：本地起一个 mock WebDAV 服务，让 worker 真的
// MKCOL / PUT / PROPFIND / GET / DELETE 一遍。
//
// 为什么不能只靠单测：webdav.test.ts 里那些用例的 fetch 是假的。假 fetch 能证明
// 「我们发出了什么」，证明不了「发出去的东西真的能被网盘接住、再原样取回来」。
// 真实链路上多出来的东西每个都可能出错：gzip 流的组装与解压、Basic 凭据的编码、
// PROPFIND 的 XML 形态、文件名带时间戳后还能不能被列出来。
//
// 顺带验一条只能在真链路上验的安全约束：**默认挡内网**。把地址指向 127.0.0.1
// 而不开 allowPrivateNetwork 时，上传必须失败且提示指向内网 —— 单测里那只是
// buildWebDavFolderUrl 抛了个错，真链路上它得真的没发出任何请求。
//
// 用法：npm run e2e:webdav   （需要先 npm run build）

import fs from "node:fs";
import path from "node:path";

import {
    ROOT,
    createChecker,
    pickPort,
    startMockWebDav,
    resolveWorkerConfig,
    startWrangler,
    waitReady,
    warnIfStale,
} from "./e2eEnv.mjs";

const { state, check } = createChecker();

// ---------------- mock WebDAV 服务 ----------------

// ---------------- 准备 ----------------

const resolved = resolveWorkerConfig();
if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
}
if (warnIfStale(resolved.config)) {
    console.warn("注意：dist 里的 worker 产物比 worker/ 下的源码还旧 —— 先跑 npm run build");
}

const DAV_USER = "dav-user";
const DAV_PASS = "dav·口令"; // 带非 ASCII：顺带验 Basic 编码在真链路上没错
const BACKUP_PASSWORD = "备份口令-1";

const dav = await startMockWebDav({ username: DAV_USER, password: DAV_PASS });
console.log(`mock WebDAV 起在 ${dav.url}（真实 socket，不是假 fetch）`);

const PORT = await pickPort("E2E_WEBDAV_PORT");
const BASE = `http://127.0.0.1:${PORT}/api`;
const persistDir = path.join(ROOT, ".wrangler-webdav-e2e", `run-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(path.dirname(persistDir), { recursive: true });

const wrangler = startWrangler({
    config: resolved.config,
    port: PORT,
    persistDir,
    logName: "navihive-webdav-e2e.log",
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
console.log("已就绪，开始跑 WebDAV 端到端…\n");

// ---------------- 会话 ----------------

let cookie = "";
const remember = res => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(";")[0];
        if (pair.startsWith("navihive_token=")) cookie = pair;
    }
};
const call = async (method, apiPath, body) => {
    const res = await fetch(`${BASE}/${apiPath}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    remember(res);
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // 非 JSON 响应按文本处理
    }
    return { status: res.status, json, text };
};

// 首次登录要求改密，改密会让当前令牌失效（api-e2e 里踩过），所以改完要重新登录
let login = await call("POST", "login", { username: "e2e-admin", password: "E2e-old-password-1" });
if (process.env.E2E_DEBUG) console.log("DEBUG login:", JSON.stringify(login));
check("首次登录成功", login.json?.success === true, `${login.status} ${login.text?.slice(0, 200) ?? ""}`);
// 注意字段名：服务端认的是 username / password（新值）+ currentPassword，
// 不是 newPassword —— 写错了不报参数错误，而是静默失败、后面每一步都被
// 「请先修改管理员密码」挡住。
await call("PUT", "auth/credentials", {
    username: "e2e-admin",
    password: "E2e-new-password-2",
    currentPassword: "E2e-old-password-1",
});
login = await call("POST", "login", { username: "e2e-admin", password: "E2e-new-password-2" });
check("改密后重新登录成功", login.json?.success === true);

// 造一份有内容的数据，备份才有得可验
const group = await call("POST", "groups", { name: "端到端分组", order_num: 0 });
const groupId = group.json?.id ?? group.json?.data?.id;
await call("POST", "sites", {
    group_id: groupId,
    name: "端到端站点",
    url: "https://example.com",
    icon: "",
    description: "",
    notes: "",
    order_num: 0,
});
if (process.env.E2E_DEBUG) console.log("DEBUG group:", JSON.stringify(group));
check("造好了待备份的数据", Number.isFinite(Number(groupId)), `group id=${groupId}`);

// ---------------- 配置指向本地 mock ----------------

const setConfig = (key, value) => call("PUT", `configs/${key}`, { value });
for (const [key, value] of Object.entries({
    "webdav.url": dav.url,
    "webdav.username": DAV_USER,
    "webdav.password": DAV_PASS,
    "webdav.path": "navihive-backup",
})) {
    const res = await setConfig(key, value);
    check(`写入配置 ${key}`, res.status < 400 || res.json?.success === true, `status=${res.status}`);
}

// ---------------- 关键：默认必须挡住内网 ----------------

const blocked = await call("POST", "webdav/upload", {});
// 内网拦截有**两层**：buildWebDavFolderUrl 挡地址，davFetch 每跳再挡一次重定向目标。
// 断言必须认准第一层的文案（「服务器地址不允许指向内网」），只写 /内网/
// 会被第二层的「重定向目标不允许指向内网」蒙过去 —— 那样即使第一层整个被删掉，
// 这条用例也照样是绿的（试过，确实没变红）。
check(
    "没开内网豁免时，指向 127.0.0.1 的上传被地址层拦下",
    blocked.json?.success === false &&
        /服务器地址不允许指向内网/.test(blocked.json?.message ?? ""),
    blocked.json?.message ?? `status=${blocked.status}`
);
check(
    "被挡下时根本没有发出任何请求（不是发完再报错）",
    dav.requests.length === 0,
    `mock 收到：${dav.requests.join(" | ") || "（无）"}`
);

// ---------------- 打开豁免后跑完整往返 ----------------

await setConfig("webdav.allowPrivateNetwork", "1");

const upload = await call("POST", "webdav/upload", {});
const filename = upload.json?.data?.filename ?? "";
check("上传成功", upload.json?.success === true, upload.json?.message ?? "");
check("文件名是手动备份那一套（带时间戳 .json.gz）", /^navihive-backup-\d{8}-\d{6}-\d{3}\.json\.gz$/.test(filename), filename);
check("mock 网盘上真的收到了这个文件", dav.files.has(filename), [...dav.files.keys()].join(" | "));

check(
    "Basic 凭据按 UTF-8 正确送达（中文口令没被编码坏）",
    dav.authorizations.every(a => a === dav.expected),
    `期望 ${dav.expected}，实际收到 ${[...new Set(dav.authorizations)].join(" / ")}`
);
// 上传刻意**不**先建目录：先 PUT，只在 404/409 时才补建，省掉每次备份的
// 一次 PROPFIND 预检。所以正常路径上应当只有 PUT、没有 MKCOL。
check(
    "目录已存在时只发 PUT，不做建目录预检",
    dav.requests.some(r => r.startsWith("PUT")) && !dav.requests.some(r => r.startsWith("MKCOL")),
    dav.requests.join(" | ")
);

const list = await call("POST", "webdav/list", {});
const names = (list.json?.data ?? []).map(f => f.name);
check("列目录能列出刚传的那份", list.json?.success === true && names.includes(filename), names.join(" | "));

const download = await call("POST", "webdav/download", { filename });
const dumped = JSON.stringify(download.json?.data ?? {});
check("下载回来的备份里能找到刚建的分组与站点", dumped.includes("端到端分组") && dumped.includes("端到端站点"));

// ---------------- 加密备份：设了口令后，口令不对就该解不开 ----------------

// 让 mock 的第一次 PUT 回 409（新网盘上备份目录还没建的情形），
// 顺带把「设了口令」和「目录不存在」两条分支一起验掉。
await setConfig("webdav.backupPassword", BACKUP_PASSWORD);
dav.state.rejectFirstPut = true;
const encUpload = await call("POST", "webdav/upload", {});
const encName = encUpload.json?.data?.filename ?? "";
check(
    "目录不存在时（PUT 409）会补建目录再重试，最终成功",
    encUpload.json?.success === true,
    encUpload.json?.message ?? ""
);
check(
    "补建目录这一步真的发了 MKCOL，且 PUT 重试了一次",
    dav.requests.some(r => r.startsWith("MKCOL")) &&
        dav.requests.filter(r => r.startsWith("PUT")).length >= 3,
    dav.requests.join(" | ")
);
check(
    "网盘上这份是密文（看不到站点名明文）",
    !Buffer.from(dav.files.get(encName)?.bytes ?? Buffer.alloc(0)).includes("端到端分组")
);

const wrongPw = await call("POST", "webdav/download", {
    filename: encName,
    backupPassword: "不是这个口令",
});
check(
    "口令不对时明确报 badPassword，而不是把乱码当数据返回",
    wrongPw.json?.success === false && (wrongPw.json?.code === "badPassword" || /口令|密码/.test(wrongPw.json?.message ?? "")),
    `${wrongPw.json?.code ?? ""} ${wrongPw.json?.message ?? ""}`
);

const rightPw = await call("POST", "webdav/download", {
    filename: encName,
    backupPassword: BACKUP_PASSWORD,
});
check(
    "口令对时能解开，内容一致",
    rightPw.json?.success === true &&
        JSON.stringify(rightPw.json?.data ?? {}).includes("端到端分组"),
    rightPw.json?.message ?? ""
);

// ---------------- 删除 ----------------

const del = await call("POST", "webdav/delete", { filename });
check("删除成功", del.json?.success === true, del.json?.message ?? "");
check("mock 网盘上那份确实没了", !dav.files.has(filename));

// ---------------- 收尾 ----------------

console.log(`\nwrangler 日志：${wrangler.logFile}`);
await wrangler.stopAndWait();
await dav.close();

console.log(`\n${state.checks - state.failures}/${state.checks} 通过`);
if (state.failures) {
    console.error(`有 ${state.failures} 条没过`);
    process.exit(1);
}
console.log("WebDAV 端到端全部通过");
// 显式退出：wrangler 子进程与 mock 服务的句柄会让事件循环空不下来，
// 不写这一句脚本会打完最后一行还挂在那儿（表现为 CI 上「跑完了但一直不结束」）。
process.exit(0);
