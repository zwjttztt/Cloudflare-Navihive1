// tests/cryptoSingleSalt.test.ts
// C2 回归：新增 keyId 4 / 5（**确定性单盐**），把「冷启动解 N 条凭据要跑 N 次 PBKDF2(50k)」
// 降到 1 次。这份用例钉住五件事：
//
//   1. 收益是真的：100 条 keyId 4 密文**冷解密只调用 1 次 PBKDF2**（直接数 deriveBits），
//      对照 keyId 2 是逐条线性 —— 只断言「能解开」是看不出这个收益的
//   2. 老密文（keyId 0 / 1 / 2 / 3 的硬编码 fixture）一条都不能变成废数据
//   3. `parseEnc` 的字符集覆盖 0–5：漏一个的失败形态是**静默解出空串**，最恶劣
//   4. 空密钥（AUTH_SECRET === ""）退回随机盐 keyId 2，不拿公开常量当盐
//   5. `isSaltedKeyId(4/5)` 必须是 false（读取路径靠它决定「盐不从密文取」）
//
// 运行环境与生产一致：Node 22 全局有 crypto.subtle / btoa / atob。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createKeyring,
    decryptSecret,
    decryptSecretDeep,
    encryptSecret,
    isEncrypted,
    isSaltedKeyId,
    parseEnc,
    KEY_ID_LEGACY,
    KEY_ID_LEGACY_SALTED,
    KEY_ID_LEGACY_SINGLE,
    KEY_ID_DATA_SINGLE,
} from "../src/API/crypto";

// ===================== 基础工具 =====================
// 下面这几个是**独立于** src/API/crypto.ts 的一份实现：用来手工造出「缓存没热过」的密文，
// 从而真正测到冷启动那一次派生。副产品是它顺手校验了盐推导规则本身 ——
// 标签串、盐长度、迭代数任何一个变了，这里造出来的密文在生产代码里就解不开。

type Bytes = Uint8Array<ArrayBuffer>;
const asBytes = (view: Uint8Array): Bytes => view as unknown as Bytes;
const enc = new TextEncoder();

/** 与生产代码同名的盐推导规则（改这里 = 明确知道自己在改密文兼容性） */
const SINGLE_SALT_LABEL = "navihive-single-salt-v4";
const SALT_LEN = 16;
const AES_ITERS = 50_000;

function b64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Bytes {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function pbkdf2AesKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "PBKDF2" }, false, [
        "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: asBytes(salt), iterations: AES_ITERS, hash: "SHA-256" },
        base,
        256
    );
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function singleSalt(secret: string): Promise<Bytes> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        enc.encode(`${SINGLE_SALT_LABEL}|${secret}`)
    );
    return new Uint8Array(digest).slice(0, SALT_LEN);
}

/**
 * 手工拼一条 `enc$<keyId>$<b64(iv||ct)>` 或 `enc$<keyId>$<b64(salt||iv||ct)>`。
 * salt 传了就拼成「盐在头上」的 2 / 3 格式，不传就是 4 / 5 的格式。
 */
async function buildCipher(
    keyId: number,
    key: CryptoKey,
    plain: string,
    salt?: Uint8Array
): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, asBytes(enc.encode(plain)))
    );
    const head = salt ? salt.length : 0;
    const out = new Uint8Array(head + 12 + ct.byteLength);
    if (salt) out.set(salt, 0);
    out.set(iv, head);
    out.set(ct, head + 12);
    return `enc$${keyId}$${b64urlEncode(out)}`;
}

/**
 * 给 `crypto.subtle.deriveBits` 套一层计数器。
 *
 * 为什么直接 patch 原型而不是让生产代码导出一个计数钩子：计数是**测试的关切**，
 * 不该为了可测性往 src 里塞只给测试用的状态。原型上的方法可写（Node 22 实测
 * `writable: true, configurable: true`），测试内用完立刻还原。
 *
 * 只数 PBKDF2：这个模块里 deriveBits 也只有 PBKDF2 在用，但按算法名过滤一句更保险，
 * 将来有人在这里加 ECDH 之类不会把计数带歪。
 */
interface DeriveBitsProto {
    deriveBits(algorithm: unknown, key: CryptoKey, length?: number): Promise<ArrayBuffer>;
}

function instrumentPbkdf2(): { calls: () => number; restore: () => void } {
    const target = Object.getPrototypeOf(crypto.subtle) as DeriveBitsProto;
    const original = target.deriveBits;
    let calls = 0;
    // ⚠️ 必须用 crypto.subtle 当接收者，不能是 target（那是原型，没有内部的 key handle，
    // 调用会抛 "Illegal invocation"；而那个异常被 keyFor 的 try/catch 吃掉之后表现成
    // 「所有密文都解不开、返回空串」，很难往这里想）。
    target.deriveBits = (algorithm, key, length) => {
        const name = (algorithm as { name?: string } | null)?.name;
        if (name === "PBKDF2") calls += 1;
        return original.call(crypto.subtle, algorithm, key, length);
    };
    return {
        calls: () => calls,
        restore: () => {
            target.deriveBits = original;
        },
    };
}

function parseOrThrow(cipher: string): { keyId: number; payload: string } {
    const parsed = parseEnc(cipher);
    if (!parsed) throw new Error(`parseEnc 不该返回 null：${cipher}`);
    return parsed;
}

// ===================== 1. 核心收益：N 条密文 → 1 次 PBKDF2 =====================

test("100 条 keyId 4 密文**冷解密**只调用 1 次 PBKDF2（本项的核心收益）", async () => {
    // 用一个本进程从未用过的 secret，保证 aesKey 缓存是冷的
    const secret = "cold-start-single-salt-secret";
    const ring = createKeyring({ legacySecret: secret });
    assert.equal(ring.writeKeyId, KEY_ID_LEGACY_SINGLE, "有 AUTH_SECRET 时新写入走 keyId 4");

    // 手工造 100 条密文：走测试侧那把钥匙，生产侧的缓存一次都没被预热
    const key = await pbkdf2AesKey(secret, await singleSalt(secret));
    const plains = Array.from({ length: 100 }, (_, i) => `site-${i}-password`);
    const ciphers: string[] = [];
    for (const plain of plains) ciphers.push(await buildCipher(KEY_ID_LEGACY_SINGLE, key, plain));

    const hook = instrumentPbkdf2();
    try {
        const back: string[] = [];
        for (const cipher of ciphers) back.push(await decryptSecret(cipher, ring));
        assert.deepEqual(back, plains, "100 条全都要解得出原文");
        assert.equal(
            hook.calls(),
            1,
            `100 条密文应当只派生 1 次，实际派生了 ${hook.calls()} 次（线性增长说明单盐没生效）`
        );
    } finally {
        hook.restore();
    }
});

test("对照：keyId 2（逐条随机盐）的派生次数随密文条数线性增长", async () => {
    // 这条不是考古，是给上一条做「标尺」：同样的操作在旧格式下就是 N 次，
    // 证明上一条测到的 1 次确实是新增的 keyId 4 带来的，而不是计数器没接上。
    const secret = "linear-salt-contrast-secret";
    const ring = createKeyring({ legacySecret: secret });

    const total = 5;
    const plains: string[] = [];
    const ciphers: string[] = [];
    for (let i = 0; i < total; i++) {
        const plain = `salted-${i}`;
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        const key = await pbkdf2AesKey(secret, salt);
        plains.push(plain);
        ciphers.push(await buildCipher(KEY_ID_LEGACY_SALTED, key, plain, salt));
    }

    const hook = instrumentPbkdf2();
    try {
        const back: string[] = [];
        for (const cipher of ciphers) back.push(await decryptSecret(cipher, ring));
        assert.deepEqual(back, plains);
        assert.equal(
            hook.calls(),
            total,
            `${total} 条约 2 密文必然派生 ${total} 次（每条密文一个盐 = 一个缓存条目）`
        );
    } finally {
        hook.restore();
    }
});

// ===================== 2. 老密文一条都不能废 =====================
// fixture 是用固定 secret 生成的**硬编码**密文（keyId 4/5 那两条还额外钉住了盐的推导规则）。
// 这些字符串一旦解不开，说明有人改了密文格式或盐的来源 —— 线上就是数据丢失。
const FIXTURE_LEGACY_SECRET = "fixture-legacy-secret-2026";
const FIXTURE_DATA_KEY = "fixture-data-key-2026";

const OLD_FIXTURES: Array<{ keyId: number; cipher: string; plain: string }> = [
    {
        keyId: KEY_ID_LEGACY,
        // 升级前唯一格式：没有 keyId 段
        cipher: "enc$N8DZB-ZCadwV-tWRNpKy6qKXvJ4AEYvFNpITJOQqIB3Rbf8_LexqtLCeIQ",
        plain: "fixture-plain-0",
    },
    {
        keyId: 1,
        cipher: "enc$1$gszwIWHVFgpGDns4BxQC8hD0Oa7Nvw1GWbHdiW4OmuGnq46wog36zAR9ow",
        plain: "fixture-plain-1",
    },
    {
        keyId: KEY_ID_LEGACY_SALTED,
        cipher:
            "enc$2$EBESExQVFhcYGRobHB0eH1coaaPnScN0Rdlq94zHtOuXe_okcOpHBgQioWIbQlEN1Jqp_jmou8qeYwg",
        plain: "fixture-plain-2",
    },
    {
        keyId: 3,
        cipher:
            "enc$3$MDEyMzQ1Njc4OTo7PD0-P5-s7QlqeS9Ja70Fp7jvVaq8Hl4i-bocZpLMjcnv0Izxfp068EY2APe48L4",
        plain: "fixture-plain-3",
    },
];

const fullRing = (): ReturnType<typeof createKeyring> =>
    createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET, dataKey: FIXTURE_DATA_KEY });

for (const { keyId, cipher, plain } of OLD_FIXTURES) {
    test(`keyId ${keyId} 的老密文 fixture 仍然解得开（格式与密钥派生逐字节未变）`, async () => {
        assert.equal(await decryptSecret(cipher, fullRing()), plain);
    });
}

test("keyId 0 的老密文仍与原格式逐字节一致：payload 里不含 keyId 段", async () => {
    const legacy = OLD_FIXTURES[0];
    assert.equal(parseOrThrow(legacy.cipher).keyId, KEY_ID_LEGACY);
    assert.equal(await decryptSecret(legacy.cipher, FIXTURE_LEGACY_SECRET), legacy.plain);
});

// ===================== 3. keyId 4 / 5 的硬编码 fixture =====================
// 这两条密文把「确定性盐」的推导规则钉死了：标签串、盐长度、PBKDF2 迭代数任一改变，
// 它们就解不开 —— 而那正是线上所有 keyId 4/5 数据的格式。

test("keyId 4 的硬编码 fixture 解得开（钉住确定性盐的推导：label + 长度 + 迭代数）", async () => {
    const cipher = "enc$4$UYA2jhy6-odG1lwHHhHZmmSbddCgr1JAAEAAqs-MK6o7ffHSbG3jHA-YVw";
    assert.equal(parseOrThrow(cipher).keyId, KEY_ID_LEGACY_SINGLE);
    assert.equal(await decryptSecret(cipher, FIXTURE_LEGACY_SECRET), "fixture-plain-4");
});

test("keyId 5 的硬编码 fixture 解得开（DATA_ENCRYPTION_KEY + 确定性盐）", async () => {
    const cipher = "enc$5$b_WEkgYnAtrOpvGGwDlbIk32fKwDDiOoIUWwKOxqG53RIBvbel6PH7Ib8w";
    assert.equal(parseOrThrow(cipher).keyId, KEY_ID_DATA_SINGLE);
    assert.equal(await decryptSecret(cipher, fullRing()), "fixture-plain-5");
    // 只用 AUTH_SECRET 的环里没有 5 的钥匙 → 解不开必须回空串，不能回密文
    assert.equal(await decryptSecret(cipher, FIXTURE_LEGACY_SECRET), "");
});

// ===================== 4. parseEnc 的字符集必须覆盖 0–5 =====================

test("parseEnc 认得 keyId 4 / 5（漏了就是「静默解出空串」那个入口）", async () => {
    const p4 = parseOrThrow("enc$4$x");
    assert.equal(p4.keyId, KEY_ID_LEGACY_SINGLE);
    assert.equal(p4.payload, "x");

    const p5 = parseOrThrow("enc$5$x");
    assert.equal(p5.keyId, KEY_ID_DATA_SINGLE);
    assert.equal(p5.payload, "x");

    // 0–3 与「没有编号段」的老格式照旧
    assert.equal(parseOrThrow("enc$0$abc").keyId, KEY_ID_LEGACY);
    assert.equal(parseOrThrow("enc$0$abc").payload, "abc");
    assert.equal(parseOrThrow("enc$2$abc").keyId, KEY_ID_LEGACY_SALTED);
    assert.equal(parseOrThrow("enc$3$abc").keyId, 3);
    assert.equal(parseOrThrow("enc$abc").keyId, KEY_ID_LEGACY);
    assert.equal(parseOrThrow("enc$abc").payload, "abc");
});

test("正则漏掉 4 的真实后果：密文会被整段当成 keyId 0 的 payload（数据看着没了）", async () => {
    // 反过来说明「为什么这条正则必须同步」：真按 keyId 0 去解 keyId 4 的密文，
    // 结果既不是原文也不是报错 —— 是空串。这里锁住「现在不会这样」。
    const cipher = "enc$4$UYA2jhy6-odG1lwHHhHZmmSbddCgr1JAAEAAqs-MK6o7ffHSbG3jHA-YVw";
    const plain = await decryptSecret(cipher, FIXTURE_LEGACY_SECRET);
    assert.equal(plain, "fixture-plain-4");
    assert.notEqual(plain, "");
});

// ===================== 5. 写入编号的选择 =====================

test("writeKeyId：有 AUTH_SECRET 走 4，有 DATA_ENCRYPTION_KEY 走 5，空密钥退回 2", () => {
    assert.equal(
        createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET }).writeKeyId,
        KEY_ID_LEGACY_SINGLE
    );
    assert.equal(
        createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET, dataKey: FIXTURE_DATA_KEY }).writeKeyId,
        KEY_ID_DATA_SINGLE
    );
    // 空密钥守卫：确定性盐在空串下等于公开常量，退回逐条随机盐
    assert.equal(createKeyring({ legacySecret: "" }).writeKeyId, KEY_ID_LEGACY_SALTED);
    assert.equal(createKeyring({}).writeKeyId, KEY_ID_LEGACY_SALTED);
});

test("bytesKeyId 仍是固定盐的 0 / 1（备份文件格式里没有 keyId，绝不能变）", () => {
    assert.equal(createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET }).bytesKeyId, KEY_ID_LEGACY);
    assert.equal(
        createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET, dataKey: FIXTURE_DATA_KEY }).bytesKeyId,
        1
    );
});

test("空密钥时写入的密文带 16 字节盐（keyId 2 格式，不是 4）", async () => {
    const plain = "empty-secret-pass";
    const cipher = await encryptSecret(plain, createKeyring({ legacySecret: "" }));
    assert.ok(cipher.startsWith("enc$2$"), cipher.slice(0, 8));

    const raw = b64urlDecode(cipher.slice("enc$2$".length));
    const plainLen = enc.encode(plain).length;
    assert.equal(
        raw.length,
        SALT_LEN + 12 + plainLen + 16,
        "payload = 盐(16) + IV(12) + 密文 + GCM tag(16)"
    );
    assert.equal(await decryptSecret(cipher, createKeyring({ legacySecret: "" })), plain);
});

// ===================== 6. 4 / 5 的读取语义 =====================

test("isSaltedKeyId 对 4 / 5 必须返回 false（读取路径靠它决定盐不从密文取）", () => {
    assert.equal(isSaltedKeyId(KEY_ID_LEGACY_SINGLE), false);
    assert.equal(isSaltedKeyId(KEY_ID_DATA_SINGLE), false);
    assert.equal(isSaltedKeyId(KEY_ID_LEGACY_SALTED), true);
    assert.equal(isSaltedKeyId(3), true);
    assert.equal(isSaltedKeyId(KEY_ID_LEGACY), false);
});

test("4 / 5 的密文：isEncrypted 认、往返正确、错密钥回空串、深层解密不误报", async () => {
    const ring = createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET, dataKey: FIXTURE_DATA_KEY });
    const cipher = await encryptSecret("webdav-pass", ring);
    assert.ok(cipher.startsWith("enc$5$"), cipher.slice(0, 8));
    assert.equal(isEncrypted(cipher), true);
    assert.equal(await decryptSecret(cipher, ring), "webdav-pass");

    // 明文值不该被当成密文
    assert.equal(isEncrypted("webdav-pass"), false);
    assert.equal(await decryptSecret("webdav-pass", ring), "webdav-pass");

    // 换钥之后解不开 → 空串（不能回密文，否则会被二次加密）
    const rotated = createKeyring({ legacySecret: "rotated", dataKey: "rotated-data" });
    assert.equal(await decryptSecret(cipher, rotated), "");
    assert.equal(await decryptSecretDeep(cipher, rotated), "");

    // 多层（历史脏值）也解得到底：外层 5、内层 4
    const legacyOnly = createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET });
    const inner = await encryptSecret("deep-pass", legacyOnly);
    assert.ok(inner.startsWith("enc$4$"), inner.slice(0, 8));
    const outer = await encryptSecret(inner, ring);
    assert.equal(await decryptSecretDeep(outer, ring), "deep-pass");
});

test("同一明文两次加密得到不同密文（IV 随机），但都解得开", async () => {
    const ring = createKeyring({ legacySecret: FIXTURE_LEGACY_SECRET });
    const a = await encryptSecret("same-plaintext", ring);
    const b = await encryptSecret("same-plaintext", ring);
    assert.notEqual(a, b, "盐固定了，但 IV 仍然必须随机");
    assert.equal(await decryptSecret(a, ring), "same-plaintext");
    assert.equal(await decryptSecret(b, ring), "same-plaintext");
});
