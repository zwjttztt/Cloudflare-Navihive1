// tests/recovery.test.ts
// 找回管理员密码用的是「非对称密钥恢复」：服务器只持 Ed25519 公钥、只做验签，
// 私钥离线保管。这几条测试守的是三条硬约束：
//   1. 验签必须真验 —— 篡改令牌 / 换错公钥 / 非 JWS 都不能蒙混过关；
//   2. 令牌必须过期失效 + jti 一次性（防重放）；
//   3. 脚本算出的 passwordHash 格式必须与后端 verifyPassword 完全对得上。
// 第 3 条尤其关键：脚本是独立的 .mjs，改错一位就让「重置完还是登不进去」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRecoveryToken, verifyPassword } from "../src/API/crypto";
import { NavigationAPI } from "../src/API/http";

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function newKeypair() {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const privBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const privKey = await crypto.subtle.importKey("pkcs8", privBytes, { name: "Ed25519" }, false, ["sign"]);
    return { pub, privKey };
}

async function buildToken(
    privKey: CryptoKey,
    payload: Record<string, unknown>
): Promise<string> {
    const header = b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWS" })));
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, privKey, enc.encode(`${header}.${body}`))
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
    // alg 声明成 HS256 也拒绝（只允许 EdDSA）
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
            return {
                bind(...args: unknown[]) {
                    return {
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
                            return { success: true };
                        },
                        async all() {
                            return { results: [] };
                        },
                    };
                },
            };
        },
        async batch() {
            return [];
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
    assert.equal(api.hasRecoveryKey(), false);
});
