// src/utils/undoPersist.ts
// 撤销栈的跨刷新保留：把「能靠数据重放」的那几步写进 localStorage。
//
// 撤销栈平时是命令模式（每条记着一个 undo 闭包），闭包没法存进 localStorage ——
// 所以这里只挑**重放不需要闭包**的操作：改卡片就是把 before 写回去，纯数据就能倒回去。
// 删除不走这条路：它已经有回收站兜底（那才是跨刷新的正解），没必要再存一份。
//
// 存是有代价的：卡片里可能有站点密码。所以它跟着两条限制：只留最近几步、超过一天作废，
// 并且刷新后恢复时会先确认卡片还在（不在了就丢弃，避免把一张早删掉的卡片写回来）。
import type { Site } from "../API/http";
import { scopedKey } from "./accountScope";

/** 一条可以跨刷新重放的撤销记录 */
export type PersistedUndo = {
    kind: "site-edit";
    /** 提示条 / 读屏用的一句话说明 */
    label: string;
    /** 记录时间（毫秒）；超过一天就作废 */
    at: number;
    siteId: number;
    /** 改之前的那一版 */
    before: Site;
    /** 改之后的那一版 */
    after: Site;
};

const STORAGE_KEY = "navihive:persistedUndo";
/** 只留最近几步：多了 localStorage 里就常年躺着一堆卡片内容 */
const MAX_ITEMS = 10;
/** 超过一天就不认了：隔了这么久再撤销，多半已经不是当时那回事 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 当前账号；换人登录时各自一份，不会看见上一个人的撤销快照 */
let accountUid: number | null = null;

/** 绑定账号：换人时换一份存储，旧账号的快照留着但读不到 */
export function setUndoAccountUid(uid: number | null): void {
    accountUid = uid;
}

const key = () => scopedKey(STORAGE_KEY, accountUid);

/**
 * 抹掉站点里的凭据再落盘。
 *
 * 撤销快照整份存在浏览器里、还是明文 JSON —— 站点密码跟着一起躺在那儿，
 * 任何人摸到这台机器（或任意一个能读同源存储的脚本）就能把密码从 localStorage 里
 * 翻出来。撤销「改卡片」本来也不需要凭据：重放时只把业务字段写回去，
 * 凭据保持库里的现状，于是把这两个字段留空即可。
 */
function stripSecrets(site: Site): Site {
    if (!site) return site;
    return { ...site, username: "", password: "" };
}

function isSiteLike(value: unknown): value is Site {
    if (!value || typeof value !== "object") return false;
    const site = value as Partial<Site>;
    return typeof site.id === "number" && typeof site.name === "string";
}

/** 反序列化后的形状校验：坏数据一律丢弃（宁可少一步撤销，也别把脏东西写回库里） */
export function isPersistedUndo(value: unknown): value is PersistedUndo {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<PersistedUndo>;
    if (item.kind !== "site-edit") return false;
    if (typeof item.siteId !== "number" || typeof item.at !== "number") return false;
    if (typeof item.label !== "string") return false;
    return isSiteLike(item.before) && isSiteLike(item.after);
}

/**
 * 读出还能用的记录（坏的、过期的自动丢掉）。
 *
 * 顺带做一次**物理清理**：过期条目以前只是「读的时候过滤掉」，盘上一直留着；
 * 现在读完就只把有效的写回去，过期的当场删掉，不再躺着等别人来翻。
 */
export function loadPersistedUndo(now = Date.now()): PersistedUndo[] {
    try {
        const raw = localStorage.getItem(key());
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const valid = parsed.filter(
            item => isPersistedUndo(item) && now - item.at < MAX_AGE_MS
        ) as PersistedUndo[];
        if (valid.length !== parsed.length) {
            // 有坏的 / 过期的：把剩下的写回去，等于顺手清掉
            savePersistedUndo(valid);
        }
        return valid;
    } catch {
        return [];
    }
}

/** 写入（超过上限丢最旧的、凭据不落盘）。localStorage 不可用时静默放弃 —— 撤销少一步不是大事 */
export function savePersistedUndo(list: PersistedUndo[]): void {
    try {
        const trimmed = list.slice(-MAX_ITEMS).map(item => ({
            ...item,
            before: stripSecrets(item.before),
            after: stripSecrets(item.after),
        }));
        if (trimmed.length === 0) {
            localStorage.removeItem(key());
            return;
        }
        localStorage.setItem(key(), JSON.stringify(trimmed));
    } catch {
        /* 隐私模式 / 配额满：忽略 */
    }
}

export function clearPersistedUndo(): void {
    try {
        localStorage.removeItem(key());
    } catch {
        /* 同上 */
    }
}
