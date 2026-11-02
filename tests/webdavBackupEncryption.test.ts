// tests/webdavBackupEncryption.test.ts
//
// 2026-11 P0：备份「没设口令就明文上传」。
//
// 事实链（源码可查）：
//   1. src/API/methods/transfer.ts 打包前把站点密码**解密成明文**；
//   2. worker/webdav/index.ts 原来是 `password ? 加密 : 明文 gzip`；
//   3. 于是没配 webdav.backupPassword 的部署，每周把全站明文凭据传到自己网盘。
//
// 这里钉死四条不变量：
//   ① 没口令、但有 AUTH_SECRET → 上传的必须是密文；
//   ② 有显式口令 → 同样加密，且能用该口令解回原 JSON（不能把口令版本弄丢）；
//   ③ 恢复要能靠候选列表兜底：自动密钥加密的旧备份，在用户后来设了口令之后仍能解开；
//   ④ 一把根密钥都没有 → 拒绝上传（绝不静默降级成明文），候选列表为空。
//
// fetch 打桩方式照抄 tests/webdav.test.ts（直接替换 globalThis.fetch）：WebDAV 全部请求
// 都由 Worker 代发，替换全局 fetch 就是唯一入口，不需要另造一套注入机制。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    decryptBackup,
    encryptBackup,
    isEncryptedBackup,
    type Bytes,
} from "../src/API/crypto";
import { gunzipToString, gzipBytes } from "../worker/webdav/transport";
import {
    deriveAutoBackupKey,
    resolveBackupPasswords,
} from "../worker/webdav/autoKey";
import { runWebDavBackup, webdavDownloadBytes } from "../worker/webdav";
import type { Env } from "../worker/types";

/**
 * Env 里的 DB / FILES 等绑定在这几条用例里用不到，只声明根密钥。
 * 不直接写字面量是因为 Env.DB 是必填项，字面量过不了类型检查。
 */
const envOf = (values: Record<string, string>): Env => values as unknown as Env;

/** 一份最小可用的 WebDAV 配置（公网地址，不触发内网拦截） */
function cfg() {
    return {
        url: "https://dav.example.com/dav/",
        username: "u",
        password: "p",
        path: "navihive-backup",
    };
}

/** 备份目标的最小 api 桩：导出 + 记配置，currentUserId 供自动密钥按账号派生 */
function makeApi(written: Record<string, string>, userId: number | null = 1) {
    return {
        currentUserId: userId,
        exportData: async () => ({
            groups: [{ name: "默认分组" }],
            sites: [
                {
                    name: "内网面板",
                    url: "https://example.com",
                    username: "admin",
                    // 导出时已经是明文 —— 这正是必须默认加密的原因
                    password: "site-plain-password",
                },
            ],
            configs: {},
        }),
        setConfig: async (key: string, value: string) => {
            written[key] = value;
            return true;
        },
    } as never;
}

/** 临时接管 globalThis.fetch，返回本次 PUT 实际发出的字节 */
async function captureUploadBytes(run: () => Promise<unknown>): Promise<Uint8Array> {
    const realFetch = globalThis.fetch;
    let sent: Uint8Array | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        sent = init?.body as Uint8Array | undefined;
        return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
        await run();
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.ok(sent, "应当真的发出了上传请求");
    return sent as Uint8Array;
}

/** 临时接管 globalThis.fetch，让 GET 下载返回给定的字节 */
async function withDownloadBody(body: Bytes, run: () => Promise<void>): Promise<void> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
        await run();
    } finally {
        globalThis.fetch = realFetch;
    }
}

const AUTH_SECRET = "test-auth-secret-for-backup";

// ============ ① 默认加密：没口令 + 有 AUTH_SECRET ============

test("没设备份口令但有 AUTH_SECRET：上传的是密文，不是明文 gzip", async () => {
    const written: Record<string, string> = {};
    const sent = await captureUploadBytes(() =>
        runWebDavBackup(makeApi(written), cfg(), {
            mode: "manual",
            stored: {},
            env: envOf({ AUTH_SECRET }),
        })
    );

    assert.notDeepEqual([...sent.subarray(0, 2)], [0x1f, 0x8b], "明文 gzip 的魔数绝不能出现");
    assert.equal(
        isEncryptedBackup(sent),
        true,
        `必须以 NAVIHIVE-ENC* 开头，实际前 13 字节：${new TextDecoder().decode(sent.subarray(0, 13))}`
    );

    const info = JSON.parse(written["webdav.lastBackupInfo"] ?? "{}");
    assert.equal(info.encrypted, true, "网盘上那份是密文，状态里要如实记录");
    assert.equal(info.encryptedWith, "auto", "来源要标成自动派生，便于排障时知道换密钥会解不开");
});

// ============ ② 显式口令：照旧加密，且解得回来 ============

test("设了显式口令：加密上传，且用该口令能解回原 JSON", async () => {
    const written: Record<string, string> = {};
    const password = "my-backup-pass";
    const sent = await captureUploadBytes(() =>
        runWebDavBackup(makeApi(written), cfg(), {
            mode: "manual",
            stored: {},
            password,
            env: envOf({ AUTH_SECRET }),
        })
    );

    assert.equal(isEncryptedBackup(sent), true);
    const info = JSON.parse(written["webdav.lastBackupInfo"] ?? "{}");
    assert.equal(info.encryptedWith, "password", "显式口令要标成 password（可跨实例解）");

    // 解开 → gzip → JSON：内容必须与导出的完全一致
    const gz = await decryptBackup(sent, password);
    assert.deepEqual([gz[0], gz[1]], [0x1f, 0x8b], "解密后应当是 gzip");
    const parsed = JSON.parse(await gunzipToString(gz)) as {
        sites: Array<{ password?: string }>;
    };
    assert.equal(parsed.sites[0].password, "site-plain-password");
});

// ============ ③ 恢复兜底：候选列表 ============

test("恢复兜底：自动口令加密的文件，用 [错误口令, 自动口令] 能解开", async () => {
    const auto = await deriveAutoBackupKey({ AUTH_SECRET }, 1);
    assert.ok(auto, "测试前提：能派生自动密钥");
    const gz = await gzipBytes(JSON.stringify({ sites: [{ name: "a" }] }));
    const cipher = await encryptBackup(gz, auto);

    await withDownloadBody(cipher, async () => {
        const result = await webdavDownloadBytes(cfg(), "navihive-backup-auto-x.json.gz", [
            "wrong-password",
            auto,
        ]);
        assert.equal(result.success, true, result.message);
        assert.equal(result.data?.encrypted, true);
        assert.deepEqual(
            [...(result.data?.bytes as Uint8Array).subarray(0, 2)],
            [0x1f, 0x8b],
            "解出来的应该是原始 gzip"
        );
    });
});

test("恢复兜底：只给错误口令 → badPassword，且消息说明试过几个候选", async () => {
    const auto = await deriveAutoBackupKey({ AUTH_SECRET }, 1);
    const gz = await gzipBytes(JSON.stringify({ sites: [] }));
    const cipher = await encryptBackup(gz, auto);

    await withDownloadBody(cipher, async () => {
        const result = await webdavDownloadBytes(cfg(), "navihive-backup-auto-x.json.gz", [
            "wrong-password",
        ]);
        assert.equal(result.success, false);
        assert.equal(result.code, "badPassword");
        assert.match(result.message ?? "", /已尝试 1 个口令候选/);
    });
});

// ============ ④ 没有任何根密钥：必须拒绝，而不是明文上传 ============

test("既无 AUTH_SECRET 也无 DATA_ENCRYPTION_KEY：source=none、候选为空", async () => {
    const none = await resolveBackupPasswords({}, 1, "");
    assert.equal(none.source, "none");
    assert.deepEqual(none.candidates, []);
    assert.equal(await deriveAutoBackupKey({}, 1), "");
});

test("没有任何根密钥：备份直接失败，一次上传请求都不发", async () => {
    const written: Record<string, string> = {};
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
        const result = await runWebDavBackup(makeApi(written), cfg(), {
            mode: "manual",
            stored: {},
            env: envOf({}),
        });
        assert.equal(result.success, false, "拿不到密钥就必须失败");
        assert.match(result.message ?? "", /AUTH_SECRET/);
        assert.equal(calls, 0, "绝不能把明文传出去");
        assert.equal(written["webdav.lastBackup"], undefined, "失败不该记「上次备份」");
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ============ 派生本身的稳定性：同实例同账号要能解回自己的备份 ============

test("自动密钥：同一 AUTH_SECRET + 同一账号 → 派生结果稳定；换账号/换密钥 → 不同", async () => {
    const a = await deriveAutoBackupKey({ AUTH_SECRET }, 1);
    assert.equal(
        await deriveAutoBackupKey({ AUTH_SECRET }, 1),
        a,
        "同输入必须同输出，否则自己的备份解不开"
    );
    assert.notEqual(await deriveAutoBackupKey({ AUTH_SECRET }, 2), a, "不同账号不能共用同一把钥匙");
    assert.notEqual(await deriveAutoBackupKey({ AUTH_SECRET: "other" }, 1), a, "换根密钥就该换钥匙");
    assert.ok(a.length >= 32, "密钥长度要足够（base64url 编码 32 字节 = 43 字符）");
});
