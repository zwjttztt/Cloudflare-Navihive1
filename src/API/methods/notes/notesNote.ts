// src/API/methods/notes/notesNote.ts
// 笔记本体 CRUD（listNotes / getNote / createNote / updateNote / deleteNote /
// updateNoteOrder / countNotes）以及 createNote/updateNote 共用的两条本地辅助
// （inlineTagStatements 自动标签、releaseSiteBindingStatement 一站一笔记收口）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI` 让 TS 认得 this，
// 由 http.ts 混回原型。组合不改变 `this` 绑定与调用语义 —— 对外完全不变。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { Note, NoteBatchDeleteResult } from "../../types";
import type { AuditEntry } from "../data";
import type { D1PreparedStatement } from "../../schema";
import { chunkByParamBudget } from "../../d1Limits";
import { auditStatement } from "../data";
import { newUuid } from "../../../utils/uuid";
import { countWikiLinks } from "../../../utils/noteWikiLinkCount";
import { extractNoteTags } from "../../../utils/markdownNoteTags";
import {
    NOTE_LIST_MAX_LIMIT,
    NOTE_SUMMARY_CHARS,
    REVISION_KEEP_PER_NOTE,
    needsSummary,
} from "../../../utils/noteLimits";
import { segmentCJK, FTS_CONTENT_LIMIT } from "../../../utils/ftsQuery";
import { NoteConflictError } from "../../../utils/noteConflict";
import { NOTE_FIELDS, validateFolderParent } from "./notesShared";
import { logger } from "../../../../shared/logger";

/**
 * 每条笔记的自动标签：从正文里挑出 `[[标签]]` / `#标签` 形式的标签名，
 * 条件 INSERT 进 note_tag（不存在才建）并挂到 note_note_tag（忽略重复）。
 * 只追加，不撤销手工标签。
 */
function inlineTagStatements(
    api: NavigationAPI,
    noteKey: number | string,
    content: string,
    guardRev?: number
): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    const noteColumn = typeof noteKey === "number" ? "id" : "uuid";
    // guardRev 仅 updateNote 在「带 rev 的乐观锁」路径传入（R02）：自动标签副作用也要
    // 受同一预期 rev 守卫约束，否则冲突（主 UPDATE 命中 0 行）时旧正文里的标签仍会被
    // 旁写进库。noteColumn === "id" 保证守卫落在笔记主键上；新建笔记走 uuid 且无守卫。
    const needGuard = typeof guardRev === "number" && noteColumn === "id";
    const tagGuardBinds = needGuard ? [guardRev as number] : [];
    for (const name of extractNoteTags(content)) {
        statements.push(api.db.prepare(`INSERT INTO note_tag (user_id, name)
            SELECT ?, ? WHERE EXISTS (SELECT id FROM notes WHERE ${noteColumn} = ?${api.scopeSql(true)}${needGuard ? " AND rev = ?" : ""})
            AND NOT EXISTS (SELECT id FROM note_tag WHERE name = ?${api.scopeSql(true)})`)
            .bind(api.currentUserId, name, ...api.scopeParams([noteKey, ...tagGuardBinds]), ...api.scopeParams([name])));
        statements.push(api.db.prepare(`INSERT OR IGNORE INTO note_note_tag (note_id, tag_id)
            SELECT n.id, t.id FROM notes n, note_tag t
            WHERE n.${noteColumn} = ?${needGuard ? " AND n.rev = ?" : ""} AND t.name = ?
              AND n.id IN (SELECT id FROM notes${api.scopeSql(false)})
              AND t.id IN (SELECT id FROM note_tag${api.scopeSql(false)})`)
            .bind(noteKey, ...tagGuardBinds, name, ...api.scopeParams([]), ...api.scopeParams([])));
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
    keepNoteId: number | null,
    guardRev?: number
): D1PreparedStatement {
    // guardRev 只在「换绑已有笔记」时由 updateNote 传入（R02）：只有当目标笔记确实还
    // 拿着预期 rev，才允许去解绑同站点的其它笔记。这样并发冲突（主 UPDATE 命中 0 行）时，
    // 这条解绑也会因 EXISTS 守卫落空而完全不执行 —— 冲突零业务副作用。
    // 新建笔记（keepNoteId 为 null）没有 rev 概念，不加守卫。
    const needGuard = typeof guardRev === "number" && keepNoteId !== null;
    const guard = needGuard
        ? ` AND EXISTS (SELECT 1 FROM notes WHERE id = ? AND rev = ?${api.scopeSql(true)})`
        : "";
    const guardBinds = needGuard ? api.scopeParams([keepNoteId as number, guardRev as number]) : [];
    if (keepNoteId === null) {
        return api.db
            .prepare(`UPDATE notes SET site_id = NULL WHERE site_id = ?${api.scopeSql(true)}`)
            .bind(...api.scopeParams([siteId]));
    }
    return api.db
        .prepare(
            `UPDATE notes SET site_id = NULL WHERE site_id = ? AND id != ?${api.scopeSql(true)}${guard}`
        )
        .bind(...api.scopeParams([siteId, keepNoteId]), ...guardBinds);
}

export const noteMethods: Pick<NotesApi,
    "listNotes" | "getNote" | "createNote" | "updateNote" |
    "deleteNote" | "deleteNotes" | "updateNoteOrder" | "countNotes"> = {
    /**
     * 列笔记。**不传 limit 就是全部**（这是刻意保留的默认，见下）。
     *
     * 分页参数（2026-10-28，`?limit=&offset=`）：
     *   - `limit`   一页条数，夹在 [1, NOTE_LIST_MAX_LIMIT]；
     *   - `offset`  跳过多少条；给了 offset 但没给 limit 时按「从 offset 拉到尾」处理
     *               （SQLite 的 `LIMIT -1 OFFSET ?`），语义上等于「不要头上那几条」。
     *
     * ⚠️ **不传 limit 时行为一个字节都没变**（仍然 `SELECT ... ORDER BY` 全量）。
     * 这不是偷懒：`exportNotesData`（整库导出）、`notes/reindex`（重建全文索引）
     * 和备份都要**完整**列表，给它们加个默认上限就是静默丢数据。
     * 需要限流的调用方自己传 limit —— 别把默认值改成常数。
     *
     * ⚠️ 排序必须**逐字保持** `pinned DESC, order_num, id`：internals.ts 的
     * `idx_notes_user_order`（user_id, pinned, order_num, id）就是照这个形状建的
     * （2026-10-17 排查，补上 id 尾列才消掉 TEMP B-TREE）。改了排序等于让那条
     * 覆盖索引失效，万条级每次列表都要重新排序 —— 而 LIMIT 恰恰最依赖「排序能走索引」：
     * 排序走不了索引时，`LIMIT 50` 仍要把全部行排一遍才算得出前 50 条。
     */
    listNotes: async function (
        this: NavigationAPI,
        opts?: { summary?: boolean; limit?: number; offset?: number }
    ): Promise<Note[]> {
        await this.migrate();
        const summary = opts?.summary === true;
        // 夹取：非有限数 / 0 / 负数一律当「没传」，避免 `LIMIT 0` 静默返回空列表
        const rawLimit = opts?.limit;
        const limit =
            typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit >= 1
                ? Math.min(Math.floor(rawLimit), NOTE_LIST_MAX_LIMIT)
                : null;
        const rawOffset = opts?.offset;
        const offset =
            typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset > 0
                ? Math.floor(rawOffset)
                : 0;
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
            // `LIMIT -1 OFFSET ?` = 「从 offset 一路到末尾」；SQLite 不接受只有 OFFSET
            // 的写法，必须配一个 LIMIT（-1 是官方约定的「不限」）。
            const paging =
                limit === null
                    ? offset > 0
                        ? " LIMIT -1 OFFSET ?"
                        : ""
                    : offset > 0
                      ? " LIMIT ? OFFSET ?"
                      : " LIMIT ?";
            const pagingParams: number[] =
                limit === null ? (offset > 0 ? [offset] : []) : offset > 0 ? [limit, offset] : [limit];
            const result = await this.db
                .prepare(
                    `SELECT ${fields} FROM notes${this.scopeSql(false)} ORDER BY pinned DESC, order_num, id${paging}`
                )
                .bind(...this.scopeParams([]), ...pagingParams)
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
            const tags = patch.content === undefined ? [] : inlineTagStatements(this, id, patch.content, expectRev ?? undefined);
            // R02：冲突零业务副作用。把「解绑同站其它笔记」与「自动标签」这两条副作用排在
            // 主 UPDATE **之前**，并都带同样的预期 rev 守卫：主 UPDATE 因 rev 不符而命中 0 行时，
            // 这些副作用的 EXISTS(目标 rev = 预期) 也一并落空，不会旁写。主 UPDATE 成功（rev 仍是
            // 预期值）时守卫通过，副作用照常生效。无 rev 老客户端不传守卫 = 旧行为（兼容）。
            // 一站一笔记：换绑时把同一站点上别的笔记先解绑（解绑只动 id != 目标的其它笔记，
            // 不会清掉目标自己，所以排在前面也安全）。约束只在这两处收口。
            const pre: D1PreparedStatement[] =
                typeof patch.site_id === "number"
                    ? [releaseSiteBindingStatement(this, patch.site_id, id, expectRev ?? undefined)]
                    : [];
            const all = [...pre, ...tags, statement];
            const mainIndex = pre.length + tags.length;
            // 快照与正文更新**不在同一个事务**里：快照失败不该让用户的保存失败
            // （历史是辅助功能，存不上只说明少一个版本，不能反过来把正文丢了）。
            const result =
                all.length === 1 ? await statement.all<Note>() : (await this.db.batch(all))[mainIndex];
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
                // 版本快照（存的是**改动前**的内容）与全文索引合进**同一个 batch** = 一次往返。
                // 两者都是辅助功能，失败只记日志，不能让用户的保存失败。
                // ⚠️ 这里**不做**时间节流（P2-8 的 5 分钟闸门）：每一次正文/标题编辑都必须保留
                //    改动前快照，否则用户在 5 分钟内的连续编辑会丢掉中间版本、破坏「版本历史可恢复」
                //    契约（既有测试 noteFolderTagRealSql 也锁定了「改两次 = 2 份」）。
                //    快照存储上限由 REVISION_KEEP_PER_NOTE(=20) 兜底；时间节流只保留在显式
                //    pushRevision 入口（拦重复的手动存版本点击，正文不变不丢历史）。
                const followup: D1PreparedStatement[] = [];
                followup.push(
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
                        .bind(id, this.currentUserId, id, this.currentUserId, REVISION_KEEP_PER_NOTE)
                );
                if (typeof row.id === "number" && titleOrContentTouched && this.notesFtsReady) {
                    // ⚠️ 按 rowid 定位（不是 note_id）：note_id 是 UNINDEXED 列，
                    // `WHERE note_id = ?` 会整表扫 fts5 虚拟表，而保存笔记是最高频的
                    // 写入路径（见 internals.ts NOTES_FTS_TABLE_SQL 的实测）。
                    followup.push(
                        this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").bind(row.id),
                        this.db
                            .prepare(
                                "INSERT INTO notes_fts (rowid, note_id, user_id, title, body) VALUES (?, ?, ?, ?, ?)"
                            )
                            .bind(
                                row.id,
                                row.id,
                                this.currentUserId,
                                segmentCJK(row.title ?? ""),
                                segmentCJK((row.content ?? "").slice(0, FTS_CONTENT_LIMIT))
                            )
                    );
                }
                try {
                    // 此分支（changed && before）followup 至少含一份改动前快照，FTS 就绪时再加索引项
                    if (followup.length > 0) await this.db.batch(followup);
                } catch (error) {
                    logger.error("保存版本快照/全文索引失败:", { err: error, component: "notesNote" })
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
                    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").bind(id)
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

    /**
     * 多选删除：把单条 deleteNote 的副作用**逐条保留**，但整组只发一次请求、
     * 每批一个 db.batch（一个事务 / 一次往返）—— 界面才能一次更新、不再一条条消失。
     *
     * 照 data.ts deleteSites 的两阶段：① 只读认出哪些 id 真的存在、按批备好语句；
     * ② 每批一次 db.batch。D1 没有跨 batch 的事务，跨批部分失败要如实回填 failed，
     * 客户端按 failed 保留未删项、别一次清空勾选（useBulkActions.ts:136-141 的教训）。
     *
     * ⚠️ 回收站条目结构必须与单删**逐字一致**（{ note, tagIds }）：还原换的是新 id，
     * recycle.ts:155/211/303 靠这份 data 写回标签，少一个字段就是「还原后标签全丢」。
     * **不要删附件**：pruneAttachments 靠回收站 data 里的笔记正文保住图片。
     */
    deleteNotes: async function (
        this: NavigationAPI,
        ids: number[],
        audit?: AuditEntry
    ): Promise<NoteBatchDeleteResult> {
        await this.migrate();
        const unique = [...new Set(ids.filter(id => Number.isInteger(id)))];
        if (unique.length === 0) return { items: [], failed: [] };

        return this.withSchemaRetry(async () => {
            // SELECT ... WHERE id IN (?,…) 每项 1 参数 + scopeSql 追加的 user_id 占 1 个：
            // 预留 1 按预算切批（data.ts:530-531、notes/notesTag.ts:131 同一套）。
            // 每批最多 99 条 × 6 条语句 + 1 条审计 = 595 < D1_MAX_BATCH_STATEMENTS(1000)，
            // 所以这里不用再 chunkStatements。
            const chunks = chunkByParamBudget(unique, 1);

            interface Step {
                ids: number[];
                statements: D1PreparedStatement[];
                /** recycle_bin INSERT 在 statements 里的下标，按位置取 last_row_id */
                recycleAt: number[];
            }
            const planned: Step[] = [];
            const failed: number[] = [];

            // ---- 阶段①：只读，认出存在的 id + 取标签关联，按批备好语句 ----
            for (const chunk of chunks) {
                const inList = chunk.map(() => "?").join(", ");
                // 两条 SELECT 互不依赖，并行发。标签关联靠 JOIN notes 判归属
                //（note_note_tag 没有 user_id 列，见单删注释），scopeSql 落在 JOIN ON，
                // 所以参数顺序是 [userId, ...chunk]。
                const [rows, links] = await Promise.all([
                    this.db
                        .prepare(`SELECT * FROM notes WHERE id IN (${inList})${this.scopeSql(true)}`)
                        .bind(...this.scopeParams(chunk))
                        .all<Record<string, unknown>>(),
                    this.db
                        .prepare(
                            `SELECT l.note_id, l.tag_id FROM note_note_tag l
                             JOIN notes n ON n.id = l.note_id${this.scopeSql(true)}
                             WHERE l.note_id IN (${inList})`
                        )
                        .bind(...this.scopeParams([]), ...chunk)
                        .all<{ note_id: number; tag_id: number }>(),
                ]);

                const found = new Map<number, Record<string, unknown>>();
                for (const row of rows.results || []) {
                    const id = Number(row.id);
                    if (Number.isFinite(id)) found.set(id, row);
                }
                const tagIdsByNote = new Map<number, number[]>();
                for (const link of links.results || []) {
                    const id = Number(link.note_id);
                    const list = tagIdsByNote.get(id) ?? [];
                    list.push(Number(link.tag_id));
                    tagIdsByNote.set(id, list);
                }

                const statements: D1PreparedStatement[] = [];
                const recycleAt: number[] = [];
                const stepIds: number[] = [];
                for (const id of chunk) {
                    const note = found.get(id);
                    if (!note) {
                        failed.push(id);
                        continue;
                    }
                    const tagIds = tagIdsByNote.get(id) ?? [];
                    stepIds.push(id);

                    // ① 整行 + tagIds 进回收站（先搬进站再删行，顺序反了救不回来）
                    recycleAt.push(statements.length);
                    statements.push(
                        this.db
                            .prepare(
                                "INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)"
                            )
                            .bind(
                                "note",
                                this.currentUserId,
                                JSON.stringify({ note, tagIds }),
                                Math.floor(Date.now() / 1000)
                            )
                    );
                    // ② 清标签关联（有才清，与单删一致）
                    if (tagIds.length > 0) {
                        statements.push(
                            this.db.prepare("DELETE FROM note_note_tag WHERE note_id = ?").bind(id)
                        );
                    }
                    // ③ 吊销链接，恢复笔记也不会重新公开
                    statements.push(
                        this.db
                            .prepare("DELETE FROM note_share WHERE note_id = ? AND user_id IS ?")
                            .bind(id, this.currentUserId)
                    );
                    // ④ 删真身（带 scope 多账号隔离）
                    statements.push(
                        this.db
                            .prepare(`DELETE FROM notes WHERE id = ?${this.scopeSql(true)}`)
                            .bind(...this.scopeParams([id]))
                    );
                    // ⑤ 删全文索引
                    if (this.notesFtsReady) {
                        statements.push(
                            this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").bind(id)
                        );
                    }
                    // ⑥ 墓碑：软删除对 notes 是物理删行，其它设备靠它感知（同单删只认 uuid）
                    if (typeof note.uuid === "string" && note.uuid) {
                        statements.push(
                            this.db
                                .prepare("INSERT INTO note_tombstone (user_id, note_uuid) VALUES (?, ?)")
                                .bind(this.currentUserId, note.uuid)
                        );
                    }
                }
                if (stepIds.length === 0) continue;
                planned.push({ ids: stepIds, statements, recycleAt });
            }
            if (planned.length === 0) return { items: [], failed };

            // ---- 阶段②：每批一次 db.batch（= 一个事务 / 一次往返）----
            const items: Array<{ id: number; recycleId?: number }> = [];
            for (let i = 0; i < planned.length; i++) {
                const step = planned[i];
                const statements = [...step.statements];
                // ⑦ 审计一条，只挂最后一批（一次调用一条审计，与单删 / deleteSites 一致）；
                // 追加在末尾，不影响 recycleAt 记的 INSERT 下标。
                if (i === planned.length - 1) {
                    const auditStmt = auditStatement(this, audit);
                    if (auditStmt) statements.push(auditStmt);
                }
                try {
                    const results = await this.db.batch(statements);
                    step.ids.forEach((id, j) => {
                        const at = step.recycleAt[j];
                        const meta = (at === undefined ? undefined : results[at]?.meta) as
                            | { last_row_id?: number }
                            | undefined;
                        items.push({
                            id,
                            recycleId:
                                typeof meta?.last_row_id === "number" ? meta.last_row_id : undefined,
                        });
                    });
                } catch (error) {
                    // 跨批无法原子：D1 没有跨 batch 的事务。单批场景保持「全或无」，
                    // 失败照旧上抛（500）；多批时已提交批次（items）保留，本批及之后
                    // 未提交的 id 全部并入 failed，并标记 partial —— 客户端据此如实续传。
                    if (planned.length === 1) throw error;
                    return {
                        items,
                        failed: [
                            ...failed,
                            ...items.filter(item => item.recycleId === undefined).map(item => item.id),
                            ...planned.slice(i).flatMap(s => s.ids),
                        ],
                        partial: true,
                    };
                }
            }

            return {
                items,
                failed: [
                    ...failed,
                    ...items.filter(item => item.recycleId === undefined).map(item => item.id),
                ],
            };
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
