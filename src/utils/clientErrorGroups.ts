// src/utils/clientErrorGroups.ts
// 「前端错误上报」的归并规则（2026-10-22，3.3 mock 同源化第一批）。
//
// 前端把 window.onerror / unhandledrejection 报上来，detail 是一段 JSON。
// 一条条看没有意义（一次渲染抖动能刷几十条），要按「同一个错误」折起来看次数与最后时间。
//
// ⚠️ 为什么必须同源：这段规则原先在 audit.ts（真机）和 mock.ts（本地演示）各有一份，
//    而且**已经分叉了** —— 真机版会把出错路径收集进 `paths`（最多 3 条），
//    mock 版压根没收集，`paths` 永远是空数组。于是「本地看着一切正常」
//    而真机上多出来的那几列信息从没人注意过。规则只有一份，才不会这样悄悄走偏。
//
// ⚠️ 另一处分叉：真机版用 `typeof parsed.source === "string" && parsed.source`
//    做类型防御，mock 版直接 `parsed.source || "unknown"` ——
//    若上报里 source 是个数字，mock 会把 `123` 当来源名，真机则是 "unknown"。
//    这里统一成严格版（只认非空字符串）：日志字段宁可是 unknown，也不要混进奇怪类型。

/** 消息最多留多少字（太长会把界面撑开，也没人读得完） */
export const CLIENT_ERROR_MESSAGE_MAX = 200;
/** 归并键里消息最多取多少字：前缀相同就算同一类错误 */
export const CLIENT_ERROR_KEY_MAX = 120;
/** 每条归并结果最多记几条出错路径 */
export const CLIENT_ERROR_MAX_PATHS = 3;
/** 兜底消息：detail 是空的/不是 JSON 时用 */
export const CLIENT_ERROR_EMPTY_MESSAGE = "（无错误信息）";

export interface ClientErrorRow {
    /** 上报的原始 detail（正常是 JSON，也可能因为老版本/手写而是一段裸文本） */
    detail: string | null;
    /** 这条记录的时间（SQLite datetime 字符串，直接按字符串比大小） */
    created_at: string;
}

export interface ClientErrorGroup {
    /** 归并键：`source|message 前 120 字` */
    key: string;
    source: string;
    message: string;
    count: number;
    /** 最近一次出现的时间（字符串，取最大） */
    lastAt: string;
    /** 出错过的最多 3 条路径 */
    paths: string[];
}

/**
 * 把一批审计行归并成「一个错误一条」。
 *
 * 顺序：按传入顺序累计；输出按出现次数降序（同次数则最近出现的排前面）——
 * 界面上最该先看到的是「刷得最多的那个」。
 */
export function groupClientErrors(rows: ClientErrorRow[]): ClientErrorGroup[] {
    const groups = new Map<string, ClientErrorGroup>();

    for (const row of rows) {
        const raw = row.detail ?? "";
        let parsed: { source?: unknown; message?: unknown; path?: unknown } = {};
        try {
            parsed = JSON.parse(raw || "{}") as typeof parsed;
        } catch {
            // 老记录 / 手写记录可能不是 JSON：整条当消息，至少还能看见
            parsed = { message: raw.slice(0, CLIENT_ERROR_MESSAGE_MAX) };
        }

        const source =
            typeof parsed.source === "string" && parsed.source ? parsed.source : "unknown";
        const message =
            typeof parsed.message === "string" && parsed.message
                ? parsed.message
                : (raw || CLIENT_ERROR_EMPTY_MESSAGE).slice(0, CLIENT_ERROR_MESSAGE_MAX);
        const key = `${source}|${message.slice(0, CLIENT_ERROR_KEY_MAX)}`;
        const path = typeof parsed.path === "string" && parsed.path ? parsed.path : "";

        const existing = groups.get(key);
        if (existing) {
            existing.count += 1;
            if (row.created_at > existing.lastAt) existing.lastAt = row.created_at;
            if (path && !existing.paths.includes(path) && existing.paths.length < CLIENT_ERROR_MAX_PATHS) {
                existing.paths.push(path);
            }
            continue;
        }
        groups.set(key, {
            key,
            source,
            message,
            count: 1,
            lastAt: row.created_at ?? "",
            paths: path ? [path] : [],
        });
    }

    return [...groups.values()].sort(
        (a, b) => b.count - a.count || (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0)
    );
}
