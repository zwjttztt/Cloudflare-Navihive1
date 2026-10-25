// src/utils/vaultCrypto.ts
// 保险库（方案 B，端到端加密）的**加密层** —— 纯函数，全部走 WebCrypto。
//
// ⚠️ 这是全仓唯一「写错会让用户数据永久读不出来」的模块，所以它**先写、先测、独立可验证**，
// 且刻意不依赖任何 React / 网络 / 存储：密钥分层与加解密都在这里，上层（API/UI）只管搬密文。
//
// 密钥分层（envelope，为什么不一上来就拿主密码直接加密条目，见 docs/password-manager-plan-B.md）：
//
//   主密码  ──PBKDF2(盐, iters)──▶ MK(包装钥,仅内存)
//   恢复码  ──PBKDF2(盐, iters)──▶ RK(包装钥,仅内存)
//                                   │ 都用 AES-GCM 包/解 同一份 DEK
//                                   ▼
//   随机 DEK(数据钥,仅内存) ──逐条目 AES-GCM(各自随机 IV)──▶ 密文
//
// 服务端只存：kdf_salt / kdf_iterations / 用 MK 包的 wrapped_dek / 用 RK 包的 wrapped_dek_recovery /
// 每条目的 ciphertext+iv。**服务端（与任何拿到库的人）解不出明文，也数不出条目内容。**
//
// KDF 在**浏览器**跑，没有 Worker 50ms CPU 预算，所以迭代数用 OWASP 量级（默认 60 万）。
// 迭代数随记录存服务端，将来要上调只需用新 iters 重裹一次 DEK，不必惊动任何条目。

/** PBKDF2 迭代数（客户端跑，无 Worker 预算；随记录落库便于将来平滑上调） */
export const VAULT_KDF_ITERS = 600_000;
/** 盐长度（字节） */
const SALT_LEN = 16;
/** AES-GCM IV 长度（字节，WebCrypto 推荐 12） */
const IV_LEN = 12;
/** DEK 长度（bit） */
const DEK_LEN = 256;
/** 恢复码随机字节数（25 字节 = 200 bit 熵） */
const RECOVERY_BYTES = 25;

/** 一段 AES-GCM 密文 + 它的 IV（IV 不保密，但必须与密文一起存/传） */
export interface EncryptedBlob {
    iv: Uint8Array;
    ciphertext: Uint8Array;
}

// ---------------- 随机数 ----------------

function randomBytes(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
}

/** 生成 KDF 盐（16 字节）。盐可公开，只是为了抗彩虹表。 */
export function generateSalt(): Uint8Array {
    return randomBytes(SALT_LEN);
}

// ---------------- base64（存储层用；btoa/atob 在浏览器与 Node 16+ 都是全局） ----------------

export function bytesToB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

// ---------------- 包装钥（MK / RK 都走这里） ----------------

/**
 * 从一段秘密（主密码 或 恢复码）派生 AES-GCM 包装钥。
 * PBKDF2-HMAC-SHA256 → 256-bit AES-GCM key（不可导出，仅内存）。
 */
export async function deriveWrappingKey(
    secret: string,
    salt: Uint8Array,
    iterations: number
): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: DEK_LEN },
        false,
        ["encrypt", "decrypt"]
    );
}

// ---------------- DEK（数据钥） ----------------

/** 生成随机 DEK（AES-GCM 256）。可导出——包/重包 DEK 需要它的原始字节，它只活在内存里。 */
export async function generateDek(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: DEK_LEN }, true, ["encrypt", "decrypt"]);
}

/** 用包装钥包住 DEK（AES-GCM 加密 DEK 的原始字节）。产出可存服务端。 */
export async function wrapDek(dek: CryptoKey, wrappingKey: CryptoKey): Promise<EncryptedBlob> {
    const raw = await crypto.subtle.exportKey("raw", dek);
    const iv = randomBytes(IV_LEN);
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        wrappingKey,
        raw as unknown as BufferSource
    );
    return { iv, ciphertext: new Uint8Array(ct) };
}

/**
 * 用包装钥解出 DEK。
 * ⚠️ 密码错 / 密文被改 → AES-GCM 认证失败 → crypto.subtle.decrypt 抛错，
 * 调用方据此判定「密码不对」——验证这件事由加密算法本身完成，不需要另存密码校验值。
 */
export async function unwrapDek(blob: EncryptedBlob, wrappingKey: CryptoKey): Promise<CryptoKey> {
    const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.iv as unknown as BufferSource },
        wrappingKey,
        blob.ciphertext as unknown as BufferSource
    );
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// ---------------- 恢复码 ----------------

/** 生成一次性恢复码：200 bit 熵，大写十六进制、每 5 位一组、10 组（如 `A3F9K-...`）。 */
export function generateRecoveryCode(): string {
    const hex = Array.from(randomBytes(RECOVERY_BYTES), b => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    return (hex.match(/.{1,5}/g) || []).join("-");
}

/** 归一化用户输入的恢复码：去空白/连字符、转大写，方便照抄时带不带分隔符都能解。 */
export function normalizeRecoveryCode(code: string): string {
    return (code || "").replace(/[\s-]/g, "").toUpperCase();
}

// ---------------- 条目加解密 ----------------

/** 用 DEK 加密一个条目（整体 JSON 信封：标题/URL/用户名/密码/备注全在里面）。 */
export async function encryptJson(dek: CryptoKey, value: unknown): Promise<EncryptedBlob> {
    const iv = randomBytes(IV_LEN);
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        dek,
        pt as unknown as BufferSource
    );
    return { iv, ciphertext: new Uint8Array(ct) };
}

/** 用 DEK 解出一个条目。密码错/被改 → 抛错。 */
export async function decryptJson<T = unknown>(dek: CryptoKey, blob: EncryptedBlob): Promise<T> {
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.iv as unknown as BufferSource },
        dek,
        blob.ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
}
