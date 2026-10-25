// src/API/methods/notes/notesAttachment.ts
// 图片/文件附件的元数据 CRUD（notes 域的「附件」那一组）。
//
// ⚠️ 只存**元数据**。二进制在 R2（首选）或 KV（降级），见 worker/attachments.ts。
//   账号隔离：与其它 notes 方法同一套 scopeSql（单账号部署 uid 可能是 NULL，
//   scopeSql 会处理；这里不多套一层 WHERE —— attachments 表**没有 user_id 以外
//   的全局可见性**，写死 WHERE user_id 会破坏单账号部署）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { NoteAttachment, AttachmentStorage } from "../../types";

/**
 * 把正文里指向某个附件的 Markdown 链接的**显示文本**换掉（2026-10-19 附件重命名）。
 *
 * 只动方括号里那一段，括号里的 URL 一个字都不碰 —— URL 里是附件 id，
 * 改了就点不开了。上传时插的是 `[名字](<url>)`（带尖括号，见 NotesPage handleAttach），
 * 用户手写的可能是 `[名字](url)`，两种都要认。
 *
 * ⚠️ 图片语法 `![alt](url)` 故意跳过：重命名只对 txt / json 开放，
 * 一个文本附件被当图片嵌进正文属于脏数据，别顺手把它改成链接。
 */
function relabelAttachmentLink(content: string, id: string, filename: string): string {
    const needle = `/api/notes/attachments/${id}`;
    if (!content.includes(needle)) return content;
    return content.replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, whole => {
        if (!whole.includes(needle)) return whole;
        if (whole.startsWith("!")) return whole;
        const at = whole.indexOf("](");
        const target = whole.slice(at + 2, -1);
        return `[${filename}](${target})`;
    });
}

export const attachmentMethods: Pick<NotesApi,
    "listAttachments" | "getAttachment" | "getPublicAttachment" | "createAttachment" |
    "deleteAttachment" | "renameAttachment" | "pruneAttachments"> = {
    listAttachments: async function (this: NavigationAPI): Promise<NoteAttachment[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // ⚠️ 不 SELECT object_key：暴露它等于泄漏存储布局（key 里带 user_id），
            // 前端也没有理由知道。
            const result = await this.db
                .prepare(
                    `SELECT id, note_id, filename, mime, size, width, height, storage, created_at
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
            // 删除元数据与持久化对象清理任务同批提交，进程中断也不会丢失对象 key。
            const results = await this.db.batch([
                this.db.prepare(`INSERT OR IGNORE INTO configs (key, value)
                    SELECT 'auth.attachment.gc.' || id, json_object('storage', storage, 'objectKey', object_key)
                    FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
                this.db.prepare(`DELETE FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
            ]);
            const del = results[1] as { meta?: { changes?: number } };
            if (!del.meta?.changes) return { ok: false, status: 404, error: "附件不存在" };
            return { ok: true, storage: row.storage as AttachmentStorage, objectKey: row.object_key };
        });
    },

    renameAttachment: async function (
        this: NavigationAPI,
        id: string,
        filename: string
    ): Promise<
        | { ok: true; filename: string; updatedNotes: { id: number; content: string }[] }
        | { ok: false; status: 404 | 400; error: string }
    > {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                // ⚠️ 同 getAttachment：scopeSql(true) 多一个占位符，必须 scopeParams 补 uid
                .prepare(`SELECT filename, mime FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<{ filename: string; mime: string }>();
            if (!row) return { ok: false, status: 404, error: "附件不存在" };

            // ① 元数据改名。object_key 一个字都不动 —— 正文里的链接靠 id，
            //    id 不变就永远打得开（见接口注释）。
            await this.db
                .prepare(`UPDATE attachments SET filename = ?1 WHERE id = ?2 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([filename, id]))
                .run();

            // ② 正文同步：把引用了这个附件的笔记里、`[旧文本](…<id>…)` 的**方括号
            //    部分**换成新名字。只动 label，不动 URL —— URL 里是 id，改了就打不开。
            const pattern = `%/api/notes/attachments/${id}%`;
            const found = await this.db
                .prepare(`SELECT id, content FROM notes WHERE content LIKE ?1 ${this.scopeSql(true)}`)
                .bind(...this.scopeParams([pattern]))
                .all<{ id: number; content: string | null }>();

            const updatedNotes: { id: number; content: string }[] = [];
            for (const note of found.results || []) {
                const before = note.content || "";
                const after = relabelAttachmentLink(before, id, filename);
                // 记的是「正文里出现了 id」的笔记，但可能只出现在图片语法 / 纯文本里，
                // 没有可替换的 label —— 那样 after === before，跳过，别白白 rev+1。
                if (after === before) continue;
                updatedNotes.push({ id: note.id, content: after });
            }

            if (updatedNotes.length) {
                // ⚠️ rev 必须 +1：正文真的变了，别的设备靠 rev 感知「这条被改过」。
                // 不 +1 的话它们会一直拿着旧正文，直到自己下一次编辑把它覆盖回去。
                await this.db.batch(
                    updatedNotes.map(note =>
                        this.db
                            .prepare(
                                `UPDATE notes SET content = ?1, rev = rev + 1, updated_at = CURRENT_TIMESTAMP
                                  WHERE id = ?2${this.scopeSql(true)}`
                            )
                            .bind(...this.scopeParams([note.content, note.id]))
                    )
                );
            }

            return { ok: true, filename, updatedNotes };
        });
    },

    pruneAttachments: async function (this: NavigationAPI): Promise<{
        removed: { id: string; size: number; storage: AttachmentStorage; object_key: string }[];
    }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 一次查询直接把「没有任何正文引用」的附件挑出来。
            //
            // ⚠️ 2026-10-24 改（P1-2 消除 O(正文总量) 的全表扫）：
            // 老写法是「SELECT content FROM notes 全表拉回 JS → join 成一个大字符串
            // → 逐个 id 做 includes」。三个问题叠在一起：
            //   ① 把当前账号的**全部正文**从 D1 传进 Worker（几百条 × 几 KB 就是几 MB）；
            //   ② 再拼一个同等大小的字符串，峰值内存是正文总量的 2 倍；
            //   ③ `includes` 每命中不了就从头再扫 —— O(附件数 × 正文总量)。
            // 现在交给 SQLite 一次算完：NOT EXISTS + INSTR，内存只跟**结果集**有关
            // （被删的附件通常是个位数），正文一个字都不进 Worker。
            //
            // 判据没变：正文里出现这个 id 就算「还在用」。
            // 范围是**全部**笔记 —— 归档仍在 notes 表里，回收站不在（见下面第二条）。
            //
            // 关联条件用 `n.user_id IS a.user_id` 而不是 `=`：单账号部署下两边都是 NULL，
            // `=` 对 NULL 恒为假，会把「有引用」全判成「没引用」→ **误删所有附件**。
            // IS 在 SQLite 里对非 NULL 等价于 =，只在 NULL 上做特判，正好是我们要的。
            //
            // ⚠️ 第二条 NOT EXISTS 是这次补的**既存缺陷**（2026-10-24 由新增用例抓出来）：
            // `deleteNote` 是「把整行搬进 recycle_bin.data（JSON）→ 再从 notes 删行」，
            // 所以回收站里的笔记**正文根本不在 notes 表里**。老实现（只查 notes）因此会
            // 把「一条带图的笔记进回收站 → 清一次附件」的图**真删掉**，用户还原笔记后
            // 图片打不开。注释里当时写着「含回收站」，但代码并没有做到。
            // 现在补一层：在 recycle_bin.data 这份 JSON 文本里找附件 id（id 是 uuid 字符串，
            // 原样出现在 JSON 里，INSTR 足够且不需要解析 JSON）。
            const scopeA = this.currentUserId === null ? "" : " AND a.user_id = ?";
            const atts = await this.db
                .prepare(
                    `SELECT a.id, a.size, a.storage, a.object_key
                       FROM attachments a
                      WHERE 1 = 1${scopeA}
                        AND NOT EXISTS (
                              SELECT 1 FROM notes n
                               WHERE n.user_id IS a.user_id
                                 AND INSTR(n.content, a.id) > 0
                        )
                        AND NOT EXISTS (
                              SELECT 1 FROM recycle_bin r
                               WHERE r.kind = 'note'
                                 AND r.owner_user_id IS a.user_id
                                 AND INSTR(r.data, a.id) > 0
                        )`
                )
                .bind(...this.scopeParams([]))
                .all<{ id: string; size: number; storage: string; object_key: string }>();
            const removed = atts.results || [];
            for (const a of removed) {
                await this.db.batch([
                    this.db.prepare(`INSERT OR IGNORE INTO configs (key, value)
                        SELECT 'auth.attachment.gc.' || id, json_object('storage', storage, 'objectKey', object_key)
                        FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                        .bind(...this.scopeParams([a.id])),
                    this.db.prepare(`DELETE FROM attachments WHERE id = ?1 ${this.scopeSql(true)}`)
                        .bind(...this.scopeParams([a.id])),
                ]);
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
};
