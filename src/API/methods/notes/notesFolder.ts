// src/API/methods/notes/notesFolder.ts
// 笔记文件夹 CRUD（listFolders / createFolder / updateFolder / deleteFolder）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
// 防环 + 账号隔离校验复用 notesShared 的 validateFolderParent（与笔记侧同一份实现）。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { NoteFolder } from "../../types";
import { validateFolderParent } from "./notesShared";

export const folderMethods: Pick<NotesApi,
    "listFolders" | "createFolder" | "updateFolder" | "deleteFolder"> = {
    listFolders: async function (this: NavigationAPI): Promise<NoteFolder[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // ⚠️ 子查询里必须用 scopeSql(**true**) —— 它给的是 " AND user_id = ?"。
            // 用 scopeSql(false) 会在「WHERE n.folder_id = f.id」后面再接一个
            // 「WHERE user_id = ?」，拼出两个 WHERE，SQLite 直接报语法错 → 接口 500。
            // 子查询里那个没限定的 user_id 归 notes n（内层优先），正好是想要的隔离。
            // 绑定顺序要跟 SQL 里 ? 的出现顺序一致：子查询的先，外层的后。
            // ⚠️ 计数子查询里的 `n.archived = 0` 不能少：前端的 folderCounts/tagCounts
            // 是按「未归档」算的（归档笔记默认从各视图隐去），后端不排除的话，
            // 首屏渲染的 count 会在本地重算后突然变小 —— 同一行数字自己变了。
            const result = await this.db
                .prepare(
                    `SELECT f.*, (SELECT COUNT(*) FROM notes n
                        WHERE n.folder_id = f.id AND n.archived = 0${this.scopeSql(true)}
                    ) AS count
                    FROM note_folder f ${this.scopeSql(false)}
                    ORDER BY f.order_num, f.name`
                )
                .bind(...this.scopeParams([]), ...this.scopeParams([]))
                .all<NoteFolder>();
            return result.results || [];
        });
    },

    createFolder: async function (this: NavigationAPI, draft: Partial<NoteFolder>): Promise<NoteFolder> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            await validateFolderParent(this, draft.parent_id ?? null);
            const scopeTail = this.scopeParams([]);
            const result = await this.db
                .prepare(
                    `INSERT INTO note_folder (user_id, name, icon, color, parent_id, order_num)
                     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(order_num) + 1 FROM note_folder${
                         this.scopeSql(false)
                     }), 0))
                     RETURNING *, 0 AS count`
                )
                .bind(
                    this.currentUserId,
                    draft.name || "新建文件夹",
                    // 外观两列：传什么存什么（路由层已验证格式），空就是默认样式
                    draft.icon ?? null,
                    draft.color ?? null,
                    draft.parent_id ?? null,
                    ...scopeTail
                )
                .all<NoteFolder>();
            if (!result.results || result.results.length === 0) {
                throw new Error("创建文件夹失败");
            }
            return result.results[0];
        });
    },

    updateFolder: async function (
        this: NavigationAPI,
        id: number,
        patch: Partial<NoteFolder>
    ): Promise<NoteFolder | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
            const params: (string | number | null)[] = [];
            if (patch.name !== undefined) {
                updates.push("name = ?");
                params.push(patch.name);
            }
            if (patch.order_num !== undefined) {
                updates.push("order_num = ?");
                params.push(patch.order_num);
            }
            if (patch.parent_id !== undefined) {
                await validateFolderParent(this, patch.parent_id, id);
                updates.push("parent_id = ?");
                params.push(patch.parent_id);
            }
            // 文件夹外观（schema 11）：与 name 同一层级的普通字段，格式校验在路由层
            if (patch.icon !== undefined) {
                updates.push("icon = ?");
                params.push(patch.icon);
            }
            if (patch.color !== undefined) {
                updates.push("color = ?");
                params.push(patch.color);
            }
            params.push(id);
            const result = await this.db
                .prepare(`UPDATE note_folder SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams(params))
                .run();
            if (!result.success) return null;
            const row = await this.db
                .prepare(
                    `SELECT f.*, (SELECT COUNT(*) FROM notes n
                        WHERE n.folder_id = f.id AND n.archived = 0${this.scopeSql(true)}
                    ) AS count
                    FROM note_folder f WHERE f.id = ?${this.scopeSql(true)}`
                )
                // 顺序：子查询的账号 id → 外层 id → 外层账号 id
                .bind(...this.scopeParams([]), id, ...this.scopeParams([]))
                .first<NoteFolder>();
            return row ?? null;
        });
    },

    /**
     * 删文件夹：**不连带删笔记**。
     *
     * 笔记不可再生（用户写了几百字的 Markdown），文件夹名删错了还能重建；
     * 所以这里只把笔记的 folder_id 置空，让它们回到「未归类」。
     * 返回值里的 orphaned 给 UI 提示「N 条笔记已移到未归类」——
     * 不告诉用户的话，他会以为笔记跟着文件夹一起没了。
     */
    deleteFolder: async function (
        this: NavigationAPI,
        id: number
    ): Promise<{ success: boolean; orphaned: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const stat = await this.db
                .prepare(`SELECT COUNT(*) AS n FROM notes WHERE folder_id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<{ n: number }>();
            const orphaned = stat?.n ?? 0;
            // ⚠️ 这三条必须**走同一个 batch**（= 同一个 D1 事务），不能顺序单发。
            // 分开跑的话，中途失败/超时就会留下「文件夹没了、笔记还指着它」的悬空
            // folder_id：那几条笔记在左栏任何文件夹视图里都点不出来，
            // 看着就像被删掉了。顺序也重要 —— 先摘关联再删文件夹。
            const statements = [
                this.db
                    .prepare(`UPDATE notes SET folder_id = NULL WHERE folder_id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
                this.db
                    .prepare(`UPDATE note_folder SET parent_id = NULL WHERE parent_id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
                this.db
                    .prepare(`DELETE FROM note_folder WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
            ];
            const committed = await this.db.batch(statements);
            if (committed.some(r => !r.success)) return { success: false, orphaned: 0 };
            return { success: true, orphaned };
        });
    },
};
