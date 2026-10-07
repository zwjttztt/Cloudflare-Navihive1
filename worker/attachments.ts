// worker/attachments.ts
// 图片附件的存储与配额（对齐 inkstone 的 worker/attachments/）。
//
// ============================ 为什么这么设计 ============================
//
// **双通道而不是二选一**（照 inkstone 的 backend.ts:17 selectAttachmentStorage）：
//   有 env.FILES(R2) → 用 R2；否则有 env.FILES_KV → 用 KV；都没有 → 禁用图片。
// 用户目前没开通 R2，所以走 KV。但**接口按「两种都在」设计** ——
// 以后开了 R2 只要加一条 wrangler 绑定，代码不用动（也不用改前端）。
//
// **为什么不用 D1 存二进制**：D1 单行上限约 2MB，一张图就顶满了。
// inkstone 在 constants.ts:19 的注释里写明了这一点（正文上限 1.9MB 就是给元数据留的余量）。
//
// **元数据在 D1、二进制在 KV/R2**：
//   KV 单条 25MB、1000 次写入/天、写操作 $1/百万 —— 适合放「不频繁读、偶尔写」的大对象。
//   每天读图是要花 KV 读配额的，所以**正文里存 URL，不存 base64**。
//
// **配额三重**（数值照 inkstone constants.ts:24-26）：
//   单文件 25MB / 单用户总量 1GB / 每小时 100 次。
//   总量用 `SUM(size) WHERE user_id=?` 实时算，不维护累加字段 ——
//   累加字段一旦和实际对象数对不上（删对象失败、并发上传）就永久漂移。
//
// ============================ 并发 ============================
//
// 两个并发上传可能同时读到「已用 900MB」，都认为还能塞 100MB → 实际写了 1.1GB。
// inkstone 用 lease（lib/lease.ts + D1 里的锁行）把同一用户的上传串行化
// （storage.ts:44 persistAttachmentWithinQuota 第一件事就是 acquireLease）。
// 这里照做：拿不到锁就返回 409，让用户稍后重试 —— 宁可拒绝一次，也不能超配额。
//
// =======================================================================

import type { Env } from "./types";

/** 单个文件上限 25MB（与 inkstone attachmentMaxBytes 一致；KV 单条也是 25MB） */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** 单用户总量上限 1GB */
export const ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
/** 每小时上传次数上限 */
export const ATTACHMENT_UPLOADS_PER_HOUR = 100;
/** lease 持有时长：2 分钟。拿不到就返回 409 让用户重试 */
export const ATTACHMENT_LEASE_MS = 2 * 60 * 1000;

const LEASE_KEY = "attachment-quota";
const UPLOAD_RATE_KEY = "attachment-rate";

/** KV prefix —— 备份/导出时要能一眼认出这些不是配置 */
export const ATTACHMENT_PREFIX = "attach/";

export type AttachmentStorage = "r2" | "kv";

/**
 * 选存储通道：有 R2 用 R2，否则退 KV，都没有 → null（图片功能禁用）。
 * 顺序**不能改**：R2 是更合适的通道（读配额便宜、可设缓存头），
 * KV 只是「还没开 R2 时也能用」的降级。
 */
export function selectAttachmentStorage(env: Env): AttachmentStorage | null {
    if (env.FILES) return "r2";
    if (env.FILES_KV) return "kv";
    return null;
}

export function isAttachmentObjectStorage(v: string): v is AttachmentStorage {
    return v === "r2" || v === "kv";
}

/** 对象的 key：`attach/<userId>/<uuid>`。前缀带 userId → 按用户列前缀查即可清理 */
export function attachmentObjectKey(userId: number, id: string): string {
    return `${ATTACHMENT_PREFIX}${userId}/${id}`;
}

/**
 * 只放**图片**。inkstone 的 allowlist（lib/image.ts safeAttachmentMime）：
 * SVG 故意**不在**内 —— 它能带脚本，写进笔记里就是一个 XSS 面；
 * 我们预览层虽然用 KaTeX/React 渲染不 inject HTML，但正文里的
 * `<img src=...svg>` 由浏览器原生解析，绕过了我们的渲染层。
 */
export const SAFE_IMAGE_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
};

/** 上限内的扩展名白名单（存储层/下载层都会用到） */
export function imageExtension(mime: string): string | null {
    return SAFE_IMAGE_MIME[mime] ?? null;
}

/**
 * **按文件头**判定图片类型，不信客户端给的 Content-Type。
 * 只信 Content-Type 的话，传 `image/png` 但内容是 HTML/脚本就绕过了类型限制。
 * （我们最终只把图片渲染进 `<img src>`，不是 innerHTML，风险面比 inkstone 小，
 *  但类型欺骗会让「只允许图片」这条约束形同虚设，所以还是要嗅探。）
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
    const b = bytes;
    if (b.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    // JPEG: FF D8 FF
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    // GIF: "GIF8"
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
    // WEBP: "RIFF" .... "WEBP"
    if (
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) return "image/webp";
    // AVIF: .... "ftypavif"
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
        const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
        if (brand === "avif" || brand === "avis") return "image/avif";
    }
    return null;
}

export interface PersistedAttachment {
    id: string;
    userId: number;
    noteId: number | null;
    filename: string;
    mime: string;
    size: number;
    storage: AttachmentStorage;
    createdAt: number;
}

export type QuotaResult =
    | { ok: true; storage: AttachmentStorage }
    | { ok: false; status: number; error: string };

/**
 * 上传前的三道闸：存储通道 → 租约 → 配额。
 * 顺序照 inkstone storage.ts:44（先拿锁再算配额），否则并发下配额会算错。
 */
export async function checkUploadQuota(env: Env, userId: number, size: number): Promise<QuotaResult> {
    const storage = selectAttachmentStorage(env);
    if (!storage) {
        return {
            ok: false,
            status: 501,
            error: "服务器未配置附件存储（R2 或 KV），图片上传暂不可用",
        };
    }
    if (size <= 0) return { ok: false, status: 400, error: "空文件" };
    if (size > ATTACHMENT_MAX_BYTES) {
        return {
            ok: false,
            status: 413,
            error: `单个文件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB`,
        };
    }
    // ① 租约：同一用户的上传串行化。拿不到直接 409，不排队 —— 宁可让用户重试。
    const lease = await acquireLease(env, LEASE_KEY, ATTACHMENT_LEASE_MS);
    if (!lease) {
        return { ok: false, status: 409, error: "另一个上传正在进行，请稍后重试" };
    }
    try {
        // ② 每小时次数
        const hourAgo = Date.now() - 3600 * 1000;
        const stamps = await listUploadStamps(env, userId);
        const recent = stamps.filter(t => t > hourAgo);
        if (recent.length >= ATTACHMENT_UPLOADS_PER_HOUR) {
            return {
                ok: false,
                status: 429,
                error: `每小时最多上传 ${ATTACHMENT_UPLOADS_PER_HOUR} 张，请稍后再试`,
            };
        }
        // ③ 总量：实时 SUM，不维护累加字段
        const used = await usedBytes(env, userId);
        if (used + size > ATTACHMENT_QUOTA_BYTES) {
            const free = Math.max(0, ATTACHMENT_QUOTA_BYTES - used);
            return {
                ok: false,
                status: 413,
                error: `存储空间不足（每账号 ${Math.round(ATTACHMENT_QUOTA_BYTES / 1024 / 1024)}MB，还剩 ${Math.floor(free / 1024 / 1024)}MB）`,
            };
        }
        return { ok: true, storage };
    } finally {
        await releaseLease(env, lease);
    }
}

/** 已用字节数：实时聚合 attachments 表 */
async function usedBytes(env: Env, userId: number): Promise<number> {
    const row = await env.DB.prepare(
        "SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE user_id = ?1"
    ).bind(userId).first<{ bytes: number }>();
    return Number(row?.bytes ?? 0);
}

/**
 * 每小时上传次数的时间戳列表。
 * 放在 configs 表（KV 里）而不是 attachments 表 —— 后者要按 user_id 扫全表，
 * 而 KV 只是取一个 key。
 */
async function listUploadStamps(env: Env, userId: number): Promise<number[]> {
    const row = await env.DB.prepare("SELECT value FROM configs WHERE key = ?1")
        .bind(`${UPLOAD_RATE_KEY}.${userId}`)
        .first<{ value: string }>();
    if (!row?.value) return [];
    try {
        const parsed: unknown = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
    } catch {
        // 数据坏了宁可当成「0 次」放行，也不要因为一条脏数据把上传功能整体锁死
        return [];
    }
}

/** 记一次上传（只保留最近一小时，数组长度天然有界） */
export async function recordUpload(env: Env, userId: number): Promise<void> {
    const hourAgo = Date.now() - 3600 * 1000;
    const stamps = (await listUploadStamps(env, userId)).filter(t => t > hourAgo);
    stamps.push(Date.now());
    await env.DB.prepare(
        "INSERT INTO configs (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(`${UPLOAD_RATE_KEY}.${userId}`, JSON.stringify(stamps)).run();
}

/** 写二进制对象 */
export async function putAttachmentObject(
    env: Env,
    storage: AttachmentStorage,
    key: string,
    bytes: Uint8Array,
    meta: { userId: number; mime: string }
): Promise<void> {
    if (storage === "r2") {
        if (!env.FILES) throw new Error("R2 未配置");
        await env.FILES.put(key, bytes, {
            httpMetadata: { contentType: meta.mime, cacheControl: "private, no-store" },
            customMetadata: { userId: String(meta.userId) },
        });
        return;
    }
    if (!env.FILES_KV) throw new Error("KV 未配置");
    // ⚠️ KV 单条上限 25MB（与 ATTACHMENT_MAX_BYTES 一致）。
    // 超过会在 put 时报错，所以大小检查必须放在**之前**（checkUploadQuota 已做）。
    // metadata 存的是纯文本，不能塞 Uint8Array —— 这里只放最小必要信息，
    // 真正的 mime 以 D1 attachments 表为准（KV 只是存字节）。
    await env.FILES_KV.put(key, bytes);
}

/** 读二进制对象 */
export async function readAttachmentObject(
    env: Env,
    storage: AttachmentStorage,
    key: string
): Promise<Uint8Array | null> {
    if (storage === "r2") {
        if (!env.FILES) return null;
        const obj = await env.FILES.get(key);
        if (!obj) return null;
        return new Uint8Array(await obj.arrayBuffer());
    }
    if (!env.FILES_KV) return null;
    const raw = await env.FILES_KV.get(key, "arrayBuffer");
    if (!raw) return null;
    return new Uint8Array(raw as ArrayBuffer);
}

/** 删对象 */
export async function deleteAttachmentObject(
    env: Env,
    storage: AttachmentStorage,
    key: string
): Promise<void> {
    if (storage === "r2") {
        if (env.FILES) await env.FILES.delete(key);
        return;
    }
    if (env.FILES_KV) await env.FILES_KV.delete(key);
}

// ---------------- 租约（防并发超配额） ----------------
//
// 用 configs 表的一行做锁：INSERT 抢占、DELETE 释放、value 里写过期时间戳。
// 进程崩了锁不会永久占着 —— 读的时候顺手判断过期就能接管。

interface Lease {
    key: string;
    token: string;
}

async function acquireLease(env: Env, key: string, ttlMs: number): Promise<Lease | null> {
    const token = crypto.randomUUID();
    const expires = Date.now() + ttlMs;
    // INSERT ... ON CONFLICT DO UPDATE WHERE value 里的过期时间已过
    // → 只有「没别人占着」或「上次的人已超时」才抢得到。
    // ⚠️ D1 的 run() 返回值类型是 {}，读 meta.changes 必须显式断言
    // （同 src/API/methods/ai.ts:116 的写法）。
    const res = (await env.DB.prepare(
        `INSERT INTO configs (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(json_extract(configs.value, '$.expires') AS INTEGER) IS NULL
            OR CAST(json_extract(configs.value, '$.expires') AS INTEGER) < ?3`
    ).bind(key, JSON.stringify({ token, expires }), Date.now()).run()) as { meta?: { changes?: number } };
    // changes === 0 = 别人正占着这把锁（或已超时但那人的 DELETE 还没跑到）
    if (!res.meta?.changes) return null;
    return { key, token };
}

async function releaseLease(env: Env, lease: Lease): Promise<void> {
    // 只删自己那把锁：token 对不上说明已经被别人接管了，这时删了会误伤对方
    await env.DB.prepare(
        "DELETE FROM configs WHERE key = ?1 AND json_extract(value, '$.token') = ?2"
    ).bind(lease.key, lease.token).run();
}