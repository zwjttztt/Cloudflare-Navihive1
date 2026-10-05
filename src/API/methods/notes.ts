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
import type { Note, NoteFolder, NoteTag } from "../types";
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

    // ---- 文件夹（阶段三收尾）----
    /** 取当前账号的文件夹清单（顺带回每条的笔记数，UI 直接显示） */
    listFolders(): Promise<NoteFolder[]>;
    createFolder(draft: Partial<NoteFolder>): Promise<NoteFolder>;
    updateFolder(id: number, patch: Partial<NoteFolder>): Promise<NoteFolder | null>;
    /** 删文件夹：笔记不跟着删，只把它们的 folder_id 置空（变成「未归类」） */
    deleteFolder(id: number): Promise<{ success: boolean; orphaned: number }>;

    // ---- 标签（阶段三收尾）----
    listTags(): Promise<NoteTag[]>;
    createTag(draft: Partial<NoteTag>): Promise<NoteTag>;
    updateTag(id: number, patch: Partial<NoteTag>): Promise<NoteTag | null>;
    /** 删标签：只删关联，笔记本身不动 */
    deleteTag(id: number): Promise<{ success: boolean }>;
    /** 给一条笔记换上整组标签（传空数组 = 清空标签） */
    setNoteTags(noteId: number, tagIds: number[]): Promise<NoteTag[]>;
    /** 反查：一组标签Id命中哪些笔记（标签筛选视图用） */
    listNotesByTags(tagIds: number[]): Promise<number[]>;
    /**
     * 全量标签关联：{ [noteId]: tagId[] }。
     * 列表页要显示每条笔记的标签、也算每个标签的条数，逐条查笔记标签会是 N+1；
     * 而这份东西就几百行，一次全取回来放在客户端最省事。
     */
    listNoteTags(): Promise<Record<number, number[]>>;
}

// NoteFolder / NoteTag 定义在 ../types（那边的 Note 也在一起）——
// 前后端、路由层共用同一份形状，别在方法文件里另起一份。

const NOTE_FIELDS =
    "id, uuid, title, content, pinned, order_num, site_id, archived, folder_id, created_at, updated_at";

export const notesImpl: NotesApi = {
    listNotes: async function (this: NavigationAPI): Promise<Note[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db
                .prepare(
                    `SELECT ${NOTE_FIELDS} FROM notes${this.scopeSql(
                        false
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
        // order_num 缺省时排到当前最后一条之后，省得前端每次都要先查一遍最大值。
        //
        // ⚠️ 两个坑都在这���句里（踩过一次，症状是接口一律 500）：
        //   1. 子查询里必须用 `scopeSql(false)`。`scopeSql(true)` 生成的是
        //      ` AND user_id = ?`，接在 `FROM notes` 后面就成了
        //      `FROM notes AND user_id = ?` —— SQL 语法错误。
        //      带 AND 的那个只用在「已经有 WHERE」的语句尾部。
        //   2. 子查询里的 `?` 也要绑参数。用 `scopeParams([])` 取，
        //      它在单账号部署（uid 为 NULL）下返回空数组，两种情况都对。
        const scopeTail = this.scopeParams([]);
        const result = await this.db
            .prepare(
                `INSERT INTO notes (user_id, uuid, title, content, pinned, order_num, site_id, folder_id)
                 VALUES (?, ?, ?, ?, ?, COALESCE((
                     SELECT MAX(order_num) + 1 FROM notes${this.scopeSql(false)}
                 ), 0), ?)
                 RETURNING ${NOTE_FIELDS}`
            )
            .bind(
                this.currentUserId,
                draft.uuid || newUuid(),
                draft.title || "",
                draft.content || "",
                draft.pinned ? 1 : 0,
                ...scopeTail,
                draft.site_id ?? null,
                // 未指定就落 NULL（= 未归类），而不是 0 —— 0 会被当成「有个 id 为 0 的文件夹」
                draft.folder_id ?? null
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
            // 阶段三：归档 / 取回归档
            if (patch.archived !== undefined) {
                updates.push("archived = ?");
                params.push(patch.archived ? 1 : 0);
            }
            // 阶段三收尾：归入 / 移出文件夹。显式传 null 才是「移到未归类」
            if (patch.folder_id !== undefined) {
                updates.push("folder_id = ?");
                params.push(patch.folder_id);
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
                .prepare(`SELECT COUNT(*) AS n FROM notes${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .first<{ n: number }>();
            return row?.n ?? 0;
        });
    },

    // ---------------- 文件夹 ----------------

    listFolders: async function (this: NavigationAPI): Promise<NoteFolder[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 左子树是聚合查询，右子树是条件：SQLite 支持的这种写法比 JOIN + GROUP BY 好读，
            // 且 HAVING 里直接就能写「count(n.id) > 0」这种别名。
            const result = await this.db
                .prepare(
                    `SELECT f.*, (SELECT COUNT(*) FROM notes n
                        WHERE n.folder_id = f.id ${this.scopeSql(false)}
                    ) AS count
                    FROM note_folder f ${this.scopeSql(false)}
                    ORDER BY f.order_num, f.name`
                )
                .bind(...this.scopeParams([]))
                .all<NoteFolder>();
            return result.results || [];
        });
    },

    createFolder: async function (this: NavigationAPI, draft: Partial<NoteFolder>): Promise<NoteFolder> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const scopeTail = this.scopeParams([]);
            const result = await this.db
                .prepare(
                    `INSERT INTO note_folder (user_id, name, order_num)
                     VALUES (?, ?, COALESCE((SELECT MAX(order_num) + 1 FROM note_folder${
                         this.scopeSql(false)
                     }), 0))
                     RETURNING *, 0 AS count`
                )
                .bind(this.currentUserId, draft.name || "新建文件夹", ...scopeTail)
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
            params.push(id);
            const result = await this.db
                .prepare(`UPDATE note_folder SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams(params))
                .run();
            if (!result.success) return null;
            const row = await this.db
                .prepare(
                    `SELECT f.*, (SELECT COUNT(*) FROM notes n
                        WHERE n.folder_id = f.id ${this.scopeSql(false)}
                    ) AS count
                    FROM note_folder f WHERE f.id = ?${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams([id]))
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
            const drop = await this.db
                .prepare(`DELETE FROM note_folder WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            if (!drop.success) return { success: false, orphaned: 0 };
            if (orphaned > 0) {
                await this.db
                    .prepare(`UPDATE notes SET folder_id = NULL WHERE folder_id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id]))
                    .run();
            }
            return { success: true, orphaned };
        });
    },

    // ---------------- 标签 ----------------

    listTags: async function (this: NavigationAPI): Promise<NoteTag[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db
                .prepare(
                    `SELECT t.*, (SELECT COUNT(*) FROM note_note_tag l
                        JOIN notes n ON n.id = l.note_id ${this.scopeSql(false)}
                        WHERE l.tag_id = t.id
                    ) AS count
                    FROM note_tag t ${this.scopeSql(false)}
                    ORDER BY t.name`
                )
                .bind(...this.scopeParams([]))
                .all<NoteTag>();
            return result.results || [];
        });
    },

    createTag: async function (this: NavigationAPI, draft: Partial<NoteTag>): Promise<NoteTag> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db
                .prepare(
                    `INSERT INTO note_tag (user_id, name, color)
                     VALUES (?, ?, ?)
                     RETURNING *, 0 AS count`
                )
                .bind(
                    this.currentUserId,
                    draft.name || "新标签",
                    draft.color ?? null
                )
                .all<NoteTag>();
            if (!result.results || result.results.length === 0) {
                throw new Error("创建标签失败");
            }
            return result.results[0];
        });
    },

    updateTag: async function (this: NavigationAPI, id: number, patch: Partial<NoteTag>): Promise<NoteTag | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
            const params: (string | number | null)[] = [];
            if (patch.name !== undefined) {
                updates.push("name = ?");
                params.push(patch.name);
            }
            if (patch.color !== undefined) {
                updates.push("color = ?");
                params.push(patch.color);
            }
            params.push(id);
            const result = await this.db
                .prepare(`UPDATE note_tag SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams(params))
                .run();
            if (!result.success) return null;
            const row = await this.db
                .prepare(
                    `SELECT t.*, (SELECT COUNT(*) FROM note_note_tag l
                        JOIN notes n ON n.id = l.note_id ${this.scopeSql(false)}
                        WHERE l.tag_id = t.id
                    ) AS count
                    FROM note_tag t WHERE t.id = ?${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams([id]))
                .first<NoteTag>();
            return row ?? null;
        });
    },

    deleteTag: async function (this: NavigationAPI, id: number): Promise<{ success: boolean }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 先删关联再删标签：反着来会在第一个 DELETE 上就卡外键（虽然这张表没建外键，
            // 但留着顺序是对的 —— 万一以后加上 ON DELETE，就不会留下悬空关联）。
            await this.db
                .prepare("DELETE FROM note_note_tag WHERE tag_id = ?")
                .bind(id)
                .run();
            const result = await this.db
                .prepare(`DELETE FROM note_tag WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success };
        });
    },

    /**
     * 给一条笔记换上整组标签。
     *
     * 用「整组替换」而不是逐个增删：UI 每次都是由勾选状态发出去的，
     * 差量算法（只加差集）在勾选/反选来回点时会把状态算乱。
     * 两条 INSERT 就能盖住（主键 (note_id, tag_id) 保证重复插入是幂等的），
     * 两条 DELETE 兜掉被取消的标签。
     */
    setNoteTags: async function (this: NavigationAPI, noteId: number, tagIds: number[]): Promise<NoteTag[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const ids = Array.isArray(tagIds) ? tagIds.filter(n => Number.isInteger(n) && n > 0) : [];
            // 先确认这条笔记属于当前账号，否则能给别人家的笔记贴标签
            const note = await this.db
                .prepare(`SELECT id FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([noteId]))
                .first<{ id: number }>();
            if (!note) return [];

            // 标签也必须属于当前账号：别人的标签 id 传进来不能拿来贴上
            const owned = ids.length
                ? await this.db
                      .prepare(
                          `SELECT id FROM note_tag WHERE id IN (${ids
                              .map(() => "?")
                              .join(",")})${this.scopeSql(true)}`
                      )
                      .bind(...this.scopeParams(ids))
                      .all<{ id: number }>()
                : null;
            const allowed = new Set((owned?.results || []).map(r => r.id));
            const toKeep = ids.filter(id => allowed.has(id));

            await this.db
                .prepare("DELETE FROM note_note_tag WHERE note_id = ?")
                .bind(noteId)
                .run();
            if (toKeep.length > 0) {
                await this.db
                    .prepare(
                        `INSERT OR REPLACE INTO note_note_tag (note_id, tag_id) VALUES ${toKeep
                            .map(() => "(?, ?)")
                            .join(",")}`
                    )
                    .bind(...toKeep.flatMap(id => [noteId, id]))
                    .run();
            }
            return this.listTags();
        });
    },

    listNotesByTags: async function (this: NavigationAPI, tagIds: number[]): Promise<number[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const ids = Array.isArray(tagIds) ? tagIds.filter(n => Number.isInteger(n) && n > 0) : [];
            if (ids.length === 0) return [];
            const result = await this.db
                .prepare(
                    `SELECT DISTINCT l.note_id FROM note_note_tag l
                     JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}
                     WHERE l.tag_id IN (${ids.map(() => "?").join(",")})`
                )
                .bind(...this.scopeParams(ids))
                .all<{ note_id: number }>();
            return (result.results || []).map(r => r.note_id);
        });
    },

    listNoteTags: async function (this: NavigationAPI): Promise<Record<number, number[]>> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db.prepare("SELECT note_id, tag_id FROM note_note_tag").all<{
                note_id: number;
                tag_id: number;
            }>();
            const map: Record<number, number[]> = {};
            for (const row of result.results || []) {
                (map[row.note_id] ||= []).push(row.tag_id);
            }
            return map;
        });
    },
};
