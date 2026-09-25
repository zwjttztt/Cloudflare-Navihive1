// src/utils/iconCache.ts
// 图标本地缓存：把「哪个图标地址能用 / 用不了」记进 IndexedDB，
// 下次打开直接命中，不用再逐个试一遍；失败的地址会被跳过，避免每次都等超时。
import { getDomainFromUrl, resolveIconApiUrl } from "./iconApi";

const DB_NAME = "navihive";
const DB_VERSION = 1;
const STORE = "icon-cache";

export type IconRecord = { ok: boolean; ts: number };

// 内存里的短期缓存：IndexedDB 打开失败（隐私模式等）时仍然可用
const memoryCache = new Map<string, IconRecord>();

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
        if (value && !list.includes(value)) list.push(value);
    };

    push(site.icon);
    push(resolveIconApiUrl(iconApi, site.url || ""));

    const domain = getDomainFromUrl(site.url || "");
    if (domain) {
        push(`https://${domain}/favicon.ico`);
        push(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
    }

    return list;
}
