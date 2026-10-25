// src/API/methods/notes.ts
// NavigationAPI 的「notes」域方法体（记事本）。
//
// 与 data.ts 同样的结构：方法体用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 混回原型。
//
// 三个和 sites 不同的地方，都是刻意的：
//   1. **user_id 靠 scopeSql 隔离**，与 sites/configs 完全同一套（含单账号部署 uid=NULL）。
//   2. **删除走回收站**（kind='note'）：笔记往往比卡片更不可再生，值得多这一步。
//   3. **uuid 在这里生成**：合并导入靠它识别「同一条笔记」（见 transfer.ts 的导入逻辑）。
//      没有它就只能按标题+内容硬比，用户改过一次的笔记会被当成两条。
//
// 2026-10-25 拆分（#538）：域方法按职责拆进 ./notes/*.ts，这里只保留 NotesApi 接口与组合点；
// 子模块各自导出 `Pick<NotesApi, ...>` 的一组方法，再展开合成 notesImpl。组合不改变 `this`
// 绑定与调用语义，纯属文件归属调整 —— 对外（navigationApi.ts、mock 对齐、单测）完全不变。
import type { AuditEntry } from "./data";
import type {
    AttachmentStorage,
    Note,
    NoteAttachment,
    NoteFolder,
    NoteRevision,
    NoteTag,
    NoteShare,
    NoteShareListItem,
    NoteStats,
    NoteImportStats,
    NoteSearchResult,
    NotesChangesResult,
    NotesImportPayload,
    PublicNoteAccess,
} from "../types";

import { shareMethods } from "./notes/notesShare";
import { backupMethods } from "./notes/notesBackup";
import { noteMethods } from "./notes/notesNote";
import { attachmentMethods } from "./notes/notesAttachment";
import { folderMethods } from "./notes/notesFolder";
import { tagMethods } from "./notes/notesTag";
import { revisionMethods } from "./notes/notesRevision";
import { searchMethods } from "./notes/notesSearch";

export interface NotesApi {
    getNoteShare(id: number): Promise<NoteShare | null>;
    /** 分享列表：主人名下所有已分享的笔记（设置页「分享列表」） */
    listNoteShares(): Promise<NoteShareListItem[]>;
    /** 创建/轮换分享链接；password 可空（null = 不设/清除访问口令） */
    createNoteShare(id: number, days: number | null, password?: string | null): Promise<NoteShare | null>;
    revokeNoteShare(id: number): Promise<{ success: boolean }>;
    /**
     * 更新有效期但**保留 token**（链接不变）—— inkstone SharePanel 的
     * 「更新设置」同语义；createNoteShare 会轮换令牌，不能拿它改设置。
     * password 传 string 则重设口令；传 null 则清除口令；不传则保持原口令。
     * 没有有效期时返回 null（分享不存在）。
     */
    updateNoteShare(id: number, days: number | null, password?: string | null): Promise<NoteShare | null>;
    getPublicNote(token: string, password?: string | null, countView?: boolean): Promise<PublicNoteAccess>;
    /** 数据页概览「双链 / 版本历史」两格的全站计数（后端现算，前端不持有全量正文） */
    notesStats(): Promise<NoteStats>;
    /**
     * 导入「记事本导出」JSON（NotesPage exportAllData 的形状），**只动记事本**：
     * 按 uuid 识别同一条，文件里较新才覆盖，本地较新就保留；文件夹按
     * 「父路径+名称」、标签按「名称」去重重建，标签关联翻译到新 id。
     * 整批一个事务：任何一条失败全部回滚，本地数据一根汗毛都不动。
     */
    importNotesData(payload: NotesImportPayload): Promise<NoteImportStats>;
    /**
     * 导出全部笔记数据（**服务端自取**，cron 自动备份与手动备份共用）：
     * 形状与 importNotesData 的入参对齐（kind: "navihive-notes-backup"），
     * 所以「备份 → 下载 → 数据页导入」天然是闭环，不需要另一套恢复代码。
     * 只含当前账号的在册笔记（回收站里的不算）。
     */
    exportNotesData(): Promise<NotesImportPayload>;
    /**
     * 笔记列表。
     *
     * `summary: true` 时**不回正文**，只回开头一段摘要，并在每条上打
     * `content_truncated: true` —— 点开某条要用 getNote 取全文。
     * 这是给「笔记多了以后 /api/notes 变成 MB 级」准备的阀门
     * （正文几 KB~几十 KB × 几百条，在慢链路上要几十秒）。
     * 现在默认不开：笔记才几十条时，列表里带正文只要 2 KB，
     * 开了反而让**每次点开笔记多一次往返**。
     */
    listNotes(opts?: { summary?: boolean }): Promise<Note[]>;
    getNote(id: number): Promise<Note | null>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    /** 软删除：先进回收站再删行，返回 recycleId 供撤销 */
    deleteNote(id: number, audit?: AuditEntry): Promise<{ success: boolean; recycleId?: number }>;
    updateNoteOrder(orders: { id: number; order_num: number }[]): Promise<boolean>;
    countNotes(): Promise<number>;

    // ---- 文件夹（阶段三收尾）----
    /** 取当前账号的文件夹清单（顺带回每条的笔记数，UI 直接显示） */
    listFolders(): Promise<NoteFolder[]>;
    createFolder(draft: Partial<NoteFolder>): Promise<NoteFolder>;
    updateFolder(id: number, patch: Partial<NoteFolder>): Promise<NoteFolder | null>;
    /** 删文件夹：笔记不跟着删，只把它们的 folder_id 置空（变成「未归类」） */
    deleteFolder(id: number): Promise<{ success: boolean; orphaned: number }>;

    // ---- 图片附件（2026-07）----
    /**
     * 列出当前账号的附件（给「图片管理」之类的入口用）。
     * ⚠️ 二进制**不在这里**返回 —— 一次最多 25MB，走 JSON 会把 Worker 响应体撑爆。
     * 这里只回元数据，取图走 `GET notes/attachments/<id>`。
     */
    listAttachments(): Promise<NoteAttachment[]>;
    getAttachment(id: string): Promise<NoteAttachment | null>;
    /** 公开分享页取图：附件必须属于一条**当前有效**的分享，否则 null（防越权枚举） */
    getPublicAttachment(id: string): Promise<NoteAttachment | null>;
    /** 删记录。**不删对象** —— 对象由调用方拿着 storage/object_key 去删（见 worker/routes/data.ts） */
    deleteAttachment(id: string): Promise<
        | { ok: true; storage: AttachmentStorage; objectKey: string }
        | { ok: false; status: 404; error: string }
    >;
    /**
     * 重命名附件（2026-10-19 用户要「上传后的 txt / json 能重命名」）。
     *
     * **只改元数据里的 filename，不动 object_key** —— 正文里那张链接是
     * `/api/notes/attachments/<id>`，id 不变，所以笔记里的链接照样打得开。
     * 代价是「文件名」与「存储 key」从此解耦：key 一直是最初上传时的 uuid，
     * 谁也看不到，也无所谓。
     *
     * 顺带把正文里 `[旧名字](/api/notes/attachments/<id>)` 的**方括号部分**换成
     * 新名字（只替换 label，不碰 URL）—— 否则管理器里改了名，笔记里还显示旧名，
     * 用户会以为没生效。改过正文的笔记 rev +1，其它设备下一轮轮询就能感知。
     */
    renameAttachment(id: string, filename: string): Promise<
        | { ok: true; filename: string; updatedNotes: { id: number; content: string }[] }
        | { ok: false; status: 404 | 400; error: string }
    >;
    /**
     * 清理未引用附件（2026-10-08，设置 → 数据 → 维护，照 inkstone）：
     * 扫全部笔记正文（含回收站/归档，还原后图片还要能用），把 id 没在任何
     * 正文里出现过的附件删掉。**只删 D1 记录** —— 对象由 worker 路由拿着
     * 返回的 storage/object_key 去删（与 deleteAttachment 同一约定）。
     */
    pruneAttachments(): Promise<{
        removed: { id: string; size: number; storage: AttachmentStorage; object_key: string }[];
    }>;
    /** 写一条附件记录（D1 只有元数据） */
    createAttachment(row: {
        id: string;
        note_id: number | null;
        filename: string;
        mime: string;
        size: number;
        storage: AttachmentStorage;
        object_key: string;
    }): Promise<void>;

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

    // ---- 跨设备变更轮询（2026-10-11）----
    /**
     * 自上次游标以来的变更信号 + 文件夹/标签全量快照。
     * 只回计数与轻量结构，**不回笔记正文** —— 客户端发现变更后走既有 reload() 整表重拉。
     */
    notesChanges(since?: string): Promise<NotesChangesResult>;

    // ---- 版本历史（inkstone 顶栏「版本历史」）----
    /** 存一个快照（updateNote 内部调用；对外暴露是为了测试与批量导入） */
    pushRevision(noteId: number, title: string, content: string): Promise<void>;
    /** 列出一条笔记的历史快照（新→旧），不含正文全文以外的账号外信息 */
    listNoteRevisions(id: number): Promise<NoteRevision[]>;
    /** 取某个快照的全文（列表里只给摘要，省得一次拉十几份正文） */
    getNoteRevision(noteId: number, revisionId: number): Promise<NoteRevision | null>;
    /** 把某条快照恢复成当前正文（走 updateNote 的同一条路径，自动再存一份快照） */
    restoreNoteRevision(noteId: number, revisionId: number): Promise<Note | null>;

    // ---- 全文检索（2026-10-09，FTS5 + LIKE 回退）----
    /**
     * 搜当前账号的笔记。有 notes_fts 就走 FTS5（bm25 排序、标题权重更高），
     * 没有就退回 LIKE 全表扫 —— 结果一致，只是慢、且没有相关度排序。
     * 返回按相关度排好的 `id` 列表 + 命中片段，前端拿它排序与显示摘要。
     */
    searchNotes(query: string, limit?: number): Promise<NoteSearchResult>;
    /** 把一条笔记（重）写进全文索引。失败只记日志，绝不打断调用方。 */
    syncNoteFts(noteId: number, title: string, content: string): Promise<void>;
    /** 从全文索引里去掉一条笔记（删除 / 清空回收站时） */
    dropNoteFts(noteId: number): Promise<void>;
}

// NoteFolder / NoteTag 定义在 ../types（那边的 Note 也在一起）——
// 前后端、路由层共用同一份形状，别在方法文件里另起一份。

export const notesImpl: NotesApi = {
    ...shareMethods,
    ...backupMethods,
    ...noteMethods,
    ...attachmentMethods,
    ...folderMethods,
    ...tagMethods,
    ...revisionMethods,
    ...searchMethods,
};
