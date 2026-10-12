// shared/maintenance.ts
// 维护模式的共享键名（worker/routes/middleware.ts 与 public.ts 都要用）。
//
// 为什么抽出来：middleware 拦写请求时读 `maintenance.enabled`，public.ts 的
// /api/init 也要读它给前端挂横幅 —— 两个地方各写一个字符串字面量，
// 改名漏一处就是「拦下了但用户不知道为什么」。键名收敛成一份。

/** 全站维护开关的配置键（configs 表，值 "1" = 开） */
export const MAINTENANCE_ENABLED_KEY = "maintenance.enabled";
