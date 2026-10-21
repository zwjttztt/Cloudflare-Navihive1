// src/API/crypto.ts
// 认证相关的安全原语集中放这里：JWT(HS256) 签名/验签、密码哈希(PBKDF2)、凭据静态加密(AES-GCM)。
// 全部走 WebCrypto（Workers 运行时与 Node 22 全局都有 crypto.subtle），零外部依赖、可单测。

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 「由 ArrayBuffer 支撑」的字节视图。
 *
 * TypeScript 5.9 起 `Uint8Array` 是泛型：默认的 `Uint8Array<ArrayBufferLike>` 可以是
 * SharedArrayBuffer 支撑的视图，因此不再满足 WebCrypto 的 `BufferSource`（要求
 * `ArrayBufferView<ArrayBuffer>`）、`BlobPart`、`BodyInit`。而 `subarray()` 会原样保留
 * 所在视图的泛型参数，所以从外部传进来的 `Uint8Array` 未必满足。
 *
 * 本项目所有字节都来自 `new Uint8Array(n)` / `arrayBuffer()` / atob 循环，不存在
 * SharedArrayBuffer 支撑的视图；`asBytes` 只做类型重解释、不拷贝数据（改签名的地方
 * 也尽量用「返回 `Bytes`」而不是到处断言，让约束沿着调用链自然收窄）。
 */
export type Bytes = Uint8Array<ArrayBuffer>;
const asBytes = (view: Uint8Array): Bytes => view as unknown as Bytes;

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
    const [headerB64, body, sig] = parts;

    // 纵深防御：钉死算法与类型。单算法 HS256 下 alg:none 攻击实际不可达（签名比对必失败），
    // 但显式拒绝非预期 header 能挡住未来「多算法共存时降级到 none」这类误配置，
    // 也顺手拦掉 tampered/exp 改写的令牌（header 一变就验不过）。
    try {
        const header = JSON.parse(dec.decode(b64urlDecode(headerB64))) as Record<string, unknown>;
        if (header.alg !== "HS256" || header.typ !== "JWT") return { valid: false };
    } catch {
        return { valid: false };
    }

    const expected = await hmac(secret, enc.encode(`${headerB64}.${body}`));
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

/**
 * 依次用多把密钥验签，任意一把通过就算通过。
 *
 * 用途是「平滑轮换 JWT 密钥」：配了新 JWT_SECRET 之后，此前用旧密钥签发的令牌
 * （30 天「记住我」）不该当场全部掉线，于是把旧值放进 JWT_SECRET_OLD 名单里过渡。
 * 签名永远只用第一把（当前密钥），旧密钥只能验、不能签 —— 轮换过渡结束后把它删掉，
 * 泄露的旧密钥就不再有签发能力。
 */
export async function verifyJwtAny(
    token: string,
    secrets: readonly string[],
    opts?: { tokenVersion?: number }
): Promise<JwtResult> {
    const tried = new Set<string>();
    for (const secret of secrets) {
        if (!secret || tried.has(secret)) continue;
        tried.add(secret);
        const result = await verifyJwt(token, secret, opts);
        if (result.valid) return result;
    }
    return { valid: false };
}

async function hmac(secret: string, data: Uint8Array): Promise<Bytes> {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, asBytes(data)));
}

// ---------------- 密码哈希 (PBKDF2-SHA256) ----------------
// Workers 没有 scrypt/bcrypt，WebCrypto 只给 PBKDF2。
//
// 迭代数**按运行时取值**（2026-10-20）：
//   - Cloudflare Workers：硬上限 10 万，超过直接抛「iteration counts above 100000
//     are not supported」（线上真踩过，见下面备份那段）。所以那边只能 10 万。
//   - 自托管（Node）：没有这个上限，取 OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议值
//     60 万 —— 库被拖走后的离线爆破成本提高 6 倍，登录时多花两三百毫秒，这个交换划算。
//   - 浏览器：同样按 10 万（它只是偶尔参与加密，哈希一律由服务端写）。
//
// 迁移是「新旧并存」而不是「一次性升级」：**迭代数写在哈希串里**（pbkdf2$<iters>$…），
// 校验时按串里记的数算，所以老哈希（10 万）照旧能登、新写的用新值，改一次密码就自动
// 升上去。这与密钥环 keyId 的轮换思路一致：不搞停机迁移。
//
// ⚠️ 只有在 Workers 上才会被夹到 10 万，所以不存在「自托管写了 60 万、搬到 Workers
// 登不进去」这种隐式陷阱 —— 但反过来，把自托管库搬到 Workers 之前要先把密码改一遍。
export const WORKERS_PBKDF2_MAX_ITERS = 100_000;
export const DEFAULT_PBKDF2_ITERS = 600_000;
export const PBKDF2_MIN_ITERS = 100_000;
export const PBKDF2_MAX_ITERS = 1_000_000;
const PWD_PREFIX = "pbkdf2$";

/** 是否跑在 Node 上（自托管）。Workers 与浏览器都是 false。 */
export function isNodeRuntime(): boolean {
    const g = globalThis as { process?: { versions?: { node?: string } } };
    return typeof g.process?.versions?.node === "string";
}

/**
 * 算出「这次该用多少迭代」。纯函数、可单测。
 *
 * Workers 恒为 10 万（硬上限，env 也不放行 —— 给了只会让每次哈希直接抛错）；
 * Node 侧取 env `NAVIHIVE_PBKDF2_ITERS`，缺省 60 万，并夹进 [10 万, 100 万]。
 */
export function resolvePbkdf2Iterations(
    requested?: number | string | null,
    opts: { node?: boolean } = {}
): number {
    const node = opts.node ?? isNodeRuntime();
    const parsed = typeof requested === "number" ? requested : Number(requested ?? "");
    const wanted = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : NaN;
    const fallback = node ? DEFAULT_PBKDF2_ITERS : WORKERS_PBKDF2_MAX_ITERS;
    const base = Number.isNaN(wanted) ? fallback : wanted;
    // 非 Node（Workers / 浏览器）：env 一律无效，直接钉在上限
    if (!node) return Math.min(base, WORKERS_PBKDF2_MAX_ITERS);
    return Math.min(Math.max(base, PBKDF2_MIN_ITERS), PBKDF2_MAX_ITERS);
}

function readEnvIterations(): number | string | undefined {
    // Workers 的 vars 在模块作用域拿不到（只在 handler 的 env 参数里），而它本来就被
    // 夹在 10 万，所以这里只在 Node 侧读。
    if (!isNodeRuntime()) return undefined;
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    return g.process?.env?.NAVIHIVE_PBKDF2_ITERS;
}

/** 当前运行时写新哈希时用的迭代数 */
export function currentPbkdf2Iterations(): number {
    return resolvePbkdf2Iterations(readEnvIterations());
}

/** 读出哈希串里记的迭代数；不是 pbkdf2$ 格式或格式坏了返回 null */
export function storedPbkdf2Iterations(stored: string): number | null {
    if (!isHashedPassword(stored)) return null;
    const iters = Number(stored.slice(PWD_PREFIX.length).split("$")[0]);
    return Number.isFinite(iters) && iters > 0 ? iters : null;
}

/**
 * 这个哈希是不是「低于当前标准」—— 用于将来做登录时静默升级。
 * 现在只是给运维一个可查询的判断，登录链路**没有**自动重写（改写登录路径不值得）。
 */
export function isWeakPbkdf2Hash(stored: string): boolean {
    const iters = storedPbkdf2Iterations(stored);
    return iters !== null && iters < currentPbkdf2Iterations();
}

export function isHashedPassword(stored: string): boolean {
    return stored.startsWith(PWD_PREFIX);
}

export async function hashPassword(password: string): Promise<string> {
    const iters = currentPbkdf2Iterations();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await pbkdf2(password, salt, iters, 32);
    return `${PWD_PREFIX}${iters}$${b64urlEncode(salt)}$${b64urlEncode(derived)}`;
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
): Promise<Bytes> {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: asBytes(salt), iterations, hash: "SHA-256" },
        key,
        length * 8
    );
    return new Uint8Array(bits);
}

// ---------------- 密钥环 + 凭据静态加密 (AES-GCM) ----------------
// 用于 webdav.password 这类「明文落 D1」的敏感字段：D1 导出 / 备份泄露也解不出明文
// （没有服务端密钥即解不开）。每次写入换随机 IV。
//
// 密文自带 keyId，一把钥匙一个编号：
//   keyId 0 —— 由 AUTH_SECRET 派生（升级前的唯一格式，密文里不带编号）
//   keyId 1 —— 由 DATA_ENCRYPTION_KEY 派生
// 这样做的意义是「轮换数据密钥不必停机迁移」：新写入一律用新钥，老密文按自己头上的
// 编号找老钥，两边同时可读。没配 DATA_ENCRYPTION_KEY 时 writeKeyId 仍是 0、
// 格式与升级前逐字节一致 —— 缺失新环境变量等于没启用这个功能，绝不碰已有密文。
const ENC_PREFIX = "enc$";
const AES_SALT_LEGACY = enc.encode("navihive-aes-v1");
const AES_SALT_DATA = enc.encode("navihive-aes-k1");
const AES_ITERS = 50_000;
/** keyId 2/3 的盐长度：随每条密文一起存，GCM 的 nonce 安全性不影响它 */
const SALT_LEN = 16;

export const KEY_ID_LEGACY = 0;
export const KEY_ID_DATA = 1;
/**
 * 2026-10-21（质量评估 4.3）：**随机盐**版本，盐随密文存。
 *
 * 固定盐的问题不是「强度不够」——源密钥本身是 32 字节随机 hex，损失有限 ——
 * 而是**任何人都能预先算好**：拿到一份密文 + 知道盐是常量，就能离线跑
 * PBKDF2 逐个试候选密钥（`navihive-aes-v1` 这种字符串就写在仓库里）。
 * 每条密文一个随机盐，这条路直接断掉。
 *
 * 为什么分成两个编号而不是一个：keyId 必须能表达「这条密文是用哪把源密钥派生的」。
 * 用同一把 AUTH_SECRET 派生的 salted 密文，在后来配上 DATA_ENCRYPTION_KEY 之后
 * 仍要能解 —— 所以 salted 版也按源密钥分 2 / 3。
 */
export const KEY_ID_LEGACY_SALTED = 2;
export const KEY_ID_DATA_SALTED = 3;
export type KeyId =
    | typeof KEY_ID_LEGACY
    | typeof KEY_ID_DATA
    | typeof KEY_ID_LEGACY_SALTED
    | typeof KEY_ID_DATA_SALTED;

/** 这个编号的密文里是不是自带盐（盐在最前面 16 字节） */
export function isSaltedKeyId(id: KeyId): boolean {
    return id === KEY_ID_LEGACY_SALTED || id === KEY_ID_DATA_SALTED;
}

/** 固定盐：只有 0 / 1 用得到（salted 版的盐来自密文本身） */
const KEY_SALTS: Record<typeof KEY_ID_LEGACY | typeof KEY_ID_DATA, Uint8Array> = {
    [KEY_ID_LEGACY]: AES_SALT_LEGACY,
    [KEY_ID_DATA]: AES_SALT_DATA,
};

export interface Keyring {
    /** 新**文本**密文一律用它加密（salted 编号） */
    readonly writeKeyId: KeyId;
    /**
     * 整包二进制（备份文件）用的编号 —— **固定盐**那一个。
     * 二进制格式里没有地方写 keyId，也不会把盐塞进去：备份文件的格式一旦变，
     * 老备份就再也导不回来了。所以这条维持原样（0 或 1）。
     */
    readonly bytesKeyId: KeyId;
    /** 已注册的钥匙编号，第一个是 writeKeyId（解密时按这个顺序兜底） */
    readonly ids: readonly KeyId[];
    /** 固定盐的那几个编号（二进制解密用：没有盐可读） */
    readonly fixedIds: readonly KeyId[];
    /**
     * 取某把钥匙；没注册返回 null（不是抛错——缺钥要能优雅降级）。
     * `salt` 只对 salted 编号有意义，由调用方从密文头上取。
     */
    keyFor(id: KeyId, salt?: Uint8Array): Promise<CryptoKey | null>;
}

export function createKeyring(opts: {
    /** DATA_ENCRYPTION_KEY：独立的数据加密密钥（可选） */
    dataKey?: string;
    /** AUTH_SECRET：旧密钥，同时也是未配置新密钥时的回退（可选） */
    legacySecret?: string;
}): Keyring {
    const dataKey = opts.dataKey ?? "";
    const legacySecret = opts.legacySecret ?? "";
    // 编号 → 源密钥。salted 版与固定盐版**共用同一个源密钥**，只是盐的来源不同。
    const secrets = new Map<KeyId, string>();
    // legacy 永远注册：升级前没配 AUTH_SECRET 时也是拿空串当密钥用的，
    // 这里保持一致，免得「未配置」场景下加密突然变成不可解。
    secrets.set(KEY_ID_LEGACY, legacySecret);
    secrets.set(KEY_ID_LEGACY_SALTED, legacySecret);
    if (dataKey) {
        secrets.set(KEY_ID_DATA, dataKey);
        secrets.set(KEY_ID_DATA_SALTED, dataKey);
    }

    const writeKeyId: KeyId = dataKey ? KEY_ID_DATA_SALTED : KEY_ID_LEGACY_SALTED;
    const bytesKeyId: KeyId = dataKey ? KEY_ID_DATA : KEY_ID_LEGACY;
    // 解密兜底顺序：新写入的 → 整包用的 → 剩下那些历史编号
    const all: KeyId[] = [writeKeyId, bytesKeyId, KEY_ID_DATA_SALTED, KEY_ID_LEGACY_SALTED, KEY_ID_DATA, KEY_ID_LEGACY];
    const ids = [...new Set(all)].filter(id => secrets.has(id));
    const fixedIds = ids.filter(id => !isSaltedKeyId(id));
    return {
        writeKeyId,
        bytesKeyId,
        ids,
        fixedIds,
        async keyFor(id, salt) {
            const secret = secrets.get(id);
            if (secret === undefined) return null;
            // 走 aesKey 缓存而不是直接 deriveAesKey：API 实例是每请求新建的，
            // 不缓存的话每个请求都要重跑一次五万次迭代的 PBKDF2（首屏要解 N 个站点密码）。
            // salted 版的缓存键里带盐，否则不同密文会撞到同一把钥匙。
            const effective = isSaltedKeyId(id) ? salt : undefined;
            if (isSaltedKeyId(id) && !effective) return null;
            try {
                return await aesKey(id, secret, effective);
            } catch {
                // 派生失败别把坏结果留在缓存里反复失败（aesKey 内部已清）
                return null;
            }
        },
    };
}

/**
 * 加解密函数既吃裸字符串（老调用方 / 单测）也吃密钥环。
 * 传字符串 = 只有一把 keyId 0 的钥匙，行为与升级前完全一致。
 */
export type SecretSource = string | Keyring;

// 字符串 → 密钥环要缓存：PBKDF2 五万次迭代，首屏每个站点密码都要解一遍，
// 每次调用重新派生会让首屏慢几十倍。
const stringKeyringCache = new Map<string, Keyring>();
function resolveKeyring(src: SecretSource): Keyring {
    if (typeof src !== "string") return src;
    let ring = stringKeyringCache.get(src);
    if (!ring) {
        ring = createKeyring({ legacySecret: src });
        stringKeyringCache.set(src, ring);
    }
    return ring;
}

export function isEncrypted(stored: string): boolean {
    return stored.startsWith(ENC_PREFIX);
}

/** 拆密文：`enc$<keyId>$<b64>`（带编号）或 `enc$<b64>`（旧，等价于 keyId 0） */
function parseEnc(cipher: string): { keyId: KeyId; payload: string } | null {
    const rest = cipher.slice(ENC_PREFIX.length);
    const m = /^([0-3])\$/.exec(rest);
    if (!m) return { keyId: KEY_ID_LEGACY, payload: rest };
    return { keyId: Number(m[1]) as KeyId, payload: rest.slice(m[0].length) };
}

export async function encryptSecret(plain: string, src: SecretSource): Promise<string> {
    if (!plain) return "";
    const ring = resolveKeyring(src);
    const keyId = ring.writeKeyId;
    const salted = isSaltedKeyId(keyId);
    // 每条密文一个新盐（salted 编号）：断掉「固定盐 → 可预计算」这条路
    const salt = salted ? crypto.getRandomValues(new Uint8Array(SALT_LEN)) : undefined;
    const key = await ring.keyFor(keyId, salt);
    if (!key) return "";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
    const head = salt ? SALT_LEN : 0;
    const out = new Uint8Array(head + 12 + ct.byteLength);
    if (salt) out.set(salt, 0);
    out.set(iv, head);
    out.set(new Uint8Array(ct), head + 12);
    return `${ENC_PREFIX}${keyId === KEY_ID_LEGACY ? "" : `${keyId}$`}${b64urlEncode(out)}`;
}

export async function decryptSecret(cipher: string, src: SecretSource): Promise<string> {
    if (!cipher || !isEncrypted(cipher)) return cipher;
    const parsed = parseEnc(cipher);
    if (!parsed) return "";
    const raw = b64urlDecode(parsed.payload);
    const ring = resolveKeyring(src);
    // salted 编号：盐在 payload 最前面 16 字节；固定盐编号：盐来自常量
    const head = isSaltedKeyId(parsed.keyId) ? SALT_LEN : 0;
    if (raw.length <= head + 12) return "";
    const salt = head ? raw.subarray(0, head) : undefined;
    const iv = raw.subarray(head, head + 12);
    const ct = raw.subarray(head + 12);
    // 先按密文自带的编号解；解不开再依次试其它已注册的钥匙 ——
    // 历史上存在「换过 AUTH_SECRET 后旧密文没重加密」的存量，兜底能让这些数据自愈。
    // ⚠️ 兜底试 salted 编号时**只能用它自己的盐**：盐是逐条随机的，
    // 拿别的盐去试一定失败，白花一次 PBKDF2（五万次迭代，首屏上很贵）。
    for (const id of [parsed.keyId, ...ring.ids.filter((x) => x !== parsed.keyId)]) {
        const keySalt = isSaltedKeyId(id) ? salt : undefined;
        if (isSaltedKeyId(id) && !keySalt) continue;
        const key = await ring.keyFor(id, keySalt);
        if (!key) continue;
        try {
            return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
        } catch {
            // 这把钥匙不对，换下一把
        }
    }
    return "";
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
    src: SecretSource,
    maxDepth = 3
): Promise<string> {
    let value = stored;
    for (let i = 0; i < maxDepth && isEncrypted(value); i++) {
        const next = await decryptSecret(value, src);
        // 解不开（换了密钥等）时 decryptSecret 返回 ""。这时必须回空而不是
        // 回密文：密文回填进密码框再保存一次就会被加密第二层，越修越糟
        if (!next) return "";
        if (next === value) break;
        value = next;
    }
    return value;
}

// PBKDF2 派生一次 5 万次迭代。首屏要把每个站点的密码都解一遍，逐个派生同一个密钥
// 会白白拖慢几十倍：派生结果永远不变，按「keyId + 源密钥」缓存即可，
// 解 N 个字段只派生一次。缓存的是 Promise 而不是结果，并发调用也不会重复派生。
// 顺带让 decryptSecretDeep 的多层解密（每层都要一次派生）也只付一次代价。
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(keyId: KeyId, secret: string, salt?: Uint8Array): Promise<CryptoKey> {
    // 缓存键必须带盐：salted 编号下「同一个 keyId + 同一个 secret」对应的是**每条密文各一把**钥匙，
    // 不带盐就会把不同密文的钥匙混成一把，解密直接错。
    const cacheKey = `${keyId}:${secret}:${salt ? b64urlEncode(salt) : ""}`;
    let cached = aesKeyCache.get(cacheKey);
    if (!cached) {
        cached = deriveAesKey(keyId, secret, salt);
        aesKeyCache.set(cacheKey, cached);
        // 派生失败别把坏结果永久留在缓存里
        cached.catch(() => aesKeyCache.delete(cacheKey));
    }
    return cached;
}

async function deriveAesKey(keyId: KeyId, secret: string, salt?: Uint8Array): Promise<CryptoKey> {
    // salted 编号必须带盐；固定盐编号忽略传入的盐（保持老密文的口径不变）
    const useSalt = isSaltedKeyId(keyId)
        ? (salt as Uint8Array)
        : KEY_SALTS[keyId as typeof KEY_ID_LEGACY | typeof KEY_ID_DATA];
    if (!useSalt) throw new Error("salted keyId 缺少盐");
    const raw = await pbkdf2(secret, useSalt, AES_ITERS, 32);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// 二进制版（用于备份文件整包加密）：IV(12) + 密文，与 encryptSecret 同套密钥派生。
// 裸字节没有地方写 keyId，所以解密时按密钥环里的顺序依次试。
export async function encryptBytes(plain: Uint8Array, src: SecretSource): Promise<Bytes> {
    const ring = resolveKeyring(src);
    // 整包二进制用**固定盐**那把：文件里没有地方写 keyId 与盐，格式必须与历史一致
    const key = await ring.keyFor(ring.bytesKeyId);
    if (!key) throw new Error("没有可用的加密密钥");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, asBytes(plain))
    );
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
}

export async function decryptBytes(cipher: Uint8Array, src: SecretSource): Promise<Bytes> {
    if (cipher.length <= 12) throw new Error("密文过短");
    const buf = asBytes(cipher);
    const iv = buf.subarray(0, 12);
    const ct = buf.subarray(12);
    const ring = resolveKeyring(src);
    // 只试固定盐的编号：salted 那把的盐在密文里根本没存（格式没变），试了必然失败
    for (const id of ring.fixedIds) {
        const key = await ring.keyFor(id);
        if (!key) continue;
        try {
            return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
        } catch {
            // 换下一把
        }
    }
    throw new Error("密文密钥不匹配");
}

// ---------------- 备份文件口令加密 ----------------
// 本地下载 / 离线存档的备份要用用户自己的口令加密：这类文件会落到磁盘、聊天附件、
// 网盘同步目录，从落盘那一刻起就不在服务端 AUTH_SECRET 的保护范围内了。
// 因此不能用固定盐的 aesKey（那是服务端密钥派生），这里每次加密换随机盐。
// 文件格式：MAGIC(13) + salt(16) + IV(12) + 密文，迭代数编在 MAGIC 的版本号里：
// - NAVIHIVE-ENC1：15 万次（历史格式）。浏览器解得动，但 Cloudflare Workers 的
//   PBKDF2 迭代上限是 10 万次 —— WebDAV 的上传/下载都由 Worker 代劳，Worker 侧
//   一解密就抛「Pbkdf2 failed: iteration counts above 100000」，线上真踩过。
// - NAVIHIVE-ENC2：10 万次。浏览器与 Workers 都支持，**新加密一律用它**。
//   两个 MAGIC 长度相同，文件头布局完全一致，只是迭代数不同。
const BACKUP_MAGIC_V1 = "NAVIHIVE-ENC1";
const BACKUP_MAGIC_V2 = "NAVIHIVE-ENC2";
const BACKUP_MAGIC = BACKUP_MAGIC_V2;
const BACKUP_SALT_BYTES = 16;
const BACKUP_IV_BYTES = 12;
const BACKUP_ITERS_V1 = 150_000;
// Workers 的 PBKDF2 上限是 100000（「above 100000 are not supported」），顶格取
const BACKUP_ITERS = 100_000;
const BACKUP_HEADER_BYTES = BACKUP_MAGIC.length + BACKUP_SALT_BYTES + BACKUP_IV_BYTES;

/** 读出文件头魔数；既不是 ENC1 也不是 ENC2 时返回 null */
function backupMagicVersion(bytes: Uint8Array): "v1" | "v2" | null {
    const matches = (magic: string) => {
        if (bytes.length < magic.length) return false;
        for (let i = 0; i < magic.length; i++) {
            if (bytes[i] !== magic.charCodeAt(i)) return false;
        }
        return true;
    };
    if (matches(BACKUP_MAGIC_V1)) return "v1";
    if (matches(BACKUP_MAGIC_V2)) return "v2";
    return null;
}

/** 按文件头判断是不是口令加密过的备份（明文 JSON / gzip 都认不出来） */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
    return backupMagicVersion(bytes) !== null;
}

export async function encryptBackup(plain: Uint8Array, password: string): Promise<Bytes> {
    if (!password) throw new Error("请先设置备份密码");
    const salt = crypto.getRandomValues(new Uint8Array(BACKUP_SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(BACKUP_IV_BYTES));
    const key = await backupKey(password, salt, BACKUP_ITERS);
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, asBytes(plain))
    );
    const out = new Uint8Array(BACKUP_HEADER_BYTES + ct.byteLength);
    out.set(enc.encode(BACKUP_MAGIC), 0);
    out.set(salt, BACKUP_MAGIC.length);
    out.set(iv, BACKUP_MAGIC.length + BACKUP_SALT_BYTES);
    out.set(ct, BACKUP_HEADER_BYTES);
    return out;
}

export async function decryptBackup(cipher: Uint8Array, password: string): Promise<Bytes> {
    const version = backupMagicVersion(cipher);
    if (!version) throw new Error("这不是加密的备份文件");
    const iters = version === "v1" ? BACKUP_ITERS_V1 : BACKUP_ITERS;
    const buf = asBytes(cipher);
    const salt = buf.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + BACKUP_SALT_BYTES);
    const iv = buf.subarray(
        BACKUP_MAGIC.length + BACKUP_SALT_BYTES,
        BACKUP_HEADER_BYTES
    );
    const ct = buf.subarray(BACKUP_HEADER_BYTES);
    let key: CryptoKey;
    try {
        key = await backupKey(password, salt, iters);
    } catch (error) {
        // 只有旧版 15 万次迭代会在 Workers 上撞 PBKDF2 上限：给一句能照着做的提示，
        // 而不是让「Pbkdf2 failed: iteration counts...」这种原文直接糊在用户脸上
        if (
            iters > BACKUP_ITERS &&
            /pbkdf2|iteration/i.test(error instanceof Error ? error.message : String(error))
        ) {
            throw new Error(
                "这份备份是旧版加密格式，当前运行环境不支持它的迭代次数：请把文件下载到本地，用「从本地文件恢复」并输入备份密码",
                { cause: error }
            );
        }
        throw error;
    }
    try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    } catch {
        // AES-GCM 认证失败 = 密码不对或文件被动过，两种情况对用户都是「打不开」
        throw new Error("备份密码不正确，或备份文件已损坏");
    }
}

async function backupKey(
    password: string,
    salt: Uint8Array,
    iterations: number
): Promise<CryptoKey> {
    const raw = await pbkdf2(password, salt, iterations, 32);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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

// ---------------- 恢复密钥 (非对称签名, JWS compact) ----------------
// 找回管理员密码用非对称方案：服务器只持有公钥（AUTH_RECOVERY_PUBLIC_KEY 环境变量
// 或库里的 recovery.publicKey），私钥离线保管，永远不进服务器。管理员用私钥对
// {username,passwordHash,exp,jti} 签名成 JWS，服务端用公钥验签即可重置密码 ——
// 没有私钥造不出合法 token，所以这个公网「恢复」入口是安全的。
//
// 支持两种算法，由 JWS 头的 alg 决定：
//   EdDSA = Ed25519（首选，密钥短）；ES256 = ECDSA P-256（老浏览器不支持 Ed25519 时的退路）
// 公钥统一按 SPKI 容器导入；仅对 32 字节的裸公钥做兼容（早期脚本导出过这种格式）。
const RECOVERY_ALGS = ["EdDSA", "ES256"] as const;

export interface RecoveryPayload {
    username: string;
    passwordHash: string;
    exp: number; // 秒级过期时间戳
    jti: string; // 一次性 nonce，防重放
}

/** 按 alg 导入恢复公钥；失败返回 null */
async function importRecoveryPublicKey(
    alg: string,
    publicKeyB64url: string
): Promise<CryptoKey | null> {
    let raw: Bytes;
    try {
        raw = b64urlDecode(publicKeyB64url);
    } catch {
        return null;
    }
    try {
        if (alg === "ES256") {
            return await crypto.subtle.importKey(
                "spki",
                raw,
                { name: "ECDSA", namedCurve: "P-256" },
                false,
                ["verify"]
            );
        }
        if (alg === "EdDSA") {
            // 32 字节 = 早期脚本导出的裸 Ed25519 公钥，其余按 SPKI 解析
            if (raw.length === 32) {
                try {
                    return await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, [
                        "verify",
                    ]);
                } catch {
                    // 裸公钥导入失败（运行时不支持），继续按 SPKI 试
                }
            }
            return await crypto.subtle.importKey("spki", raw, { name: "Ed25519" }, false, [
                "verify",
            ]);
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 判断一个 base64url 公钥是否是「可用的恢复公钥」，用于写入前的校验：
 * 免得把一段乱码存进库，等到真要找回密码时才发现用不了。
 */
export async function isValidRecoveryPublicKey(publicKeyB64url: string): Promise<boolean> {
    for (const alg of RECOVERY_ALGS) {
        const key = await importRecoveryPublicKey(alg, publicKeyB64url);
        if (key) return true;
    }
    return false;
}

/**
 * 只看一眼恢复令牌里的账号名（不验签）。
 * 多账号下每个账号有自己的恢复公钥，得先知道「这份令牌是给哪个账号的」，
 * 才知道拿哪一把公钥去验。这里解出来的内容只用于挑公钥，令牌随后仍要完整验签 ——
 * 把账号名改成别人也过不了验签那一关。
 */
export function peekRecoveryTokenUsername(token: string): string {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return "";
        const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as {
            username?: unknown;
        };
        return typeof payload?.username === "string" ? payload.username.trim() : "";
    } catch {
        return "";
    }
}

/**
 * 不验签地读一个 JWT payload 字段。
 *
 * 只用于「决定验签该用哪套参数」这类无关信任的场景（比如先知道这是哪个账号的令牌，
 * 才能取它自己的令牌版本号来比对）。任何安全结论都必须由 verifyJwt 得出，
 * 这里的返回值一律当作不可信输入看待。
 */
export function peekJwtClaim(token: string, claim: string): unknown {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return undefined;
        const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as Record<
            string,
            unknown
        >;
        return payload?.[claim];
    } catch {
        return undefined;
    }
}

export async function verifyRecoveryToken(
    token: string,
    publicKeyB64url: string
): Promise<{ valid: boolean; payload?: RecoveryPayload }> {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };
    const [headerB64, payloadB64, sigB64] = parts;

    // 验算法声明
    let alg: string;
    try {
        const header = JSON.parse(dec.decode(b64urlDecode(headerB64)));
        if (header.typ !== "JWS" || !RECOVERY_ALGS.includes(header.alg)) return { valid: false };
        alg = header.alg;
    } catch {
        return { valid: false };
    }

    const key = await importRecoveryPublicKey(alg, publicKeyB64url);
    if (!key) return { valid: false };

    const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
    const sig = b64urlDecode(sigB64);
    // 不同运行时的 WebCrypto 类型定义不一致（Workers / DOM 的验签参数类型名字不同），
    // 直接从 SubtleCrypto.verify 的签名上取，省得为类型名打补丁
    const verifyParams = (
        alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" }
    ) as unknown as Parameters<SubtleCrypto["verify"]>[0];
    let ok: boolean;
    try {
        ok = await crypto.subtle.verify(verifyParams, key, sig, signingInput);
    } catch {
        ok = false;
    }
    if (!ok) return { valid: false };

    let payload: RecoveryPayload;
    try {
        payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as RecoveryPayload;
    } catch {
        return { valid: false };
    }
    if (
        !payload ||
        typeof payload.username !== "string" ||
        !payload.passwordHash ||
        typeof payload.exp !== "number" ||
        typeof payload.jti !== "string"
    ) {
        return { valid: false };
    }
    return { valid: true, payload };
}
