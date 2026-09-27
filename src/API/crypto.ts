// src/API/crypto.ts
// 认证相关的安全原语集中放这里：JWT(HS256) 签名/验签、密码哈希(PBKDF2)、凭据静态加密(AES-GCM)。
// 全部走 WebCrypto（Workers 运行时与 Node 22 全局都有 crypto.subtle），零外部依赖、可单测。

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// 定时间比较，防时序侧信道（XOR 累加，早退出也不泄露位数差异）
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ---------------- JWT (HS256) ----------------
const JWT_HEADER = { alg: "HS256", typ: "JWT" };

export async function signJwt(
    payload: Record<string, unknown>,
    secret: string
): Promise<string> {
    const header = b64urlEncode(enc.encode(JSON.stringify(JWT_HEADER)));
    const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const data = `${header}.${body}`;
    const sig = await hmac(secret, enc.encode(data));
    return `${data}.${b64urlEncode(sig)}`;
}

export interface JwtResult {
    valid: boolean;
    payload?: Record<string, unknown>;
}

export async function verifyJwt(
    token: string,
    secret: string,
    opts?: { tokenVersion?: number }
): Promise<JwtResult> {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };
    const [header, body, sig] = parts;
    const expected = await hmac(secret, enc.encode(`${header}.${body}`));
    if (!constantTimeEqual(expected, b64urlDecode(sig))) return { valid: false };

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(dec.decode(b64urlDecode(body)));
    } catch {
        return { valid: false };
    }

    const exp = payload.exp;
    if (typeof exp === "number" && exp < Math.floor(Date.now() / 1000)) {
        return { valid: false };
    }

    // 改密 / 重置后会 bump tokenVersion，旧令牌一律作废 —— 实现服务端可吊销
    if (opts && typeof opts.tokenVersion === "number") {
        const tv = typeof payload.tv === "number" ? payload.tv : 0;
        if (tv !== opts.tokenVersion) return { valid: false };
    }
    return { valid: true, payload };
}

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

// ---------------- 密码哈希 (PBKDF2-SHA256) ----------------
// Workers 没有 scrypt/bcrypt，WebCrypto 只给 PBKDF2。迭代数在「扛离线爆破」
// 与「Worker 50ms CPU 预算」之间取折中；个人站足够，之后可上调。
const PBKDF2_ITERS = 100_000;
const PWD_PREFIX = "pbkdf2$";

export function isHashedPassword(stored: string): boolean {
    return stored.startsWith(PWD_PREFIX);
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await pbkdf2(password, salt, PBKDF2_ITERS, 32);
    return `${PWD_PREFIX}${PBKDF2_ITERS}$${b64urlEncode(salt)}$${b64urlEncode(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    if (!stored || !isHashedPassword(stored)) {
        // 升级前的存量明文：按明文比，命中后由登录流程顺手重哈希落库
        return password === stored;
    }
    const parts = stored.slice(PWD_PREFIX.length).split("$");
    if (parts.length !== 3) return false;
    const iters = Number(parts[0]);
    const salt = b64urlDecode(parts[1]);
    const expected = b64urlDecode(parts[2]);
    const derived = await pbkdf2(password, salt, iters, 32);
    return constantTimeEqual(derived, expected);
}

async function pbkdf2(
    password: string,
    salt: Uint8Array,
    iterations: number,
    length: number
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        length * 8
    );
    return new Uint8Array(bits);
}

// ---------------- 凭据静态加密 (AES-GCM，密钥由 AUTH_SECRET 派生) ----------------
// 用于 webdav.password 这类「明文落 D1」的敏感字段：D1 导出 / 备份泄露也解不出明文
// （没有 AUTH_SECRET 即解不开）。每次写入换随机 IV。
const ENC_PREFIX = "enc$";
const AES_SALT = enc.encode("navihive-aes-v1");
const AES_ITERS = 50_000;

export function isEncrypted(stored: string): boolean {
    return stored.startsWith(ENC_PREFIX);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
    if (!plain) return "";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(secret);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return `${ENC_PREFIX}${b64urlEncode(out)}`;
}

export async function decryptSecret(cipher: string, secret: string): Promise<string> {
    if (!cipher || !isEncrypted(cipher)) return cipher;
    const raw = b64urlDecode(cipher.slice(ENC_PREFIX.length));
    if (raw.length <= 12) return "";
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const key = await aesKey(secret);
    try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        return dec.decode(pt);
    } catch {
        return "";
    }
}

/**
 * 反复解密到明文为止（默认最多 3 层）。
 *
 * 存在的理由：历史上「读出来没解密就又存回去」会把明文套成密文的密文
 * （典型是刷新后前端拿到 enc$... 密文、再保存一次）。这种值解开一层还是 enc$ 开头，
 * 只解一层的话用户看到的仍是一串乱码，还得手动重填。这里循环解到不再是密文为止。
 * 正常值第一次循环就结束，多出来的开销只有一个字段几次 PBKDF2。
 */
export async function decryptSecretDeep(
    stored: string,
    secret: string,
    maxDepth = 3
): Promise<string> {
    let value = stored;
    for (let i = 0; i < maxDepth && isEncrypted(value); i++) {
        const next = await decryptSecret(value, secret);
        // 解不开（换了 AUTH_SECRET 等）时 decryptSecret 返回 ""。这时必须回空而不是
        // 回密文：密文回填进密码框再保存一次就会被加密第二层，越修越糟
        if (!next) return "";
        if (next === value) break;
        value = next;
    }
    return value;
}

// PBKDF2 派生一次 5 万次迭代。首屏要把每个站点的密码都解一遍，逐个派生同一个密钥
// 会白白拖慢几十倍：同一个 AUTH_SECRET 的派生结果永远不变，按 secret 缓存即可，
// 解 N 个字段只派生一次。缓存的是 Promise 而不是结果，并发调用也不会重复派生。
// 顺带让 decryptSecretDeep 的多层解密（每层都要一次派生）也只付一次代价。
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
    let cached = aesKeyCache.get(secret);
    if (!cached) {
        cached = deriveAesKey(secret);
        aesKeyCache.set(secret, cached);
        // 派生失败别把坏结果永久留在缓存里
        cached.catch(() => aesKeyCache.delete(secret));
    }
    return cached;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
    const raw = await pbkdf2(secret, AES_SALT, AES_ITERS, 32);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// 二进制版（用于备份文件整包加密）：IV(12) + 密文，与 encryptSecret 同套密钥派生。
export async function encryptBytes(plain: Uint8Array, secret: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(secret);
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain)
    );
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
}

export async function decryptBytes(cipher: Uint8Array, secret: string): Promise<Uint8Array> {
    if (cipher.length <= 12) throw new Error("密文过短");
    const iv = cipher.subarray(0, 12);
    const ct = cipher.subarray(12);
    const key = await aesKey(secret);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

// ---------------- 密码强度策略 ----------------
// 改密 / 重置强制：至少 12 位、不能由同一字符重复组成（挡住 000000000000 这类）。
// 不引入额外依赖做弱口令字典，长度门槛对个人站足够，之后可接 zxcvbn。
export function validatePasswordStrength(password: string): { ok: boolean; message: string } {
    if (password.length < 12) {
        return { ok: false, message: "密码至少 12 位" };
    }
    if (/^(.)\1+$/.test(password)) {
        return { ok: false, message: "密码不能由同一字符重复组成" };
    }
    return { ok: true, message: "" };
}
