// src/utils/noteLimits.ts
// 笔记域的「规则值 + 由它派生的判定」（2026-10-22，3.3 mock 同源化第一批）。
//
// 为什么集中在这里：这些数字原先散在两处，而且**已经在两处走偏了**：
//   - 真实侧 `REVISION_KEEP_PER_NOTE = 60`，mock 里直接写 `60`，
//     只靠一句注释「与后端 REVISION_KEEP_PER_NOTE 一致」维持 —— 改常量时 mock 不会跟着变，
//     而这类不一致**不会报错**，只会让本地演示和线上表现不同；
//   - 摘要截断：真实侧是 `>= NOTE_SUMMARY_CHARS` 且只打标记（内容已在 SQL 里截好），
//     mock 侧是 `> 200` 且自己截 —— 阈值恰好等于 200 时两边判断相反。
//
// 约定：**规则值只在这里定义一次**，两边都 import；判定也一起给，别各写一次比较。

/** 每条笔记最多保留多少个历史版本（超出从最旧开始裁） */
export const REVISION_KEEP_PER_NOTE = 60;

/** 列表摘要里正文最多多少字（超出打 content_truncated 标记） */
export const NOTE_SUMMARY_CHARS = 200;

/**
 * 这份正文在「列表摘要」里算不算被截断。
 *
 * ⚠️ 用 `>=` 而不是 `>`：SQL 侧截到 NOTE_SUMMARY_CHARS 个字，长度**恰好等于**
 *    上限时也可能是被截过的（原文正好 N 字？无法区分，按保守处理打标记）。
 *    真实侧原本就是 `>=`，mock 侧原本是 `>` —— 这里统一到 `>=`。
 */
export function needsSummary(content: string | null | undefined): boolean {
    return (content ?? "").length >= NOTE_SUMMARY_CHARS;
}

/** 按摘要上限截断（mock / 前端本地渲染用；真实侧由 SQL 的 substr 完成） */
export function summarizeContent(content: string | null | undefined): string {
    return (content ?? "").slice(0, NOTE_SUMMARY_CHARS);
}
