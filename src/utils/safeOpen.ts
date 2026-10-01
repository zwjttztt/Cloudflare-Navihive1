// src/utils/safeOpen.ts
// 「打开一个站点」的唯一入口。
//
// 为什么需要它：打开链接这件事散落在五处（卡片左键、右键菜单、键盘回车、
// 搜索面板、命令面板），各写各的 `window.open`。写法不一致的地方就是缺口：
//   - 有两处连 `noopener` 都没给 —— 新页面能通过 `window.opener` 反向操作本站页面
//     （把它导航到钓鱼站就是最典型的用法）；
//   - 所有 `window.open` 路径都**没过协议白名单**，而渲染 `<a href>` 那条是过的。
//     于是「点卡片没事、右键选打开就出事」这种分裂是真实存在的：
//     一条历史数据里的 `javascript:` 链接，右键打开就会在同源于本站的上下文里执行。
//
// 所以判定与打开必须是一个动作：先按白名单审，过不了就**根本不打**，
// 而不是「打开之后指望浏览器拦」。

import { isSafeHttpUrl } from "./url";

export type OpenOutcome =
    /** 已打开 */
    | "opened"
    /** 协议不在白名单：一条都没打开（调用方可以据此提示用户去改这条链接） */
    | "blocked"
    /** 压根没给地址 */
    | "empty";

/**
 * 这个地址现在能不能打开。**渲染与打开共用这一个判定** ——
 * 出 `href` 前问一次，`window.open` 前也问一次，两边不会给出不同答案。
 */
export const canOpenSite = isSafeHttpUrl;

/**
 * 打开一个站点链接，返回实际发生了什么。
 *
 * 两个固定动作，不交给调用方记：
 *   - `noopener`：新页面拿不到 `window.opener`，反向操作本站这条路堵死
 *   - `noreferrer`：外链不带本站地址（搜索面板里那些外站不该知道你从哪点过来）
 */
export function safeOpenSite(url?: string | null): OpenOutcome {
    const value = (url || "").trim();
    if (!value) return "empty";
    if (!canOpenSite(value)) return "blocked";
    if (typeof window === "undefined") return "blocked";
    // 浏览器弹窗拦截会让 open 返回 null；那不是「地址有问题」，但仍算没打开
    const win = window.open(value, "_blank", "noopener,noreferrer");
    return win ? "opened" : "blocked";
}

/**
 * 批量打开（命令面板里「打开整组」这类）。
 * 只在用户手势里同步调用才不会被弹窗拦截 —— 放进 setTimeout / await 之后基本白搭。
 */
export function safeOpenSites(urls: Array<string | null | undefined>): {
    opened: number;
    blocked: number;
} {
    let opened = 0;
    let blocked = 0;
    for (const url of urls) {
        const outcome = safeOpenSite(url);
        if (outcome === "opened") opened++;
        else if (outcome === "blocked") blocked++;
    }
    return { opened, blocked };
}
