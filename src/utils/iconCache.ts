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

/**
 * 「这个图标源能用」这条记事的保质期。
 *
 * 站点换图标是常事：换了新的 favicon，我们却永远记得「老地址能用」，
 * 于是每次都命中老地址 —— 用户看到的是几个月前的图标，刷新也没用。
 * 到期就当作没记过，重新走一次网络；网络拿到的是新图，顺手把 blob 也换了。
 */
export const ICON_OK_TTL = 7 * 24 * 60 * 60 * 1000;
/**
 * 失败负缓存的保质期（比成功那条短得多）。
 *
 * 负缓存是必要的：几百张卡片每张都去试一个注定 404 的地址，光等超时就能把首屏拖垮。
 * 但它**不能是永久的** —— 站点今天装上 favicon、图标服务今天恢复，
 * 一次失败就判终身出局的话，那个图标永远不会再回来。
 */
export const ICON_FAIL_TTL = 24 * 60 * 60 * 1000;

/** 一条记事现在还算不算数（过期 = 当作没记过，重新试一次） */
export function isIconRecordFresh(record: IconRecord | null, now = Date.now()): boolean {
    if (!record) return false;
    const ttl = record.ok ? ICON_OK_TTL : ICON_FAIL_TTL;
    return now - (record.ts || 0) < ttl;
}

// 内存里的短期缓存：IndexedDB 打开失败（隐私模式等）时仍然可用
const memoryCache = new Map<string, IconRecord>();

/**
 * 图标地址 -> objectURL。
 *
 * objectURL 是**拿着不放的资源**：每一个都钉住一份内存里的 blob，不 revoke 就永远不释放，
 * 卡片来回切分组 / 长会话挂着，这个 Map 会一路涨到几百条。所以这里记引用数：
 * 谁拿到谁负责还（releaseIconObjectUrl），没人引用了再按 LRU 淘汰掉并 revoke。
 */
const objectUrlCache = new Map<string, { url: string; refs: number; lastUse: number }>();
/** 没人引用的 objectURL 最多留这么多，超了按最久没用的先 revoke */
const OBJECT_URL_IDLE_MAX = 120;

/**
 * objectURL 的创建器。抽出来是因为它没法在 node 测试里用（那边没有真的 Blob URL），
 * 测试替换成计数器就能验证「借了有没有还」，不用真的去建 URL。
 */
let objectUrlFactory: (blob: Blob) => string = blob => URL.createObjectURL(blob);
export function setIconObjectUrlFactoryForTest(factory: (blob: Blob) => string): void {
    objectUrlFactory = factory;
}

/** 淘汰没人引用的 objectURL：留 OBJECT_URL_IDLE_MAX 条最近用过的，其余 revoke 掉 */
function trimIdleObjectUrls(): void {
    const idle: { key: string; lastUse: number }[] = [];
    for (const [key, entry] of objectUrlCache) {
        if (entry.refs === 0) idle.push({ key, lastUse: entry.lastUse });
    }
    if (idle.length <= OBJECT_URL_IDLE_MAX) return;

    idle.sort((a, b) => a.lastUse - b.lastUse);
    for (const { key } of idle.slice(0, idle.length - OBJECT_URL_IDLE_MAX)) {
        const entry = objectUrlCache.get(key);
        if (!entry) continue;
        objectUrlCache.delete(key);
        try {
            URL.revokeObjectURL(entry.url);
        } catch {
            // 已经失效的 URL，撤不掉没关系
        }
    }
}

/** 归还一个 objectURL（readIconObjectUrl 拿到的每一个都要还） */
export function releaseIconObjectUrl(url: string): void {
    const entry = objectUrlCache.get(url);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) trimIdleObjectUrls();
}

/**
 * 为一个 blob 取 objectURL（同一个地址复用同一个），引用数 +1。
 *
 * 单独暴露出来是为了能在没有 IndexedDB 的环境里验证借还配对 ——
 * 否则 objectURL 那部分只能靠「线上跑一段时间看内存涨不涨」来发现泄漏。
 */
export function acquireIconObjectUrl(url: string, blob: Blob): string {
    const existing = objectUrlCache.get(url);
    if (existing) {
        existing.refs++;
        existing.lastUse = Date.now();
        return existing.url;
    }
    const created = objectUrlFactory(blob);
    objectUrlCache.set(url, { url: created, refs: 1, lastUse: Date.now() });
    return created;
}

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

export async function readIconRecord(url: string, now = Date.now()): Promise<IconRecord | null> {
    if (!url) return null;

    // 内存里的那份也要看保质期：进程没重启不等于记事还作数
    const hit = memoryCache.get(url);
    if (hit) {
        if (isIconRecordFresh(hit, now)) return hit;
        memoryCache.delete(url);
    }

    const db = await openDb();
    if (!db) return null;

    try {
        const value = await new Promise<IconRecord | null>(resolve => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).get(url);
            req.onsuccess = () => resolve((req.result as IconRecord) ?? null);
            req.onerror = () => resolve(null);
        });
        if (!value) return null;
        if (!isIconRecordFresh(value, now)) {
            // 过期就顺手清掉，省得 IndexedDB 里堆一堆永远不会被读的旧记事
            memoryCache.delete(url);
            try {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).delete(url);
            } catch {
                // 清不掉不影响使用
            }
            return null;
        }
        memoryCache.set(url, value);
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

    // 命中：引用数 +1，用完必须 releaseIconObjectUrl 还回来
    const cached = objectUrlCache.get(url);
    if (cached) {
        cached.refs++;
        cached.lastUse = Date.now();
        return cached.url;
    }

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

        return acquireIconObjectUrl(url, record.blob);
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
    // 已经有一份在用的就别重复抓（objectUrlCache 现在存的是带引用数的条目）
    if (!url || objectUrlCache.has(url)) return;
    if (!isSameOrigin(url)) return;

    try {
        const res = await fetch(url, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!blob.size || blob.size > BLOB_MAX_BYTES) return;
        if (!blob.type.startsWith("image/")) return;

        // 只建引用数 0 的条目：调用方（卡片）稍后会自己 read 一份并拿走引用，
        // 这里不该替它占着 —— 否则这张卡片卸载后引用永远归不了零
        objectUrlCache.set(url, { url: objectUrlFactory(blob), refs: 0, lastUse: Date.now() });
        trimIdleObjectUrls();

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
