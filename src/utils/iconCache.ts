// src/utils/iconCache.ts
// 图标本地缓存：把「哪个图标地址能用 / 用不了」记进 IndexedDB，
// 下次打开直接命中，不用再逐个试一遍；失败的地址会被跳过，避免每次都等超时。
// 另外把图标图片本体也缓存下来（icon-blob），弱网/离线重开时图标直接就有，不用等网络。
import { getDomainFromUrl, resolveIconApiUrl } from "./iconApi";

const DB_NAME = "navihive";
const DB_VERSION = 2;
const STORE = "icon-cache";
/** 图标图片本体：图标地址 -> { blob, type, ts } */
const BLOB_STORE = "icon-blob";
/** 最多缓存多少张图标（超出就淘汰最旧的一批，避免 IndexedDB 无限膨胀） */
const BLOB_MAX = 300;
/** 图标本体的有效期：7 天 */
const BLOB_TTL = 7 * 24 * 60 * 60 * 1000;
/** 单张图标超过这个体积就不缓存了（动图/异常大图） */
const BLOB_MAX_BYTES = 200 * 1024;

export type IconRecord = { ok: boolean; ts: number };
export type IconBlobRecord = { blob: Blob; type: string; ts: number };

// 内存里的短期缓存：IndexedDB 打开失败（隐私模式等）时仍然可用
const memoryCache = new Map<string, IconRecord>();
// 图标地址 -> objectURL：同一个地址只创建一次，避免反复 createObjectURL
const objectUrlCache = new Map<string, string>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(resolve => {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
            if (!db.objectStoreNames.contains(BLOB_STORE)) {
                db.createObjectStore(BLOB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });

    return dbPromise;
}

export async function readIconRecord(url: string): Promise<IconRecord | null> {
    if (!url) return null;
    const hit = memoryCache.get(url);
    if (hit) return hit;

    const db = await openDb();
    if (!db) return null;

    try {
        const value = await new Promise<IconRecord | null>(resolve => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).get(url);
            req.onsuccess = () => resolve((req.result as IconRecord) ?? null);
            req.onerror = () => resolve(null);
        });
        if (value) memoryCache.set(url, value);
        return value;
    } catch {
        return null;
    }
}

export async function writeIconRecord(url: string, ok: boolean): Promise<void> {
    if (!url) return;
    const record: IconRecord = { ok, ts: Date.now() };
    memoryCache.set(url, record);

    const db = await openDb();
    if (!db) return;

    try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record, url);
    } catch {
        // 写不进去也不影响使用，内存缓存已经生效
    }
}

/** 淘汰最旧的一批图标本体，控制 IndexedDB 体积 */
async function trimIconBlobs(db: IDBDatabase) {
    const all = await new Promise<{ key: IDBValidKey; ts: number }[]>(resolve => {
        const rows: { key: IDBValidKey; ts: number }[] = [];
        let tx: IDBTransaction;
        try {
            tx = db.transaction(BLOB_STORE, "readonly");
        } catch {
            resolve(rows);
            return;
        }
        const req = tx.objectStore(BLOB_STORE).openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                rows.push({ key: cursor.key, ts: (cursor.value as IconBlobRecord)?.ts ?? 0 });
                cursor.continue();
            } else {
                resolve(rows);
            }
        };
        req.onerror = () => resolve(rows);
    });

    if (all.length <= BLOB_MAX) return;
    all.sort((a, b) => a.ts - b.ts);
    // 一次多删 30 条，省得每次写入都要整理一遍
    const drop = all.slice(0, Math.min(all.length, all.length - BLOB_MAX + 30));

    try {
        const tx = db.transaction(BLOB_STORE, "readwrite");
        const store = tx.objectStore(BLOB_STORE);
        for (const row of drop) store.delete(row.key);
    } catch {
        // 整理失败不影响使用
    }
}

/**
 * 读缓存的图标本体，返回一个可直接给 <img src> 用的 objectURL。
 * 没缓存 / 已过期 / IndexedDB 不可用都返回 null（调用方继续用原地址）。
 */
export async function readIconObjectUrl(url: string): Promise<string | null> {
    if (!url) return null;

    const cached = objectUrlCache.get(url);
    if (cached) return cached;

    const db = await openDb();
    if (!db) return null;

    try {
        const record = await new Promise<IconBlobRecord | null>(resolve => {
            const tx = db.transaction(BLOB_STORE, "readonly");
            const req = tx.objectStore(BLOB_STORE).get(url);
            req.onsuccess = () => resolve((req.result as IconBlobRecord) ?? null);
            req.onerror = () => resolve(null);
        });

        if (!record?.blob) return null;
        // 过期就丢掉，下次重新拉一次
        if (Date.now() - (record.ts || 0) > BLOB_TTL) {
            try {
                const tx = db.transaction(BLOB_STORE, "readwrite");
                tx.objectStore(BLOB_STORE).delete(url);
            } catch {
                // 删不掉也没关系
            }
            return null;
        }

        const objectUrl = URL.createObjectURL(record.blob);
        objectUrlCache.set(url, objectUrl);
        return objectUrl;
    } catch {
        return null;
    }
}

/** 图标地址是否同源（只有同源的才能安全地 fetch 下来，跨域的交给 Service Worker 缓存） */
const isSameOrigin = (url: string) => {
    try {
        return new URL(url, typeof location !== "undefined" ? location.href : undefined).origin ===
            (typeof location !== "undefined" ? location.origin : "");
    } catch {
        return false;
    }
};

/**
 * 把一张已经加载成功的图标存进本地：下次打开直接用 objectURL，不用再走网络。
 * 只处理同源图标（跨域的 fetch 会触发 CORS 报错，那部分由 Service Worker 缓存兜住）。
 */
export async function cacheIconBlob(url: string): Promise<void> {
    if (!url || objectUrlCache.has(url)) return;
    if (!isSameOrigin(url)) return;

    try {
        const res = await fetch(url, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!blob.size || blob.size > BLOB_MAX_BYTES) return;
        if (!blob.type.startsWith("image/")) return;

        const objectUrl = URL.createObjectURL(blob);
        objectUrlCache.set(url, objectUrl);

        const db = await openDb();
        if (!db) return;
        const record: IconBlobRecord = { blob, type: blob.type, ts: Date.now() };
        const tx = db.transaction(BLOB_STORE, "readwrite");
        tx.objectStore(BLOB_STORE).put(record, url);
        tx.oncomplete = () => void trimIconBlobs(db);
    } catch {
        // CORS / 网络失败都是预期内的，忽略即可
    }
}

/** 图标代理地址的前缀：第三方图标从这里转一圈变成同源响应 */
const ICON_PROXY = "/api/icon?u=";

/**
 * 第三方图标统一走本站 /api/icon 代理转一手。
 *
 * 为什么要转：跨域图片的响应是 opaque 的，前端 fetch 不到内容，
 * IndexedDB 里也就存不下 blob；转过一手之后是同源资源，
 * cacheIconBlob 能把它存下来，二次打开这块是零网络请求。
 * 已经是同源的（比如用户自己填的相对路径）不用多绕一圈。
 */
const proxied = (url: string): string => {
    if (!url) return url;
    if (isSameOrigin(url)) return url;
    if (url.startsWith("/")) return url;
    return `${ICON_PROXY}${encodeURIComponent(url)}`;
};

/**
 * 图标候选源：按「越靠前越可信」排序，前一个加载不出来就换下一个。
 * 顺序：站点自带图标 → 配置的图标 API → 站点根目录 favicon → 公共 favicon 服务
 */
export function iconCandidates(
    site: { icon?: string; url?: string },
    iconApi: string
): string[] {
    const list: string[] = [];
    const push = (v?: string) => {
        const value = (v || "").trim();
        if (value && !list.includes(value)) list.push(proxied(value));
    };

    push(site.icon);
    push(resolveIconApiUrl(iconApi, site.url || ""));

    return list;
}

/**
 * 兜底图标源：只有前面两个主源都加载不出来时才用。
 * 拆出来是为了避免每张卡片一上来就排 4 个请求 —— 几百张卡片时，
 * 光是排队等 favicon 超时就能把首屏拖慢好几秒。
 */
export function iconFallbackCandidates(site: { url?: string }): string[] {
    const raw: string[] = [];
    const domain = getDomainFromUrl(site.url || "");
    if (domain) {
        raw.push(`https://${domain}/favicon.ico`);
        raw.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
    }
    return raw.map(proxied);
}
