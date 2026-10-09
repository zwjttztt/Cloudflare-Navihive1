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
import type {
    AttachmentStorage,
    Note,
    NoteAttachment,
    NoteFolder,
    NoteRevision,
    NoteTag,
    NoteShare,
    NoteShareListItem,
    PublicNoteAccess,
} from "../types";
import type { D1PreparedStatement } from "../schema";
import { newUuid } from "../../utils/uuid";
import { extractNoteTags } from "../../utils/markdownNoteTags";
import { hashPassword, verifyPassword } from "../crypto";

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
    getPublicNote(token: string, password?: string | null): Promise<PublicNoteAccess>;
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

    // ---- 版本历史（inkstone 顶栏「版本历史」）----
    /** 存一个快照（updateNote 内部调用；对外暴露是为了测试与批量导入） */
    pushRevision(noteId: number, title: string, content: string): Promise<void>;
    /** 列出一条笔记的历史快照（新→旧），不含正文全文以外的账号外信息 */
    listNoteRevisions(id: number): Promise<NoteRevision[]>;
    /** 取某个快照的全文（列表里只给摘要，省得一次拉十几份正文） */
    getNoteRevision(noteId: number, revisionId: number): Promise<NoteRevision | null>;
    /** 把某条快照恢复成当前正文（走 updateNote 的同一条路径，自动再存一份快照） */
    restoreNoteRevision(noteId: number, revisionId: number): Promise<Note | null>;
}

// NoteFolder / NoteTag 定义在 ../types（那边的 Note 也在一起）——
// 前后端、路由层共用同一份形状，别在方法文件里另起一份。

const NOTE_FIELDS =
    "id, uuid, title, content, pinned, order_num, site_id, archived, folder_id, created_at, updated_at";

/**
 * 每条笔记保留多少个历史快照。
 *
 * 60 是个容量与体验的折中：正常一天改十几版，60 条够回溯半个月；
 * 单条快照按 2KB 算 → 每条笔记最多约 120KB，一百条笔记约 12MB，
 * 在 D1 的额度里可接受。超出的从最旧开始裁。
 */
const REVISION_KEEP_PER_NOTE = 60;

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

export const notesImpl: NotesApi = {
    listNoteShares: async function (this: NavigationAPI) {
        await this.migrate();
        // JOIN notes 是必须的：光看 note_share 拿不到标题，而「分享列表」要一眼认出
        // 是哪篇笔记；顺带借 notes.user_id 做归属判定（note_share 自己也有 user_id）。
        return this.db.prepare(`SELECT s.note_id AS note_id, n.title AS title, s.token AS token,
                s.expires_at AS expires_at, s.views AS views, n.created_at AS created_at, n.updated_at AS updated_at
            FROM note_share s JOIN notes n ON n.id = s.note_id AND n.uuid = s.note_uuid AND n.user_id IS s.user_id
            WHERE s.user_id IS ?
            ORDER BY n.updated_at DESC`)
            .bind(this.currentUserId).all<NoteShareListItem>().then(r => r.results || []);
    },
    getNoteShare: async function (this: NavigationAPI, id: number) {
        await this.migrate();
        return this.db.prepare(`SELECT s.token, s.expires_at, s.views AS views,
                (s.password IS NOT NULL) AS hasPassword, n.created_at AS created_at
            FROM note_share s
            JOIN notes n ON n.id = s.note_id AND n.uuid = s.note_uuid AND n.user_id IS s.user_id
            WHERE n.id = ? AND n.user_id IS ?`)
            .bind(id, this.currentUserId).first<NoteShare>();
    },
    createNoteShare: async function (this: NavigationAPI, id: number, days: number | null, password?: string | null) {
        if (days !== null && ![1, 7, 30].includes(days)) throw new Error("分享有效期无效");
        await this.migrate();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
        const expires = days === null ? null : Date.now() + days * 86_400_000;
        // 访问口令：传了非空串才哈希落库；传 null/空 = 不设（公开）。
        // INSERT SELECT 直接验证归属；重新生成会轮换令牌，旧链接立即失效。
        const hashed = password && password.length > 0 ? await hashPassword(password) : null;
        return this.db.prepare(`INSERT INTO note_share (note_id, note_uuid, user_id, token, expires_at, password)
            SELECT id, uuid, user_id, ?, ?, ?
            FROM notes WHERE id = ? AND user_id IS ?
            ON CONFLICT(note_id) DO UPDATE SET note_uuid = excluded.note_uuid,
                user_id = excluded.user_id, token = excluded.token, expires_at = excluded.expires_at,
                password = excluded.password
            RETURNING token, expires_at, views, (password IS NOT NULL) AS hasPassword`)
            .bind(token, expires, hashed, id, this.currentUserId).first<NoteShare>();
    },
    revokeNoteShare: async function (this: NavigationAPI, id: number) {
        await this.migrate();
        await this.db.prepare("DELETE FROM note_share WHERE note_id = ? AND user_id IS ?")
            .bind(id, this.currentUserId).run();
        return { success: true };
    },
    updateNoteShare: async function (this: NavigationAPI, id: number, days: number | null, password?: string | null) {
        if (days !== null && ![1, 7, 30].includes(days)) throw new Error("分享有效期无效");
        await this.migrate();
        const expires = days === null ? null : Date.now() + days * 86_400_000;
        // UPDATE 保留 token：链接不变，只改有效期（与 createNoteShare 的
        // 「重新生成会轮换令牌」刻意区分 —— 对应 inkstone 的「更新设置」）。
        // 口令：传 string 重设；传 null 清除；不传（undefined）保持原值。
        let setSql = "expires_at = ?";
        const binds: unknown[] = [expires];
        if (password !== undefined) {
            setSql += ", password = ?";
            binds.push(password && password.length > 0 ? await hashPassword(password) : null);
        }
        // user_id IS ? 与 createNoteShare 一样是**内联**写的（不是 scopeSql 生成的），
        // 所以 uid 要像它那样直接 bind，不能走 scopeParams（否则会多绑一个 uid）。
        binds.push(id, this.currentUserId);
        return this.db
            .prepare(
                `UPDATE note_share SET ${setSql}
                 WHERE note_id = ? AND user_id IS ?
                 RETURNING token, expires_at, views, (password IS NOT NULL) AS hasPassword`
            )
            .bind(...binds)
            .first<NoteShare>();
    },
    getPublicNote: async function (this: NavigationAPI, token: string, password?: string | null): Promise<PublicNoteAccess> {
        if (!/^[a-f0-9]{64}$/.test(token)) return { status: "not-found" };
        await this.migrate();
        const row = await this.db.prepare(`SELECT n.title AS title, n.content AS content, n.updated_at AS updated_at,
                s.password AS password, s.views AS views
            FROM note_share s
            JOIN notes n ON n.id = s.note_id AND n.uuid = s.note_uuid AND n.user_id IS s.user_id
            WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
            AND (s.user_id IS NULL OR EXISTS (
                SELECT 1 FROM users u WHERE u.id = s.user_id AND COALESCE(u.status, 'active') = 'active'))`)
            .bind(token, Date.now()).first<{ title: string; content: string; updated_at?: string; password: string | null; views: number }>();
        if (!row) return { status: "not-found" };
        // 设了访问口令：没给 / 给错都拦下（401 让公开页弹出口令框）
        if (row.password) {
            const ok = password !== undefined && password !== null && password.length > 0
                && await verifyPassword(password, row.password);
            if (!ok) return { status: "need-password" };
        }
        // 浏览次数 +1（每次成功打开记一次；并发时 D1 自增原子，不会互相盖掉）
        const inc = await this.db.prepare(`UPDATE note_share SET views = views + 1 WHERE token = ?`)
            .bind(token).run();
        const views = (typeof row.views === "number" ? row.views : 0) + (inc.success ? 1 : 0);
        return {
            status: "ok",
            note: { title: row.title, content: row.content, updated_at: row.updated_at },
            views,
        };
    },
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
            // 版本历史：**正文/标题真的变了才留快照**。
            // 自动保存是 3 秒一防抖，一次连续改字会触发很多次 update，
            // 每次都存的话一分钟能堆出几十条一模一样的快照（用户回溯时被
            // 「十几版内容相同」淹没，真正的那次改动反而找不到）。
            const before =
                patch.content !== undefined || patch.title !== undefined
                    ? await this.db
                          .prepare(`SELECT title, content FROM notes WHERE id = ?${this.scopeSql(true)}`)
                          .bind(...this.scopeParams([id]))
                          .first<{ title: string; content: string }>()
                    : null;
            const changed =
                before !== null &&
                (before.content !== (patch.content ?? before.content) ||
                    before.title !== (patch.title ?? before.title));
            const tags = patch.content === undefined ? [] : inlineTagStatements(this, id, patch.content);
            // 快照与正文更新**不在同一个事务**里：快照失败不该让用户的保存失败
            // （历史是辅助功能，存不上只说明少一个版本，不能反过来把正文丢了）。
            const result = tags.length
                ? (await this.db.batch([statement, ...tags]))[0]
                : await statement.run();
            if (!result.success) return null;
            // 更新成功后才落快照（存的是**改动前**的内容）。
            // 失败只记日志：历史丢了不该让用户的保存变成失败。
            if (changed && before) {
                try {
                    await this.pushRevision(id, before.title, before.content);
                } catch (error) {
                    console.error("保存版本快照失败:", error);
                }
            }
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
            // 删除时先吊销链接，恢复笔记也不会重新公开。
            await this.revokeNoteShare(id);
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

    // ---------------- 图片附件（2026-07） ----------------
    //
    // ⚠️ 只存**元数据**。二进制在 R2（首选）或 KV（降级），见 worker/attachments.ts。
    //   账号隔离：与其它 notes 方法同一套 scopeSql（单账号部署 uid 可能是 NULL，
    //   scopeSql 会处理；这里不多套一层 WHERE —— attachments 表**没有 user_id 以外
    //   的全局可见性**，写死 WHERE user_id 会破坏单账号部署）。

    listAttachments: async function (this: NavigationAPI): Promise<NoteAttachment[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // ⚠️ 不 SELECT object_key：暴露它等于泄漏存储布局（key 里带 user_id），
            // 前端也没有理由知道。
            const result = await this.db
                .prepare(
                    `SELECT id, note_id, filename, mime, size, storage, created_at
                     FROM attachments
                     ${this.scopeSql(false)}
                     ORDER BY created_at DESC
                     LIMIT 200`
                )
                // ⚠️ scopeSql(false) 在登录用户下会追加 "WHERE user_id = ?"：
                // 不 bind 的话 D1 直接抛 wrong number of bindings → 接口 500。
                // 附件方法是全库唯一直接 .bind(id) 的重灾区（2026-10-09 线上取图 500 的真因）。
                .bind(...this.scopeParams([]))
                // 纯读用 all()（D1 的 run()/all() 都带 results，但真 SQLite 适配器只有 all() 给行）
                .all();
            return result.results as unknown as NoteAttachment[];
        });
    },

    getAttachment: async function (this: NavigationAPI, id: string): Promise<NoteAttachment | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                // ⚠️ 必须走 scopeParams：scopeSql(true) 追加 " AND user_id = ?"，
                // 直接 .bind(id) 会让占位符（2 个）与参数（1 个）不匹配 → D1 抛错 → 500。
                // 2026-10-09 线上「图片显示不出（服务器返回 500）」就是这一行。
                .prepare(`SELECT * FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            return row ? ({ ...row } as unknown as NoteAttachment) : null;
        });
    },

    /**
     * 取一条**公开笔记里的**图片附件（2026-10-08）。
     *
     * 公开分享页是匿名访问的（/s/<token>），而 `GET notes/attachments/<id>` 挂在
     * 鉴权后面 —— 访客拿不到图，笔记里就只剩一个「图片加载失败」占位。
     * 但直接把取图放开是越权：任何知道 uuid 的人都能把所有人的图拉走。
     * 所以这里多一道判定：这个附件必须属于**一条当前有效的分享**才能取。
     * uuid 本身不可猜（128 位随机），链接持有者看到自己那份，边界与分享页一致。
     */
    getPublicAttachment: async function (
        this: NavigationAPI,
        id: string
    ): Promise<NoteAttachment | null> {
        if (!/^[0-9a-z-]{8,64}$/.test(id)) return null;
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(
                    `SELECT a.* FROM attachments a
                        JOIN note_share s ON s.note_id = a.note_id
                     WHERE a.id = ?1
                       AND (s.expires_at IS NULL OR s.expires_at > ?2)
                       AND (s.user_id IS NULL OR EXISTS (
                            SELECT 1 FROM users u
                             WHERE u.id = s.user_id AND COALESCE(u.status, 'active') = 'active'))`
                )
                .bind(id, Date.now())
                .first<Record<string, unknown>>();
            return row ? ({ ...row } as unknown as NoteAttachment) : null;
        });
    },

    createAttachment: async function (
        this: NavigationAPI,
        row: {
            id: string;
            note_id: number | null;
            filename: string;
            mime: string;
            size: number;
            storage: AttachmentStorage;
            object_key: string;
        }
    ): Promise<void> {
        await this.migrate();
        await this.withSchemaRetry(async () => {
            await this.db
                .prepare(
                    `INSERT INTO attachments
                       (id, user_id, note_id, filename, mime, size, storage, object_key, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
                )
                // ⚠️ user_id 取当前账号 —— **不要**接受调用方传的用户 id，
                // 否则改个参数就能往别人名下塞数据（越权）。
                .bind(
                    row.id,
                    this.currentUserId ?? null,
                    row.note_id,
                    row.filename,
                    row.mime,
                    row.size,
                    row.storage,
                    row.object_key,
                    Date.now()
                )
                .run();
        });
    },

    deleteAttachment: async function (
        this: NavigationAPI,
        id: string
    ): Promise<
        | { ok: true; storage: AttachmentStorage; objectKey: string }
        | { ok: false; status: 404; error: string }
    > {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                // ⚠️ 同 getAttachment：scopeSql(true) 多一个占位符，必须 scopeParams 补 uid
                .prepare(`SELECT storage, object_key FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<{ storage: string; object_key: string }>();
            if (!row) return { ok: false, status: 404, error: "附件不存在" };
            // 先删记录，成功才让调用方去删对象（反过来会出现「记录没了、对象还在」→ 永久泄漏）
            const del = (await this.db
                .prepare(`DELETE FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run()) as { meta?: { changes?: number } };
            if (!del.meta?.changes) return { ok: false, status: 404, error: "附件不存在" };
            return { ok: true, storage: row.storage as AttachmentStorage, objectKey: row.object_key };
        });
    },

    pruneAttachments: async function (this: NavigationAPI): Promise<{
        removed: { id: string; size: number; storage: AttachmentStorage; object_key: string }[];
    }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 全量附件元数据（object_key 只在服务端链路里用，前端列表会被剥掉、
            // 但 prune 本身只在 worker 侧跑，拿得到）。
            const atts = await this.db
                .prepare(
                    `SELECT id, size, storage, object_key FROM attachments ${this.scopeSql(false)}`
                )
                // ⚠️ scopeSql(false) 登录用户下是 "WHERE user_id = ?"，必须补 bind（同 listAttachments）
                .bind(...this.scopeParams([]))
                .all<{ id: string; size: number; storage: string; object_key: string }>();
            // 正文全集（含回收站 / 归档）：还原后图片还得能用，所以判据是
            // 「任何一篇的正文里都没出现这个 id」，不是「所属笔记已删除」。
            const rows = await this.db
                .prepare(`SELECT content FROM notes ${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .all<{ content: string | null }>();
            const corpus = (rows.results || []).map(r => r.content || "").join("\n");
            const removed = (atts.results || []).filter(a => !corpus.includes(a.id));
            for (const a of removed) {
                await this.db
                    .prepare(`DELETE FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                    // scopeSql(true) 追加 " AND user_id = ?"：参数末尾要跟上 uid
                    // （单账号部署 uid 为 NULL 时 scopeSql/scopeParams 都返回空，正好）。
                    .bind(...this.scopeParams([a.id]))
                    .run();
            }
            return {
                removed: removed.map(a => ({
                    id: a.id,
                    size: a.size,
                    storage: a.storage as AttachmentStorage,
                    object_key: a.object_key,
                })),
            };
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

    // ============ 版本历史 ============
    //
    // 快照落点：updateNote 里正文**改动前**先把旧内容存一份。
    // 每条笔记只保留 REVISION_KEEP_PER_NOTE 条 —— 这是容量红线：
    // D1 单库有上限，快照是唯一会随时间无限增长的新表，不裁剪迟早撑爆。

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
