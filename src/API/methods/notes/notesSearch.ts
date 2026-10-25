// src/API/methods/notes/notesSearch.ts
// 全文检索（syncNoteFts / dropNoteFts / searchNotes）。FTS5 + LIKE 回退。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
// 本地辅助 ftsScopeSql 处理 `notes_fts JOIN notes` 的账号隔离（user_id 列歧义）。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { Note, NoteSearchResult } from "../../types";
import { migrationState } from "../internals";
import { buildFtsMatch, escapeLike, FTS_CONTENT_LIMIT, makeSnippet, segmentCJK } from "../../../utils/ftsQuery";
import { NOTE_FIELDS } from "./notesShared";

/**
 * 全文检索那条 JOIN 查询里的账号隔离片段。
 *
 * ⚠️ 不能直接用 `scopeSql(true)`：它生成的是**裸的** ` AND user_id = ?`，
 * 而这条查询是 `notes_fts JOIN notes` —— 两张表都有 user_id 列，SQLite 会报
 * "ambiguous column name: user_id"（登录态下直接 500）。
 * 单账号部署（uid = NULL）时那句片段是空串，所以本机怎么点都点不出这个错，
 * 只有登录态才炸 —— 和之前附件那次「bind 数量不匹配」是同一类坑。
 */
function ftsScopeSql(api: NavigationAPI): string {
    return api.currentUserId === null ? "" : " AND n.user_id = ?";
}

export const searchMethods: Pick<NotesApi,
    "syncNoteFts" | "dropNoteFts" | "searchNotes"> = {
    syncNoteFts: async function (
        this: NavigationAPI,
        noteId: number,
        title: string,
        content: string
    ): Promise<void> {
        if (!this.notesFtsReady) return;
        try {
            // FTS5 表没有主键约束，更新就是「先删后插」两步。
            // 同一个 batch 里跑，一次往返。
            await this.db.batch([
                this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(noteId),
                this.db
                    .prepare(
                        "INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)"
                    )
                    .bind(
                        noteId,
                        this.currentUserId,
                        segmentCJK(title || ""),
                        segmentCJK((content || "").slice(0, FTS_CONTENT_LIMIT))
                    ),
            ]);
        } catch (error) {
            // 索引写不进去只影响搜索速度，绝不能让「保存笔记」失败
            console.error("写全文索引失败:", error);
        }
    },

    dropNoteFts: async function (this: NavigationAPI, noteId: number): Promise<void> {
        if (!this.notesFtsReady) return;
        try {
            await this.db
                .prepare("DELETE FROM notes_fts WHERE note_id = ?")
                .bind(noteId)
                .run();
        } catch (error) {
            console.error("删全文索引失败:", error);
        }
    },

    searchNotes: async function (
        this: NavigationAPI,
        query: string,
        limit = 50
    ): Promise<NoteSearchResult> {
        await this.migrate();
        const q = (query || "").trim().slice(0, 512);
        const max = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
        const mode: NoteSearchResult["mode"] = this.notesFtsReady ? "fts" : "like";
        if (!q) return { mode, results: [] };
        const terms = q.split(/\s+/).filter(Boolean);

        if (this.notesFtsReady) {
            try {
                const match = buildFtsMatch(q);
                if (match) {
                    const rows = await this.db
                        .prepare(
                            `SELECT n.id AS id, n.title AS title, n.content AS content,
                                    n.updated_at AS updated_at,
                                    bm25(notes_fts, 0.0, 0.0, 10.0, 1.0) AS score
                               FROM notes_fts
                               JOIN notes n ON n.id = notes_fts.note_id
                              WHERE notes_fts MATCH ?${ftsScopeSql(this)}
                              ORDER BY score ASC, n.updated_at DESC, n.id DESC
                              LIMIT ?`
                        )
                        // ⚠️ 参数顺序：match 在前，账号 id 在后（与上面 SQL 的 ? 顺序一致）
                        .bind(match, ...this.scopeParams([]), max)
                        .all<{ id: number; title: string; content: string; updated_at: string; score: number }>();
                    if (rows.results?.length) {
                        return {
                            mode: "fts",
                            results: rows.results.map(row => ({
                                id: row.id,
                                title: row.title ?? "",
                                snippet: makeSnippet(row.content ?? "", terms),
                                // bm25 返回负数（越小越相关），翻成正的更好读
                                score: -row.score,
                                updated_at: row.updated_at,
                            })),
                        };
                    }
                    // 一条没中：真没这个内容（不是索引坏了），不用再退 LIKE 扫一遍
                    return { mode: "fts", results: [] };
                }
            } catch (error) {
                // 到这里说明索引虽然建起来了、但真查询时炸了（D1 版本/磁盘格式差异）：
                // 直接把开关关掉，之后的搜索都走 LIKE，别每次请求都炸一遍。
                console.error("全文检索失败，改用 LIKE:", error);
                migrationState.ftsReady = false;
            }
        }

        // ---- LIKE 回退：多个词 AND，标题命中加权 ----
        const params: (string | number)[] = [];
        let where = "1=1";
        for (const term of terms.slice(0, 8)) {
            // ESCAPE '\' + escapeLike：用户输入里的 % _ 不当通配符
            where += ` AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`;
            const pat = `%${escapeLike(term)}%`;
            params.push(pat, pat);
        }
        const rows = await this.db
            .prepare(
                `SELECT ${NOTE_FIELDS} FROM notes WHERE ${where}${this.scopeSql(
                    true
                )} ORDER BY updated_at DESC LIMIT ?`
            )
            .bind(...params, ...this.scopeParams([]), max)
            .all<Note>();
        const hits = (rows.results || []).map(row => {
            const title = row.title ?? "";
            const content = row.content ?? "";
            const lowerTitle = title.toLowerCase();
            const lowerContent = content.toLowerCase();
            let score = 0;
            for (const term of terms) {
                const lower = term.toLowerCase();
                if (lowerTitle.includes(lower)) score += 10;
                // 正文里出现几次就加几分（粗略相关度：出现得多的大概率更对题）
                let at = lowerContent.indexOf(lower);
                while (at >= 0) {
                    score += 1;
                    at = lowerContent.indexOf(lower, at + lower.length);
                    if (score > 200) break;
                }
            }
            return {
                id: row.id ?? 0,
                title,
                snippet: makeSnippet(content, terms),
                score,
                updated_at: row.updated_at,
            };
        });
        hits.sort((a, b) => b.score - a.score || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
        return { mode: "like", results: hits };
    },
};
