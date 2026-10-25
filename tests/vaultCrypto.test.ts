// tests/vaultCrypto.test.ts
// 保险库加密层（方案 B）的守卫 —— 全仓唯一「写错就永久丢数据」的模块，所以钉得最细。
//
// 重点证明四件事：
//   1. 正常路：主密码解出 DEK → 解条目。
//   2. 找回路：**忘了主密码，用恢复码解出同一份 DEK → 解同一条目**（忘密码不丢数据）。
//   3. 拒绝路：错主密码 / 错恢复码 / 密文被改 → AES-GCM 认证失败 → 抛错（不会静默解出垃圾）。
//   4. 改密路：找回后用新主密码重裹 DEK，旧密码从此失效、新密码能解。
//
// ⚠️ 迭代数用 1000 而不是生产 60 万：PBKDF2 的迭代数只影响派生耗时、不影响加解密正确性，
// 测试走同一代码路径但跑得快。（生产值 VAULT_KDF_ITERS=600k 在客户端跑，无 Worker 预算。）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    VAULT_KDF_ITERS,
    generateSalt,
    generateDek,
    wrapDek,
    unwrapDek,
    deriveWrappingKey,
    encryptJson,
    decryptJson,
    generateRecoveryCode,
    normalizeRecoveryCode,
    bytesToB64,
    b64ToBytes,
} from "../src/utils/vaultCrypto";

const ITERS = 1000; // 测试专用低迭代（见文件头）
const MASTER = "correct horse battery staple";

test("VAULT_KDF_ITERS 是 OWASP 量级（客户端跑，无 Worker 50ms 预算）", () => {
    assert.ok(VAULT_KDF_ITERS >= 600_000, `应 ≥ 60 万，实际 ${VAULT_KDF_ITERS}`);
});

test("base64 往返：任意字节编解码一致", () => {
    for (let i = 0; i < 20; i++) {
        const bytes = crypto.getRandomValues(new Uint8Array(i * 7));
        assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes);
    }
});

test("恢复码格式：200 bit 熵、10 组 × 5 位大写十六进制", () => {
    for (let i = 0; i < 20; i++) {
        const code = generateRecoveryCode();
        assert.match(code, /^[0-9A-F]{5}(-[0-9A-F]{5}){9}$/, `格式不对：${code}`);
    }
    // 归一化：带不带分隔符、大小写都能解
    assert.equal(normalizeRecoveryCode("ab12c-de34f"), "AB12CDE34F");
    assert.equal(normalizeRecoveryCode(" ab12c de34f "), "AB12CDE34F");
});

test("包装钥派生确定：同秘密+盐+iters → 可互解（换设备/重进也能解）", async () => {
    const salt = generateSalt();
    const dek = await generateDek();
    const mkA = await deriveWrappingKey(MASTER, salt, ITERS);
    const wrapped = await wrapDek(dek, mkA);
    // 独立再派生一把（模拟下次登录重新输入密码）
    const mkB = await deriveWrappingKey(MASTER, salt, ITERS);
    const dek2 = await unwrapDek(wrapped, mkB);
    const enc = await encryptJson(dek, { hello: "world" });
    assert.deepEqual(await decryptJson(dek2, enc), { hello: "world" });
});

test("DEK 包/解往返：解出的 DEK 能解原 DEK 加的密", async () => {
    const salt = generateSalt();
    const dek = await generateDek();
    const mk = await deriveWrappingKey(MASTER, salt, ITERS);
    const wrapped = await wrapDek(dek, mk);
    const dekBack = await unwrapDek(wrapped, mk);
    const enc = await encryptJson(dek, { n: 42 });
    assert.deepEqual(await decryptJson(dekBack, enc), { n: 42 });
});

test("错主密码解不开 wrapped_dek（AES-GCM 认证失败 → 抛错）", async () => {
    const salt = generateSalt();
    const dek = await generateDek();
    const mk = await deriveWrappingKey(MASTER, salt, ITERS);
    const wrapped = await wrapDek(dek, mk);
    const mkWrong = await deriveWrappingKey("wrong password", salt, ITERS);
    await assert.rejects(() => unwrapDek(wrapped, mkWrong), "错密码必须解不开");
});

test("wrapped_dek 被改一个字节就解不开（完整性）", async () => {
    const salt = generateSalt();
    const dek = await generateDek();
    const mk = await deriveWrappingKey(MASTER, salt, ITERS);
    const wrapped = await wrapDek(dek, mk);
    const tampered = { iv: wrapped.iv, ciphertext: new Uint8Array(wrapped.ciphertext) };
    tampered.ciphertext[0] ^= 0x01;
    await assert.rejects(() => unwrapDek(tampered, mk), "被改的密文必须解不开");
});

test("条目加解密往返 + 错 DEK / 被改条目都抛错", async () => {
    const dek = await generateDek();
    const entry = { title: "GitHub", username: "me", password: "s3cr3t!", notes: "2FA on" };
    const enc = await encryptJson(dek, entry);
    assert.deepEqual(await decryptJson(dek, enc), entry);

    const otherDek = await generateDek();
    await assert.rejects(() => decryptJson(otherDek, enc), "错 DEK 必须解不开条目");

    const tampered = { iv: enc.iv, ciphertext: new Uint8Array(enc.ciphertext) };
    tampered.ciphertext[tampered.ciphertext.length - 1] ^= 0x01;
    await assert.rejects(() => decryptJson(dek, tampered), "被改的条目必须解不开");
});

test("🔴 全链路：主密码解锁 + 忘了主密码用恢复码解出同一份 DEK + 找回后改密重裹", async () => {
    const salt = generateSalt();

    // ── 建库：随机 DEK，用主密码包一份、用恢复码包一份，都上服务端 ──
    const dek = await generateDek();
    const mk = await deriveWrappingKey(MASTER, salt, ITERS);
    const wrappedMaster = await wrapDek(dek, mk);
    const code = generateRecoveryCode();
    const rk = await deriveWrappingKey(normalizeRecoveryCode(code), salt, ITERS);
    const wrappedRecovery = await wrapDek(dek, rk);

    // 一条条目，用 DEK 加密后上服务端
    const entry = { title: "银行", username: "alice", password: "p@ssw0rd!", notes: "key" };
    const encEntry = await encryptJson(dek, entry);

    // ── 正常路：输主密码 → 解 DEK → 解条目 ──
    const dekViaMaster = await unwrapDek(wrappedMaster, await deriveWrappingKey(MASTER, salt, ITERS));
    assert.deepEqual(await decryptJson(dekViaMaster, encEntry), entry, "主密码路应能解出条目");

    // ── 找回路：忘了主密码，用恢复码 → 解出同一份 DEK → 解同一条目 ──
    const dekViaRecovery = await unwrapDek(
        wrappedRecovery,
        await deriveWrappingKey(normalizeRecoveryCode(code), salt, ITERS)
    );
    assert.deepEqual(await decryptJson(dekViaRecovery, encEntry), entry, "恢复码路应能解出同一条目");

    // 错恢复码解不开 recovery 包裹
    await assert.rejects(
        async () => unwrapDek(wrappedRecovery, await deriveWrappingKey("WRONGCODE", salt, ITERS)),
        "错恢复码必须解不开"
    );

    // ── 改密路：找回后设新主密码 → 用（恢复出来的）DEK 重裹一份 ──
    const NEW_MASTER = "brand new master password 2026";
    const mkNew = await deriveWrappingKey(NEW_MASTER, salt, ITERS);
    const rewrapped = await wrapDek(dekViaRecovery, mkNew);

    // 新密码能解
    const dekViaNew = await unwrapDek(rewrapped, await deriveWrappingKey(NEW_MASTER, salt, ITERS));
    assert.deepEqual(await decryptJson(dekViaNew, encEntry), entry, "改密后新密码应能解出条目");
    // 旧主密码从此失效（服务端此后只存 rewrapped）
    await assert.rejects(
        async () => unwrapDek(rewrapped, await deriveWrappingKey(MASTER, salt, ITERS)),
        "改密后旧主密码应失效"
    );
});
