// src/API/methods/notes/notesShared.ts
// notes 域的共享常量与辅助，被多个子模块复用（不放回 notes.ts，避免再长回去）。
//
// 这里只放「被超过一个子模块用到」的东西：
//   - NOTE_FIELDS：listNotes / getNote / createNote / updateNote / searchNotes 都要它。
//   - validateFolderParent：笔记与文件夹的创建/移动都靠它做防环 + 账号隔离校验。
// 单模块专用的辅助（relabelAttachmentLink / inlineTagStatements / releaseSiteBindingStatement /
// ftsScopeSql / pushRevision 那个函数）各自待在自己的子模块里。
import type { NavigationAPI } from "../../http";
import { validateFolderMove } from "../../../utils/folderTree";

/** notes 表全字段（写操作的 RETURNING、读操作的 SELECT 都用它） */
export const NOTE_FIELDS =
    "id, uuid, title, content, pinned, starred, rev, order_num, site_id, archived, folder_id, created_at, updated_at";

/**
 * 校验「把笔记/文件夹移到 parent 下」是否合法（防环 + 越权按「查不到」处理，不泄露存在性）。
 *
 * 环路判定本身搬到 utils/folderTree（mock 也用同一份，同源化）；这里只剩「怎么查父 id」
 * —— 要带账号 scope，越权访问按「查不到」处理，不泄露存在性。
 */
export async function validateFolderParent(
    api: NavigationAPI,
    parent: number | null,
    moving?: number
): Promise<void> {
    await validateFolderMove({
        parent,
        moving,
        lookup: async id => {
            const row: { parent_id: number | null } | null = await api.db
                .prepare(`SELECT parent_id FROM note_folder WHERE id = ?${api.scopeSql(true)}`)
                .bind(...api.scopeParams([id])).first<{ parent_id: number | null }>();
            // ⚠️ 查不到时返回 undefined（= 这一级不存在），null 是「存在但它是根」
            return row ? (row.parent_id ?? null) : undefined;
        },
    });
}
