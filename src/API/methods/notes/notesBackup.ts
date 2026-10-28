// src/API/methods/notes/notesBackup.ts
// 笔记备份 / 导入导出 / 跨设备变更轮询（notes 域的「备份」那一组）。
//
// 与 methods/notes.ts 同一套约定：方法体用 `this: NavigationAPI`，由 http.ts 混回原型。
import type { NavigationAPI } from "../../http";
import type { NotesApi } from "../notes";
import type {
    Note,
    NoteBackupSiteRef,
    NoteFolder,
    NotesChangesResult,
    NotesImportPayload,
    NoteImportStats,
} from "../../types";
import type { D1PreparedStatement } from "../../schema";
import { newUuid } from "../../../utils/uuid";
import { countWikiLinks } from "../../../utils/noteWikiLink";
import { segmentCJK, FTS_CONTENT_LIMIT } from "../../../utils/ftsQuery";
import { sqlNow } from "../../../utils/sqlTime";
import { normalizeUrl } from "../../../utils/url";
import { notesSnapshotFingerprint } from "./notesShared";

export const backupMethods: Pick<NotesApi,
    "exportNotesData" | "notesChanges" | "importNotesData"> = {
    exportNotesData: async function (this: NavigationAPI): Promise<NotesImportPayload> {
        await this.migrate();
        // 全部走现成的账号隔离读法（scopeSql 在各方法内部处理），不再另写一遍 SQL ——
        // 「导出什么」必须和「页面上看到什么」一致。
        const [notes, folders, tags, noteTags] = await Promise.all([
            this.listNotes(),
            this.listFolders(),
            this.listTags(),
            this.listNoteTags(),
        ]);
        // noteTags 的键是数字笔记 id；JSON 里对象键一定是字符串，导入方也按字符串读
        const noteTagsOut: Record<string, number[]> = {};
        for (const [noteId, tagIds] of Object.entries(noteTags)) {
            noteTagsOut[String(noteId)] = tagIds;
        }
        // 绑定指纹（2026-10-25）：site_id 只在导出方的库里有效，跨机导入时站点 id 会重排，
        // 只有「名称 + URL」能跨库对上（importNotesData 按指纹重连，否则绑定全断）。
        // 只带被笔记引用的站点，不搬全量站点表。
        const boundIds = [
            ...new Set(
                notes
                    .map(n => n.site_id)
                    .filter((id): id is number => typeof id === "number")
            ),
        ];
        const boundSites: NoteBackupSiteRef[] = [];
        if (boundIds.length > 0) {
            const siteRows = await this.db
                .prepare(`SELECT id, name, url FROM sites${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .all<{ id: number; name: string; url: string | null }>();
            const byId = new Map((siteRows.results || []).map(r => [r.id, r]));
            for (const id of boundIds) {
                const row = byId.get(id);
                if (row) boundSites.push({ id, name: row.name || "", url: row.url || "" });
            }
        }
        return {
            kind: "navihive-notes-backup",
            exportedAt: new Date().toISOString(),
            notes,
            folders,
            tags,
            noteTags: noteTagsOut,
            boundSites,
        };
    },
    /**
     * 跨设备变更轮询（2026-10-11）。
     *
     * 游标是 SQLite 的 CURRENT_TIMESTAMP（秒精度），与 notes.updated_at 同一刻度；
     * 比较用 `>=`：同一秒内的并发变更可能被相邻两轮各看见一次 —— 多触发一次
     * reload 无害（幂等读），漏看才是问题，所以宁可重复不可遗漏。
     *
     * 文件夹/标签没有可靠的 per-row 时间戳，直接全量快照让客户端比对
     * （这两张表就几十行，比补列 + 回填便宜得多，也不会漏改色/改名）。
     * 首次轮询（since 为空）只初始化游标，不报变更。
     *
     * 变更指纹（2026-10-28，省流量）：`fingerprint` 是**调用方上一轮拿到的指纹**。
     * 本轮快照算出来的指纹与它相同 → 只回 `{ unchanged: true, fingerprint }`，
     * 三个快照字段回空数组。指纹怎么算、为什么不能用「便宜的近似量」见
     * notesShared.ts 的 notesSnapshotFingerprint 注释。
     * 不传 fingerprint（首次轮询 / 老客户端 / 老 mock）→ 永远走全量，行为与改造前一致。
     */
    notesChanges: async function (
        this: NavigationAPI,
        since?: string,
        fingerprint?: string
    ): Promise<NotesChangesResult> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // ── 笔记侧的三条查询合成**一次往返**（2026-10-28）──
            // 原来是 now → 计数 → 变更 id 三步串行（D1 每条语句一次往返）。
            // 轮询本身是后台流量，一串行就是几十毫秒白等；合成 batch 之后只有一次。
            //
            // ⚠️ 顺序不能动：`strftime('now')` 必须**排在最前面**执行。游标是「本轮读到哪儿」，
            // 先算时间再读计数，万一有变更落在两者之间，它会被**下一轮**重复看见（多报一次，无害）；
            // 顺序反过来的话，那条变更这一轮没数到、下一轮又被更晚的游标挡住 —— 直接**漏掉**。
            //
            // ⚠️ 墓碑计数**不进这个 batch**：它在老库上可能整张表都不存在（迁移没跑到），
            // 进了 batch 会一条语句失败拖垮整批，连「有笔记被改过」都读不出来。
            // 它自己带 try/catch，缺表时只是「感知不到彻底删除」，不影响其它信号。
            const notesStatements = [
                this.db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S', 'now') AS now"),
            ];
            if (since) {
                notesStatements.push(
                    this.db
                        .prepare(
                            // 变更笔记 id（有界 50）：客户端用它判断「当前打开的这篇是否被改」，
                            // 给出针对性提示，而不是只有一句全局的「列表已刷新」。
                            // 无条件带上（即便这一轮没变更）：走 idx_notes_user_updated 的范围扫，
                            // 命中 0 行时几乎没有代价，换来的是「不用先知道计数再发第二次」。
                            "SELECT id FROM notes WHERE updated_at >= ?1 AND user_id IS ?2 ORDER BY updated_at DESC LIMIT 50"
                        )
                        .bind(since, this.currentUserId),
                    this.db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM notes WHERE updated_at >= ?1 AND user_id IS ?2"
                        )
                        .bind(since, this.currentUserId)
                );
            }
            const notesResults = await this.db.batch(notesStatements);
            const now =
                (notesResults[0]?.results?.[0] as { now?: string } | undefined)?.now || sqlNow();
            let notesChanged = 0;
            let changedNoteIds: number[] = [];
            if (since) {
                const idRows = (notesResults[1]?.results ?? []) as { id: number }[];
                const updated = (notesResults[2]?.results?.[0] as { n?: number } | undefined)?.n ?? 0;
                let purged = 0;
                try {
                    const row = await this.db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM note_tombstone WHERE deleted_at >= ?1 AND user_id IS ?2"
                        )
                        .bind(since, this.currentUserId)
                        .first<{ n: number }>();
                    purged = row?.n ?? 0;
                } catch (error) {
                    // 墓碑表缺失（迁移还没跑到）只影响「彻底删除」的感知，不算致命
                    console.error("读取笔记墓碑失败:", error);
                }
                notesChanged = updated + purged;
                // 没变更时 ids 一定是空的（同一个 WHERE），不必再判一次计数
                if (notesChanged > 0) changedNoteIds = idRows.map(r => r.id);
            }
            const [folders, tags, noteTags] = await Promise.all([
                this.listFolders(),
                this.listTags(),
                this.listNoteTags(),
            ]);
            const currentFingerprint = notesSnapshotFingerprint(folders, tags, noteTags);
            // ⚠️ 只有「调用方确实带来过指纹、且与本轮相同」才敢回空快照。
            // 调用方没带（首次 / 老客户端）时必须回全量 —— 否则它手里根本没有快照基线。
            if (typeof fingerprint === "string" && fingerprint.length > 0 && fingerprint === currentFingerprint) {
                return {
                    success: true,
                    now,
                    notesChanged,
                    changedNoteIds,
                    folders: [],
                    tags: [],
                    noteTags: {},
                    unchanged: true,
                    fingerprint: currentFingerprint,
                };
            }
            return {
                success: true,
                now,
                notesChanged,
                changedNoteIds,
                folders,
                tags,
                noteTags,
                unchanged: false,
                fingerprint: currentFingerprint,
            };
        });
    },
    importNotesData: async function (this: NavigationAPI, payload: NotesImportPayload): Promise<NoteImportStats> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const stats: NoteImportStats = { created: 0, updated: 0, skipped: 0, removed: 0 };
            // 只收形状完整的那几条：title/content 不是字符串的条目直接丢弃，
            // 不能让一条脏数据把整批导入拖崩。uuid 缺失（很老的导出）现场补一个，
            // 让它当成新笔记进来 —— 合并去重靠 uuid，没有它就只能整条新增。
            const incoming = (Array.isArray(payload?.notes) ? payload.notes : [])
                .filter((n): n is Note => !!n && typeof n.title === "string" && typeof n.content === "string")
                .map(n => ({ ...n, uuid: n.uuid || newUuid() }));

            const commitStatements: D1PreparedStatement[] = [];

            // ── 文件夹：按「父路径 + 名称」去重（与 transfer.importData 同一套判据）──
            const folderMap = new Map<number, number>();
            if (Array.isArray(payload.folders) && payload.folders.length > 0) {
                const local = await this.db
                    .prepare(`SELECT id, name, parent_id FROM note_folder${this.scopeSql(false)}`)
                    .bind(...this.scopeParams([]))
                    .all<{ id: number; name: string; parent_id: number | null }>();
                const max = await this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM note_folder").first<{ m: number }>();
                let next = max?.m || 0;
                const byPath = new Map((local.results || []).map(f => [JSON.stringify([f.parent_id ?? null, f.name]), f.id]));
                const source = new Map(payload.folders.map(f => [f.id, f]));
                const visiting = new Set<number>();
                const add = (folder: NoteFolder): number => {
                    if (folder.id !== undefined && folderMap.has(folder.id)) return folderMap.get(folder.id)!;
                    if (folder.id !== undefined && visiting.has(folder.id)) throw new Error("文件夹层级存在循环");
                    if (folder.id !== undefined) visiting.add(folder.id);
                    const parent = folder.parent_id ? source.get(folder.parent_id) : undefined;
                    const parentId = parent ? add(parent) : null;
                    const key = JSON.stringify([parentId, folder.name]);
                    let id = byPath.get(key);
                    if (id === undefined) {
                        id = ++next;
                        byPath.set(key, id);
                        commitStatements.push(
                            this.db.prepare("INSERT INTO note_folder (id, user_id, name, order_num, parent_id) VALUES (?, ?, ?, ?, ?)")
                                .bind(id, this.currentUserId, folder.name, folder.order_num ?? 0, parentId)
                        );
                    }
                    if (folder.id !== undefined) { folderMap.set(folder.id, id); visiting.delete(folder.id); }
                    return id;
                };
                payload.folders.forEach(add);
            }

            // ── 标签：按名称去重 ──
            const tagMap = new Map<number, number>();
            if (Array.isArray(payload.tags) && payload.tags.length > 0) {
                const local = await this.db
                    .prepare(`SELECT id, name FROM note_tag${this.scopeSql(false)}`)
                    .bind(...this.scopeParams([]))
                    .all<{ id: number; name: string }>();
                const byName = new Map((local.results || []).map(r => [r.name, r.id]));
                const max = await this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM note_tag").first<{ m: number }>();
                let next = max?.m || 0;
                for (const row of payload.tags) {
                    let id = byName.get(row.name);
                    if (id === undefined) {
                        id = ++next;
                        byName.set(row.name, id);
                        commitStatements.push(
                            this.db.prepare("INSERT INTO note_tag (id, user_id, name, color) VALUES (?, ?, ?, ?)")
                                .bind(id, this.currentUserId, row.name, row.color ?? null)
                        );
                    }
                    if (typeof row.id === "number") tagMap.set(row.id, id);
                }
            }

            // ── 绑定重连（2026-10-25）：site_id 只在导出方的库里有效，跨机导入时站点 id 会重排──
            // 新版备份带 boundSites（站点指纹）：按「规范化 URL 唯一命中 → 名称唯一命中」重连，
            // 命中不了或有歧义一律置空 —— 宁可断绑，不错绑到别的卡片上。
            // 老备份没有指纹，无从判断，同样置空（老行为本来就是 NULL，不算回退）。
            // 一站一篇约束与 updateNote/createNote 同源：同批抢同一站点的先到先得，
            // 本地已占位的绑定由赋值前的「解绑同站」语句清掉（见提交循环）。
            const siteResolve = new Map<number, number | null>();
            const boundRefs = Array.isArray(payload.boundSites) ? payload.boundSites : [];
            if (boundRefs.length > 0) {
                const siteRows = await this.db
                    .prepare(`SELECT id, name, url FROM sites${this.scopeSql(false)}`)
                    .bind(...this.scopeParams([]))
                    .all<{ id: number; name: string; url: string | null }>();
                const canonicalUrl = (u: string | null | undefined) => {
                    if (!u) return "";
                    const r = normalizeUrl(u);
                    return r.ok ? r.url : "";
                };
                const byUrl = new Map<string, number[]>();
                const byName = new Map<string, number[]>();
                for (const s of siteRows.results || []) {
                    const ku = canonicalUrl(s.url);
                    if (ku) byUrl.set(ku, [...(byUrl.get(ku) ?? []), s.id]);
                    const kn = (s.name || "").trim();
                    if (kn) byName.set(kn, [...(byName.get(kn) ?? []), s.id]);
                }
                for (const ref of boundRefs) {
                    if (!ref || typeof ref.id !== "number" || siteResolve.has(ref.id)) continue;
                    let resolved: number | null = null;
                    const urlHits = byUrl.get(canonicalUrl(ref.url));
                    if (urlHits && urlHits.length === 1) {
                        resolved = urlHits[0];
                    } else {
                        const nameHits = byName.get((ref.name || "").trim());
                        if (nameHits && nameHits.length === 1) resolved = nameHits[0];
                    }
                    siteResolve.set(ref.id, resolved);
                }
            }

            // ── 笔记合并：先读本地算计划（uuid 相同比 updated_at，文件较新才覆盖）──
            const localRows = await this.db
                .prepare(`SELECT id, uuid, updated_at FROM notes${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .all<{ id: number; uuid: string | null; updated_at: string | null }>();
            const localByUuid = new Map<string, { id: number; updated_at: string | null }>();
            for (const row of localRows.results || []) {
                if (row.uuid) localByUuid.set(row.uuid, row);
            }
            const maxNote = await this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM notes").first<{ m: number }>();
            let nextNoteId = maxNote?.m || 0;

            const plan: Array<{
                id: number;
                uuid: string;
                title: string;
                content: string;
                pinned: boolean;
                starred: boolean;
                order_num: number;
                folderId: number | null | undefined;
                siteId: number | null | undefined;
                archived: boolean | undefined;
                isNew: boolean;
            }> = [];
            for (const n of incoming) {
                const local = localByUuid.get(n.uuid!);
                const folderId = n.folder_id !== undefined ? folderMap.get(n.folder_id ?? 0) ?? null : undefined;
                // 绑定：文件里没这个字段（很老的导出）→ 不动本地；有字段 → 按指纹解析
                //（解析不了置 null）。新笔记没有「本地」可保持，置 null 就是最终态。
                const siteId =
                    n.site_id === undefined
                        ? undefined
                        : typeof n.site_id === "number"
                          ? siteResolve.size > 0
                                ? siteResolve.get(n.site_id) ?? null
                                : null
                          : null;
                if (!local) {
                    plan.push({
                        id: ++nextNoteId,
                        uuid: n.uuid!,
                        title: n.title, content: n.content,
                        pinned: Boolean(n.pinned), starred: Boolean(n.starred),
                        order_num: n.order_num ?? 0,
                        folderId, siteId, archived: n.archived, isNew: true,
                    });
                    stats.created += 1;
                } else if (Date.parse(n.updated_at || "") > Date.parse(local.updated_at || "")) {
                    // 覆盖写回原 id —— 新建一条再删旧的会把 updated_at 弄丢
                    plan.push({
                        id: local.id,
                        uuid: n.uuid!,
                        title: n.title, content: n.content,
                        pinned: Boolean(n.pinned), starred: Boolean(n.starred),
                        order_num: n.order_num ?? 0,
                        folderId, siteId, archived: n.archived, isNew: false,
                    });
                    stats.updated += 1;
                } else {
                    // 本地较新（或时间解析不出来）：保守保留本地，不冒险覆盖
                    stats.skipped += 1;
                }
            }

            // 一站一篇：同批两个笔记解析到同一站点时先到先得，后者置空
            const usedSites = new Set<number>();
            for (const p of plan) {
                if (typeof p.siteId === "number") {
                    if (usedSites.has(p.siteId)) p.siteId = null;
                    else usedSites.add(p.siteId);
                }
            }

            // ── 提交：一个 batch = 一个事务，中途失败全部回滚 ──
            const planByUuid = new Map(plan.map(p => [p.uuid, p]));
            for (const p of plan) {
                // 一站一篇：把同站点上别的笔记先解绑（与 updateNote/createNote 同一约束）。
                // 必须排在赋值语句前面 —— batch 内按顺序执行；对新建笔记而言此时
                // 它自己还没入表，解绑语句只会清掉「本地占位」的别人。
                if (typeof p.siteId === "number") {
                    commitStatements.push(
                        this.db
                            .prepare(
                                `UPDATE notes SET site_id = NULL WHERE site_id = ?${this.scopeSql(true)}`
                            )
                            .bind(...this.scopeParams([p.siteId]))
                    );
                }
                if (p.isNew) {
                    commitStatements.push(
                        this.db.prepare(
                            // link_count 必须在这里一起写：导入是「绕过 updateNote 的直接落库」，
                            // 漏了它这一批笔记的双链数永远是 NULL（统计里当 0）。
                            `INSERT INTO notes (id, user_id, uuid, title, content, link_count, pinned, starred, order_num, site_id, folder_id, archived)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        ).bind(
                            p.id,
                            // user_id 只能是导入者自己 —— 文件里那个值是导出方的，
                            // 照抄会把笔记写到别人名下，而这个字段是唯一的隔离依据
                            this.currentUserId,
                            p.uuid, p.title, p.content, countWikiLinks(p.content ?? ""),
                            p.pinned ? 1 : 0, p.starred ? 1 : 0,
                            p.order_num,
                            p.siteId ?? null,
                            p.folderId ?? null, p.archived ? 1 : 0
                        )
                    );
                } else {
                    commitStatements.push(
                        this.db.prepare(
                            // ⚠️ rev 也要 +1：导入是一次真正的写入，不改的话客户端手里的
                            // rev 会一直对不上（下一次保存被并发守卫挡住 → 「保存不了」）
                            // link_count 同理要重算：正文被整段替换了，旧计数作废。
                            `UPDATE notes SET uuid = ?, title = ?, content = ?, link_count = ?, pinned = ?,
                             starred = ?, rev = rev + 1,
                             order_num = ?, folder_id = CASE WHEN ? THEN ? ELSE folder_id END,
                             site_id = CASE WHEN ? THEN ? ELSE site_id END,
                             archived = COALESCE(?, archived), updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?${this.scopeSql(true)}`
                        ).bind(...this.scopeParams([
                            p.uuid, p.title, p.content, countWikiLinks(p.content ?? ""),
                            p.pinned ? 1 : 0, p.starred ? 1 : 0,
                            p.order_num, p.folderId !== undefined ? 1 : 0,
                            p.folderId ?? null,
                            p.siteId !== undefined ? 1 : 0, p.siteId ?? null,
                            p.archived === undefined ? null : p.archived ? 1 : 0,
                            p.id,
                        ]))
                    );
                }
            }

            // ── 标签关联：noteTags 的键是导出方的笔记 id，经 uuid 翻译到本地 id ──
            // 只有这批真写进去的笔记才重建关联（skipped 的本地关联本来就在，别动）。
            if (payload.noteTags && typeof payload.noteTags === "object") {
                for (const [exportedId, tagIds] of Object.entries(payload.noteTags)) {
                    const source = incoming.find(n => n.id !== undefined && String(n.id) === exportedId);
                    if (!source?.uuid) continue;
                    const p = planByUuid.get(source.uuid);
                    if (!p) continue;
                    commitStatements.push(
                        this.db.prepare(`DELETE FROM note_note_tag WHERE note_id IN
                            (SELECT id FROM notes WHERE id = ?${this.scopeSql(true)})`)
                            .bind(...this.scopeParams([p.id]))
                    );
                    for (const tagId of Array.isArray(tagIds) ? tagIds : []) {
                        const mapped = tagMap.get(tagId);
                        if (mapped === undefined) continue;
                        commitStatements.push(
                            this.db.prepare("INSERT OR IGNORE INTO note_note_tag (note_id, tag_id) VALUES (?, ?)")
                                .bind(p.id, mapped)
                        );
                    }
                }
            }

            // ── 提交：分批提交，每批仍是一个事务 ──
            // 以前整批一次性 batch：大导入（几百条笔记 + 标签 + 关联）会撞上
            // D1 单次 batch 的语句数上限 → 整个导入报 500。按 250 条/批切片，
            // 与 updateNoteOrder / updateSiteOrder 同一界限。
            // 中途失败：已提交的批保留，stats.warning 说明情况 —— 重新导入即可续传
            //（相同 uuid 按「文件较新才覆盖」去重，已写入的不会重复建）。
            if (commitStatements.length > 0) {
                const COMMIT_CHUNK = 250;
                try {
                    for (let i = 0; i < commitStatements.length; i += COMMIT_CHUNK) {
                        await this.db.batch(commitStatements.slice(i, i + COMMIT_CHUNK));
                    }
                } catch (error) {
                    console.error("导入提交失败（部分已写入）:", error);
                    stats.warning =
                        "部分数据未能写入，重新导入即可续传（相同笔记按「文件较新才覆盖」去重，不会重复建）";
                    return stats;
                }
            }

            // 全文索引：一次可能进来几百条，逐条 syncNoteFts 是几百次往返 ——
            // 自己拼一个 batch（同样的「先删后插」两步）。失败只记日志：
            // 索引不全的结果是「搜不到」，而导入本身已经成功，不能反过来回滚。
            if (this.notesFtsReady && plan.length > 0) {
                try {
                    const ftsStatements: D1PreparedStatement[] = [];
                    for (const p of plan) {
                        // ⚠️ 按 rowid 定位（不是 note_id）：见 internals.ts
                        // NOTES_FTS_TABLE_SQL 的契约与实测（note_id 是 UNINDEXED，
                        // `WHERE note_id = ?` 只能整表扫）。
                        ftsStatements.push(
                            this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").bind(p.id),
                            this.db
                                .prepare(
                                    "INSERT INTO notes_fts (rowid, note_id, user_id, title, body) VALUES (?, ?, ?, ?, ?)"
                                )
                                .bind(
                                    p.id,
                                    p.id,
                                    this.currentUserId,
                                    segmentCJK(p.title || ""),
                                    segmentCJK((p.content || "").slice(0, FTS_CONTENT_LIMIT))
                                )
                        );
                    }
                    // FTS 语句同样分批（先删后插两条/条，几百条笔记就是近千条语句）
                    const FTS_CHUNK = 250;
                    for (let i = 0; i < ftsStatements.length; i += FTS_CHUNK) {
                        await this.db.batch(ftsStatements.slice(i, i + FTS_CHUNK));
                    }
                } catch (error) {
                    console.error("导入后重建全文索引失败:", error);
                }
            }
            return stats;
        });
    },
};
