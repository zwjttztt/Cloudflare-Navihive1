// src/API/methods/notes/revisionThrottle.ts
// 版本快照的节流闸门（P2-8，2026-11 审计整改）。
//
// 为什么单独成一个纯函数：
//   - `shouldSkipRevision` 供**显式**创建快照的入口（notesRevision.ts 的 pushRevision，
//     以及 mock 服务端的更新路径）复用，抽出来避免两份逻辑漂移；
//   - 它只依赖 `api.db` 做一次极轻量的 SELECT，不碰任何写入，便于单测（见
//     tests/revisionThrottle.test.ts）且不影响笔记正文/标题的保存路径。
//   - ⚠️ 真实 updateNote 的「每次编辑存改动前快照」路径**不**调用本函数（见 notesNote.ts）：
//     那一路必须保证版本历史可恢复，不能因时间节流丢掉中间版本。
import type { NavigationAPI } from "../../http";
import { REVISION_MIN_INTERVAL_MS } from "../../../utils/noteLimits";

/**
 * 是否应该跳过这一次笔记版本快照的写入。
 *
 * 背景：自动保存是 3 秒一防抖，一次连续改字会触发很多次 update，每次都存快照的话
 * 一分钟内能堆出几十条一模一样的版本，把 `note_revision` 表撑爆（D1 有容量上限）。
 * 这里在「内容确实变了」之外再加一道时间闸门：上一次快照距今还没过
 * `REVISION_MIN_INTERVAL_MS`，就跳过这次快照写入。
 *
 * ⚠️ 节流的是「快照」，不是笔记正文：调用方在返回 `true` 时仍要继续执行笔记
 *    内容/标题的 `UPDATE`（那是用户的保存，必须照常落地），只是不额外写一份
 *    `note_revision`。
 *
 * ⚠️ 查询失败要优雅降级为 `false`：读不到上次快照时间时，宁可多写一份快照，
 *    也绝不能把正常保存路径变成「不写」（那会悄悄丢掉历史）。
 *
 * @param api    提供 `db` / `scopeSql` / `scopeParams` / `currentUserId` 的导航 API 实例
 * @param noteId 要写快照的笔记 id
 * @returns `true` 表示距上次快照不足最小间隔、应跳过；`false` 表示可以照常写
 */
export async function shouldSkipRevision(api: NavigationAPI, noteId: number): Promise<boolean> {
    try {
        const row = await api.db
            .prepare(
                `SELECT created_at FROM note_revision WHERE note_id = ?${api.scopeSql(true)} ORDER BY id DESC LIMIT 1`
            )
            .bind(...api.scopeParams([noteId]))
            .first<{ created_at: string }>();
        // 没有任何快照记录（或查不到时间）：不跳过，该写第一份
        if (!row) return false;
        // created_at 是 SQLite 的 `YYYY-MM-DD HH:MM:SS[.sss]`（CURRENT_TIMESTAMP / sqlNow 的形状）。
        // 归一成 ISO 再解析；补 `Z` 让 JS 按 UTC 解读（库里本来就是 UTC），避免按本地时区误判。
        const iso = String(row.created_at).replace(" ", "T");
        const last = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
        if (!Number.isFinite(last)) return false; // 解析不出来也降级为「不跳过」
        return Date.now() - last < REVISION_MIN_INTERVAL_MS;
    } catch {
        // 任何查询异常：降级为「不跳过」，照常写新快照
        return false;
    }
}
