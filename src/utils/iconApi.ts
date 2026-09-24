// src/utils/iconApi.ts
// 图标 API 地址解析：把配置里的模板（含 {domain} 等占位符）与站点链接组合成可直接使用的图标 URL

// 默认图标 API：不填时用这个
export const DEFAULT_ICON_API =
    "https://www.faviconextractor.com/favicon/{domain}?larger=true";

/**
 * 从站点链接中提取域名（含子域，例如 www.example.com）
 * 链接非法时返回空字符串
 */
export function getDomainFromUrl(siteUrl: string): string {
    const raw = (siteUrl || "").trim();
    if (!raw) return "";

    try {
        return new URL(raw).hostname;
    } catch {
        // 用户可能只填了 example.com，容错补一个协议再试
        try {
            return new URL(`https://${raw}`).hostname;
        } catch {
            return "";
        }
    }
}

/**
 * 按配置的模板生成图标 URL
 *
 * 支持的占位符：
 *   {domain} / {host} → 完整主机名（含子域，如 www.yunso.net）
 *   {origin}          → 协议 + 主机名（如 https://www.yunso.net）
 *   {url}             → 站点完整链接
 *
 * 模板为空时回退到 DEFAULT_ICON_API；站点链接非法时返回空字符串。
 */
export function resolveIconApiUrl(template: string, siteUrl: string): string {
    const tpl = (template || "").trim() || DEFAULT_ICON_API;
    const domain = getDomainFromUrl(siteUrl);
    if (!domain) return "";

    let origin = `https://${domain}`;
    try {
        origin = new URL(siteUrl).origin;
    } catch {
        // 忽略：用兜底 origin
    }

    return tpl
        .replace(/\{domain\}/gi, domain)
        .replace(/\{host\}/gi, domain)
        .replace(/\{origin\}/gi, origin)
        .replace(/\{url\}/gi, siteUrl);
}
