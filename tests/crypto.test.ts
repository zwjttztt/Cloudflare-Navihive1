// tests/crypto.test.ts
// 安全原语的纯函数单测：JWT 签名/验签、密码哈希、凭据加解密。
// 运行环境 Node 22（全局有 crypto.subtle / btoa / atob），与 Workers 运行时一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    signJwt,
    verifyJwt,
    hashPassword,
    verifyPassword,
    isHashedPassword,
    encryptSecret,
    decryptSecret,
    decryptSecretDeep,
    encryptBackup,
    decryptBackup,
    isEncryptedBackup,
    encryptBytes,
    decryptBytes,
    validatePasswordStrength,
    constantTimeEqual,
} from "../src/API/crypto";

const SECRET = "test-secret-key";

test("signJwt/verifyJwt 正常往返且带令牌版本", async () => {
    const token = await signJwt({ username: "admin", tv: 3 }, SECRET);
    const r = await verifyJwt(token, SECRET, { tokenVersion: 3 });
    assert.equal(r.valid, true);
    assert.equal((r.payload as { username: string }).username, "admin");
});

test("verifyJwt 拒绝被篡改的签名", async () => {
    const token = await signJwt({ username: "admin", tv: 1 }, SECRET);
    const forged = `${token}.x`; // 后面多塞一段，签名段被改
    const r = await verifyJwt(forged, SECRET, { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("verifyJwt 拒绝错误密钥签发的 token", async () => {
    const token = await signJwt({ username: "admin", tv: 1 }, SECRET);
    const r = await verifyJwt(token, "wrong-secret", { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("verifyJwt 拒绝过期 token", async () => {
    const token = await signJwt({ username: "admin", tv: 1, exp: 1000 }, SECRET);
    const r = await verifyJwt(token, SECRET, { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("verifyJwt 拒绝令牌版本不匹配（改密后旧 token 失效）", async () => {
    const token = await signJwt({ username: "admin", tv: 1 }, SECRET);
    const r = await verifyJwt(token, SECRET, { tokenVersion: 2 });
    assert.equal(r.valid, false);
});

test("hashPassword/verifyPassword 正常校验且每次盐不同", async () => {
    const h1 = await hashPassword("hunter2");
    const h2 = await hashPassword("hunter2");
    assert.ok(isHashedPassword(h1));
    assert.notEqual(h1, h2); // 随机盐，两次哈希不同
    assert.equal(await verifyPassword("hunter2", h1), true);
    assert.equal(await verifyPassword("hunter2", h2), true);
    assert.equal(await verifyPassword("wrong", h1), false);
});

test("verifyPassword 兼容升级前的存量明文", async () => {
    assert.equal(await verifyPassword("plain", "plain"), true);
    assert.equal(await verifyPassword("plain", "other"), false);
});

test("encryptSecret/decryptSecret 往返，且无密钥解不出", async () => {
    const cipher = await encryptSecret("my-webdav-pass", SECRET);
    assert.ok(cipher.startsWith("enc$"));
    assert.equal(await decryptSecret(cipher, SECRET), "my-webdav-pass");
    assert.notEqual(await decryptSecret(cipher, "other"), "my-webdav-pass");
});

test("encryptSecret 空串返回空串；decryptSecret 对明文原样返回", async () => {
    assert.equal(await encryptSecret("", SECRET), "");
    assert.equal(await decryptSecret("plain-not-enc", SECRET), "plain-not-enc");
});

test("constantTimeEqual 长度不同直接 false", () => {
    assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1])), false);
    assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
});

test("encryptBytes/decryptBytes 往返，且无密钥解不出", async () => {
    const plain = new TextEncoder().encode(JSON.stringify({ a: 1, sites: [{ pw: "x" }] }));
    const cipher = await encryptBytes(plain, SECRET);
    assert.ok(cipher.length > plain.length); // 带 12 字节 IV
    const back = await decryptBytes(cipher, SECRET);
    assert.deepEqual([...back], [...plain]);

    // 错误密钥解密应抛错（AES-GCM 认证失败）
    await assert.rejects(() => decryptBytes(cipher, "wrong-secret"));
});

test("validatePasswordStrength 强制最低 12 位且拒绝同字符重复", () => {
    assert.equal(validatePasswordStrength("1234567890").ok, false); // 太短
    assert.equal(validatePasswordStrength("000000000000").ok, false); // 同字符重复
    const ok = validatePasswordStrength("Kp9$mQ2xLz7!vR");
    assert.equal(ok.ok, true);
    assert.equal(ok.message, "");
});

// ---- 多重加密的历史脏值要能自愈 ----
// 曾经「读出来没解密就又存回去」会把明文套成密文的密文，只解一层用户看到的仍是乱码。

test("decryptSecretDeep：明文原样返回（历史明文，无 enc$ 前缀）", async () => {
    assert.equal(await decryptSecretDeep("plain-pwd", SECRET), "plain-pwd");
});

test("decryptSecretDeep：正常单层密文解出明文", async () => {
    const cipher = await encryptSecret("app-pwd-123", SECRET);
    assert.equal(await decryptSecretDeep(cipher, SECRET), "app-pwd-123");
});

test("decryptSecretDeep：密文的密文也能解回明文（自愈）", async () => {
    const once = await encryptSecret("app-pwd-123", SECRET);
    const twice = await encryptSecret(once, SECRET);
    assert.equal(await decryptSecretDeep(twice, SECRET), "app-pwd-123");
});

test("decryptSecretDeep：解不开时返回空，不抛异常也不回乱码", async () => {
    const cipher = await encryptSecret("app-pwd-123", SECRET);
    assert.equal(await decryptSecretDeep(cipher, "wrong-secret"), "");
});

// ---- 批量加解密：首屏要一次解开所有站点密码，密钥派生不能跟着站点数线性放大 ----

test("批量 40 个值加解密往返一致（aesKey 缓存不串味）", async () => {
    const plains = Array.from({ length: 40 }, (_, i) => `pwd-${i}-${"x".repeat(i)}`);
    const ciphers = await Promise.all(plains.map(p => encryptSecret(p, SECRET)));
    const back = await Promise.all(ciphers.map(c => decryptSecret(c, SECRET)));
    assert.deepEqual(back, plains);
});

test("换 secret 后旧密文解不开，但新密文正常（缓存按 secret 隔离）", async () => {
    const a = await encryptSecret("shared", SECRET);
    const other = SECRET + "-other";
    assert.equal(await decryptSecret(a, other), "");
    assert.equal(await decryptSecret(await encryptSecret("shared", other), other), "shared");
});

// ---- 备份文件口令加密 ----
// 本地下载的备份会落到磁盘 / 网盘同步目录，明文 JSON 带着站点密码等于裸奔。
// 这类文件必须用用户自己的口令加密，且不能复用服务端固定盐的 aesKey。

const enc = new TextEncoder();
const dec = new TextDecoder();
const BACKUP_JSON = JSON.stringify({ groups: [{ id: 1, name: "常用" }], sites: [{ id: 1, password: "p@ss" }] });

test("加密后的备份能被认出来，明文 JSON 不会被误判", async () => {
    const cipher = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    assert.equal(isEncryptedBackup(cipher), true);
    assert.equal(isEncryptedBackup(enc.encode(BACKUP_JSON)), false);
    assert.equal(isEncryptedBackup(enc.encode('{"groups":[]}')), false);
});

test("正确口令能解回原文", async () => {
    const cipher = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    assert.equal(dec.decode(await decryptBackup(cipher, "backup-pwd")), BACKUP_JSON);
});

test("口令错误抛可读懂的错误，不返回乱码", async () => {
    const cipher = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    await assert.rejects(() => decryptBackup(cipher, "wrong-pwd"), /密码不正确/);
});

test("拿明文文件去解密会明确报错，而不是当成乱码解", async () => {
    await assert.rejects(() => decryptBackup(enc.encode(BACKUP_JSON), "x"), /不是加密的备份文件/);
});

test("空口令直接拒绝加密（加密了却没口令等于把文件锁死）", async () => {
    await assert.rejects(() => encryptBackup(enc.encode(BACKUP_JSON), ""), /请先设置备份密码/);
});

test("同一份数据两次加密结果不同（随机盐 + 随机 IV）", async () => {
    const a = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    const b = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    assert.notEqual(Buffer.from(a).toString("hex"), Buffer.from(b).toString("hex"));
    // 结果不同但都能解开
    assert.equal(dec.decode(await decryptBackup(b, "backup-pwd")), BACKUP_JSON);
});

// Cloudflare Workers 的 PBKDF2 迭代上限是 10 万次：ENC1 的 15 万次在 Worker 侧
// （WebDAV 上传/下载都由它代劳）会直接抛「Pbkdf2 failed」。新加密一律用 ENC2。
test("新加密走 ENC2 头（10 万次迭代，Workers 也支持）", async () => {
    const cipher = await encryptBackup(enc.encode(BACKUP_JSON), "backup-pwd");
    assert.equal(dec.decode(cipher.subarray(0, 13)), "NAVIHIVE-ENC2");
    assert.equal(isEncryptedBackup(cipher), true);
    assert.equal(dec.decode(await decryptBackup(cipher, "backup-pwd")), BACKUP_JSON);
});

/** 手工按旧版 ENC1 格式（15 万次迭代）造一份备份，验证新代码仍能解开历史文件 */
async function encryptLegacyV1(plain: Uint8Array, password: string): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const raw = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" },
        await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, [
            "deriveBits",
        ]),
        256
    );
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const out = new Uint8Array(13 + 16 + 12 + ct.byteLength);
    out.set(enc.encode("NAVIHIVE-ENC1"), 0);
    out.set(salt, 13);
    out.set(iv, 29);
    out.set(ct, 41);
    return out;
}

test("旧版 ENC1（15 万次迭代）备份仍能解开（本地恢复场景）", async () => {
    const legacy = await encryptLegacyV1(enc.encode(BACKUP_JSON), "old-pass");
    assert.equal(dec.decode(legacy.subarray(0, 13)), "NAVIHIVE-ENC1");
    assert.equal(isEncryptedBackup(legacy), true, "旧格式也要被认成加密备份");
    assert.equal(dec.decode(await decryptBackup(legacy, "old-pass")), BACKUP_JSON);
    await assert.rejects(() => decryptBackup(legacy, "wrong-pass"), /密码不正确/);
});
