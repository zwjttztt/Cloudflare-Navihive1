// src/API/methods/notes/notesRevision.ts
// 笔记版本历史（pushRevision / listNoteRevisions / getNoteRevision / restoreNoteRevision）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
// 本地辅助 pushRevision 负责「存快照 + 按 REVISION_KEEP_PER_NOTE 裁剪」，
// 既供本模块 pushRevision 方法调用，也供 updateNote（notesNote.ts）直接内联同样的 SQL。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { Note, NoteRevision } from "../../types";
import { REVISION_KEEP_PER_NOTE } from "../../../utils/noteLimits";

/**
 * 记一个版本快照，并裁掉超出上限的旧版本。
 *
 * 两步必须都在：只插不裁，这张表就会随使用时间无限增长（D1 有容量上限，
 * 且备份/导出也会跟着变大）。裁剪用一条 `DELETE … WHERE id NOT IN (最近 N 条)`，
 * 不用 OFFSET 分页 —— 一次语句搞定，不受并发影响。
 */
async function pushRevision(
    api: NavigationAPI,
    noteId: number,
    title: string,
    content: string
): Promise<void> {
    await api.db
        .prepare(
            `INSERT INTO note_revision (note_id, user_id, title, content) VALUES (?, ?, ?, ?)`
        )
        .bind(noteId, api.currentUserId, title, content)
        .run();
    await api.db
        .prepare(
            `DELETE FROM note_revision WHERE note_id = ? AND user_id IS ?
             AND id NOT IN (
                 SELECT id FROM note_revision WHERE note_id = ? AND user_id IS ?
                 ORDER BY id DESC LIMIT ?
             )`
        )
        // ⚠️ `IS ?` 而不是 `= ?`：单账号部署下 user_id 是 NULL，
        // 而 `col = NULL` 永远不成立，裁剪会**一条都删不掉**（静默失去上限）。
        .bind(noteId, api.currentUserId, noteId, api.currentUserId, REVISION_KEEP_PER_NOTE)
        .run();
}

export const revisionMethods: Pick<NotesApi,
    "pushRevision" | "listNoteRevisions" | "getNoteRevision" | "restoreNoteRevision"> = {
    pushRevision: async function (
        this: NavigationAPI,
        noteId: number,
        title: string,
        content: string
    ): Promise<void> {
        await this.migrate();
        await pushRevision(this, noteId, title, content);
    },

    listNoteRevisions: async function (this: NavigationAPI, id: number): Promise<NoteRevision[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 归属校验：note_revision 有 user_id，但先确认这条笔记是当前账号的，
            // 免得靠快照表自己的 user_id 判断（老数据可能是 NULL）
            const note = await this.db
                .prepare(`SELECT id FROM notes WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<{ id: number }>();
            if (!note) return [];
            // ⚠️ 列表**不带正文**：一条笔记可能有几十版，全量拉回来只是白费流量。
            //   用户点开某一条时再走 getNoteRevision 取全文。
            const result = await this.db
                .prepare(
                    `SELECT id, note_id, title, length(content) AS size, created_at
                     FROM note_revision WHERE note_id = ?${this.scopeSql(true)}
                     ORDER BY id DESC LIMIT ?`
                )
                // ⚠️ 必须**按 SQL 里 ? 的出现顺序**手工绑定，不能用 scopeParams：
                //   占位符顺序是 note_id → user_id → LIMIT，而 scopeParams 把账号 id
                //   追加到**末尾**，那样 LIMIT 会绑到 user_id、60 会绑到 LIMIT ——
                //   症状是「历史永远是空的」（LIMIT 0）或「串到别人的行」。
                .bind(
                    id,
                    ...(this.currentUserId === null ? [] : [this.currentUserId]),
                    REVISION_KEEP_PER_NOTE
                )
                .all<NoteRevision>();
            return result.results || [];
        });
    },

    getNoteRevision: async function (
        this: NavigationAPI,
        noteId: number,
        revisionId: number
    ): Promise<NoteRevision | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 两次条件都要有：note_id 挡住「拿 A 笔记的快照 id 读 B 笔记」，
            // 账号条件挡住跨账号。
            const row = await this.db
                .prepare(
                    `SELECT r.id, r.note_id, r.title, r.content, r.created_at
                     FROM note_revision r
                     JOIN notes n ON n.id = r.note_id${this.scopeSql(true)}
                     WHERE r.note_id = ? AND r.id = ?`
                )
                .bind(...this.scopeParams([]), noteId, revisionId)
                .first<NoteRevision>();
            return row ?? null;
        });
    },

    restoreNoteRevision: async function (
        this: NavigationAPI,
        noteId: number,
        revisionId: number
    ): Promise<Note | null> {
        const revision = await this.getNoteRevision(noteId, revisionId);
        if (!revision) return null;
        // 走 updateNote 那条路：会自动把「恢复前」的正文再存一份快照，
        // 所以恢复这个动作本身也能撤回（不至于一点就永久丢失）。
        return await this.updateNote(noteId, {
            title: revision.title,
            content: revision.content,
        });
    },
};
