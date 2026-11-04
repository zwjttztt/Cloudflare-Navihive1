// tests/noteImportRecoveryRealSql.test.ts
//
// R03 / R04 回归钉子：**真实 SQLite**（tests/helpers/realSqliteD1.ts 的 batch 是真事务
// BEGIN/COMMIT/ROLLBACK），验证 importNotesData 的四个改动：
//
//   1. 可恢复单元：正文 / 标签关联 / FTS 交错成一条笔记的自足单元，任何一个批失败
//      都不会留下「正文有、标签或索引缺」的半截记录；重导能补齐到与一次成功导入一致。
//   2. CAS：已有笔记的 UPDATE 带 `AND rev = 计划时库里的 rev`，命中 0 行 = 计划后被
//      别人改过 → 不覆盖用户较新的编辑，并如实计入 conflicts。
//   3. 统计真实化：created/updated/skipped 只按「真的提交成功」的批累加，失败批不计入，
//      失败返回带 partial 显式标记。
//   4. 并发安全 ID：不再事务外 MAX(id)+1 预分配，全部交给 AUTOINCREMENT，
//      关联/folder 一律按稳定键（uuid / 名称 / (父,名称)）子查询解析。
//
// 为什么必须真库：FakeD1/MockD1 不执行 SQL，主键冲突、子查询解析、RETURNING 零行、
// 「批失败整批回滚」这些在它们身上永远绿。这里所有断言都直接查库。

import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1, type RealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import type { NotesImportPayload } from "../src/API/types";

/** 过去时间：保证「已导入的笔记」重导时判 skipped（本地 updated_at 是导入时的 now） */
const PAST_AT = "2020-01-01T00:00:00.000Z";
/** 80 条笔记：即使 FTS 不可用（每单元 4 语句）总语句也 > 250，必然切成 ≥2 个提交批 */
const NOTE_COUNT = 80;

async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署：scopeSql 返回空串，IS/=/ 语义在真引擎上说得清
    assert.equal(api.notesFtsReady, true, "本组用例要验证 FTS 与正文同批，底座必须建出 FTS5 表");
    return { db, api };
}

/** 造一份带文件夹 / 两个标签 / 全量 noteTags 的备份 */
function makePayload(count: number, updatedAt: string, prefix = "n"): NotesImportPayload {
    const notes = Array.from({ length: count }, (_, i) => ({
        id: 1000 + i, // 导出方笔记 id：noteTags 的键就是它
        uuid: `${prefix}-${i}`,
        title: `${prefix}标题${i}`,
        content: `${prefix}正文${i} 独特词${i}`,
        updated_at: updatedAt,
        folder_id: 1,
    }));
    return {
        kind: "navihive-notes-backup",
        folders: [{ id: 1, name: "导入夹", parent_id: null, order_num: 0 }],
        tags: [{ id: 1, name: "标签甲" }, { id: 2, name: "标签乙" }],
        noteTags: Object.fromEntries(notes.map(n => [String(n.id), [1, 2]])),
        notes,
    };
}

/** 按「稳定键」取快照，不比自增 id / rev / updated_at（两个库本来就不会一样） */
async function snapshot(db: RealD1) {
    const notes = (await db
        .prepare(
            `SELECT n.uuid AS uuid, n.title AS title, n.content AS content, f.name AS folder
             FROM notes n LEFT JOIN note_folder f ON f.id = n.folder_id ORDER BY n.uuid`
        )
        .all<{ uuid: string; title: string; content: string; folder: string | null }>()).results ?? [];
    const links = (await db
        .prepare(
            `SELECT n.uuid AS uuid, t.name AS tag FROM note_note_tag l
             JOIN notes n ON n.id = l.note_id JOIN note_tag t ON t.id = l.tag_id
             ORDER BY n.uuid, t.name`
        )
        .all<{ uuid: string; tag: string }>()).results ?? [];
    const fts = (await db
        .prepare(
            `SELECT n.uuid AS uuid, f.title AS title, f.body AS body FROM notes_fts f
             JOIN notes n ON n.id = f.note_id ORDER BY n.uuid`
        )
        .all<{ uuid: string; title: string; body: string }>()).results ?? [];
    const folders = (await db.prepare("SELECT name FROM note_folder ORDER BY name").all<{ name: string }>()).results ?? [];
    const tags = (await db.prepare("SELECT name FROM note_tag ORDER BY name").all<{ name: string }>()).results ?? [];
    return { notes, links, fts, folders, tags };
}

/**
 * 在 db.batch 外套一层可切换的钩子，用来在**提交阶段**制造故障或并发窗口。
 * 只包装一次（arm 会重置计数），arm 之前的 migrate() 不受影响 —— 迁移缓存命中后
 * importNotesData 里那次 `await this.migrate()` 不会再调 batch。
 */
interface BatchHook {
    arm(): void;
    disarm(): void;
    calls(): number;
    setHandler(fn: (call: number) => Promise<void> | void): void;
}
function installBatchHook(db: RealD1): BatchHook {
    type BatchFn = RealD1["batch"];
    const original = db.batch.bind(db) as BatchFn;
    let armed = false;
    let calls = 0;
    let handler: (call: number) => Promise<void> | void = () => {};
    db.batch = (async (stmts: Parameters<BatchFn>[0]) => {
        if (armed) {
            calls += 1;
            await handler(calls);
        }
        return original(stmts);
    }) as BatchFn;
    return {
        arm: () => { armed = true; calls = 0; },
        disarm: () => { armed = false; },
        calls: () => calls,
        setHandler: (fn) => { handler = fn; },
    };
}

const countOf = async (db: RealD1, sql: string): Promise<number> =>
    (await db.prepare(sql).first<{ c: number }>())!.c;

// ─────────────────────────── 1. 分批故障 → 重导可恢复 ───────────────────────────

test("真实 SQLite：第 2 个提交批失败后重导，结果与一次成功导入一致（正文/标签/FTS 全在）", async () => {
    const payload = makePayload(NOTE_COUNT, PAST_AT);

    // A：让第 2 个提交批抛错 —— 已提交的第 1 批必须全是「完整笔记」
    const a = await fresh();
    const hookA = installBatchHook(a.db);
    hookA.setHandler((call) => {
        if (call === 2) throw new Error("注入：第 2 个提交批失败");
    });
    hookA.arm();
    const first = await a.api.importNotesData(payload);
    hookA.disarm();

    assert.equal(first.partial, true, "失败必须带显式 partial 标记");
    assert.ok(hookA.calls() >= 2, "确实切成了至少两个提交批");
    const committed = await countOf(a.db, "SELECT COUNT(*) AS c FROM notes");
    assert.ok(committed > 0 && committed < NOTE_COUNT, "只提交了一部分，另一部分完全没落库");
    // 核心断言：已提交笔记的标签关联与 FTS 一条不少 —— 不再有「正文有、关联/索引缺」
    assert.equal(
        await countOf(a.db, "SELECT COUNT(*) AS c FROM note_note_tag l JOIN notes n ON n.id = l.note_id"),
        committed * 2,
        "已提交笔记的标签关联（每条 2 个）必须完整"
    );
    assert.equal(
        await countOf(a.db, "SELECT COUNT(*) AS c FROM notes_fts f JOIN notes n ON n.id = f.note_id"),
        committed,
        "已提交笔记的 FTS 必须完整（FTS 与正文同批，失败时不会跳过）"
    );

    // 重导：已提交的按 uuid 去重，未提交的补上
    const second = await a.api.importNotesData(payload);
    assert.equal(second.partial, undefined, "重导成功不该再带 partial");
    assert.equal(second.created + first.created, NOTE_COUNT, "两次合计正好覆盖全部笔记");
    assert.equal(await countOf(a.db, "SELECT COUNT(*) AS c FROM notes"), NOTE_COUNT);

    // B：同一份 payload 一次成功导入（对照组）。所有 A 的 api 调用已结束，可安全换库。
    const b = await fresh();
    const ok = await b.api.importNotesData(payload);
    assert.equal(ok.partial, undefined);
    assert.equal(ok.created, NOTE_COUNT);

    assert.deepEqual(
        await snapshot(a.db),
        await snapshot(b.db),
        "故障重导后的库与一次成功导入逐字段一致（笔记正文 / 文件夹 / 标签关联 / FTS）"
    );
});

// ─────────────────────────── 2. CAS 保护用户后来的编辑 ───────────────────────────

test("真实 SQLite：故障后用户又编辑了某条笔记 → 重导不覆盖新内容，conflicts 如实上报", async () => {
    const { db, api } = await fresh();
    // 未来时间：让「已提交的笔记」在重导时进入 updated 分支（而不是被 skipped 掉），
    // 这样才真的走到 CAS 判定那一行。
    const futureAt = new Date(Date.now() + 60_000).toISOString();
    const payload = makePayload(NOTE_COUNT, futureAt);

    const hook = installBatchHook(db);
    hook.setHandler((call) => {
        if (call === 2) throw new Error("注入：第 2 个提交批失败");
    });
    hook.arm();
    const first = await api.importNotesData(payload);
    hook.disarm();
    assert.equal(first.partial, true);
    assert.ok(first.created > 0, "批 1 已提交若干笔记，X = n-0 在其中");

    const xBefore = await db
        .prepare("SELECT id, rev, content FROM notes WHERE uuid = ?")
        .bind("n-0")
        .first<{ id: number; rev: number; content: string }>();
    assert.ok(xBefore, "X 已在批 1 里落库");

    // 重导的计划阶段已经把库里 rev 读走；在**提交窗口**里模拟「用户又编辑了 X」：
    // 改正文 + rev+1 + updated_at=now，正是多端并发时另一设备保存的样子。
    // 单线程测试里要可复现地制造这个窗口，只能在 batch 之前动手。
    const editedContent = "用户后来编辑的内容（绝不能被备份覆盖）";
    hook.setHandler(async (call) => {
        if (call !== 1) return;
        await db
            .prepare("UPDATE notes SET content = ?, rev = rev + 1, updated_at = CURRENT_TIMESTAMP WHERE uuid = ?")
            .bind(editedContent, "n-0")
            .run();
    });
    hook.arm();
    const retry = await api.importNotesData(payload);
    hook.disarm();

    const xAfter = await db
        .prepare("SELECT rev, content FROM notes WHERE uuid = ?")
        .bind("n-0")
        .first<{ rev: number; content: string }>();
    assert.equal(xAfter!.content, editedContent, "CAS 未命中 → 重导不得覆盖用户后来编辑的内容");
    assert.equal(xAfter!.rev, xBefore!.rev + 1, "那次未命中的 UPDATE 不该把 rev 又 +1");
    assert.equal(retry.conflicts, 1, "CAS 未命中的笔记如实计入 conflicts");
    assert.equal(retry.updated, first.created - 1, "其余 updated 单元照常计入，不含冲突那条");
    assert.match(retry.warning ?? "", /改过|未覆盖|保留/, "warning 要如实说明冲突");
    assert.equal(retry.partial, undefined, "冲突不等于提交失败，不该带 partial");
});

// ─────────────────────────── 3. 统计对应真实提交 ───────────────────────────

test("真实 SQLite：created/updated/skipped 只按真实提交累加，失败批不计入且返回 partial", async () => {
    const { db, api } = await fresh();
    const payload = makePayload(NOTE_COUNT, PAST_AT);
    const hook = installBatchHook(db);
    hook.setHandler((call) => {
        if (call === 2) throw new Error("注入：第 2 个提交批失败");
    });
    hook.arm();
    const partial = await api.importNotesData(payload);
    hook.disarm();

    assert.equal(partial.partial, true, "失败返回必须带显式 partial 标记");
    assert.match(partial.warning ?? "", /重新导入|重导/, "warning 要说明「重导可续传」");
    assert.match(partial.warning ?? "", /未计入|未写入|失败/, "warning 要说明失败批没算进统计");
    const committed = await countOf(db, "SELECT COUNT(*) AS c FROM notes");
    assert.equal(partial.created, committed, "created 只数真正提交成功的批");
    assert.equal(partial.updated, 0);
    assert.equal(partial.skipped, 0, "全是新笔记，失败批的笔记不能算 skipped");
    assert.ok(committed > 0 && committed < NOTE_COUNT);
    // 反证：stats 不再是「计划数」
    assert.notEqual(partial.created, NOTE_COUNT, "不能把未提交批也算进 created（这是 R03 的原缺陷）");

    const retry = await api.importNotesData(payload);
    assert.equal(retry.partial, undefined);
    assert.equal(retry.created, NOTE_COUNT - committed, "重导只补未提交的那部分");
    assert.equal(retry.skipped, committed, "已提交的按 uuid 认出是同一条，本次 skipped");
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM notes"), NOTE_COUNT);
});

// ─────────────────────────── 4. 幂等 ───────────────────────────

test("真实 SQLite：相同 payload 连续导入两次不产生重复笔记 / 标签关联", async () => {
    const { db, api } = await fresh();
    const payload = makePayload(20, PAST_AT);

    const first = await api.importNotesData(payload);
    assert.equal(first.created, 20);
    assert.equal(first.partial, undefined);
    const second = await api.importNotesData(payload);
    assert.equal(second.created, 0, "第二次一条都不该新建");
    assert.equal(second.skipped, 20, "全部按 uuid 认出是同一条");
    assert.equal(second.partial, undefined);

    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM notes"), 20);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM note_note_tag"), 40);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM note_tag"), 2);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM note_folder"), 1);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM notes_fts"), 20);
});

// ─────────────────────────── 5. 并发 ID 分配窗口 ───────────────────────────

test("真实 SQLite：两次导入 + 一次普通 createNote 交错，不撞主键、不错关联（并发窗口）", async () => {
    const { db, api } = await fresh();
    const hook = installBatchHook(db);
    hook.setHandler(async (call) => {
        if (call !== 1) return;
        // 计划已完成、正要提交时另一设备插入一条笔记：改前 MAX(id)+1 预分配的
        // 显式 id 会与它撞主键，改后交给 AUTOINCREMENT 就不会。
        await db
            .prepare("INSERT INTO notes (user_id, uuid, title, content) VALUES (?, ?, ?, ?)")
            .bind(null, "concurrent-note", "并发新建", "并发正文")
            .run();
    });
    hook.arm();
    const a = await api.importNotesData(makePayload(10, PAST_AT, "a"));
    hook.disarm();
    assert.equal(a.partial, undefined, "并发插入不得导致主键冲突 / 部分失败");
    assert.equal(a.created, 10);

    // 交错：一次普通 createNote（走 createNote 自己的自增 + RETURNING 路径）
    const plain = await api.createNote({ title: "普通新建", content: "普通正文" });
    assert.ok(plain.uuid);

    const b = await api.importNotesData(makePayload(10, PAST_AT, "b"));
    assert.equal(b.partial, undefined);
    assert.equal(b.created, 10);

    const total = await countOf(db, "SELECT COUNT(*) AS c FROM notes");
    assert.equal(total, 22, "10 导入 + 1 并发插入 + 1 普通新建 + 10 导入");
    assert.equal(
        await countOf(db, "SELECT COUNT(DISTINCT id) AS c FROM notes"),
        total,
        "所有 id 唯一，没有撞主键"
    );

    // 关联不错：每条 a-/b- 笔记恰好挂着「标签甲」「标签乙」（按 uuid 查，不看数字 id）
    for (const prefix of ["a", "b"]) {
        for (let i = 0; i < 10; i += 1) {
            const uuid = `${prefix}-${i}`;
            const row = await db
                .prepare(
                    `SELECT COUNT(*) AS c FROM note_note_tag l
                     JOIN notes n ON n.id = l.note_id JOIN note_tag t ON t.id = l.tag_id
                     WHERE n.uuid = ? AND t.name IN ('标签甲', '标签乙')`
                )
                .bind(uuid)
                .first<{ c: number }>();
            assert.equal(row!.c, 2, `${uuid} 的标签必须挂在自己身上，不能串到别的笔记 id`);
        }
    }
    assert.equal(
        await countOf(
            db,
            `SELECT COUNT(*) AS c FROM notes_fts f JOIN notes n ON n.id = f.note_id
             WHERE n.uuid LIKE 'a-%' OR n.uuid LIKE 'b-%'`
        ),
        20,
        "20 条导入笔记的 FTS 一条不少，rowid 都对齐到自己的 notes.id"
    );
});

// ─────────────────────────── 兼容性补充 ───────────────────────────

test("真实 SQLite：老备份（无 boundSites / 无 rev / 缺 uuid / 无 folders-tags）仍可导入", async () => {
    const { db, api } = await fresh();
    const stats = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [
            { title: "没有 uuid 的老笔记", content: "正文甲", updated_at: PAST_AT },
            { uuid: "legacy-1", title: "带 uuid 的老笔记", content: "正文乙", updated_at: PAST_AT, site_id: null },
        ],
    });
    assert.equal(stats.created, 2);
    assert.equal(stats.partial, undefined);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM notes"), 2);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM notes_fts"), 2);
    // 缺 uuid 的那条被现场补上了 uuid（合并去重靠它）
    assert.equal(
        await countOf(db, "SELECT COUNT(*) AS c FROM notes WHERE uuid IS NOT NULL AND uuid != ''"),
        2
    );
});

test("真实 SQLite：父子文件夹按 (父, 名称) 稳定键重建，笔记 folder_id 落到子夹", async () => {
    const { db, api } = await fresh();
    const stats = await api.importNotesData({
        kind: "navihive-notes-backup",
        folders: [
            { id: 1, name: "根夹", parent_id: null, order_num: 0 },
            { id: 2, name: "子夹", parent_id: 1, order_num: 1 },
        ],
        notes: [
            { uuid: "f-1", title: "归类笔记", content: "正文", updated_at: PAST_AT, folder_id: 2 },
        ],
    });
    assert.equal(stats.created, 1);
    assert.equal(await countOf(db, "SELECT COUNT(*) AS c FROM note_folder"), 2);
    const row = await db
        .prepare(
            `SELECT f.name AS folder, p.name AS parent_name
             FROM notes n JOIN note_folder f ON f.id = n.folder_id
             LEFT JOIN note_folder p ON p.id = f.parent_id WHERE n.uuid = ?`
        )
        .bind("f-1")
        .first<{ folder: string; parent_name: string | null }>();
    assert.equal(row!.folder, "子夹", "folder_id 由嵌套子查询解析，不能落到内存递增的旧 id");
    assert.equal(row!.parent_name, "根夹", "子夹的 parent_id 也由稳定键子查询解析");
});

test("真实 SQLite：多账号（uid≠null）下嵌套 folder 子查询与标签 scope 参数顺序对齐", async () => {
    const { db, api } = await fresh();
    api.setCurrentUser(555);
    const payload: NotesImportPayload = {
        kind: "navihive-notes-backup",
        folders: [
            { id: 1, name: "根", parent_id: null, order_num: 0 },
            { id: 2, name: "子", parent_id: 1, order_num: 1 },
        ],
        tags: [{ id: 1, name: "多账号标签" }],
        noteTags: { "7": [1] },
        notes: [
            { id: 7, uuid: "acct-1", title: "甲", content: "正文甲", updated_at: PAST_AT, folder_id: 2 },
        ],
    };

    const first = await api.importNotesData(payload);
    assert.equal(first.created, 1);
    assert.equal(first.partial, undefined);
    const row = await db
        .prepare(
            `SELECT f.name AS folder, p.name AS parent_name, n.user_id AS uid
             FROM notes n JOIN note_folder f ON f.id = n.folder_id
             LEFT JOIN note_folder p ON p.id = f.parent_id WHERE n.uuid = ?`
        )
        .bind("acct-1")
        .first<{ folder: string; parent_name: string | null; uid: number | null }>();
    assert.equal(row!.folder, "子", "登录态下 folder_id 的嵌套 scope 子查询必须解析到本账号的行");
    assert.equal(row!.parent_name, "根");
    assert.equal(row!.uid, 555);
    assert.equal(
        await countOf(db, "SELECT COUNT(*) AS c FROM note_note_tag l JOIN notes n ON n.id = l.note_id WHERE n.uuid = 'acct-1'"),
        1,
        "标签关联的 join + 两条 IN(scope) 守卫在登录态下参数顺序必须对齐"
    );

    // 再导一次并让文件较新 → 走 updated 分支（CAS + 嵌套 folder 子查询都带 user_id 参数）
    const again = await api.importNotesData({
        ...payload,
        notes: [{
            ...payload.notes![0],
            title: "甲（改）",
            updated_at: new Date(Date.now() + 60_000).toISOString(),
        }],
    });
    assert.equal(again.updated, 1, "登录态下 CAS 应命中 1 行");
    assert.equal(again.conflicts, undefined);
    assert.equal(again.partial, undefined);
    const title = await db.prepare("SELECT title FROM notes WHERE uuid = ?").bind("acct-1").first<{ title: string }>();
    assert.equal(title!.title, "甲（改）");

    // 别的账号看不到，也不会被串进来
    api.setCurrentUser(777);
    assert.equal((await api.listNotes()).length, 0, "账号隔离不能因为子查询改造而丢");
    api.setCurrentUser(null);
});

