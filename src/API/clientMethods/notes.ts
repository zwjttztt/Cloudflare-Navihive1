// src/API/clientMethods/notes.ts
// NavigationClient 的「notes」域方法体：笔记 CRUD + 分享 + 文件夹 / 标签 / 版本 / 附件 —— 记事本那一整块。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: ClientThis` 让 TS 认得 this，再由 client.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationClient，也别在模块顶层读它的状态。
//
// 拆分的理由（P2-10）：client.ts 一个文件里塞了传输层与 90 个业务方法，
// 想改「笔记附件怎么传」要在 1500 行里翻。按域分开之后，每个域自己长得清楚，
// 传输层的改动（超时 / 幂等头 / 错误翻译）也不会再和业务方法混在一处。
// 范式照抄 src/API/http.ts + methods/*.ts —— 那套已经跑了很久，
// 并且有 tests/clientSurface.test.ts 盯着「域没混回原型」这类静默失效。

import {
    Note,
    NoteAttachment,
    NoteFolder,
    NoteRevision,
    NoteSearchResult,
    NoteTag,
    NoteShare,
    NoteShareListItem,
    NoteStats,
    NoteImportStats,
    NotesChangesResult,
    NotesImportPayload,
} from "../http";
import type {
    SoftDeleteResponse,
} from "../responses";
import type { ClientThis } from "../transport";

export const notesImpl = {
    async listNoteShares(this: ClientThis): Promise<NoteShareListItem[]> {
        return this.request<NoteShareListItem[]>("notes/shares");
    },
    async getNoteShare(this: ClientThis, id: number): Promise<NoteShare | null> {
        return this.request<NoteShare | null>(`notes/${id}/share`);
    },
    async createNoteShare(this: ClientThis, id: number, days: number | null, password?: string | null): Promise<NoteShare | null> {
        return this.request<NoteShare | null>(`notes/${id}/share`, {
            method: "POST",
            body: JSON.stringify({ days, password: password ?? null }),
        });
    },
    async revokeNoteShare(this: ClientThis, id: number): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>(`notes/${id}/share`, { method: "DELETE" });
    },
    async updateNoteShare(this: ClientThis, id: number, days: number | null, password?: string | null): Promise<NoteShare | null> {
        return this.request<NoteShare | null>(`notes/${id}/share`, {
            method: "PUT",
            body: JSON.stringify({ days, password: password === undefined ? undefined : (password ?? null) }),
        });
    },
    /**
     * 列笔记。
     *
     * `limit` / `offset`（2026-10-28）会作为 `?limit=&offset=` 传给服务端；
     * **两个都不传时 URL 与改造前逐字一致**（`notes` 或 `notes?fields=list`）——
     * 这一条很关键：老后端不认这两个参数，但我们也不发，所以老部署零影响。
     */
    async listNotes(
        this: ClientThis,
        opts?: { summary?: boolean; limit?: number; offset?: number }
    ): Promise<Note[]> {
        const params = new URLSearchParams();
        if (opts?.summary) params.set("fields", "list");
        // 非正整数与「没传」等价（与服务端 parsePositiveInt 同一口径），
        // 免得 `limit: 0` 在 URL 上变成一个 LIMIT 0（白给空列表）
        if (typeof opts?.limit === "number" && Number.isInteger(opts.limit) && opts.limit > 0) {
            params.set("limit", String(opts.limit));
        }
        if (typeof opts?.offset === "number" && Number.isInteger(opts.offset) && opts.offset > 0) {
            params.set("offset", String(opts.offset));
        }
        const query = params.toString();
        return this.request<Note[]>(query ? `notes?${query}` : "notes");
    },
    async getNote(this: ClientThis, id: number): Promise<Note | null> {
        return this.request<Note | null>(`notes/${id}`);
    },
    async createNote(this: ClientThis, draft: Partial<Note>): Promise<Note> {
        return this.request<Note>("notes", {
            method: "POST",
            body: JSON.stringify(draft),
        });
    },
    async updateNote(this: ClientThis, id: number, patch: Partial<Note>): Promise<Note | null> {
        // 冲突（409）由 request 直接抛成 NoteConflictError，这里原样透出
        return this.request<Note | null>(`notes/${id}`, {
            method: "PUT",
            body: JSON.stringify(patch),
        });
    },
    async deleteNote(this: ClientThis, id: number): Promise<{ success: boolean; recycleId?: number }> {
        const res = await this.request<SoftDeleteResponse>(`notes/${id}`, {
            method: "DELETE",
        });
        // 与 deleteGroup 同一套：HTTP 200 就说明删掉了，recycleId 是撤销凭据
        return { success: res?.success !== false, recycleId: res?.recycleId };
    },
    async updateNoteOrder(this: ClientThis, orders: { id: number; order_num: number }[]): Promise<boolean> {
        const response = await this.request<{ success?: boolean }>("note-orders", {
            method: "PUT",
            body: JSON.stringify({ orders }),
        });
        return response?.success !== false;
    },
    async countNotes(this: ClientThis): Promise<number> {
        const res = await this.request<{ count?: number }>("notes/count");
        return res?.count ?? 0;
    },
    async reindexNotes(this: ClientThis): Promise<{ success: boolean; count: number }> {
        return this.request("notes/reindex", { method: "POST" });
    },
    async notesStats(this: ClientThis): Promise<NoteStats> {
        const res = await this.request<Partial<NoteStats>>("notes/stats");
        return { versions: res?.versions ?? 0, links: res?.links ?? 0, words: res?.words ?? 0 };
    },
    /**
     * 跨设备变更轮询。
     *
     * `fingerprint`（2026-10-28）是上一轮响应里的 `fingerprint`，原样带回去：
     * 服务端发现快照没变就只回 `{ unchanged: true, fingerprint }`，
     * 不再把文件夹/标签/标签关联整份倒一遍（上千条笔记时那是几十 KB 的死数据）。
     * 不传（首次轮询 / 老后端）就是原来的全量行为。
     */
    async notesChanges(this: ClientThis, since?: string, fingerprint?: string): Promise<NotesChangesResult> {
        const params = new URLSearchParams();
        if (since) params.set("since", since);
        if (fingerprint) params.set("fp", fingerprint);
        const query = params.toString();
        return this.request<NotesChangesResult>(`notes/changes${query ? `?${query}` : ""}`);
    },
    async importNotes(this: ClientThis, payload: NotesImportPayload): Promise<NoteImportStats> {
        return this.request<NoteImportStats>("notes/import", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },
    async notesSearch(this: ClientThis, query: string, limit = 50): Promise<NoteSearchResult> {
        return this.request<NoteSearchResult>("notes/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    },
    async uploadAttachment(this: ClientThis, file: File, noteId?: number | null): Promise<{
        id: string;
        url: string;
        filename: string;
        mime: string;
        size: number;
    }> {
        const params = new URLSearchParams({ filename: file.name || "image" });
        if (noteId) params.set("noteId", String(noteId));
        return this.request<{
            id: string;
            url: string;
            filename: string;
            mime: string;
            size: number;
        }>(`notes/attachments?${params.toString()}`, {
            method: "POST",
            body: file,
            // ⚠️ 不能写 Content-Type: application/json —— 这里要带的是**真实**类型，
            // 让服务端记进元数据（但类型判定仍以文件头嗅探为准，不信这个头）。
            headers: { "Content-Type": file.type || "application/octet-stream" },
        });
    },
    async listAttachments(this: ClientThis): Promise<NoteAttachment[]> {
        return this.request<NoteAttachment[]>("notes/attachments/list");
    },
    async deleteAttachment(this: ClientThis, id: string): Promise<{ ok: boolean }> {
        return this.request<{ ok: boolean }>(`notes/attachments/${id}`, { method: "DELETE" });
    },
    async renameAttachment(this: ClientThis, 
        id: string,
        filename: string
    ): Promise<{ id: string; filename: string; updatedNotes: number }> {
        return this.request<{ id: string; filename: string; updatedNotes: number }>(
            `notes/attachments/${id}`,
            { method: "PATCH", body: JSON.stringify({ filename }) }
        );
    },
    async updateAttachmentContent(this: ClientThis, 
        id: string,
        text: string
    ): Promise<{ id: string; size: number; mime: string }> {
        return this.request<{ id: string; size: number; mime: string }>(
            `notes/attachments/${id}/content`,
            {
                method: "PUT",
                body: text,
                // 纯文本；charset 只是自我描述，服务端仍按文件头嗅探
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
        );
    },
    async pruneAttachments(this: ClientThis): Promise<{ removed: number; freedBytes: number }> {
        return this.request<{ removed: number; freedBytes: number }>("notes/attachments/prune", {
            method: "POST",
        });
    },
    async listFolders(this: ClientThis): Promise<NoteFolder[]> {
        return this.request<NoteFolder[]>("notes/folders");
    },
    async createFolder(this: ClientThis, name: string, parent_id: number | null = null): Promise<NoteFolder> {
        return this.request<NoteFolder>("notes/folders", {
            method: "POST",
            body: JSON.stringify({ name, parent_id }),
        });
    },
    async updateFolder(this: ClientThis, id: number, patch: Partial<NoteFolder>): Promise<NoteFolder | null> {
        return this.request<NoteFolder | null>(`notes/folders/${id}`, {
            method: "PUT",
            body: JSON.stringify(patch),
        });
    },
    async deleteFolder(this: ClientThis, id: number): Promise<{ success: boolean; orphaned: number }> {
        return this.request<{ success: boolean; orphaned: number }>(`notes/folders/${id}`, {
            method: "DELETE",
        });
    },
    async listTags(this: ClientThis): Promise<NoteTag[]> {
        return this.request<NoteTag[]>("notes/tags");
    },
    async createTag(this: ClientThis, name: string, color?: string | null): Promise<NoteTag> {
        return this.request<NoteTag>("notes/tags", {
            method: "POST",
            body: JSON.stringify({ name, color: color ?? null }),
        });
    },
    async updateTag(this: ClientThis, id: number, patch: Partial<NoteTag>): Promise<NoteTag | null> {
        return this.request<NoteTag | null>(`notes/tags/${id}`, {
            method: "PUT",
            body: JSON.stringify(patch),
        });
    },
    async deleteTag(this: ClientThis, id: number): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>(`notes/tags/${id}`, { method: "DELETE" });
    },
    async listNoteTags(this: ClientThis): Promise<Record<number, number[]>> {
        return this.request<Record<number, number[]>>("notes/tag-links");
    },
    async listNoteRevisions(this: ClientThis, id: number): Promise<NoteRevision[]> {
        return this.request<NoteRevision[]>(`notes/${id}/revisions`);
    },
    async getNoteRevision(this: ClientThis, noteId: number, revisionId: number): Promise<NoteRevision | null> {
        return this.request<NoteRevision | null>(`notes/${noteId}/revisions/${revisionId}`);
    },
    async restoreNoteRevision(this: ClientThis, noteId: number, revisionId: number): Promise<Note | null> {
        return this.request<Note | null>(`notes/${noteId}/revisions/${revisionId}`, { method: "POST" });
    },
    async setNoteTags(this: ClientThis, noteId: number, tagIds: number[]): Promise<NoteTag[]> {
        return this.request<NoteTag[]>(`notes/${noteId}/tags`, {
            method: "PUT",
            body: JSON.stringify({ tagIds }),
        });
    },
};
