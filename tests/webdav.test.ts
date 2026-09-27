// tests/webdav.test.ts
// worker/webdav.ts：重点守「内网豁免」这条安全约束——
// 默认情况下 Worker 必须拒绝内网地址（防账号被攻破后被改成内网靶子），
// 只有显式打开 allowPrivateNetwork 才放行（备份到家里 NAS 的合法用例）。
// 这条如果不写测试，改坏了没人拦得住：默认值从 false 变成 true 是静默的。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildWebDavFolderUrl,
    configFromStored,
    resolveWebDavConfig,
    isAutoBackupFileName,
    selectAutoBackupsToPrune,
    describeWebDavStatus,
    describeWebDavError,
    runWebDavBackup,
} from "../worker/webdav";

/** 造一份配置：默认关内网豁免，path 走默认值 */
function cfg(url: string, allowPrivateNetwork?: boolean) {
    return {
        url,
        username: "u",
        password: "p",
        path: "navihive-backup",
        ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
    };
}

// ---- 默认（未设置 / false）：内网一律挡 ----

test("默认：192.168.x.x 被挡（家庭 NAS 典型地址）", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("http://192.168.1.10:8080/dav/")), /不允许指向内网或本机/);
});

test("默认：未设置 allowPrivateNetwork 也算关（undefined 不能误判成放行）", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("http://10.0.0.5/dav")), /不允许指向内网或本机/);
});

test("默认：显式 false 被挡", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("http://127.0.0.1/dav", false)), /不允许指向内网或本机/);
});

test("默认：.local 域名被挡（mDNS，群晖/NAS 常见）", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("https://my-nas.local/dav")), /不允许指向内网或本机/);
});

test("默认：169.254 链路本地被挡（云元数据服务段）", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("http://169.254.169.254/latest")), /不允许指向内网或本机/);
});

// ---- 打开后：内网放行 ----

test("打开后：192.168.x.x 放行，且非标端口保留", () => {
    const url = buildWebDavFolderUrl(cfg("http://192.168.1.10:8080/dav/", true));
    assert.equal(url, "http://192.168.1.10:8080/dav/navihive-backup/");
});

test("打开后：.local 放行", () => {
    const url = buildWebDavFolderUrl(cfg("https://my-nas.local/dav", true));
    assert.equal(url, "https://my-nas.local/dav/navihive-backup/");
});

// ---- 公网地址：开关两态都该过（别把正常网盘误伤了）----

test("公网地址：开关关着也放行（坚果云等公网网盘不受影响）", () => {
    const url = buildWebDavFolderUrl(cfg("https://dav.jianguoyun.com/dav/"));
    assert.equal(url, "https://dav.jianguoyun.com/dav/navihive-backup/");
});

test("公网地址：开关打开后仍放行（豁免只放宽，不收紧）", () => {
    const url = buildWebDavFolderUrl(cfg("https://dav.jianguoyun.com/dav/", true));
    assert.equal(url, "https://dav.jianguoyun.com/dav/navihive-backup/");
});

// ---- 开关不该捎带把别的校验也免了 ----

test("打开内网豁免后，非 http(s) 协议仍被挡", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("ftp://192.168.1.10/dav", true)), /http:\/\/ 或 https:\/\//);
});

test("打开内网豁免后，空地址仍报错", () => {
    assert.throws(() => buildWebDavFolderUrl(cfg("", true)), /请先填写 WebDAV 服务器地址/);
});

// ---- 布尔解析：configs 表里存的是 "1"/"0" ----

test("configFromStored：库里存 \"1\" 才算开", () => {
    assert.equal(configFromStored({ "webdav.allowPrivateNetwork": "1" }).allowPrivateNetwork, true);
    assert.equal(configFromStored({ "webdav.allowPrivateNetwork": "0" }).allowPrivateNetwork, false);
});

test("configFromStored：键缺失时默认关（升级上来的老库没有这个键）", () => {
    assert.equal(configFromStored({}).allowPrivateNetwork, false);
});

test("configFromStored：兼容 \"true\"/\"false\" 写法", () => {
    assert.equal(configFromStored({ "webdav.allowPrivateNetwork": "true" }).allowPrivateNetwork, true);
    assert.equal(configFromStored({ "webdav.allowPrivateNetwork": "false" }).allowPrivateNetwork, false);
});

// ---- 请求体优先级：前端刚拨的开关要盖过库里的旧值 ----

test("resolveWebDavConfig：请求体带布尔时以请求体为准", async () => {
    const fakeApi = { getConfigs: async () => ({ "webdav.allowPrivateNetwork": "0" }) } as never;
    const r = await resolveWebDavConfig(fakeApi, {} as Request, { allowPrivateNetwork: true });
    assert.equal(r.allowPrivateNetwork, true);
});

test("resolveWebDavConfig：请求体没带时回落到库里存的值", async () => {
    const fakeApi = { getConfigs: async () => ({ "webdav.allowPrivateNetwork": "1" }) } as never;
    const r = await resolveWebDavConfig(fakeApi, {} as Request, {});
    assert.equal(r.allowPrivateNetwork, true);
});

test("resolveWebDavConfig：两边都没有时默认关", async () => {
    const fakeApi = { getConfigs: async () => ({}) } as never;
    const r = await resolveWebDavConfig(fakeApi, {} as Request, {});
    assert.equal(r.allowPrivateNetwork, false);
});

// ---- 备份保留策略：自动备份滚动清理自己，手动备份一份都不删 ----
// 这条不写测试的话，「手动点的备份被定时任务清掉」是静默的数据丢失。

test("自动备份只清理上一次的自动备份，手动备份一律保留", () => {
    const files = [
        { name: "navihive-backup-auto-20260920-100000-000.json.gz" },
        { name: "navihive-backup-20260921-090000-000.json.gz" }, // 手动
        { name: "navihive-backup-20260922-090000-000.json.gz" }, // 手动
        { name: "navihive-backup-auto-20260927-100000-000.json.gz" }, // 本次
    ];
    const targets = selectAutoBackupsToPrune(files, "navihive-backup-auto-20260927-100000-000.json.gz");
    assert.deepEqual(targets, ["navihive-backup-auto-20260920-100000-000.json.gz"]);
});

test("库里有记录时优先删记录的那一份，且不会误删手动备份", () => {
    const targets = selectAutoBackupsToPrune(
        [{ name: "navihive-backup-20260921-090000-000.json.gz" }],
        "navihive-backup-auto-20260927-100000-000.json.gz",
        "navihive-backup-auto-20260913-100000-000.json.gz"
    );
    assert.deepEqual(targets, ["navihive-backup-auto-20260913-100000-000.json.gz"]);
});

test("本次上传的那份绝不在清理名单里（即使库里记录的就是它）", () => {
    const keep = "navihive-backup-auto-20260927-100000-000.json.gz";
    assert.deepEqual(selectAutoBackupsToPrune([{ name: keep }], keep, keep), []);
});

test("目录里只有手动备份时，自动备份不删任何东西", () => {
    const files = [
        { name: "navihive-backup-20260921-090000-000.json.gz" },
        { name: "navihive-backup-20260922-090000-000.json.gz" },
    ];
    assert.deepEqual(selectAutoBackupsToPrune(files, "navihive-backup-auto-20260927-100000-000.json.gz"), []);
});

test("isAutoBackupFileName：只有 auto 前缀算自动备份", () => {
    assert.equal(isAutoBackupFileName("navihive-backup-auto-20260927-100000-000.json.gz"), true);
    assert.equal(isAutoBackupFileName("navihive-backup-20260927-100000-000.json.gz"), false);
    assert.equal(isAutoBackupFileName(""), false);
    assert.equal(isAutoBackupFileName("other-file.json.gz"), false);
});

// ---- 连接失败提示要能照着改 ----
// 「连接失败：HTTP 405」等于没说：用户分不清该改地址、改账号还是打开内网豁免。

test("401/403 提示去检查应用密码", () => {
    assert.match(describeWebDavStatus(401), /应用密码/);
    assert.match(describeWebDavStatus(403), /应用密码/);
});

test("404/405 指向地址问题（多半少了 WebDAV 路径）", () => {
    assert.match(describeWebDavStatus(404), /备份目录不存在/);
    assert.match(describeWebDavStatus(405), /不支持 WebDAV/);
    assert.match(describeWebDavStatus(501), /不支持 WebDAV/);
});

test("409 提示先手工建目录，5xx 说清是服务端错误", () => {
    assert.match(describeWebDavStatus(409), /上级目录不存在/);
    assert.match(describeWebDavStatus(500), /服务端错误/);
});

test("未知状态码仍带 HTTP 数字，不吞掉信息", () => {
    assert.match(describeWebDavStatus(418), /418/);
});

test("超时与地址不通分开提示", () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    assert.match(describeWebDavError(timeout), /连接超时/);
    assert.match(describeWebDavError(new Error("fetch failed")), /连不上服务器/);
});

test("内网拦截等校验类错误原样透传，不被改写成泛泛的『连不上』", () => {
    const msg = "WebDAV 服务器地址不允许指向内网或本机（如需备份到家庭 NAS，请打开「允许内网地址」）";
    assert.equal(describeWebDavError(new Error(msg)), msg);
    assert.match(describeWebDavError(new Error("WebDAV 服务器地址必须以 http:// 或 https:// 开头")), /必须以 http/);
});

// ---- 没配 AUTH_SECRET 时必须拒绝上传 ----
// webdavUpload 里是 `secret ? encryptBytes(gz, secret) : gz`：密钥缺失会静默退化成
// 明文 gzip 上传，站点密码等于裸奔在网盘上。宁可让这次备份失败，也不能悄悄上传明文。

test("没有 AUTH_SECRET：备份失败，且一个字节都不发给网盘", async () => {
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const result = await runWebDavBackup(
            { exportData: async () => ({ groups: [], sites: [], configs: {} }) } as never,
            cfg("https://dav.example.com/dav/"),
            { mode: "manual" }
        );
        assert.equal(result.success, false);
        assert.match(result.message || "", /AUTH_SECRET/);
        assert.equal(fetchCalls, 0, "没密钥就不该发出任何请求");
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("有 AUTH_SECRET：照常走到上传（不被上面的拦截误伤）", async () => {
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
        const result = await runWebDavBackup(
            { exportData: async () => ({ groups: [], sites: [], configs: {} }) } as never,
            cfg("https://dav.example.com/dav/"),
            { mode: "manual", secret: "some-secret", stored: {} }
        );
        assert.equal(result.success, true);
        assert.ok(fetchCalls > 0, "有密钥就该真的发出上传请求");
    } finally {
        globalThis.fetch = realFetch;
    }
});
