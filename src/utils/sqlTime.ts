// src/utils/sqlTime.ts
// SQLite 的 datetime 字符串格式（2026-10-22，3.3 mock 同源化第一批）。
//
// 背景：库里所有时间列都是 SQLite 的 `YYYY-MM-DD HH:MM:SS` 文本（CURRENT_TIMESTAMP 的形状），
// 代码里要自己造这个形状时，原先有 4 处手写、3 种写法：
//   internals.ts  `.toISOString().replace("T"," ").replace("Z","")`   ← 带毫秒
//   notes.ts      `.toISOString().slice(0,19).replace("T"," ")`
//   mock.ts ×2    同上
// 这不只是重复：**这些字符串是拿来做比较和排序的**（`created_at > ?`、墓碑游标、
// 审计 since 过滤）。两种精度混进同一列，同秒内的先后就分不出来 ——
// 而这类错不会报错，只会让「第二次删除的墓碑被上一次的游标挡住」这种怪事偶尔发生。
//
// 所以：**格式只有这一份定义**，两个精度各有各的函数，谁也别再手写。

/** 精确到秒：与 SQL 的 CURRENT_TIMESTAMP 一字不差（`2026-10-22 10:45:33`） */
export function sqlNow(): string {
    return toSqlTime(new Date(), false);
}

/**
 * 精确到毫秒：`2026-10-22 10:45:33.123`。
 *
 * ⚠️ 只有墓碑（tombstone）这类「同一秒里会连续产生多条、又要按先后比较」的场景需要它。
 *    其余地方一律用 sqlNow() —— 精度越大，字符串越长，而且和 CURRENT_TIMESTAMP 混在一列里
 *    会出现「同一秒两种写法」。
 */
export function sqlNowMs(): string {
    return toSqlTime(new Date(), true);
}

/**
 * Date → SQLite datetime 字符串。
 *
 * ⚠️ 刻意用 UTC：SQLite 的 CURRENT_TIMESTAMP 就是 UTC，而 `toISOString()` 也是 UTC，
 *    两者天然对齐。若改用本地时间，服务端在 UTC+8、浏览器在 UTC-5 时，
 *    「今天」的边界会差出小半天 —— 审计按日聚合、热力图都会错位。
 */
export function toSqlTime(date: Date, withMs = false): string {
    const iso = date.toISOString(); // 2026-10-22T10:45:33.123Z
    const head = iso.slice(0, 19).replace("T", " "); // 2026-10-22 10:45:33
    return withMs ? `${head}.${iso.slice(20, 23)}` : head;
}

/**
 * 把外部传入的时间（可能带 T / 带 Z / 带毫秒 / 已经是对的）归一成秒级格式。
 * 用于 `since` 这类查询参数：客户端传什么形状都收，进 SQL 前先拉齐。
 */
export function toSqlTimeLoose(value: string): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    // 已经是 `YYYY-MM-DD HH:MM:SS[.sss]` 就只截到秒
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 19);
    // ISO 形状：T → 空格、去掉 Z / 时区后缀
    return trimmed.replace("T", " ").replace("Z", "").slice(0, 19);
}

/** 「今天」的 UTC 日期（`YYYY-MM-DD`）：审计按日聚合、热力图用 */
export function sqlDay(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10);
}
