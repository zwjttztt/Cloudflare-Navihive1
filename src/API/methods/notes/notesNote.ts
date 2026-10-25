// src/API/methods/notes/notesNote.ts
// 笔记本体 CRUD（listNotes / getNote / createNote / updateNote / deleteNote /
// updateNoteOrder / countNotes）以及 createNote/updateNote 共用的两条本地辅助
// （inlineTagStatements 自动标签、releaseSiteBindingStatement 一站一笔记收口）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI` 让 TS 认得 this，
// 由 http.ts 混回原型。组合不改变 `this` 绑定与调用语义 —— 对外完全不变。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { Note } from "../../types";
import type { AuditEntry } from "../data";
import type { D1PreparedStatement } from "../../schema";
import { auditStatement } from "../data";
import { newUuid } from "../../../utils/uuid";
import { countWikiLinks } from "../../../utils/noteWikiLink";
import { extractNoteTags } from "../../../utils/markdownNoteTags";
import { NOTE_SUMMARY_CHARS, REVISION_KEEP_PER_NOTE, needsSummary } from "../../../utils/noteLimits";
import { segmentCJK, FTS_CONTENT_LIMIT } from "../../../utils/ftsQuery";
import { NoteConflictError } from "../../../utils/noteConflict";
import { NOTE_FIELDS, validateFolderParent } from "./notesShared";

/**
 * 每条笔记的自动标签：从正文里挑出 `[[标签]]` / `#标签` 形式的标签名，
 * 条件 INSERT 进 note_tag（不存在才建）并挂到 note_note_tag（忽略重复）。
 * 只追加，不撤销手工标签。
 */
function inlineTagStatements(api: NavigationAPI, noteKey: number | string, content: string): D1PreparedStatement[] {
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
 * 「一个站点最多绑一篇笔记」（#477）的**唯一收口**。
 *
 * 绑定关系存在 `notes.site_id` 上，所以「换绑」等于：先把同一个站点上**别的**
 * 笔记解绑，再把自己设上去。不这么做的话，站点侧那两个相关子查询
 * （data.ts SITE_SELECT_WITH_NOTE）就只能靠 ORDER BY 猜「该显示哪一篇」——
 * 数据是能读，但「一张卡片挂着一篇笔记」的语义就没了。
 *
 * 返回一条 UPDATE，调用方要把它塞进**同一个 batch、排在主语句之前**：
 *   顺序反了会把刚绑好的又清掉（先设后清 = 白设一次）。
 *
 * `keepNoteId` 传 null 表示「新建笔记那条路」—— 此刻新笔记还没有 id，
 * 站点上原有的那篇就该被让位（不可能保留自己）。
 * 带账号隔离，动不到别人的笔记。
 */
function releaseSiteBindingStatement(
    api: NavigationAPI,
    siteId: number,
    keepNoteId: number | null
): D1PreparedStatement {
    if (keepNoteId === null) {
        return api.db
            .prepare(`UPDATE notes SET site_id = NULL WHERE site_id = ?${api.scopeSql(true)}`)
            .bind(...api.scopeParams([siteId]));
    }
    return api.db
        .prepare(
            `UPDATE notes SET site_id = NULL WHERE site_id = ? AND id != ?${api.scopeSql(true)}`
        )
        .bind(...api.scopeParams([siteId, keepNoteId]));
}

export const noteMethods: Pick<NotesApi,
    "listNotes" | "getNote" | "createNote" | "updateNote" |
    "deleteNote" | "updateNoteOrder" | "countNotes"> = {
    listNotes: async function (this: NavigationAPI, opts?: { summary?: boolean }): Promise<Note[]> {
        await this.migrate();
        const summary = opts?.summary === true;
        return this.withSchemaRetry(async () => {
            // 摘要模式：正文换成开头 200 字符（够列表卡片显示一行预览），
            // 并打上截断标记，好让调用方知道「这条的正文不是全文」。
            // 用 SQL 的 substr 而不是取回全量再切：省的是**数据库到 Worker 这一段**，
            // 在 D1 上这才是大头（取回再切等于白跑一趟）。
            // ⚠️ 别去改 NOTE_FIELDS 本身：写操作（create/update 的 RETURNING）要用全字段。
            const fields = summary
                ? NOTE_FIELDS.replace(
                      /\bcontent\b/,
                      `substr(content, 1, ${NOTE_SUMMARY_CHARS}) AS content`
                  )
                : NOTE_FIELDS;
            const result = await this.db
                .prepare(
                    `SELECT ${fields} FROM notes${this.scopeSql(false)} ORDER BY pinned DESC, order_num, id`
                )
                .bind(...this.scopeParams([]))
                .all<Note>();
            const rows = result.results || [];
            if (!summary) return rows;
            return rows.map(row =>
                needsSummary(row.content) ? { ...row, content_truncated: true } : row
            );
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
        // ⚠️ 两个坑都在这句里（踩过一次，症状是接口一律 500）：
        //   1. 子查询里必须用 `scopeSql(false)`。`scopeSql(true)` 生成的是
        //      ` AND user_id = ?`，接在 `FROM notes` 后面就成了
        //      `FROM notes AND user_id = ?` —— SQL 语法错误。
        //      带 AND 的那个只用在「已经有 WHERE」的语句尾部。
        //   2. 子查询里的 `?` 也要绑参数。用 `scopeParams([])` 取，
        //      它在单账号部署（uid 为 NULL）下返回空数组，两种情况都对。
        const scopeTail = this.scopeParams([]);
        const uuid = draft.uuid || newUuid();
        // 正文只求值一次：link_count 与 content 必须来自**同一份**字符串
        const content = draft.content || "";
        const statement = this.db
            .prepare(
                // ⚠️⚠️ 列数必须与值数**一一对应**：阶段三收尾给列尾加了 folder_id，
                // 值这一侧却忘了补 `?` —— 8 列 7 值，SQLite 直接报
                // "table notes has 8 columns but 7 values were supplied"，
                // POST /api/notes **一律 500，新建笔记功能整个不可用**
                // （GET /api/notes 正常，所以列表看着好好的，一点都不像坏了）。
                // 下面的 sql 形状守卫就是盯这一类：INSERT 的列数 ≠ 顶层值数就红。
                `INSERT INTO notes (user_id, uuid, title, content, link_count, pinned, order_num, site_id, folder_id)
                 VALUES (?, ?, ?, ?, ?, ?, COALESCE((
                     SELECT MAX(order_num) + 1 FROM notes${this.scopeSql(false)}
                 ), 0), ?, ?)
                 RETURNING ${NOTE_FIELDS}`
            )
            .bind(
                this.currentUserId,
                uuid,
                draft.title || "",
                content,
                // 双链数在写入时算好 —— 数据页统计读的就是这一列（见 notesStats）
                countWikiLinks(content),
                draft.pinned ? 1 : 0,
                ...scopeTail,
                draft.site_id ?? null,
                // 未指定就落 NULL（= 未归类），而不是 0 —— 0 会被当成「有个 id 为 0 的文件夹」
                draft.folder_id ?? null
            );
        // 一站一笔记：新建时若直接指定了站点，站点上原来那篇要让位（见 helper 注释）
        const pre: D1PreparedStatement[] =
            typeof draft.site_id === "number"
                ? [releaseSiteBindingStatement(this, draft.site_id, null)]
                : [];
        const tags = inlineTagStatements(this, uuid, draft.content || "");
        const all = [...pre, statement, ...tags];
        // 只有一条语句时走 all()，省掉 batch 那层包装（与拆分前一致）
        const result =
            all.length === 1 ? await statement.all<Note>() : (await this.db.batch<Note>(all))[pre.length];
        if (!result.success || !result.results?.length) throw new Error("创建笔记失败");
        const created = result.results[0];
        // 全文索引：建完再补，写不进去只影响搜索（见 syncNoteFts 的注释）
        if (typeof created.id === "number") {
            // ⚠️ 刻意 await：Workers 在响应返回后会把没完成的 Promise 掐掉，
            // `void` 出去的索引写入会被静默丢掉（本地测不出来，线上索引缺一大片）。
            // syncNoteFts 自己吞异常，所以这里不会影响创建结果。
            await this.syncNoteFts(created.id, created.title ?? "", created.content ?? "");
        }
        return created;
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
                // 正文变了，双链数必须跟着重算 —— 否则数据页那个数字永远停在旧值。
                // 与 content 紧挨着 push，保证 params 顺序与 updates 一一对应。
                updates.push("link_count = ?");
                params.push(countWikiLinks(patch.content));
            }
            if (patch.pinned !== undefined) {
                updates.push("pinned = ?");
                params.push(patch.pinned ? 1 : 0);
            }
            // 收藏（与置顶分离，见 Note.starred 的注释）
            if (patch.starred !== undefined) {
                updates.push("starred = ?");
                params.push(patch.starred ? 1 : 0);
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

            // 乐观并发（2026-10-09）：客户端带上「我改的是 rev = N 那版」，
            // SQL 里就多一个 `AND rev = N`。库里已经是 N+1 说明**别人在这期间改过**，
            // 这条 UPDATE 会一条都不命中 —— 据此返回 409 + 当前内容，
            // 让客户端弹「这条在别处改过」，而不是静默覆盖掉别人的改动。
            // ⚠️ 不传 rev 就是老行为（无条件覆盖），老客户端/演示模式不受影响。
            const expectRev = typeof patch.rev === "number" ? patch.rev : null;
            updates.push("rev = rev + 1");

            params.push(id);
            const binds = [...this.scopeParams(params)];
            let sql = `UPDATE notes SET ${updates.join(", ")} WHERE id = ?${this.scopeSql(true)}`;
            if (expectRev !== null) {
                sql += " AND rev = ?";
                binds.push(expectRev);
            }
            // RETURNING：省掉「更新后再回读一次」的那趟往返（与 updateSiteRow 同款）。
            // 更新了 0 行（并发冲突 / 笔记不存在）时 RETURNING 就是空数组，直接据此判定 ——
            // 不再依赖 meta.changes 的形状（旧写法在拿不到 changes 的环境里会把冲突
            // 当「改到了」，乐观锁静默失效）。
            sql += ` RETURNING ${NOTE_FIELDS}`;
            const statement = this.db.prepare(sql).bind(...binds);
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
            // 一站一笔记：换绑时把同一站点上别的笔记先解绑（排在本条 UPDATE 之前，
            // 顺序反了会把刚设上的 site_id 又清掉）。约束只在这两处收口。
            const pre: D1PreparedStatement[] =
                typeof patch.site_id === "number"
                    ? [releaseSiteBindingStatement(this, patch.site_id, id)]
                    : [];
            const all = [...pre, statement, ...tags];
            // 快照与正文更新**不在同一个事务**里：快照失败不该让用户的保存失败
            // （历史是辅助功能，存不上只说明少一个版本，不能反过来把正文丢了）。
            const result =
                all.length === 1 ? await statement.all<Note>() : (await this.db.batch(all))[pre.length];
            if (!result.success) return null;
            const updatedRows = (result.results || []) as Note[];
            if (updatedRows.length === 0) {
                // 更新了 0 行：要么并发冲突（rev 对不上），要么这条笔记根本不存在
                if (expectRev !== null) {
                    const current = await this.db
                        .prepare(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?${this.scopeSql(true)}`)
                        .bind(...this.scopeParams([id]))
                        .first<Note>();
                    if (current) throw new NoteConflictError("这条笔记在别处被改过了", current);
                }
                return null;
            }
            const row = updatedRows[0];
            // 快照（存的是**改动前**的内容）与全文索引合进**同一个 batch** = 一次往返。
            // 两者都是辅助功能，失败只记日志，不能让用户的保存失败。
            const titleOrContentTouched =
                patch.content !== undefined || patch.title !== undefined;
            if (changed && before) {
                const followup: D1PreparedStatement[] = [
                    this.db
                        .prepare(
                            "INSERT INTO note_revision (note_id, user_id, title, content) VALUES (?, ?, ?, ?)"
                        )
                        .bind(id, this.currentUserId, before.title, before.content),
                    // 裁剪：每条笔记只留最近 N 版（与 pushRevision 同一条 SQL）
                    this.db
                        .prepare(
                            `DELETE FROM note_revision WHERE note_id = ? AND user_id IS ?
                             AND id NOT IN (
                                 SELECT id FROM note_revision WHERE note_id = ? AND user_id IS ?
                                 ORDER BY id DESC LIMIT ?
                             )`
                        )
                        // ⚠️ `IS ?` 而不是 `= ?`：单账号部署 user_id 是 NULL，`= NULL` 永远不成立
                        .bind(id, this.currentUserId, id, this.currentUserId, REVISION_KEEP_PER_NOTE),
                ];
                if (typeof row.id === "number" && titleOrContentTouched && this.notesFtsReady) {
                    followup.push(
                        this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(row.id),
                        this.db
                            .prepare(
                                "INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)"
                            )
                            .bind(
                                row.id,
                                this.currentUserId,
                                segmentCJK(row.title ?? ""),
                                segmentCJK((row.content ?? "").slice(0, FTS_CONTENT_LIMIT))
                            )
                    );
                }
                try {
                    await this.db.batch(followup);
                } catch (error) {
                    console.error("保存版本快照/全文索引失败:", error);
                }
            } else if (row && typeof row.id === "number" && titleOrContentTouched) {
                // 内容/标题动了但没快照可存（理论上到不了这里）：索引仍要同步。
                // 必须写进 notesFtsReady 由 syncNoteFts 自己判断。
                await this.syncNoteFts(row.id, row.title ?? "", row.content ?? "");
            }
            return row;
        });
    },

    deleteNote: async function (
        this: NavigationAPI,
        id: number,
        audit?: AuditEntry
    ): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 两个 SELECT 互不依赖，并行发（笔记原始行 + 标签关联）
            const [note, links] = await Promise.all([
                this.db
                    .prepare(`SELECT * FROM notes WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id]))
                    .first<Record<string, unknown>>(),
                this.db
                    .prepare(
                        `SELECT l.tag_id FROM note_note_tag l
                         JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}
                         WHERE l.note_id = ?`
                    )
                    .bind(...this.scopeParams([]), id)
                    .all<{ tag_id: number }>(),
            ]);
            if (!note) return { success: false };

            // ⚠️ 标签关联必须**跟着笔记一起进回收站**，而且要在删行之前取。
            // 以前两处都缺：① 关联行留在 note_note_tag 里，笔记没了它就成悬空行
            // （左栏标签计数还照算，读的是全表）；② 还原换新 id，那些关联接不回来，
            // 用户看到的是「删之前有标签，还原后标签没了」。
            // note_note_tag 这张表没有 user_id 列，归属只能靠 JOIN notes 判定。
            const tagIds = (links.results || []).map(r => r.tag_id);

            // 回收站、清关联、吊销分享、删真身、删全文索引、墓碑、审计 ——
            // 全部合进**同一个 db.batch**（= 一次往返 + 一个事务）。以前是 8 次
            // 串行往返，而且墓碑/索引失败会留下「行删了但下游没跟上」的中间态。
            const statements: D1PreparedStatement[] = [
                // 先搬进回收站再删行：顺序反了就救不回来了
                this.db
                    .prepare(
                        "INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)"
                    )
                    .bind(
                        "note",
                        this.currentUserId,
                        JSON.stringify({ note, tagIds }),
                        Math.floor(Date.now() / 1000)
                    ),
            ];
            if (tagIds.length > 0) {
                statements.push(
                    this.db.prepare("DELETE FROM note_note_tag WHERE note_id = ?").bind(id)
                );
            }
            // 删除时先吊销链接，恢复笔记也不会重新公开（与 revokeNoteShare 同一条 SQL）
            statements.push(
                this.db
                    .prepare("DELETE FROM note_share WHERE note_id = ? AND user_id IS ?")
                    .bind(id, this.currentUserId)
            );
            statements.push(
                this.db
                    .prepare(`DELETE FROM notes WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id]))
            );
            if (this.notesFtsReady) {
                statements.push(
                    this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(id)
                );
            }
            // 删除墓碑（2026-10-11）：软删除对 notes 表是物理删行，只看 updated_at 的
            // 轮询看不见「少了哪条」。墓碑让其它设备的轮询能感知到这次删除。
            if (typeof note.uuid === "string" && note.uuid) {
                statements.push(
                    this.db
                        .prepare("INSERT INTO note_tombstone (user_id, note_uuid) VALUES (?, ?)")
                        .bind(this.currentUserId, note.uuid)
                );
            }
            const auditStmt = auditStatement(this, audit);
            if (auditStmt) statements.push(auditStmt);

            const results = await this.db.batch(statements);
            const meta = results[0]?.meta as { last_row_id?: number } | undefined;
            const recycleId =
                typeof meta?.last_row_id === "number" ? meta.last_row_id : undefined;
            return { success: true, recycleId };
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
};
