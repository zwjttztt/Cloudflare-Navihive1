// src/utils/addSiteDeepLink.ts
// 站外「一键收藏」的深链：`https://<你的站点>/?add-site=<base64url>`
//
// 浏览器扩展（extension/）点一下就把当前网页的标题与地址带过来，页面据此直接打开
// 「新增站点」弹窗并填好字段 —— 用户只需要选分组、点保存。
//
// 为什么走 URL 参数而不是让扩展直接打 API：写接口要带登录态（httpOnly cookie + CSRF），
// 扩展想复用它得申请 cookies 权限、还要处理跨域与令牌过期，等于把鉴权面扩大一圈。
// 深链的做法是「把意图交给页面，由已登录的页面自己去写」，扩展那边不需要任何凭据。
//
// 两个刻意的取舍：
//   1. 参数用 base64url 而不是明文 query：标题里常有 & ? # 和中文，明文拼 query 会
//      被截断或转义成一团乱码；base64url 只含 [A-Za-z0-9_-]，塞进任何位置都安全。
//   2. **用完立刻从地址栏抹掉**：不抹的话刷新一次就会再弹一次，分享出去的链接也会
//      一直带这个意图 —— 意图只应兑现一次。

/** 查询参数名。改名必须同步改 extension/ 与 deploy/selfhost.md 的说明 */
export const ADD_SITE_PARAM = "add-site";

export interface AddSitePrefill {
    /** 站点链接。必填：没有链接的收藏没有意义 */
    url: string;
    /** 站点名称（扩展默认取页面标题） */
    name?: string;
    /** 图标 URL（扩展默认取页面的 favicon） */
    icon?: string;
    /** 描述 / 备注 */
    description?: string;
}

function toBase64Url(text: string): string {
    const bin = String.fromCharCode(...new TextEncoder().encode(text));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - b64.length % 4) : "";
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/** 把意图编成查询参数的值（纯函数，可单测） */
export function encodeAddSitePrefill(prefill: AddSitePrefill): string {
    return toBase64Url(JSON.stringify(prefill));
}

/**
 * 解析参数值。坏数据一律返回 null ——
 * 一个手滑打错的链接不该把弹窗开成一个字段全空的壳子，那比不开更让人困惑。
 */
export function decodeAddSitePrefill(raw: string | null | undefined): AddSitePrefill | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(fromBase64Url(raw)) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const { url, name, icon, description } = parsed as Record<string, unknown>;
        if (typeof url !== "string" || !url) return null;
        const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
        return { url, name: pick(name), icon: pick(icon), description: pick(description) };
    } catch {
        return null;
    }
}

/** 从整串 query（`location.search`，带不带 ? 都行）里读出意图 */
export function readAddSitePrefill(search: string): AddSitePrefill | null {
    const qs = search.startsWith("?") ? search.slice(1) : search;
    const value = new URLSearchParams(qs).get(ADD_SITE_PARAM);
    return decodeAddSitePrefill(value);
}

/** 拼出给扩展/书签用的完整链接 */
export function buildAddSiteLink(base: string, prefill: AddSitePrefill): string {
    const url = new URL(base);
    url.searchParams.set(ADD_SITE_PARAM, encodeAddSitePrefill(prefill));
    return url.toString();
}

/**
 * 抹掉地址栏里的意图参数。
 * 用 replaceState 而不是 pushState：这不算一次导航，用户按返回键不该「回到弹窗」。
 */
export function clearAddSiteParam(): void {
    const url = new URL(location.href);
    if (!url.searchParams.has(ADD_SITE_PARAM)) return;
    url.searchParams.delete(ADD_SITE_PARAM);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
