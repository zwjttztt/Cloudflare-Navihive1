// src/API/methods/notes/notesShare.ts
// 笔记分享 / 公开读取 / 数据页概览（notes 域的「分享」那一组）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI` 让 TS 认得 this，
// 由 http.ts 混回原型。每个方法都走 `this.migrate()` + scopeSql/scopeParams 隔离账号。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type { NoteShare, NoteShareListItem, PublicNoteAccess, NoteStats } from "../../types";
import { hashPassword, verifyPassword } from "../../crypto";

export const shareMethods: Pick<NotesApi,
    "listNoteShares" | "getNoteShare" | "createNoteShare" | "revokeNoteShare" |
    "updateNoteShare" | "getPublicNote" | "notesStats"> = {
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
    // countView=false：路由层已判定「该访客今天计过」（cookie 当日戳），这次跳过 +1。
    // 缺省 true 保持「每次成功打开计一次」的调用方兼容。
    getPublicNote: async function (this: NavigationAPI, token: string, password?: string | null, countView?: boolean): Promise<PublicNoteAccess> {
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
        // 浏览次数 +1（每次成功打开记一次；并发时 D1 自增原子，不会互相盖掉）。
        // countView === false 时跳过（防刷去重：同一访客当天已计过，见 shareAssetSession）。
        let counted = 0;
        if (countView !== false) {
            const inc = await this.db.prepare(`UPDATE note_share SET views = views + 1 WHERE token = ?`)
                .bind(token).run();
            counted = inc.success ? 1 : 0;
        }
        const views = (typeof row.views === "number" ? row.views : 0) + counted;
        return {
            status: "ok",
            note: { title: row.title, content: row.content, updated_at: row.updated_at },
            views,
        };
    },
    notesStats: async function (this: NavigationAPI): Promise<NoteStats> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 三个统计合成一次往返（D1 每次往返是几十毫秒，能合就合）。
            //
            // words（PR1 新增）同理走 SQL：`length(replace(…))` 把空格 / 换行 / 制表符
            // 去掉再求和，正文一个字都不传回来。口径与前端原来的「非空白字符数」一致。
            //
            // ⚠️ 2026-10-24 改（P1-2 消除 O(正文总量) 的全表扫）：
            // 「双链」原来是 `SELECT content FROM notes` 把当前账号的**全部正文**
            // 拉回 JS 再逐条正则数 `[[…]]` —— 打开一次数据页就是几 MB 的传输
            // 加几 MB 的正则扫描，只为得到一个两位数。
            // 现在读的是 `link_count` 这一列（写入时算好的，见 migrateNoteLinkCount），
            // 正文一个字都不进 Worker。
            //
            // COALESCE 兜的是「回填还没跑完」的行（NULL = 还没算过）。
            // 那种情况下这个数字偏小，但不会报错 —— 刻意如此：
            // 统计数字暂时不准，比「数据页打不开」轻得多。
            const row = await this.db
                .prepare(
                    `SELECT
                        (SELECT COUNT(*) FROM note_revision WHERE user_id IS ?1) AS versions,
                        (SELECT COALESCE(SUM(link_count), 0) FROM notes WHERE user_id IS ?1) AS links,
                        (SELECT COALESCE(SUM(length(replace(replace(replace(content, ' ', ''), char(10), ''), char(9), ''))), 0)
                           FROM notes WHERE user_id IS ?1) AS words`
                )
                .bind(this.currentUserId)
                .first<{ versions: number; links: number; words: number }>();
            return {
                versions: row?.versions ?? 0,
                links: row?.links ?? 0,
                words: row?.words ?? 0,
            };
        });
    },
};
