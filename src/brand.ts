// src/brand.ts
// 公开品牌配置的唯一来源。
//
// 以前「站点叫什么」散在四处：登录页写死一个常量、index.html 里的 <title>、
// manifest 的 name / short_name、还有设置里的 site.title。改一处就漂移一次，
// 登录页永远显示脚手架留下来的名字。
//
// 这里只放**可以公开**的东西：名字、一句话介绍、主题色。
// 不放域名、账号、密钥、内部路径 —— 这个文件会被打进前端 bundle，任何人都能读到。
// manifest 与 index.html 由 `npm run sync:brand`（script/sync-brand.mjs）从这里生成，
// 一致性由 tests/brand.test.ts 钉住，漂了 CI 会红。
export const BRAND = {
    /** 短名：登录页标题、manifest.short_name、apple-mobile-web-app-title */
    name: "Navihive",
    /** 全名：站点标题、manifest.name、og:site_name */
    fullName: "Navihive 导航站",
    description: "个人导航站，整理和分享您喜爱的网站链接",
    themeColor: "#1976d2",
} as const;

/**
 * 站点显示名：设置里改过标题就用改过的，没改过（或改空了）回落到品牌全名。
 * 这样自托管的人改一次「网站标题」，登录页、标题栏、分享卡片跟着一起变。
 */
export function brandTitle(customTitle?: string | null): string {
    const trimmed = (customTitle ?? "").trim();
    return trimmed || BRAND.fullName;
}
