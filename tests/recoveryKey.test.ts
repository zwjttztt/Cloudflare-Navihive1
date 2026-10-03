// tests/recoveryKey.test.ts
// 恢复密钥（忘记管理员密码时找回）的浏览器端工具。
//
// 这里钉的是这个模块**唯一的安全承诺**：私钥只留在用户浏览器里，签名时放进令牌的是
// 密码的 PBKDF2 哈希，明文密码从头到尾不出现在令牌里（服务端只拿哈希写库）。
// 所以「payload 里不含明文」必须钉死 —— 一旦哪天有人图省事把 password 直接塞进去，
// 找回密码的令牌就变成了一份明文密码副本，会在日志、代理、CDN 里到处留痕。
//
// 算法用真实的 Web Crypto（Node 22 全局有 crypto.subtle，支持 Ed25519 与 P-256），
// 不做替身 —— 替身验不出「签名参数选错了」这类问题。

import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
    algLabel,
    checkWebCryptoSupport,
    generateRecoveryKeyPair,
    signRecoveryToken,
    parseRecoveryKeyFile,
    downloadRecoveryKeyFile,
} from "../src/utils/recoveryKey";

function decodeSegment(seg: string): Record<string, unknown> {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** 临时换掉 crypto.subtle，验证浏览器不支持时的降级分支 */
function withoutSubtle(): void {
    Object.defineProperty(globalThis.crypto, "subtle", {
        value: undefined,
        configurable: true,
        writable: true,
    });
}

const realSubtle = globalThis.crypto.subtle;

/** 临时造一个 window，验证不同访问地址给出的提示文案 */
function withWindow(origin: string, protocol: string, isSecureContext: boolean): void {
    Object.defineProperty(globalThis, "window", {
        value: { location: { origin, protocol }, isSecureContext },
        configurable: true,
        writable: true,
    });
}

function cleanupEnv(): void {
    Object.defineProperty(globalThis.crypto, "subtle", {
        value: realSubtle,
        configurable: true,
        writable: true,
    });
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
}

afterEach(() => {
    cleanupEnv();
});

test("algLabel: 两种算法的展示名", () => {
    assert.equal(algLabel("EdDSA"), "Ed25519 (EdDSA)");
    assert.equal(algLabel("ES256"), "ECDSA P-256 (ES256)");
});

test("checkWebCryptoSupport: 支持时返回 null", () => {
    assert.equal(checkWebCryptoSupport(), null);
});

test("checkWebCryptoSupport: 拿不到 subtle 时给出可操作的提示", () => {
    withoutSubtle();
    const msg = checkWebCryptoSupport();
    assert.ok(msg, "不可用时要返回原因，不能返回 null");
    assert.ok(msg!.includes("Web Crypto"));
});

test("checkWebCryptoSupport: 非安全上下文（用 IP 访问）时点明原因", () => {
    withoutSubtle();
    withWindow("http://192.168.1.7:5173", "http:", false);
    const msg = checkWebCryptoSupport()!;
    assert.ok(msg.includes("安全上下文"), `应提示安全上下文，实际：${msg}`);
    assert.ok(msg.includes("192.168.1.7"), "要把当前的地址打出来，用户才知道该换哪个");
});

test("checkWebCryptoSupport: http 非 localhost 时提示改用 localhost", () => {
    withoutSubtle();
    withWindow("http://nav.example.com", "http:", undefined as unknown as boolean);
    const msg = checkWebCryptoSupport()!;
    assert.ok(msg.includes("localhost"), `应建议改用 localhost，实际：${msg}`);
});

test("generateRecoveryKeyPair: 现代环境优先 Ed25519，公私钥可导出", async () => {
    const kp = await generateRecoveryKeyPair();
    assert.equal(kp.alg, "EdDSA");
    assert.ok(kp.publicKey.length > 0);
    assert.ok(kp.privateKey.length > 0);
    assert.ok(!kp.publicKey.includes("+") && !kp.publicKey.includes("/"), "要用 base64url");
});

test("signRecoveryToken: 三段 JWS，头里写明算法", async () => {
    const kp = await generateRecoveryKeyPair();
    const token = await signRecoveryToken({
        alg: kp.alg,
        privateKey: kp.privateKey,
        password: "new-password",
    });
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    assert.deepEqual(decodeSegment(parts[0]), { alg: "EdDSA", typ: "JWS" });
});

test("signRecoveryToken: 令牌里是密码哈希，明文一个字都不出现", async () => {
    const kp = await generateRecoveryKeyPair();
    const password = "hunter2-plain";
    const token = await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password });

    // 这三重断言防的是三件不同的事：整体文本里搜不到（最直白）、payload 结构里有
    // passwordHash 字段（说明走的是哈希路径）、且没有 password 明文字段（防哪天被加回来）
    assert.equal(token.includes(password), false, "明文密码绝不能进令牌");
    const payload = decodeSegment(token.split(".")[1]);
    assert.equal(typeof payload.passwordHash, "string");
    assert.ok((payload.passwordHash as string).length > 0);
    assert.equal("password" in payload, false, "payload 里不该有明文字段");
});

test("signRecoveryToken: 有效期至少 1 小时，expHours 传 0 也不会签出已过期的令牌", async () => {
    const kp = await generateRecoveryKeyPair();
    const now = Math.floor(Date.now() / 1000);

    const zero = decodeSegment(
        (
            await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password: "p", expHours: 0 })
        ).split(".")[1]
    );
    assert.ok(
        (zero.exp as number) >= now + 3600,
        "expHours=0 也要兜到 1 小时，否则等于签了一张立刻失效的万能钥匙"
    );

    const three = decodeSegment(
        (
            await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password: "p", expHours: 3 })
        ).split(".")[1]
    );
    assert.ok((three.exp as number) >= now + 3 * 3600);
});

test("signRecoveryToken: 不传 username 时是空串，传了就带上去", async () => {
    const kp = await generateRecoveryKeyPair();
    const a = decodeSegment(
        (await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password: "p" })).split(".")[1]
    );
    assert.equal(a.username, "");

    const b = decodeSegment(
        (
            await signRecoveryToken({
                alg: kp.alg,
                privateKey: kp.privateKey,
                username: "admin2",
                password: "p",
            })
        ).split(".")[1]
    );
    assert.equal(b.username, "admin2");
});

test("signRecoveryToken: 每次签发的 jti 都不同（重放防护）", async () => {
    const kp = await generateRecoveryKeyPair();
    const first = decodeSegment(
        (await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password: "p" })).split(".")[1]
    );
    const second = decodeSegment(
        (await signRecoveryToken({ alg: kp.alg, privateKey: kp.privateKey, password: "p" })).split(".")[1]
    );
    assert.notEqual(first.jti, second.jti);
});

test("signRecoveryToken: ES256 回退路径同样能签出来", async () => {
    const raw = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    )) as CryptoKeyPair;
    const b64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const privateKey = b64(await crypto.subtle.exportKey("pkcs8", raw.privateKey));

    const token = await signRecoveryToken({ alg: "ES256", privateKey, password: "p" });
    assert.deepEqual(decodeSegment(token.split(".")[0]), { alg: "ES256", typ: "JWS" });
    // ECDSA 签名是 DER 编码且每次不同，这里只验证结构完整
    assert.equal(token.split(".").length, 3);
});

test("parseRecoveryKeyFile: 新版 JSON", () => {
    const file = parseRecoveryKeyFile(
        JSON.stringify({ v: 1, alg: "ES256", publicKey: "pub", privateKey: "priv", createdAt: "2026-10-03" })
    );
    assert.deepEqual(file, {
        v: 1,
        alg: "ES256",
        publicKey: "pub",
        privateKey: "priv",
        createdAt: "2026-10-03",
    });
});

test("parseRecoveryKeyFile: 旧版裸 PKCS8 也认（只可能是 Ed25519）", () => {
    const file = parseRecoveryKeyFile("  ABC-_123  \n");
    assert.equal(file.alg, "EdDSA");
    assert.equal(file.privateKey, "ABC-_123");
    assert.equal(file.publicKey, "");
});

test("parseRecoveryKeyFile: 缺字段 / 算法不认识 / 完全不像，都要报错", () => {
    assert.throws(() => parseRecoveryKeyFile(JSON.stringify({ alg: "EdDSA" })), /privateKey/);
    assert.throws(() => parseRecoveryKeyFile(JSON.stringify({ alg: "RS256", privateKey: "p" })), /alg/);
    assert.throws(() => parseRecoveryKeyFile(""));
    assert.throws(() => parseRecoveryKeyFile("not a key!"));
});

test("downloadRecoveryKeyFile: 文件名带日期，且真的触发了一次下载", () => {
    const clicks: string[] = [];
    const revoke = mock.fn();
    Object.defineProperty(globalThis.URL, "createObjectURL", {
        value: () => "blob:mock",
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", {
        value: revoke,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "document", {
        value: {
            createElement: () => ({
                href: "",
                download: "",
                click: () => clicks.push("click"),
                remove: () => clicks.push("remove"),
            }),
            body: { appendChild: () => undefined },
        },
        configurable: true,
        writable: true,
    });

    // 立刻吊销会让部分浏览器的下载失败，所以要留余量（见源码注释）。
    // 假定时器必须在调用**之前**开，否则源码里那个 setTimeout 用的是真的。
    mock.timers.enable({ apis: ["setTimeout"] });
    let filename = "";
    try {
        filename = downloadRecoveryKeyFile("EdDSA", "pub", "priv");
        mock.timers.tick(1000);
    } finally {
        mock.timers.reset();
    }

    assert.match(filename, /^navihive-recovery-key-\d{4}-\d{2}-\d{2}\.json$/);
    assert.deepEqual(clicks, ["click", "remove"], "要触发下载，然后把临时 <a> 摘掉");
    assert.equal(revoke.mock.callCount(), 1, "URL 应当在延时之后被吊销");
});
