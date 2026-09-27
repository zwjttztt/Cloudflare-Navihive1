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
