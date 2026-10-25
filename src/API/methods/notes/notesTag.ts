// src/API/methods/notes/notesTag.ts
// 标签 CRUD + 笔记标签关联查询（notes 域的「标签」那一组）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
// 所有计数子查询都带 scopeSql（单账号部署 uid 可能是 NULL），且 `n.archived = 0`
// 排除归档，与前端 folderCounts/tagCounts 的口径一致。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { NoteTag } from "../../types";

export const tagMethods: Pick<NotesApi,
    "listTags" | "createTag" | "updateTag" | "deleteTag" |
    "setNoteTags" | "listNotesByTags" | "listNoteTags"> = {
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
