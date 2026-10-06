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
import type { D1PreparedStatement } from "../schema";
import { newUuid } from "../../utils/uuid";
import { extractNoteTags } from "../../utils/markdownNoteTags";

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

async function validateFolderParent(api: NavigationAPI, parent: number | null, moving?: number): Promise<void> {
    if (parent === null) return;
    if (!Number.isInteger(parent) || parent <= 0) throw new Error("文件夹 ID 无效");
    const seen = new Set<number>(moving === undefined ? [] : [moving]);
    let cursor: number | null = parent;
    while (cursor !== null) {
        if (seen.has(cursor)) throw new Error("文件夹不能移入自身或子文件夹");
        seen.add(cursor);
        const row: { parent_id: number | null } | null = await api.db
            .prepare(`SELECT parent_id FROM note_folder WHERE id = ?${api.scopeSql(true)}`)
            .bind(...api.scopeParams([cursor])).first<{ parent_id: number | null }>();
        if (!row) throw new Error("目标文件夹不存在或不属于当前账号");
        cursor = row.parent_id ?? null;
    }
}

function inlineTagStatements(api: NavigationAPI, noteKey: number | string, content: string): D1PreparedStatement[] {
    // 只追加，不撤销手工标签。条件 INSERT 在同一事务内避免并发创建同名标签。
    const statements: D1PreparedStatement[] = [];
    const noteColumn = typeof noteKey === "number" ? "id" : "uuid";
    for (const name of extractNoteTags(content)) {
        statements.push(api.db.prepare(`INSERT INTO note_tag (user_id, name)
            SELECT ?, ? WHERE EXISTS (SELECT id FROM notes WHERE ${noteColumn} = ?${api.scopeSql(true)})
            AND NOT EXISTS (SELECT id FROM note_tag WHERE name = ?${api.scopeSql(true)})`)
            .bind(api.currentUserId, name, ...api.scopeParams([noteKey]), ...api.scopeParams([name])));
        statements.push(api.db.prepare(`INSERT OR IGNORE INTO note_note_tag (note_id, tag_id)
            SELECT n.id, t.id FROM notes n, note_tag t
            WHERE n.${noteColumn} = ? AND t.name = ?
              AND n.id IN (SELECT id FROM notes${api.scopeSql(false)})
              AND t.id IN (SELECT id FROM note_tag${api.scopeSql(false)})`)
            .bind(noteKey, name, ...api.scopeParams([]), ...api.scopeParams([])));
    }
    return statements;
}

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
        await validateFolderParent(this, draft.folder_id ?? null);
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
        const uuid = draft.uuid || newUuid();
        const statement = this.db
            .prepare(
                // ⚠️⚠️ 列数必须与值数**一一对应**：阶段三收尾给列尾加了 folder_id，
                // 值这一侧却忘了补 `?` —— 8 列 7 值，SQLite 直接报
                // "table notes has 8 columns but 7 values were supplied"，
                // POST /api/notes **一律 500，新建笔记功能整个不可用**
                // （GET /api/notes 正常，所以列表看着好好的，一点都不像坏了）。
                // 下面的 sql 形状守卫就是盯这一类：INSERT 的列数 ≠ 顶层值数就红。
                `INSERT INTO notes (user_id, uuid, title, content, pinned, order_num, site_id, folder_id)
                 VALUES (?, ?, ?, ?, ?, COALESCE((
                     SELECT MAX(order_num) + 1 FROM notes${this.scopeSql(false)}
                 ), 0), ?, ?)
                 RETURNING ${NOTE_FIELDS}`
            )
            .bind(
                this.currentUserId,
                uuid,
                draft.title || "",
                draft.content || "",
                draft.pinned ? 1 : 0,
                ...scopeTail,
                draft.site_id ?? null,
                // 未指定就落 NULL（= 未归类），而不是 0 —— 0 会被当成「有个 id 为 0 的文件夹」
                draft.folder_id ?? null
            );
        const tags = inlineTagStatements(this, uuid, draft.content || "");
        const result = tags.length
            ? (await this.db.batch<Note>([statement, ...tags]))[0]
            : await statement.all<Note>();
        if (!result.success || !result.results?.length) throw new Error("创建笔记失败");
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
                await validateFolderParent(this, patch.folder_id);
                updates.push("folder_id = ?");
                params.push(patch.folder_id);
            }

            params.push(id);
            const statement = this.db
                .prepare(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams(params));
            const tags = patch.content === undefined ? [] : inlineTagStatements(this, id, patch.content);
            const result = tags.length
                ? (await this.db.batch([statement, ...tags]))[0]
                : await statement.run();
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

            // ⚠️ 标签关联必须**跟着笔记一起进回收站**，而且要在删行之前取。
            // 以前两处都缺：① 关联行留在 note_note_tag 里，笔记没了它就成悬空行
            // （左栏标签计数还照算，读的是全表）；② 还原换新 id，那些关联接不回来，
            // 用户看到的是「删之前有标签，还原后标签没了」。
            // note_note_tag 这张表没有 user_id 列，归属只能靠 JOIN notes 判定。
            const links = await this.db
                .prepare(
                    `SELECT l.tag_id FROM note_note_tag l
                     JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}
                     WHERE l.note_id = ?`
                )
                .bind(...this.scopeParams([]), id)
                .all<{ tag_id: number }>();
            const tagIds = (links.results || []).map(r => r.tag_id);

            // 先搬进回收站再删行：顺序反了就救不回来了
            const recycleId = await this.pushToRecycle(
                "note",
                JSON.stringify({ note, tagIds })
            );
            if (tagIds.length > 0) {
                await this.db
                    .prepare(
                        `DELETE FROM note_note_tag WHERE note_id IN (
                             SELECT id FROM notes WHERE id = ?${this.scopeSql(true)}
                         )`
                    )
                    .bind(...this.scopeParams([id]))
                    .run();
            }
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
                    `INSERT INTO note_folder (user_id, name, parent_id, order_num)
                     VALUES (?, ?, ?, COALESCE((SELECT MAX(order_num) + 1 FROM note_folder${
                         this.scopeSql(false)
                     }), 0))
                     RETURNING *, 0 AS count`
                )
                .bind(this.currentUserId, draft.name || "新建文件夹", draft.parent_id ?? null, ...scopeTail)
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

    // ---------------- 标签 ----------------

    listTags: async function (this: NavigationAPI): Promise<NoteTag[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 同 listFolders：子查询里必须是 scopeSql(true)，且真实 WHERE 要写在它前面，
            // 否则拼出两个 WHERE。绑定顺序同样是「子查询账号 id → 外层账号 id」。
            const result = await this.db
                .prepare(
                    `SELECT t.*, (SELECT COUNT(*) FROM note_note_tag l
                        JOIN notes n ON n.id = l.note_id
                        WHERE l.tag_id = t.id AND n.archived = 0${this.scopeSql(true)}
                    ) AS count
                    FROM note_tag t ${this.scopeSql(false)}
                    ORDER BY t.name`
                )
                .bind(...this.scopeParams([]), ...this.scopeParams([]))
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
                        JOIN notes n ON n.id = l.note_id
                        WHERE l.tag_id = t.id AND n.archived = 0${this.scopeSql(true)}
                    ) AS count
                    FROM note_tag t WHERE t.id = ?${this.scopeSql(true)}`
                )
                // 顺序：子查询的账号 id → 外层 id → 外层账号 id
                .bind(...this.scopeParams([]), id, ...this.scopeParams([]))
                .first<NoteTag>();
            return row ?? null;
        });
    },

    deleteTag: async function (this: NavigationAPI, id: number): Promise<{ success: boolean }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 先删关联再删标签：反着来会在第一个 DELETE 上就卡外键（虽然这张表没建外键，
            // 但留着顺序是对的 —— 万一以后加上 ON DELETE，就不会留下悬空关联）。
            const results = await this.db.batch([
                this.db.prepare(`DELETE FROM note_note_tag WHERE tag_id IN
                    (SELECT id FROM note_tag WHERE id = ?${this.scopeSql(true)})`)
                    .bind(...this.scopeParams([id])),
                this.db.prepare(`DELETE FROM note_tag WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
            ]);
            return { success: results.every(r => r.success) };
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
            // ⚠️ 绑定顺序要跟 SQL 里 `?` 的出现顺序一致：这里的账号条件写在
            // `WHERE l.tag_id IN (…)` **之前**，所以账号 id 排在标签 id 前面。
            // 直接 `scopeParams(ids)`（它把账号 id 追加到**末尾**）会跟 SQL 反过来，
            // 运行时报「绑定参数个数/顺序对不上」。这个方法前端还没调用（死代码），
            // 但留着这条错绑定就是个雷：哪天有人接上去，症状是 500 且极难定位。
            const result = await this.db
                .prepare(
                    `SELECT DISTINCT l.note_id FROM note_note_tag l
                     JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}
                     WHERE l.tag_id IN (${ids.map(() => "?").join(",")})`
                )
                .bind(...this.scopeParams([]), ...ids)
                .all<{ note_id: number }>();
            return (result.results || []).map(r => r.note_id);
        });
    },

    listNoteTags: async function (this: NavigationAPI): Promise<Record<number, number[]>> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // ⚠️⚠️ 这条以前是 `SELECT note_id, tag_id FROM note_note_tag` —— **一张表全扫**。
            // note_note_tag 这张表没有 user_id 列，归属只能靠 JOIN notes 判定；
            // 不加这个 JOIN 就是跨账号越权：别家账号的 (note_id → tagId) 也会被拉回前端。
            // 顺带把「删了笔记却没清关联」留下的悬空行一并挡掉
            //（它们永远匹配不到活着的笔记，以前却照样占着左栏的标签计数）。
            const result = await this.db
                .prepare(
                    `SELECT l.note_id, l.tag_id FROM note_note_tag l
                     JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams([]))
                .all<{ note_id: number; tag_id: number }>();
            const map: Record<number, number[]> = {};
            for (const row of result.results || []) {
                (map[row.note_id] ||= []).push(row.tag_id);
            }
            return map;
        });
    },
};
