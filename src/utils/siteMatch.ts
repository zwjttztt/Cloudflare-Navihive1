// src/utils/siteMatch.ts
// **站点匹配**的判据：一个站点能被 `[[…]]` 命中的别名有哪些。
//
// ⚠️ 为什么它必须是一个**独立文件**、而且不许 import 任何东西：
// `src/utils/siteIndex.ts`（模块级站点索引）要用到这里的 `findSiteByTarget`，
// 而 siteIndex 是 **App（首屏）** 直接 import 的。任何要解析 Markdown 的判据
// （历史上那个 `siteNoteLink.ts` 就是）都不能并进来：首屏会为了「点击时认出站名」
// 背上整个 markdown-it —— 实测首屏从 852 KB 涨到 971 KB（gzip +50 KB）。
// ⚠️ 2026-10-23 起那套「正文提到站名就算相关」的启发式已整个删掉（用户要显式绑定），
// 但这条约束继续有效：以后谁想往这里加 Markdown 逻辑，先读这段。
//
// 一句话：**名字/网址匹配不碰 Markdown，碰 Markdown 的不许进首屏。**
/** 站点侧需要的最小信息 */
export interface SiteLinkRef {
    id?: number;
    name: string;
    url: string;
}

/** 笔记侧需要的最小信息 */
export interface NoteLinkRef {
    id?: number;
    title: string;
    content: string;
}

/** 归一化站点名：trim + 小写 + 折叠中间空白（`GitHub  Docs` 与 `github docs` 是同一个） */
export function normalizeSiteLabel(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * URL 归一化：`HTTPS://WWW.Example.com/foo/` → `example.com/foo`。
 *
 * 去掉协议 / www / 尾斜杠，是因为用户手写网址时这四样**每一种都会不一样** ——
 * 不归一的话「笔记里写了 https://x.com，站点里存的是 x.com」就算不相关，
 * 而用户眼里那就是同一个站。
 */
export function siteUrlKey(url: string): string {
    const raw = (url || "").trim();
    if (!raw) return "";
    let s = raw;
    try {
        // 没写协议的（用户最常这么写）补一个再解析，解析完只留 host + path
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
        s = `${u.hostname}${u.pathname}`;
    } catch {
        // 解析不了（写了奇怪的字符）就退回字符串处理，不因此判成「不相关」
        s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[?#]/)[0];
    }
    return s.replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
}

/** 一个站点能被 `[[…]]` 命中的全部别名：站点名、host+path、纯 host */
export function siteMatchKeys(site: SiteLinkRef): string[] {
    const keys = new Set<string>();
    const name = normalizeSiteLabel(site.name || "");
    if (name) keys.add(name);
    const urlKey = siteUrlKey(site.url || "");
    if (urlKey) {
        keys.add(urlKey);
        const host = urlKey.split("/")[0];
        if (host) keys.add(host);
    }
    return [...keys];
}

/**
 * `[[target]]` 是否指的是这个站点。
 *
 * 名字相等 **或** 归一化后的网址相等（用户可能直接把网址写进双链里）。
 */
export function siteMatchesTarget(site: SiteLinkRef, target: string): boolean {
    const t = normalizeSiteLabel(target);
    if (!t) return false;
    const keys = siteMatchKeys(site);
    if (keys.includes(t)) return true;
    // 目标是网址形态时再比一次归一化后的网址
    const tk = siteUrlKey(t);
    return !!tk && keys.includes(tk);
}

/**
 * 在站点列表里找 `[[target]]` 指向的那个。
 *
 * **先按名字、再按网址**：叫「GitHub」的站点和 host 是 github.com 的站点
 * 同时存在时，用户打 `[[GitHub]]` 想的是名字那个（网址那个他打的是网址）。
 */
export function findSiteByTarget(
    sites: readonly SiteLinkRef[],
    target: string
): SiteLinkRef | null {
    const t = normalizeSiteLabel(target);
    if (!t) return null;
    const byName = sites.find(s => normalizeSiteLabel(s.name || "") === t);
    if (byName) return byName;
    const tk = siteUrlKey(t);
    if (!tk) return null;
    return sites.find(s => siteMatchKeys(s).includes(tk)) ?? null;
}
