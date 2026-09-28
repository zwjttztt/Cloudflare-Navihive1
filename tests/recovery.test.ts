// tests/recovery.test.ts
// 找回管理员密码用的是「非对称密钥恢复」：服务器只持公钥（Ed25519 或 ECDSA P-256）、
// 只做验签，私钥离线保管。这几条测试守的是几条硬约束：
//   1. 验签必须真验 —— 篡改令牌 / 换错公钥 / 非 JWS 都不能蒙混过关；
//   2. 令牌必须过期失效 + jti 一次性（防重放）；
//   3. 脚本 / 网页算出的 passwordHash 格式必须与后端 verifyPassword 完全对得上；
//   4. 令牌里只接受哈希，不接受明文密码（否则捡到私钥的人能设弱口令绕过强度策略）；
//   5. 公钥可以存在库里（网页端生成），也必须校验当前密码才能换。
// 第 3 条尤其关键：网页端和脚本是各自独立的签名实现，改错一位就让「重置完还是登不进去」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRecoveryToken, verifyPassword, isValidRecoveryPublicKey } from "../src/API/crypto";
import { NavigationAPI } from "../src/API/http";

const enc = new TextEncoder();

type Alg = "EdDSA" | "ES256";

function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 造一对恢复密钥。公钥统一按 SPKI 导出（网页端、脚本、服务端都是这个格式），
 * 私钥按 PKCS8 导出后重新导入成可用的 CryptoKey。
 */
async function newKeypair(alg: Alg = "EdDSA") {
    const gen =
        alg === "ES256"
            ? crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
                  "sign",
                  "verify",
              ])
            : crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const kp = (await gen) as CryptoKeyPair;
    const importAlg =
        alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
    const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
    const privBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const privKey = await crypto.subtle.importKey("pkcs8", privBytes, importAlg, false, ["sign"]);
    return { pub, privKey, alg };
}

async function buildToken(
    privKey: CryptoKey,
    payload: Record<string, unknown>,
    alg: Alg = "EdDSA"
): Promise<string> {
    const header = b64url(enc.encode(JSON.stringify({ alg, typ: "JWS" })));
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const params =
        alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
    const sig = new Uint8Array(
        await crypto.subtle.sign(
            params as unknown as Parameters<SubtleCrypto["sign"]>[0],
            privKey,
            enc.encode(`${header}.${body}`)
        )
    );
    return `${header}.${body}.${b64url(sig)}`;
}

// 与后端完全一致的 PBKDF2 参数（crypto.ts 里是 10 万迭代 / SHA-256 / 16 字节盐 / 32 字节输出）
async function hashLikeScript(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
        key,
        32 * 8
    );
    return `pbkdf2$100000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

function futureExp(hours = 24): number {
    return Math.floor(Date.now() / 1000) + hours * 3600;
}

// ---- 验签（crypto.ts） ----

test("合法令牌：验签通过，payload 原样带回", async () => {
    const { pub, privKey } = await newKeypair();
    const hash = await hashLikeScript("some-strong-pass");
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: hash,
        exp: futureExp(),
        jti: "once-only-1",
    });

    const result = await verifyRecoveryToken(token, pub);
    assert.equal(result.valid, true);
    assert.equal(result.payload?.username, "admin");
    assert.equal(result.payload?.passwordHash, hash);
    assert.equal(result.payload?.jti, "once-only-1");
});

test("篡改签名：验签失败（改一个字符都不能过）", async () => {
    const { pub, privKey } = await newKeypair();
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "pbkdf2$100000$x$y",
        exp: futureExp(),
        jti: "j1",
    });
    const [h, p, s] = token.split(".");
    const badSig = b64url(new Uint8Array(64)); // 换成一串全零签名
    const tampered = `${h}.${p}.${badSig}`;

    const result = await verifyRecoveryToken(tampered, pub);
    assert.equal(result.valid, false);
    assert.notEqual(result.valid, true, `篡改后不能过：${s === badSig}`);
});

test("用另一把公钥验：失败（换错密钥不能蒙混）", async () => {
    const { privKey } = await newKeypair();
    const other = await newKeypair();
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "pbkdf2$100000$x$y",
        exp: futureExp(),
        jti: "j2",
    });
    assert.equal((await verifyRecoveryToken(token, other.pub)).valid, false);
});

test("不是三段 JWS / 算法不对：一律拒绝", async () => {
    const { pub } = await newKeypair();
    assert.equal((await verifyRecoveryToken("abc.def", pub)).valid, false);
    // alg 声明成 HS256 也拒绝（只允许 EdDSA / ES256）
    const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWS" })));
    const body = b64url(enc.encode(JSON.stringify({ username: "a", passwordHash: "b", exp: 1, jti: "c" })));
    assert.equal((await verifyRecoveryToken(`${header}.${body}.sig`, pub)).valid, false);
});

// ---- 哈希格式：脚本算的哈希必须能被后端 verifyPassword 认 ----

test("脚本格式的 passwordHash 能被后端 verifyPassword 接受", async () => {
    const hash = await hashLikeScript("MyNewPass-2026!!");
    assert.equal(await verifyPassword("MyNewPass-2026!!", hash), true);
    assert.equal(await verifyPassword("wrong-pass-here", hash), false);
});

// ---- 端到端：redeemRecoveryToken（含过期 / 重放 / 未配置） ----

function makeApi(pubKey: string) {
    const store = new Map<string, string>();
    const db = {
        prepare(sql: string) {
            // D1 真实语义：prepare 出来的语句本身就带 first/run/all/bind，
            // 且 bind 返回的是可继续调用的同一条语句（建表走 batch 时不会 bind，直接 all/run）。
            const args: unknown[] = [];
            const stmt = {
                bind(...bound: unknown[]) {
                    args.push(...bound);
                    return stmt;
                },
                async first() {
                    if (sql.includes("SELECT value FROM configs")) {
                        const v = store.get(args[0] as string);
                        return v === undefined ? null : { value: v };
                    }
                    return null;
                },
                async run() {
                    if (sql.includes("INSERT INTO configs")) {
                        store.set(args[0] as string, args[1] as string);
                    }
                    if (sql.includes("DELETE FROM configs")) {
                        store.delete(args[0] as string);
                    }
                    return { success: true };
                },
                async all() {
                    if (sql.includes("SELECT value FROM configs")) {
                        const v = store.get(args[0] as string);
                        return { results: v === undefined ? [] : [{ value: v }] };
                    }
                    return { results: [] };
                },
            };
            return stmt;
        },
        // 批量查询：逐条执行并返回 D1 形状的 { results: [...] }
        async batch(statements: Array<{ all(): Promise<{ results: unknown[] }> }>) {
            return Promise.all(statements.map(s => s.all()));
        },
        async exec() {
            return { success: true };
        },
    };
    const api = new NavigationAPI({
        DB: db,
        AUTH_RECOVERY_PUBLIC_KEY: pubKey,
    } as never);
    return { api, store };
}

test("端到端：令牌有效 → 写入新账号密码哈希，并 bump 令牌版本", async () => {
    const { pub, privKey } = await newKeypair();
    const { api, store } = makeApi(pub);
    const hash = await hashLikeScript("BrandNewPass2026");
    const token = await buildToken(privKey, {
        username: "admin2",
        passwordHash: hash,
        exp: futureExp(),
        jti: "e2e-1",
    });

    const result = await api.redeemRecoveryToken(token, "127.0.0.1");
    assert.equal(result.success, true, result.message);
    assert.equal(store.get("auth.username"), "admin2");
    assert.equal(store.get("auth.password"), hash);
    assert.equal(store.get("auth.tokenVersion"), "1", "改密必须 bump，让旧会话失效");
});

test("端到端：同一张令牌用第二次 → 拒绝（jti 防重放）", async () => {
    const { pub, privKey } = await newKeypair();
    const { api } = makeApi(pub);
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "pbkdf2$100000$a$b",
        exp: futureExp(),
        jti: "e2e-replay",
    });

    assert.equal((await api.redeemRecoveryToken(token)).success, true);
    const second = await api.redeemRecoveryToken(token);
    assert.equal(second.success, false);
    assert.match(second.message, /已被使用过/);
});

test("端到端：过期的令牌 → 拒绝", async () => {
    const { pub, privKey } = await newKeypair();
    const { api, store } = makeApi(pub);
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "pbkdf2$100000$a$b",
        exp: Math.floor(Date.now() / 1000) - 60, // 已过期
        jti: "e2e-expired",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, false);
    assert.match(result.message, /已过期/);
    assert.equal(store.get("auth.password"), undefined, "过期令牌绝不能改到凭据");
});

test("端到端：站点没配恢复公钥 → 拒绝（入口不该悄悄放行）", async () => {
    const { privKey } = await newKeypair();
    const { api, store } = makeApi("");
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "pbkdf2$100000$a$b",
        exp: futureExp(),
        jti: "e2e-nopub",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, false);
    assert.match(result.message, /尚未配置恢复公钥/);
    assert.equal(store.get("auth.password"), undefined);
    assert.equal(await api.hasRecoveryKey(), false);
});

// ---- 双算法 + 公钥来源 ----

test("ES256（老浏览器不支持 Ed25519 时的退路）：同样能验签通过", async () => {
    const { pub, privKey, alg } = await newKeypair("ES256");
    const hash = await hashLikeScript("AnotherPass2026!!");
    const token = await buildToken(
        privKey,
        { username: "admin", passwordHash: hash, exp: futureExp(), jti: "es256-1" },
        alg
    );

    const result = await verifyRecoveryToken(token, pub);
    assert.equal(result.valid, true);
    assert.equal(result.payload?.passwordHash, hash);
});

test("ES256 令牌换个 Ed25519 公钥验：失败（alg 与密钥必须匹配）", async () => {
    const { privKey, alg } = await newKeypair("ES256");
    const edKeypair = await newKeypair("EdDSA");
    const token = await buildToken(
        privKey,
        { username: "admin", passwordHash: "pbkdf2$100000$a$b", exp: futureExp(), jti: "es256-x" },
        alg
    );
    assert.equal((await verifyRecoveryToken(token, edKeypair.pub)).valid, false);
});

test("isValidRecoveryPublicKey：认得两种算法的 SPKI，拒绝乱码", async () => {
    const ed = await newKeypair("EdDSA");
    const ec = await newKeypair("ES256");
    assert.equal(await isValidRecoveryPublicKey(ed.pub), true);
    assert.equal(await isValidRecoveryPublicKey(ec.pub), true);
    assert.equal(await isValidRecoveryPublicKey(b64url(new Uint8Array(64))), false);
    assert.equal(await isValidRecoveryPublicKey("not-a-key"), false);
});

test("公钥存在库里（网页端生成，无 env 变量）也能恢复", async () => {
    const { pub, privKey } = await newKeypair();
    const { api, store } = makeApi("");
    store.set("recovery.publicKey", pub);

    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: await hashLikeScript("FromBrowserKey2026"),
        exp: futureExp(),
        jti: "db-pubkey-1",
    });

    assert.equal(await api.hasRecoveryKey(), true, "库里有公钥就该算已配置");
    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, true, result.message);
});

// ---- 令牌内容的硬约束 ----

test("令牌里带明文密码：拒绝（防止绕过密码强度策略）", async () => {
    const { pub, privKey } = await newKeypair();
    const { api, store } = makeApi(pub);
    const token = await buildToken(privKey, {
        username: "admin",
        passwordHash: "123456", // 明文，不是 pbkdf2$ 哈希
        exp: futureExp(),
        jti: "plaintext-1",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, false);
    assert.match(result.message, /格式不合法/);
    assert.equal(store.get("auth.password"), undefined);
});

test("username 留空：只重置密码，账号保持不变", async () => {
    const { pub, privKey } = await newKeypair();
    const { api, store } = makeApi(pub);
    store.set("auth.username", "original-admin");

    const token = await buildToken(privKey, {
        username: "",
        passwordHash: await hashLikeScript("KeepMyName2026"),
        exp: futureExp(),
        jti: "empty-name-1",
    });

    assert.equal((await api.redeemRecoveryToken(token)).success, true);
    assert.equal(store.get("auth.username"), "original-admin");
});

// ---- 保存公钥必须校验当前密码 ----

test("setRecoveryPublicKey：当前密码不对 → 拒绝（防会话劫持者留后门）", async () => {
    const { pub } = await newKeypair();
    const { api, store } = makeApi("");
    (api as unknown as { authEnabled: boolean }).authEnabled = true;
    store.set("auth.username", "admin");
    store.set("auth.password", "correct-horse-battery");

    const result = await api.setRecoveryPublicKey(pub, "wrong-password");
    assert.equal(result.success, false);
    assert.match(result.message, /当前密码不正确/);
    assert.equal(store.get("recovery.publicKey"), undefined);
});

test("setRecoveryPublicKey：密码正确 + 公钥合法 → 入库", async () => {
    const { pub } = await newKeypair();
    const { api, store } = makeApi("");
    (api as unknown as { authEnabled: boolean }).authEnabled = true;
    store.set("auth.username", "admin");
    store.set("auth.password", "correct-horse-battery");

    const result = await api.setRecoveryPublicKey(pub, "correct-horse-battery");
    assert.equal(result.success, true, result.message);
    assert.equal(store.get("recovery.publicKey"), pub);
});

test("setRecoveryPublicKey：公钥是乱码 → 拒绝（别存进去等用时才发现）", async () => {
    const { api, store } = makeApi("");
    const result = await api.setRecoveryPublicKey("garbage-key", "");
    assert.equal(result.success, false);
    assert.match(result.message, /格式不合法/);
    assert.equal(store.get("recovery.publicKey"), undefined);
});
