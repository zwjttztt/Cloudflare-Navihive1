// 右下角版本徽标的数据源（components/BuildBadge.tsx）。
//
// 版本号在构建时由 vite.config.ts 的 define 烘进来：
//   __NAVIHIVE_APP_VERSION__  形如 `v0.1.0+c49c59f`（语义版本 + commit 短哈希；
//                             Docker 构建没有 .git 时兜底为构建号，见那里的说明）
//   __NAVIHIVE_BUILD_TIME__   构建机本地时间 "YYYY-MM-DD HH:mm"，进徽标的悬浮提示
//
// 声明成**可选**的原因与 buildVersion.ts 相同：单测跑在 node 里、开发模式也没有
// 这份替换，那时它就是 undefined —— 类型上必须写得出来，否则「没烘进去」这种
// 情况会被类型系统假装不存在。也不放进 vite-env.d.ts 的 declare global：
// moduleDetection force 下 .d.ts 是模块，declare global 跨文件读不到（实测）。

declare const __NAVIHIVE_APP_VERSION__: string | undefined;
declare const __NAVIHIVE_BUILD_TIME__: string | undefined;

/**
 * 本机这一版的部署版本号。
 * 开发模式 / 单测环境（没有 define）读到空串 —— 徽标拿到空串就不渲染。
 */
export function appVersion(): string {
    return typeof __NAVIHIVE_APP_VERSION__ === "string" ? __NAVIHIVE_APP_VERSION__ : "";
}

/** 构建时间；同样只在构建产物里存在，开发模式下为空串 */
export function buildTime(): string {
    return typeof __NAVIHIVE_BUILD_TIME__ === "string" ? __NAVIHIVE_BUILD_TIME__ : "";
}
