// tests/cryptoKeyring.test.ts
// 「AUTH_SECRET 拆分」的回归测试：数据加密密钥(DATA_ENCRYPTION_KEY) 与 JWT 签名密钥
// (JWT_SECRET) 拆开之后，最要紧的一条是**不能把已有密文变成解不开的废数据**。
//
// 覆盖三件事：
//   1. 不配新环境变量时，行为与升级前逐字节一致（旧格式、旧密钥）
//   2. 配了新密钥后，老密文照样能解（keyId 兜底）
//   3. 老密钥不该再有签发/解密能力（拆分本身要有意义）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createKeyring,
    decryptSecret,
    decryptSecretDeep,
    encryptBytes,
    encryptSecret,
    decryptBytes,
    isEncrypted,
    isSaltedKeyId,
    KEY_ID_DATA,
    KEY_ID_DATA_SALTED,
    KEY_ID_LEGACY,
    KEY_ID_LEGACY_SALTED,
    signJwt,
    verifyJwt,
    verifyJwtAny,
} from "../src/API/crypto";

const OLD_SECRET = "legacy-auth-secret";
const NEW_SECRET = "fresh-data-encryption-key";

/**
 * 造一条**固定盐**（升级前格式）的密文。
 *
 * 生产代码已经不再写这种格式了，但线上存量的密文就是它 —— 所以要能在测试里
 * 稳定地造出来，否则「老密文还能解」这条回归无从验证。
 * 做法：用固定盐编号(0)的钥匙手动加一次，再按老格式拼串（不带 keyId 段）。
 */
async function encryptSecretWithFixedSalt(plain: string, ring: ReturnType<typeof createKeyring>): Promise<string> {
    const key = await ring.keyFor(KEY_ID_LEGACY);
    assert.ok(key, "固定盐钥匙必须可用");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain))
    );
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(ct, 12);
    const b64 = btoa(String.fromCharCode(...out)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `enc$${b64}`;
}

// ================= 1. 向后兼容：老密文永远解得开 =================
test("2026-10-21 起新写入走随机盐（keyId 2），裸字符串照样能解", async () => {
    const ring = createKeyring({ legacySecret: OLD_SECRET });
    assert.equal(ring.writeKeyId, KEY_ID_LEGACY_SALTED, "新写入一律用随机盐版");
    assert.equal(ring.bytesKeyId, KEY_ID_LEGACY, "整包二进制维持固定盐（备份格式不能变）");
    const cipher = await encryptSecret("webdav-pass", ring);
    assert.ok(cipher.startsWith("enc$2$"), cipher.slice(0, 8));
    assert.equal(await decryptSecret(cipher, ring), "webdav-pass");
    // 与「直接传裸字符串」的产物可互解 —— 老调用方不受影响
    assert.equal(await decryptSecret(cipher, OLD_SECRET), "webdav-pass");
});

test("随机盐：同一明文加密两次得到的密文不同，且都能解回来", async () => {
    // 这条是 4.3 的目的：盐不再固定，断掉「固定盐 → 可离线预计算」这条路
    const ring = createKeyring({ legacySecret: OLD_SECRET });
    const a = await encryptSecret("same-plaintext", ring);
    const b = await encryptSecret("same-plaintext", ring);
    assert.notEqual(a, b, "两条密文必须不同（盐 + IV 都随机）");
    assert.equal(await decryptSecret(a, ring), "same-plaintext");
    assert.equal(await decryptSecret(b, ring), "same-plaintext");
});

test("升级前的老格式（无 keyId 段 / keyId 1）在新环里仍然解得开", async () => {
    // 用固定盐编号手工造出「历史密文」，模拟升级当天的存量数据
    const legacyRing = createKeyring({ legacySecret: OLD_SECRET });
    const fixed = await encryptSecretWithFixedSalt("old-format", legacyRing);
    assert.ok(fixed.startsWith("enc$"), fixed);
    assert.equal(fixed.slice(4).includes("$"), false, "老格式不带 keyId 段");

    const upgraded = createKeyring({ legacySecret: OLD_SECRET });
    assert.equal(await decryptSecret(fixed, upgraded), "old-format", "老密文必须还能解");
});

test("裸字符串密钥与密钥环(keyId 0)互解：老调用方与新代码零摩擦", async () => {
    const legacyCipher = await encryptSecret("abc-123", OLD_SECRET);
    const ring = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    assert.equal(await decryptSecret(legacyCipher, ring), "abc-123");
});

// ================= 2. 核心回归：配了新密钥，老密文仍然解得开 =================
test("配了 DATA_ENCRYPTION_KEY 后：写入走新钥（keyId 3，随机盐），老密文仍可解", async () => {
    const oldRing = createKeyring({ legacySecret: OLD_SECRET });
    const legacyCipher = await encryptSecret("old-site-password", oldRing);

    const ring = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    assert.equal(ring.writeKeyId, KEY_ID_DATA_SALTED);
    assert.equal(ring.bytesKeyId, KEY_ID_DATA);
    const fresh = await encryptSecret("new-site-password", ring);
    assert.ok(fresh.startsWith("enc$3$"), fresh.slice(0, 8));

    assert.equal(await decryptSecret(fresh, ring), "new-site-password");
    assert.equal(await decryptSecret(legacyCipher, ring), "old-site-password", "老密文必须还能解");
});

test("keyId 2（旧密钥 + 随机盐）在配上 DATA_ENCRYPTION_KEY 之后仍解得开", async () => {
    // 为什么这条必须钉住：keyId 表达的是「用哪把源密钥派生的」，
    // 不能因为后来开了新数据密钥，就把之前用 AUTH_SECRET 写的随机盐密文变成废数据
    const before = createKeyring({ legacySecret: OLD_SECRET });
    const saltedWithLegacy = await encryptSecret("written-before-switch", before);
    assert.ok(saltedWithLegacy.startsWith("enc$2$"));

    const after = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    assert.equal(await decryptSecret(saltedWithLegacy, after), "written-before-switch");
});

test("多层嵌套密文跨 keyId 也能解到底（decryptSecretDeep）", async () => {
    const ringA = createKeyring({ legacySecret: OLD_SECRET });
    const ringB = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    // 模拟历史脏值：明文被套了两层，一层老钥一层新钥
    const inner = await encryptSecret("deep-pass", ringA);
    const outer = await encryptSecret(inner, ringB);
    assert.equal(await decryptSecretDeep(outer, ringB), "deep-pass");
});

test("encryptBytes/decryptBytes 走密钥环也能往返", async () => {
    const ring = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    const plain = new TextEncoder().encode(JSON.stringify({ sites: [{ password: "p" }] }));
    const cipher = await encryptBytes(plain, ring);
    assert.deepEqual([...(await decryptBytes(cipher, ring))], [...plain]);
});

test("salted 编号的判定要稳：只有 2 / 3 自带盐", () => {
    assert.equal(isSaltedKeyId(KEY_ID_LEGACY_SALTED), true);
    assert.equal(isSaltedKeyId(KEY_ID_DATA_SALTED), true);
    assert.equal(isSaltedKeyId(KEY_ID_LEGACY), false);
    assert.equal(isSaltedKeyId(KEY_ID_DATA), false);
});

// ================= 3. 拆分要有意义：老密钥不该再能读新数据 =================
test("只有 DATA_ENCRYPTION_KEY、AUTH_SECRET 换成别的：老密文解不开（返回空串而非乱码）", async () => {
    const legacyCipher = await encryptSecret("old-pass", OLD_SECRET);
    // 轮换场景：新数据密钥已换，AUTH_SECRET 也换了（老钥彻底下线）
    const ring = createKeyring({ legacySecret: "rotated-auth-secret", dataKey: NEW_SECRET });
    assert.equal(await decryptSecret(legacyCipher, ring), "", "解不开必须回空串，不能回密文");
    assert.equal(isEncrypted(legacyCipher), true);
});

test("密文声明的 keyId 在环里不存在时返回空串，不抛异常", async () => {
    const ring = createKeyring({ legacySecret: OLD_SECRET, dataKey: NEW_SECRET });
    const withNewKey = await encryptSecret("secret-value", ring);
    // 只留老钥的环：头上的 keyId=1 找不到钥匙
    const legacyOnly = createKeyring({ legacySecret: OLD_SECRET });
    assert.equal(await decryptSecret(withNewKey, legacyOnly), "");
});

// ================= JWT 拆分与平滑轮换 =================
test("verifyJwtAny：新密钥签发的令牌正常验过", async () => {
    const token = await signJwt({ username: "admin", tv: 1 }, "jwt-new");
    const r = await verifyJwtAny(token, ["jwt-new", "jwt-old"], { tokenVersion: 1 });
    assert.equal(r.valid, true);
});

test("verifyJwtAny：旧密钥签发的令牌在过渡期仍能验过（平滑轮换）", async () => {
    const token = await signJwt({ username: "admin", tv: 2 }, "jwt-old");
    const r = await verifyJwtAny(token, ["jwt-new", "jwt-old"], { tokenVersion: 2 });
    assert.equal(r.valid, true, "过渡期旧令牌不该当场掉线");
    // 过渡结束（删掉旧值）后必须验不过 —— 旧密钥不再有放行能力
    assert.equal((await verifyJwtAny(token, ["jwt-new"], { tokenVersion: 2 })).valid, false);
});

test("verifyJwtAny：不在名单里的密钥一律拒绝；空名单无效", async () => {
    const token = await signJwt({ username: "admin" }, "attacker-key");
    assert.equal((await verifyJwtAny(token, ["jwt-new"], {})).valid, false);
    assert.equal((await verifyJwtAny(token, [], {})).valid, false);
    assert.equal((await verifyJwtAny(token, ["", undefined as never], {})).valid, false);
});

test("verifyJwt 仍只认单把密钥（拆分没有削弱原来的严格性）", async () => {
    const token = await signJwt({ username: "admin" }, OLD_SECRET);
    assert.equal((await verifyJwt(token, NEW_SECRET, {})).valid, false);
    assert.equal((await verifyJwt(token, OLD_SECRET, {})).valid, true);
});
