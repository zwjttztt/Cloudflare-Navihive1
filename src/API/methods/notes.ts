// src/API/methods/notes.ts
// NavigationAPI 的「notes」域方法体（记事本）。
//
// 与 data.ts 同样的结构：方法体是类的成员，搬到这里只是因为记事本已经是一块
// 独立的领域了；用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 混回原型。
//
// 三个和 sites 不同的地方，都是刻意的：
//   1. **user_id 靠 scopeSql 隔离**，与 sites/configs 完全同一套（含单账号部署 uid=NULL）。
//   2. **删除走回收站**（kind='note'）：笔记往往比卡片更不可再生，值得多这一步。
//   3. **uuid 在这里生成**：合并导入靠它识别「同一条笔记」（见 transfer.ts 的导入逻辑）。
//      没有它就只能按标题+内容硬比，用户改过一次的笔记会被当成两条。
import type { NavigationAPI } from "../http";
import type { Note } from "../types";
import { newUuid } from "../../utils/uuid";

export interface NotesApi {
    listNotes(): Promise<Note[]>;
    getNote(id: number): Promise<Note | null>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    /** 软删除：先进回收站再删行，返回 recycleId 供撤销 */
    deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }>;
    updateNoteOrder(orders: { id: number; order_num: number }[]): Promise<boolean>;
    countNotes(): Promise<number>;
}

const NOTE_FIELDS =
    "id, uuid, title, content, pinned, order_num, site_id, created_at, updated_at";

export const notesImpl: NotesApi = {
    listNotes: async function (this: NavigationAPI): Promise<Note[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db
                .prepare(
                    `SELECT ${NOTE_FIELDS} FROM notes${this.scopeSql(
                        true
                    )} ORDER BY pinned DESC, order_num, id`
                )
                .bind(...this.scopeParams([]))
                .all<Note>();
            return result.results || [];
        });
    },

    getNote: async function (this: NavigationAPI, id: number): Promise<Note | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Note>();
            return row ?? null;
        });
    },

    createNote: async function (this: NavigationAPI, draft: Partial<Note>): Promise<Note> {
        await this.migrate();
        // order_num 缺省时排到当前最后一条之后，省得前端每次都要先查一遍最大值
        const result = await this.db
            .prepare(
                `INSERT INTO notes (user_id, uuid, title, content, pinned, order_num, site_id)
                 VALUES (?, ?, ?, ?, ?, COALESCE((
                     SELECT MAX(order_num) + 1 FROM notes${this.scopeSql(true)}
                 ), 0), ?)
                 RETURNING ${NOTE_FIELDS}`
            )
            .bind(
                this.currentUserId,
                draft.uuid || newUuid(),
                draft.title || "",
                draft.content || "",
                draft.pinned ? 1 : 0,
                draft.site_id ?? null
            )
            .all<Note>();
        if (!result.results || result.results.length === 0) {
            throw new Error("创建笔记失败");
        }
        return result.results[0];
    },

    updateNote: async function (
        this: NavigationAPI,
        id: number,
        patch: Partial<Note>
    ): Promise<Note | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
            const params: (string | number | null)[] = [];

            // 白名单逐字段加，和 updateGroup 同一套写法：不让调用方传任意列名
            if (patch.title !== undefined) {
                updates.push("title = ?");
                params.push(patch.title);
            }
            if (patch.content !== undefined) {
                updates.push("content = ?");
                params.push(patch.content);
            }
            if (patch.pinned !== undefined) {
                updates.push("pinned = ?");
                params.push(patch.pinned ? 1 : 0);
            }
            if (patch.order_num !== undefined) {
                updates.push("order_num = ?");
                params.push(patch.order_num);
            }
            // 显式传 null 才是「解除关联」；不传就不动
            if (patch.site_id !== undefined) {
                updates.push("site_id = ?");
                params.push(patch.site_id);
            }

            params.push(id);
            const result = await this.db
                .prepare(
                    `UPDATE notes SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams(params))
                .run();
            if (!result.success) return null;
            // updated_at 刚被刷新，直接回读一次拿最新值
            const row = await this.db
                .prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Note>();
            return row ?? null;
        });
    },

    deleteNote: async function (
        this: NavigationAPI,
        id: number
    ): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const note = await this.db
                .prepare(`SELECT * FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!note) return { success: false };
            // 先搬进回收站再删行：顺序反了就救不回来了
            const recycleId = await this.pushToRecycle("note", JSON.stringify({ note }));
            const result = await this.db
                .prepare(`DELETE FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success, recycleId: result.success ? recycleId : undefined };
        });
    },

    updateNoteOrder: async function (
        this: NavigationAPI,
        orders: { id: number; order_num: number }[]
    ): Promise<boolean> {
        if (!Array.isArray(orders) || orders.length === 0) return false;
        // 拖拽排序一次可能带上几百条，逐条 UPDATE 是几百次往返 —— 必须走 batch。
        // 分批界限照 transfer.ts 的 COMMIT_CHUNK_STATEMENTS 那边（250），
        // 免得语句数撞上 D1 的上限。
        const CHUNK = 250;
        let ok = true;
        for (let offset = 0; offset < orders.length; offset += CHUNK) {
            const chunk = orders.slice(offset, offset + CHUNK);
            const statements = chunk.map(item =>
                this.db
                    .prepare(
                        `UPDATE notes SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${this.scopeSql(
                            true
                        )}`
                    )
                    .bind(...this.scopeParams([item.order_num, item.id]))
            );
            const committed = await this.db.batch(statements);
            if (committed.some(r => !r.success)) {
                ok = false;
                break;
            }
        }
        return ok;
    },

    countNotes: async function (this: NavigationAPI): Promise<number> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT COUNT(*) AS n FROM notes${this.scopeSql(true)}`)
                .bind(...this.scopeParams([]))
                .first<{ n: number }>();
            return row?.n ?? 0;
        });
    },
};
