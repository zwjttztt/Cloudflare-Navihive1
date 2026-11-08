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
import type { D1PreparedStatement, D1Result } from "../../schema";
import { newUuid } from "../../../utils/uuid";
import { countWikiLinks } from "../../../utils/noteWikiLink";
import { segmentCJK, FTS_CONTENT_LIMIT } from "../../../utils/ftsQuery";
import { sqlNow } from "../../../utils/sqlTime";
import { normalizeUrl } from "../../../utils/url";
import { notesSnapshotFingerprint } from "./notesShared";
import { logger } from "../../../../shared/logger";
import { notesImportConflictsEvent, notesImportPartialEvent } from "../../../../shared/failureEvents";

/**
 * 文件夹的「稳定键解析式」：一条标量子查询，按 (父, 名称) 在库里解析出本地 id。
 * 导入不再预分配显式 id，笔记的 folder_id / 子文件夹的 parent_id 都靠它现查现用。
 */
interface FolderKey {
    sql: string;
    params: unknown[];
}

/** 一条笔记待写入的字段（created / updated 共用） */
interface NoteWrite {
    uuid: string;
    title: string;
    content: string;
    pinned: boolean;
    starred: boolean;
    order_num: number;
    /** undefined = 老备份没这字段（保持本地）；null = 移到未归类；FolderKey = 按稳定键解析 */
    folderKey: FolderKey | null | undefined;
    siteId: number | null | undefined;
    archived: boolean | undefined;
    /** null = 该笔记在 noteTags 里没有条目（不重建关联）；[] / 非空 = 先清后按名重建 */
    tags: string[] | null;
}

/**
 * 一个「可恢复单元」的计划。skipped 不产生任何语句，只参与统计；
 * created / updated 的语句在提交阶段由 buildNoteUnitStatements 一次性生成。
 */
type ImportUnit =
    | ({ kind: "created" } & NoteWrite)
    | ({ kind: "updated"; localId: number; expectedRev: number } & NoteWrite)
    | { kind: "skipped"; uuid: string };

/** 一个提交批（= 一个事务）：切分点只允许落在单元边界，绝不在单元中间切开 */
interface CommitBatch {
    units: ImportUnit[];
    statements: D1PreparedStatement[];
    /** updated 单元的 CAS UPDATE 在 statements 里的下标，供提交后读 RETURNING 判定命中 */
    updateChecks: Array<{ uuid: string; stmtIndex: number }>;
}

/**
 * 生成「一条笔记」的完整自足单元：
 *   解绑同站(若有) → 正文 INSERT/UPDATE → 该笔记标签关联 → 该笔记 FTS 先删后插。
 * 全部语句由调用方塞进**同一个 batch**，任一环节失败整组一起回滚，
 * 不会留下「正文有、标签/索引缺」的半截记录。
 */
function buildNoteUnitStatements(
    api: NavigationAPI,
    unit: Exclude<ImportUnit, { kind: "skipped" }>
): { statements: D1PreparedStatement[]; updateIndex: number | null } {
    const statements: D1PreparedStatement[] = [];
    let updateIndex: number | null = null;

    // ① 一站一篇：把同站点上别的笔记先解绑（必须排在赋值前，batch 内按顺序执行）。
    if (typeof unit.siteId === "number") {
        statements.push(
            api.db
                .prepare(`UPDATE notes SET site_id = NULL WHERE site_id = ?${api.scopeSql(true)}`)
                .bind(...api.scopeParams([unit.siteId]))
        );
    }

    // folder 值表达式：undefined 时 flag=0 走 CASE 的 ELSE（THEN 放常量 NULL 占位，不占参数）
    let folderExpr = "NULL";
    let folderParams: unknown[] = [];
    if (unit.folderKey) {
        folderExpr = `(${unit.folderKey.sql})`;
        folderParams = unit.folderKey.params;
    }
    const folderFlag = unit.folderKey !== undefined ? 1 : 0;

    // ② 正文
    if (unit.kind === "created") {
        // ⚠️ 不写 id：交给 AUTOINCREMENT，避免「事务外 MAX(id)+1 预分配 + 并发插入撞主键」。
        // link_count 必须一起写（导入绕过 updateNote 直接落库）。uuid 仍写入（去重靠它）。
        const params: unknown[] = [
            api.currentUserId,
            unit.uuid,
            unit.title,
            unit.content,
            countWikiLinks(unit.content ?? ""),
            unit.pinned ? 1 : 0,
            unit.starred ? 1 : 0,
            unit.order_num,
            unit.siteId ?? null,
            ...folderParams,
            unit.archived ? 1 : 0,
        ];
        statements.push(
            api.db
                .prepare(
                    `INSERT INTO notes (user_id, uuid, title, content, link_count, pinned, starred, order_num, site_id, folder_id, archived)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${folderExpr}, ?)`
                )
                .bind(...params)
        );
    } else {
        // ⚠️ CAS：期望 rev 取的是「计划时库里那一版」，不是备份文件里的 rev。
        // 命中 0 行 => 计划后被别人改过，不覆盖；RETURNING 用来如实判命中（与 R02 同款）。
        // rev = rev + 1 / link_count 重算 / CASE WHEN 语义均保持原样。
        const params: unknown[] = [
            unit.uuid,
            unit.title,
            unit.content,
            countWikiLinks(unit.content ?? ""),
            unit.pinned ? 1 : 0,
            unit.starred ? 1 : 0,
            unit.order_num,
            folderFlag,
            ...folderParams,
            unit.siteId !== undefined ? 1 : 0,
            unit.siteId ?? null,
            unit.archived === undefined ? null : unit.archived ? 1 : 0,
            unit.localId,
            unit.expectedRev,
        ];
        updateIndex = statements.length;
        statements.push(
            api.db
                .prepare(
                    `UPDATE notes SET uuid = ?, title = ?, content = ?, link_count = ?, pinned = ?,
                     starred = ?, rev = rev + 1, order_num = ?,
                     folder_id = CASE WHEN ? THEN ${folderExpr} ELSE folder_id END,
                     site_id = CASE WHEN ? THEN ? ELSE site_id END,
                     archived = COALESCE(?, archived), updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND rev = ?${api.scopeSql(true)}
                     RETURNING id`
                )
                .bind(...api.scopeParams(params))
        );
    }

    // ③ 标签关联：先按 uuid 清空，再按 (笔记 uuid, 标签名) 子查询重建；
    // 全程不碰数字 id，既不怕撞号也不怕跨批映射丢失。
    if (unit.tags !== null) {
        statements.push(
            api.db
                .prepare(
                    `DELETE FROM note_note_tag WHERE note_id IN
                     (SELECT id FROM notes WHERE uuid = ?${api.scopeSql(true)})`
                )
                .bind(...api.scopeParams([unit.uuid]))
        );
        for (const name of unit.tags) {
            // 与 notesNote.ts 的 inlineTagStatements 同一套账号隔离写法：
            // join 两表都有 user_id，直接写 `AND user_id = ?` 会 ambiguous column，
            // 所以各用一条 `IN (SELECT id FROM ...<scope>)` 单表守卫。
            statements.push(
                api.db
                    .prepare(
                        `INSERT OR IGNORE INTO note_note_tag (note_id, tag_id)
                         SELECT n.id, t.id FROM notes n, note_tag t
                         WHERE n.uuid = ? AND t.name = ?
                           AND n.id IN (SELECT id FROM notes${api.scopeSql(false)})
                           AND t.id IN (SELECT id FROM note_tag${api.scopeSql(false)})`
                    )
                    .bind(unit.uuid, name, ...api.scopeParams([]), ...api.scopeParams([]))
            );
        }
    }

    // ④ FTS 与正文同批（不再放到函数末尾单独跑，失败时不会被跳过）。
    // rowid 恒等于 notes.id：按 uuid 子查询解析，不依赖任何预分配 id。
    if (api.notesFtsReady) {
        const rowidExpr = `(SELECT id FROM notes WHERE uuid = ?${api.scopeSql(true)})`;
        statements.push(
            api.db
                .prepare(`DELETE FROM notes_fts WHERE rowid = ${rowidExpr}`)
                .bind(...api.scopeParams([unit.uuid]))
        );
        statements.push(
            api.db
                .prepare(
                    `INSERT INTO notes_fts (rowid, note_id, user_id, title, body)
                     VALUES (${rowidExpr}, ${rowidExpr}, ?, ?, ?)`
                )
                .bind(
                    ...api.scopeParams([unit.uuid]),
                    ...api.scopeParams([unit.uuid]),
                    api.currentUserId,
                    segmentCJK(unit.title || ""),
                    segmentCJK((unit.content || "").slice(0, FTS_CONTENT_LIMIT))
                )
        );
    }

    return { statements, updateIndex };
}

/**
 * 判定带 CAS 的 `UPDATE ... RETURNING` 是否真的命中了 1 行。
 *
 * 首选 **RETURNING 的返回行**：真 D1 与本仓共享底座（tests/helpers/realSqliteD1.ts）
 * 都会把每条语句的行放在 `D1Result.results` 里，0 行就是冲突，最准。
 *
 * 但仓库里还有几份测试用的是**更早的 D1 替身**（batch 走 `run()`，不回 RETURNING 行），
 * 以及不同 D1 版本对 batch 的结果形状也可能不同 —— 这时退回 `meta.changes`
 * （= 这条 UPDATE 实际影响的行数，实测命中 1 / 未命中 0，见 node:sqlite 的
 * StatementSync.run()）。连 meta 都拿不到时按「语句没抛错 = 已写入」处理：
 * 没有任何证据就报冲突，会把一次正常更新错记成 conflicts，比漏报更糟。
 *
 * ⚠️ 真实 D1 上 batch + RETURNING 的结果形状仍需在隔离环境复核；这里只保证
 * 「能拿到行就按行数、拿不到就按 changes」两条路都能如实反映命中。
 */
function casUpdated(result: D1Result<unknown> | undefined): boolean {
    if (!result) return true;
    if (Array.isArray(result.results)) return result.results.length > 0;
    const meta = result.meta as { changes?: number; rows_written?: number } | undefined;
    if (meta && typeof meta.changes === "number") return meta.changes > 0;
    if (meta && typeof meta.rows_written === "number") return meta.rows_written > 0;
    return true;
}

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
                    logger.error("读取笔记墓碑失败:", { err: error, component: "notesBackup" })
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
            // 老字段一个不删：created/updated/skipped/removed 保持原语义，只是不再在
            // 「计划阶段」提前累加，而是等每个提交批真的成功后才计入（见下方提交循环）。
            const stats: NoteImportStats = { created: 0, updated: 0, skipped: 0, removed: 0 };
            // 只收形状完整的那几条：title/content 不是字符串的条目直接丢弃，
            // 不能让一条脏数据把整批导入拖崩。uuid 缺失（很老的导出）现场补一个，
            // 让它当成新笔记进来 —— 合并去重靠 uuid，没有它就只能整条新增。
            const incoming = (Array.isArray(payload?.notes) ? payload.notes : [])
                .filter((n): n is Note => !!n && typeof n.title === "string" && typeof n.content === "string")
                .map(n => ({ ...n, uuid: n.uuid || newUuid() }));

            // 「前置语句」：文件夹 / 标签的创建。它们不带显式主键（交给 AUTOINCREMENT），
            // 且被后面笔记单元的子查询按稳定键引用，所以必须排在所有笔记单元之前。
            const preStatements: D1PreparedStatement[] = [];

            // ── 文件夹：按「父路径 + 名称」去重 ──
            // 不再 `MAX(id)+1` 预分配显式 id：本地 id 一律由 DB 自增生成，
            // 「源 id → 本地 id」的映射换成「(父, 名称) 稳定键子查询」（FolderKey），
            // 供 note.folder_id 与子文件夹的 parent_id 在提交阶段现查现用。
            const folderMap = new Map<number, FolderKey>();
            if (Array.isArray(payload.folders) && payload.folders.length > 0) {
                const local = await this.db
                    .prepare(`SELECT id, name, parent_id FROM note_folder${this.scopeSql(false)}`)
                    .bind(...this.scopeParams([]))
                    .all<{ id: number; name: string; parent_id: number | null }>();
                const localById = new Map<number, { id: number; name: string; parent_id: number | null }>();
                for (const f of local.results || []) localById.set(f.id, f);
                // 本地行的稳定路径 = 从根到自己的 name 序列（与源侧同一套判据）
                const localPathCache = new Map<number, string>();
                const localPathOf = (id: number, seen: Set<number>): string => {
                    const cached = localPathCache.get(id);
                    if (cached !== undefined) return cached;
                    const f = localById.get(id);
                    if (!f) return "";
                    if (seen.has(id)) return `/${f.name}`; // 脏数据成环：退回只认自己这一层
                    const nextSeen = new Set(seen);
                    nextSeen.add(id);
                    const parentPath = f.parent_id ? localPathOf(f.parent_id, nextSeen) : "";
                    const path = `${parentPath}/${f.name}`;
                    localPathCache.set(id, path);
                    return path;
                };
                const byPath = new Set<string>();
                for (const f of local.results || []) byPath.add(localPathOf(f.id, new Set()));

                const source = new Map<number, NoteFolder>();
                for (const f of payload.folders) {
                    if (typeof f.id === "number") source.set(f.id, f);
                }

                /** 源侧稳定路径（去重判据），递归时防环 */
                const sourcePathOf = (folder: NoteFolder, visiting: Set<number>): string => {
                    const parent = folder.parent_id ? source.get(folder.parent_id) : undefined;
                    let parentPath = "";
                    if (parent) {
                        if (parent.id !== undefined && visiting.has(parent.id)) {
                            throw new Error("文件夹层级存在循环");
                        }
                        const nextVisiting = new Set(visiting);
                        if (parent.id !== undefined) nextVisiting.add(parent.id);
                        parentPath = sourcePathOf(parent, nextVisiting);
                    }
                    return `${parentPath}/${folder.name}`;
                };

                /**
                 * 「解析该文件夹本地 id」的标量子查询：按 (父, 名称) 稳定键现查。
                 * 父本身也是一条同形状的嵌套子查询；每层都是**单表**，所以 scopeSql(true)
                 * 追加的 `user_id = ?` 不会在 join 里出现列歧义。参数顺序天然是
                 * 「本层 name → 父子查询全部参数 → 本层 user_id」，与 SQL 的 ? 顺序对齐。
                 */
                const folderKeyOf = (folder: NoteFolder, visiting: Set<number>): FolderKey => {
                    const parent = folder.parent_id ? source.get(folder.parent_id) : undefined;
                    let parentExpr = "NULL";
                    let parentParams: unknown[] = [];
                    if (parent) {
                        if (parent.id !== undefined && visiting.has(parent.id)) {
                            throw new Error("文件夹层级存在循环");
                        }
                        const nextVisiting = new Set(visiting);
                        if (parent.id !== undefined) nextVisiting.add(parent.id);
                        const parentKey = folderKeyOf(parent, nextVisiting);
                        parentExpr = `(${parentKey.sql})`;
                        parentParams = parentKey.params;
                    }
                    const sql =
                        `SELECT id FROM note_folder WHERE name = ? AND parent_id IS ${parentExpr}${this.scopeSql(true)}`;
                    return { sql, params: this.scopeParams([folder.name, ...parentParams]) as unknown[] };
                };

                const add = (folder: NoteFolder, visiting: Set<number>): void => {
                    const sourceId = folder.id;
                    if (sourceId !== undefined && folderMap.has(sourceId)) return;
                    if (sourceId !== undefined && visiting.has(sourceId)) {
                        throw new Error("文件夹层级存在循环");
                    }
                    const nextVisiting = new Set(visiting);
                    if (sourceId !== undefined) nextVisiting.add(sourceId);
                    const parent = folder.parent_id ? source.get(folder.parent_id) : undefined;
                    // 父先入队：保证同一个 batch 里父的 INSERT 排在子之前，子的 parent_id 子查询才查得到
                    if (parent) add(parent, nextVisiting);

                    const path = sourcePathOf(folder, new Set());
                    if (sourceId !== undefined) folderMap.set(sourceId, folderKeyOf(folder, new Set()));
                    if (byPath.has(path)) return; // 本地已有同 (父, 名称) 的文件夹，复用即可
                    byPath.add(path);            // 同一次导入里同名路径也只入队一次

                    let parentExpr = "NULL";
                    let parentParams: unknown[] = [];
                    if (parent) {
                        const parentKey = folderKeyOf(parent, new Set());
                        parentExpr = `(${parentKey.sql})`;
                        parentParams = parentKey.params;
                    }
                    preStatements.push(
                        this.db
                            .prepare(
                                `INSERT INTO note_folder (user_id, name, order_num, parent_id)
                                 VALUES (?, ?, ?, ${parentExpr})`
                            )
                            .bind(this.currentUserId, folder.name, folder.order_num ?? 0, ...parentParams)
                    );
                };
                for (const f of payload.folders) add(f, new Set());
            }

            // ── 标签：按名称去重 ──
            // 同样不写 id。INSERT 自带 NOT EXISTS 守卫：即便两个导入并发，
            // 同名标签也不会插出两行（内存去重只挡得住同一次导入内的重复）。
            const tagMap = new Map<number, string>(); // 源 tag id → 稳定键（name）
            if (Array.isArray(payload.tags) && payload.tags.length > 0) {
                const local = await this.db
                    .prepare(`SELECT id, name FROM note_tag${this.scopeSql(false)}`)
                    .bind(...this.scopeParams([]))
                    .all<{ id: number; name: string }>();
                const byName = new Set<string>();
                for (const r of local.results || []) byName.add(r.name);
                for (const row of payload.tags) {
                    if (!byName.has(row.name)) {
                        byName.add(row.name);
                        preStatements.push(
                            this.db
                                .prepare(
                                    `INSERT INTO note_tag (user_id, name, color)
                                     SELECT ?, ?, ? WHERE NOT EXISTS
                                     (SELECT id FROM note_tag WHERE name = ?${this.scopeSql(true)})`
                                )
                                .bind(
                                    this.currentUserId,
                                    row.name,
                                    row.color ?? null,
                                    ...this.scopeParams([row.name])
                                )
                        );
                    }
                    if (typeof row.id === "number") tagMap.set(row.id, row.name);
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

            // ── 老备份 / 前端手动导出的「同库有效 id」兜底（需求 4，2026-11）──
            // 前端手动导出的 JSON/ZIP 从来不写 boundSites，只有服务端整库备份带指纹。
            // 这类文件没有站点指纹，跨库导入时 site_id 会重排，本该一律置空；
            // 但「同一个库里删掉绑定笔记、再重新导入」是完全不同的场景：站点没动过，
            // 旧 site_id 依然指向那张卡片，无条件置空反而让站点反查不到笔记
            //（UI 显示「已删除」）。折中：只有这个 id 在当前库确实存在、且还没被
            // 别的笔记占用时才认它，两个条件缺一不可 ——
            //   · 「站点存在」挡住跨库导入时旧 id 碰巧指向一个同号的无关站点；
            //   · 「未被占用」挡住把它错绑到已经绑着别的笔记的站点上（那会造成
            //     一站两绑，比断绑更糟，见 data.ts 的 SITE_SELECT_WITH_NOTE 相关子查询）。
            // 有 boundSites 时**绝不介入**：指纹解析失败正说明这台机器的站点对不上，
            // 这时认旧 id 会把笔记错绑到无关站点，违反「宁可断绑、不错绑」。
            // 这两个集合是导入前的快照；同批多条笔记指向同一站点仍由下面提交循环
            // 里既有的「解绑同站」语句先到先得，这里不再额外复杂化。
            const existingSiteIds = new Set<number>();
            const occupiedSiteIds = new Set<number>();
            if (boundRefs.length === 0 && incoming.some(n => typeof n.site_id === "number")) {
                const [siteRows, occupiedRows] = await Promise.all([
                    this.db
                        .prepare(`SELECT id FROM sites${this.scopeSql(false)}`)
                        .bind(...this.scopeParams([]))
                        .all<{ id: number }>(),
                    this.db
                        .prepare(`SELECT site_id FROM notes WHERE site_id IS NOT NULL${this.scopeSql(true)}`)
                        .bind(...this.scopeParams([]))
                        .all<{ site_id: number | null }>(),
                ]);
                for (const r of siteRows.results || []) existingSiteIds.add(Number(r.id));
                for (const r of occupiedRows.results || []) {
                    const id = Number(r.site_id);
                    if (Number.isInteger(id)) occupiedSiteIds.add(id);
                }
            }
            const fallbackSiteId = (id: number): number | null =>
                Number.isInteger(id) && id > 0 &&
                existingSiteIds.has(id) && !occupiedSiteIds.has(id)
                    ? id
                    : null;

            // ── noteTags：键是导出方笔记 id，先翻成「uuid → 标签名列表」──
            // 用标签**名**而不是本地数字 id 作稳定键，关联在提交阶段按名子查询解析。
            const noteTagsByUuid = new Map<string, string[]>();
            if (payload.noteTags && typeof payload.noteTags === "object") {
                for (const [exportedId, tagIds] of Object.entries(payload.noteTags)) {
                    const source = incoming.find(n => n.id !== undefined && String(n.id) === exportedId);
                    if (!source?.uuid) continue;
                    const names = (Array.isArray(tagIds) ? tagIds : [])
                        .map(tid => tagMap.get(tid))
                        .filter((name): name is string => typeof name === "string");
                    noteTagsByUuid.set(source.uuid, [...new Set(names)]);
                }
            }

            // ── 笔记合并计划：读本地 uuid/updated_at/rev，文件较新才覆盖 ──
            // rev 取的是**库里**那一版（迁移保证列存在、老行回填 1），与备份文件里
            // 有没有 rev 无关；它作为提交时 CAS 的期望值，挡住「计划后被别人改过」。
            const localRows = await this.db
                .prepare(`SELECT id, uuid, updated_at, rev FROM notes${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .all<{ id: number; uuid: string | null; updated_at: string | null; rev: number | null }>();
            const localByUuid = new Map<string, { id: number; updated_at: string | null; rev: number }>();
            for (const row of localRows.results || []) {
                if (row.uuid) {
                    localByUuid.set(row.uuid, { id: row.id, updated_at: row.updated_at, rev: row.rev ?? 1 });
                }
            }

            const units: ImportUnit[] = [];
            for (const n of incoming) {
                const uuid = n.uuid!;
                const local = localByUuid.get(uuid);
                const folderKey =
                    n.folder_id !== undefined
                        ? typeof n.folder_id === "number"
                            ? folderMap.get(n.folder_id) ?? null
                            : null
                        : undefined;
                // 绑定：文件里没这个字段（很老的导出）→ 不动本地；有字段 → 按指纹解析
                //（解析不了置 null）。新笔记没有「本地」可保持，置 null 就是最终态。
                // 有 boundSites 时**完全**按解析结果（解析不了 = null，不许兜底救回来）；
                // 没有 boundSites 的老备份才走上面的「同库有效 id」兜底。
                const siteId =
                    n.site_id === undefined
                        ? undefined
                        : typeof n.site_id === "number"
                          ? boundRefs.length > 0
                                ? siteResolve.get(n.site_id) ?? null
                                : fallbackSiteId(n.site_id)
                          : null;
                // null = 该笔记在 noteTags 里没有条目（不重建关联，保留本地）；
                // [] 或非空 = 有条目（先清空再按名重建，空数组就是清掉所有关联）
                const tags = noteTagsByUuid.has(uuid) ? noteTagsByUuid.get(uuid)! : null;
                if (!local) {
                    units.push({
                        kind: "created", uuid,
                        title: n.title, content: n.content,
                        pinned: Boolean(n.pinned), starred: Boolean(n.starred),
                        order_num: n.order_num ?? 0,
                        folderKey, siteId, archived: n.archived, tags,
                    });
                } else if (Date.parse(n.updated_at || "") > Date.parse(local.updated_at || "")) {
                    units.push({
                        kind: "updated", uuid, localId: local.id, expectedRev: local.rev,
                        title: n.title, content: n.content,
                        pinned: Boolean(n.pinned), starred: Boolean(n.starred),
                        order_num: n.order_num ?? 0,
                        folderKey, siteId, archived: n.archived, tags,
                    });
                } else {
                    // 本地较新（或时间解析不出来）：保守保留本地，不冒险覆盖
                    units.push({ kind: "skipped", uuid });
                }
            }

            // 一站一篇：同批两个笔记解析到同一站点时先到先得，后者置空
            const usedSites = new Set<number>();
            for (const unit of units) {
                if (unit.kind === "skipped") continue;
                if (typeof unit.siteId === "number") {
                    if (usedSites.has(unit.siteId)) unit.siteId = null;
                    else usedSites.add(unit.siteId);
                }
            }

            // ── 组装「可恢复单元」批次 ──
            // 每条笔记 = 解绑 → 正文 INSERT/UPDATE → 该笔记标签关联 → 该笔记 FTS 先删后插，
            // 整组语句**必须落在同一个事务**里。这样任一失败点，已提交的都是完整笔记，
            // 未提交的笔记（正文 / 关联 / 索引一起）完全不存在，不会留下半截记录。
            //
            // 250 只是本仓约定的切片值（沿用 updateNoteOrder 等），**不是平台硬性 batch 限额**；
            // 切分点只允许落在「笔记单元」边界，绝不在一条笔记的正文与它的关联之间切开。
            const COMMIT_CHUNK = 250;
            const batches: CommitBatch[] = [];
            let cur: CommitBatch = { units: [], statements: [], updateChecks: [] };
            for (const statement of preStatements) {
                if (cur.statements.length >= COMMIT_CHUNK) {
                    batches.push(cur);
                    cur = { units: [], statements: [], updateChecks: [] };
                }
                cur.statements.push(statement);
            }
            for (const unit of units) {
                if (unit.kind === "skipped") {
                    // 零语句单元：挂在相邻批里，等那一批提交成功后才计入 skipped
                    cur.units.push(unit);
                    continue;
                }
                const built = buildNoteUnitStatements(this, unit);
                if (cur.statements.length > 0 && cur.statements.length + built.statements.length > COMMIT_CHUNK) {
                    batches.push(cur);
                    cur = { units: [], statements: [], updateChecks: [] };
                }
                const base = cur.statements.length;
                cur.units.push(unit);
                cur.statements.push(...built.statements);
                if (built.updateIndex !== null) {
                    cur.updateChecks.push({ uuid: unit.uuid, stmtIndex: base + built.updateIndex });
                }
            }
            if (cur.statements.length > 0 || cur.units.length > 0) batches.push(cur);

            // ── 提交：一个 batch = 一个事务；统计只认「真的提交成功」的批 ──
            // 失败批及其之后的批一律不计入，已提交的批保留；返回值带 partial 让调用方
            // 如实提示「重导可续传」。相同 uuid 按「文件较新才覆盖」去重，不会重复建。
            let committedUnits = 0;
            for (let bi = 0; bi < batches.length; bi += 1) {
                const batch = batches[bi];
                try {
                    // 空语句批（全是 skipped，例如备份导出后原样喂回）不调 db.batch([])，
                    // 直接视为「提交成功」把 skipped 计入 —— 它本来就没有 IO 会失败。
                    const results: D1Result<unknown>[] =
                        batch.statements.length > 0 ? await this.db.batch(batch.statements) : [];
                    for (const unit of batch.units) {
                        if (unit.kind === "skipped") {
                            stats.skipped += 1;
                        } else if (unit.kind === "created") {
                            stats.created += 1;
                        } else {
                            // CAS：UPDATE 带 RETURNING，命中 0 行 = 计划后 rev 被别人改过，
                            // 正文没覆盖 → 计入 conflicts，而不是撒谎记成 updated。
                            const check = batch.updateChecks.find(c => c.uuid === unit.uuid);
                            const hit = check ? casUpdated(results[check.stmtIndex]) : true;
                            if (hit) stats.updated += 1;
                            else stats.conflicts = (stats.conflicts ?? 0) + 1;
                        }
                    }
                    committedUnits += batch.units.length;
                } catch (error) {
                    // ⚠️ 顺序不能反：先把 partial / warning 置齐再发事件，事件里的
                    // 字段才与**返回给调用方的 stats** 逐字一致（否则日志说「没问题」、
                    // 用户看到「导入中断」，事后对不上账）。
                    stats.partial = true;
                    stats.warning =
                        `已提交 ${committedUnits} 条笔记，第 ${bi + 1} 批写入失败、该批及其之后的笔记未计入统计；` +
                        "重新导入即可续传（相同 uuid 按「文件较新才覆盖」去重，不会重复建）";
                    // 结构化事件（notes.import.partial，2026-11）：这是「静默型」失败 ——
                    // 用户只看到一句提示，运维侧原本一条记录都没有。纯观测：不改返回值、
                    // 不改状态码、不影响已提交的批。
                    const event = notesImportPartialEvent(stats, {
                        failedBatch: bi + 1,
                        batchCount: batches.length,
                        userId: this.currentUserId,
                        err: error,
                    });
                    logger[event.level](event.message, event.fields);
                    return stats;
                }
            }
            if ((stats.conflicts ?? 0) > 0) {
                stats.warning =
                    `有 ${stats.conflicts} 条笔记在导入期间被其它设备改过（rev 已变），本次未覆盖、保留了本地较新的内容`;
                // 冲突不是「失败」而是**正确的降级**（保住了用户更新的编辑），所以是 warn：
                // 一条不值得叫醒任何人，但「同一个账号一天出现几十次」本身是信号
                //（多端并发编辑 / 导入被反复重试），运维手册里那条判定就靠它。
                const event = notesImportConflictsEvent(stats, { userId: this.currentUserId });
                logger[event.level](event.message, event.fields);
            }
            return stats;
        });
    },
};
