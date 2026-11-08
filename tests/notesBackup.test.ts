// tests/notesBackup.test.ts
//
// 记事本备份（2026-10-09 照 inkstone 的 BackupSettings）的两层验证：
//
// 1. **纯逻辑**：调度判定（到没到点）、保留清理（只动自动备份、手动一份不删）、
//    运行记录合并、配置回落（url/账号/密码从 webdav.* 带入）。
//    「手动备份不会被定时任务清掉」这条铁律必须在这里被直接断言 ——
//    掺进 IO 就测不动了（与导航备份的 naming.ts 同一套路）。
// 2. **真实 SQLite**：exportNotesData 的导出形状与 importNotesData 闭环 ——
//    备份文件就是导入端点的入参，「备份 → 数据页导入」必须真的能走通。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import {
    NOTES_BACKUP_RUNS_KEY,
    appendNotesBackupRun,
    notesBackupIntervalMs,
    notesWebDavConfigFrom,
    parseNotesRetention,
    readBackupAttachmentEntries,
    readNotesBackupRuns,
    shouldRunNotesBackup,
} from "../worker/notesBackup";
import {
    buildBackupFileName,
    buildNotesBackupFileName,
    buildNotesBackupZipFileName,
    selectAutoBackupsToPrune,
    selectNotesBackupsToPrune,
} from "../worker/webdav/naming";
import type { NotesBackupRun } from "../src/API/types";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";
import { isNavBackupDue } from "../worker/cron";
import { NAV_BACKUP_INTERVAL_MS, parseAutoBackupFileTime, shouldRunNavBackup } from "../worker/cronLogic";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ============ 纯逻辑：调度 ============

test("调度：七档频率的间隔与 off 不跑", () => {
    assert.equal(notesBackupIntervalMs("hourly"), HOUR);
    assert.equal(notesBackupIntervalMs("sixHourly"), 6 * HOUR);
    assert.equal(notesBackupIntervalMs("daily"), DAY);
    assert.equal(notesBackupIntervalMs("weekly"), 7 * DAY);
    assert.equal(notesBackupIntervalMs("monthly"), 30 * DAY);
    assert.equal(notesBackupIntervalMs("yearly"), 365 * DAY);
    // off / 乱值一律不跑
    assert.equal(notesBackupIntervalMs("off"), null);
    assert.equal(notesBackupIntervalMs(""), null);
    assert.equal(notesBackupIntervalMs("every-second"), null);
});

test("调度：shouldRunNotesBackup 的到点判定", () => {
    const now = 1_800_000_000_000;
    // 没备份过 + 配了频率 → 跑
    assert.ok(shouldRunNotesBackup("daily", null, now));
    assert.ok(shouldRunNotesBackup("daily", undefined, now));
    // off → 永远不跑（哪怕从没备份过）
    assert.ok(!shouldRunNotesBackup("off", null, now));
    // 刚备份过、间隔未满 → 不跑
    assert.ok(!shouldRunNotesBackup("daily", new Date(now - DAY / 2).toISOString(), now));
    // 间隔满 → 跑
    assert.ok(shouldRunNotesBackup("daily", new Date(now - DAY).toISOString(), now));
    assert.ok(shouldRunNotesBackup("daily", new Date(now - 8 * DAY).toISOString(), now));
    // 记录坏了（解析不出时间）→ 当成从没备份过，跑（宁可多备不能漏备）
    assert.ok(shouldRunNotesBackup("daily", "not-a-date", now));
});

test("保留份数：parseNotesRetention 的默认与边界", () => {
    assert.equal(parseNotesRetention(null), 7); // 缺省 7
    assert.equal(parseNotesRetention("junk"), 7);
    assert.equal(parseNotesRetention("-3"), 7); // 负数非法
    assert.equal(parseNotesRetention("0"), 0); // 0 = 全部保留，合法
    assert.equal(parseNotesRetention("30"), 30);
    assert.equal(parseNotesRetention("9999"), 365); // 顶到上限
});

// ============ 纯逻辑：保留清理 ============

test("清理：只动自动备份、保住最新 N 份、手动与导航备份一份不碰", () => {
    const files = [
        // 新 → 旧
        { name: "navihive-notes-backup-auto-20260109-030000-000.json.gz", lastModified: "2026-01-09T03:00:00Z" },
        { name: "navihive-notes-backup-auto-20260108-030000-000.json.gz", lastModified: "2026-01-08T03:00:00Z" },
        { name: "navihive-notes-backup-auto-20260107-030000-000.json.gz", lastModified: "2026-01-07T03:00:00Z" },
        { name: "navihive-notes-backup-auto-20260106-030000-000.json.gz", lastModified: "2026-01-06T03:00:00Z" },
        // 手动备份是存档，谁都不能动
        { name: "navihive-notes-backup-20260105-120000-000.json.gz", lastModified: "2026-01-05T12:00:00Z" },
        // 导航页备份同住一个网盘，也绝不在清理范围
        { name: "navihive-backup-auto-20260104-020000-000.json.gz", lastModified: "2026-01-04T02:00:00Z" },
    ];
    // 「保留 2 份」含本次刚上传那份：新备份 + 最新的一份旧的留下，其余清掉
    const pruned = selectNotesBackupsToPrune(files, files[0].name, 2);
    assert.deepEqual(pruned, [files[2].name, files[3].name]);
    // keepFilename（本次刚上传那份）绝不出现在结果里
    assert.ok(!pruned.includes(files[0].name));
    // retention = 0（全部保留）→ 一个不删
    assert.deepEqual(selectNotesBackupsToPrune(files, files[0].name, 0), []);
    // 缺 lastModified 时退回文件名倒序（文件名自带时间戳）
    const noTime = files.map(f => ({ name: f.name }));
    const byName = selectNotesBackupsToPrune(noTime, files[0].name, 1);
    assert.deepEqual(byName, [files[1].name, files[2].name, files[3].name]);
});

// ============ 纯逻辑：文件名与运行记录 ============

test("文件名：记事本备份与导航备份前缀分开，auto/manual 可区分", () => {
    const autoName = buildNotesBackupFileName("auto");
    const manualName = buildNotesBackupFileName("manual");
    assert.ok(autoName.startsWith("navihive-notes-backup-auto-"), autoName);
    assert.ok(manualName.startsWith("navihive-notes-backup-"), manualName);
    assert.ok(!manualName.startsWith("navihive-notes-backup-auto-"));
    // 与导航备份的前缀不同：「备份和导航页的分开」在文件名这层也要成立
    assert.ok(!autoName.startsWith("navihive-backup"));
    assert.ok(buildBackupFileName("auto").startsWith("navihive-backup-auto-"));
});

// ============ 纯逻辑：备份文件名固定北京时间（UTC+8） ============
//
// 全站时间显示统一北京时间后，naming.ts 的 buildBackupFileName 用「+8h 取 getUTC*」
// 生成北京墙上时钟的定宽时间戳；cronLogic.parseAutoBackupFileTime 反解时再减 8h。
// 下面三条钉死：生成是北京钟面、往返解析回同一绝对时刻、前缀/格式/单调性都不变。

/** 固定绝对时刻 2026-01-02T17:04:05.006Z = 北京 2026-01-03 01:04:05.006（跨日，能验出 +8h） */
const BEIJING_FIXED_MS = Date.UTC(2026, 0, 2, 17, 4, 5, 6);
const BEIJING_STAMP = "20260103-010405-006";

test("buildBackupFileName 用北京时间分量：定宽零填充、前缀/后缀不变", t => {
    t.mock.timers.enable({ apis: ["Date"], now: BEIJING_FIXED_MS });
    const nav = buildBackupFileName("auto");
    const notes = buildNotesBackupFileName("auto");
    const notesZip = buildNotesBackupZipFileName("auto");
    t.mock.timers.reset();

    assert.equal(nav, `navihive-backup-auto-${BEIJING_STAMP}.json.gz`);
    // 两个包装函数复用同一 stamp，只是换前缀 / 扩展名 → 同样带北京时间
    assert.equal(notes, `navihive-notes-backup-auto-${BEIJING_STAMP}.json.gz`);
    assert.equal(notesZip, `navihive-notes-backup-auto-${BEIJING_STAMP}.zip`);
    // 旧 UTC 行为会得到 20260102-170405-006；这里必须是 +8h 的 20260103-010405-006
    assert.ok(!nav.includes("20260102-170405-006"));
});

test("新（北京命名）文件名解析成正确的绝对时刻：生成→解析往返一致", t => {
    // 北京 2026-11-08 10:00:00.000 = UTC 2026-11-08 02:00:00.000Z
    const fixedMs = Date.UTC(2026, 10, 8, 2, 0, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now: fixedMs });
    const name = buildBackupFileName("auto");
    t.mock.timers.reset();

    assert.equal(name, "navihive-backup-auto-20261108-100000-000.json.gz");
    // 北京命名反解回原绝对时刻（减 8h），不是把钟面当 UTC 得到的 10:00Z
    assert.equal(parseAutoBackupFileTime(name), fixedMs);
    assert.equal(parseAutoBackupFileTime("navihive-backup-auto-20260103-010405-006.json.gz"), BEIJING_FIXED_MS);
    // 认不出的 / 手动前缀 / null 一律 null（严格匹配不被放宽）
    assert.equal(parseAutoBackupFileTime("navihive-backup-20261108-100000-000.json.gz"), null);
    assert.equal(parseAutoBackupFileTime("navihive-backup-auto-2026-11-08-1.json.gz"), null);
    assert.equal(parseAutoBackupFileTime(null), null);
});

test("保留策略：北京时间戳仍是定宽零填充、字典序=时间序，倒序清理不变", () => {
    // 北京命名的连续三次自动备份（字典序即时间序）
    const files = [
        { name: "navihive-backup-auto-20261108-100000-000.json.gz" },
        { name: "navihive-backup-auto-20261108-090000-000.json.gz" },
        { name: "navihive-backup-auto-20261107-100000-000.json.gz" },
    ];
    // 保留 2 份：keep(最新) + 次新，最旧那份回删（第 3 参是 recorded，retentionCount 是第 4 参）
    assert.deepEqual(selectAutoBackupsToPrune(files, files[0].name, undefined, 2), [files[2].name]);
    // 跨日 / 跨月依旧单调：新名字字典序一定大于旧名字
    assert.ok(files[1].name > files[2].name);
    assert.ok(files[0].name > files[1].name);
    // notes 版按文件名倒序的兜底同样成立
    const notesFiles = files.map(f => ({ name: f.name.replace("navihive-backup-auto-", "navihive-notes-backup-auto-") }));
    assert.deepEqual(
        selectNotesBackupsToPrune(notesFiles, notesFiles[0].name, 1),
        [notesFiles[1].name, notesFiles[2].name]
    );
});

test("运行记录：新的在前、最多 12 条", () => {
    const run = (id: string): NotesBackupRun => ({
        id,
        startedAt: "2026-01-01T00:00:00Z",
        trigger: "auto",
        status: "success",
        noteCount: 1,
    });
    let runs: NotesBackupRun[] = [];
    for (let i = 0; i < 15; i++) runs = appendNotesBackupRun(runs, run(`r${i}`));
    assert.equal(runs.length, 12);
    assert.equal(runs[0].id, "r14"); // 最新的在最前
    assert.equal(runs[11].id, "r3");
});

// ============ 纯逻辑：配置回落（导航页保存后自动带入） ============

test("配置回落：url/账号/密码取 webdav.*，目录与口令才认 notesBackup.*", () => {
    // 只配过导航备份：记事本备份开箱即用同一套网盘 + 同一个加密口令
    const fromNavOnly = notesWebDavConfigFrom({
        "webdav.url": "https://dav.example.com/dav/",
        "webdav.username": "alice",
        "webdav.password": "app-password",
        "webdav.path": "navihive-backup",
        "webdav.backupPassword": "nav-pwd",
        "webdav.allowPrivateNetwork": "1",
    });
    assert.equal(fromNavOnly.url, "https://dav.example.com/dav/");
    assert.equal(fromNavOnly.username, "alice");
    assert.equal(fromNavOnly.password, "app-password");
    assert.equal(fromNavOnly.backupPassword, "nav-pwd"); // 口令也带入
    assert.equal(fromNavOnly.path, "navihive-notes-backup"); // 但目录是自己的默认值
    assert.ok(fromNavOnly.allowPrivateNetwork);

    // 记事本自己的差异项优先于回落
    const overridden = notesWebDavConfigFrom({
        "webdav.url": "https://dav.example.com/dav/",
        "webdav.password": "app-password",
        "notesBackup.path": "my-notes-dir",
        "notesBackup.backupPassword": "notes-pwd",
    });
    assert.equal(overridden.path, "my-notes-dir");
    assert.equal(overridden.backupPassword, "notes-pwd");

    // 啥都没配：空 url（调用方据此判「尚未配置」）
    const empty = notesWebDavConfigFrom({});
    assert.equal(empty.url, "");
    assert.equal(empty.path, "navihive-notes-backup");
});

// ============ 纯逻辑：导航自动备份的到点判定（按上次成功时间，不是墙上时钟窗口） ============
//
// 背景（2026-10-29）：这条判定原来是「UTC 周一 02:00-02:59 这一小时」的窗口，
// 错过不补跑。线上实测最后一次自动备份停在 10-19，10-26 整周没有任何产出 ——
// 而界面上「上次备份」被 10-26 的手动备份刷成了正常值，自动备份死了都看不出来。
// 所以下面这组用例全部围绕「时间差」而不是「星期几几点」。

/** 2026-10-19T02:00:00.005Z —— 线上最后一次自动备份那一刻 */
const LAST_AUTO_MS = Date.UTC(2026, 9, 19, 2, 0, 0, 5);
const LAST_AUTO_NAME = "navihive-backup-auto-20261019-020000-005.json.gz";

test("导航自动备份：满 6.5 天就跑（刚好等于阈值也算到点）", () => {
    const at = new Date(LAST_AUTO_MS).toISOString();
    assert.equal(NAV_BACKUP_INTERVAL_MS, 6.5 * DAY, "阈值改成别的值就得同步这里");
    assert.ok(
        shouldRunNavBackup(at, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS),
        "刚好满 6.5 天必须跑 —— 差一毫秒不跑还可以理解，卡在边界上不跑就是漏备份"
    );
});

test("导航自动备份：差 1 毫秒就不跑（否则每小时触发会每小时都传一份）", () => {
    const at = new Date(LAST_AUTO_MS).toISOString();
    assert.ok(!shouldRunNavBackup(at, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS - 1));
    // 常见情形：一小时前刚备份过
    assert.ok(!shouldRunNavBackup(at, LAST_AUTO_MS + HOUR));
});

test("导航自动备份：从来没备份过就跑（配了自动备份的人不该等 6.5 天）", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    assert.ok(shouldRunNavBackup(null, now));
    assert.ok(shouldRunNavBackup(undefined, now));
    assert.ok(shouldRunNavBackup("", now));
    // 带一个同样没有的旧文件名参数，行为不变
    assert.ok(shouldRunNavBackup(null, now, null));
    assert.ok(shouldRunNavBackup(null, now, ""));
});

test("存量兼容：老 UTC 文件名按新规则偏早 8 小时，但只会多备份、绝不漏备份", () => {
    // 该键是 2026-10-29 新加的，老库里没有 —— 文件名一直带着精确时间。
    // 但老文件名是 **UTC 命名**：LAST_AUTO_NAME 里的 20261019-020000-005 本意是
    // 2026-10-19T02:00:00.005Z。改成按北京时间反解（统一减 8h）后，它被读成
    // 比真实时刻早 8 小时。这是本次时区统一对存量文件唯一的影响。
    const parsed = parseAutoBackupFileTime(LAST_AUTO_NAME);
    assert.equal(parsed, LAST_AUTO_MS - 8 * HOUR, "老 UTC 文件名按新规则反解偏早 8 小时");

    // 偏早只会让「距上次备份」偏大 → 更倾向于判「到点」→ 多备份一次（安全侧）：
    //   · 刚备份完 2 小时：即便偏早 8h（累计 10h），仍远小于 6.5 天 → 跳过，不会立刻重传
    const justAfter = LAST_AUTO_MS + 2 * HOUR;
    assert.ok(!shouldRunNavBackup(null, justAfter, LAST_AUTO_NAME));
    //   · 真正到 6.5 天：照样跑，绝不会因为时区改动被卡成「还没到点」而漏备份
    assert.ok(shouldRunNavBackup(null, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS, LAST_AUTO_NAME));
    //   · 关键安全侧证明：「按真实时刻还差 1ms、按偏早时刻已到点」这个 8 小时窗口里，
    //     结果是「提前触发（多备份一次）」而不是「跳过」（漏备）。
    assert.ok(
        shouldRunNavBackup(null, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS - 1, LAST_AUTO_NAME),
        "偏早 8 小时只会提前触发，不会漏备份"
    );
});

test("调度：有 lastAutoAt（绝对时刻 ISO）时优先用它，时区改动不影响判定", () => {
    const at = new Date(LAST_AUTO_MS).toISOString();
    // 带一个旧文件名也无所谓：ISO 绝对时刻是首选，文件名回退根本不参与
    assert.ok(!shouldRunNavBackup(at, LAST_AUTO_MS + 2 * HOUR, LAST_AUTO_NAME));
    assert.ok(!shouldRunNavBackup(at, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS - 1, LAST_AUTO_NAME));
    assert.ok(shouldRunNavBackup(at, LAST_AUTO_MS + NAV_BACKUP_INTERVAL_MS, LAST_AUTO_NAME));
});

test("文件名坏掉 / 认不出：当作「从没备份过」，宁可多备一次也不能永久不备", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    for (const bad of [
        "navihive-backup-auto-2026-10-19-1.json.gz", // 分隔符不对（宽松解析会把它猜成某个时间）
        "navihive-backup-20261019-020000-005.json.gz", // 手动备份的前缀，不是自动备份
        "随便一个名字.json.gz",
        "navihive-backup-auto-.json.gz",
    ]) {
        assert.ok(shouldRunNavBackup(null, now, bad), `认不出的文件名（${bad}）该当作没备份过`);
    }
    // 时间戳是脏字符串（不是 ISO、也不是文件名）同理
    assert.ok(shouldRunNavBackup("not-a-date", now, undefined));
});

test("时间戳落在未来（改过系统时间 / 文件名被改）：不能信它，照样跑", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const future = new Date(now + 30 * DAY).toISOString();
    assert.ok(
        shouldRunNavBackup(future, now),
        "若相信未来的时间戳，「还差 N 天才到点」会永远成立 —— 备份就此静默"
    );
});

test("触发表达式不再参与到点判定：任何频率都进入检查（e2e 的通配表达式必须照跑）", () => {
    // 真正的到点判定已经搬到 shouldRunNavBackup（按上次成功时间），
    // 与触发频率无关；cron-e2e 用 "* * * * *" 触发时必须真的跑一遍备份，
    // 否则那六条断言全在测空气（2026-10-09 CI 实际发生过的红）。
    assert.ok(isNavBackupDue(undefined));
    assert.ok(isNavBackupDue("* * * * *"));
    assert.ok(isNavBackupDue("0 * * * *"));
    assert.ok(isNavBackupDue("0 2 * * 1"));
});

// ============ 真实 SQLite：导出形状与导入闭环 ============

/** 把 node:sqlite 包成 D1 形状的替身（与 noteFolderTagRealSql.test.ts 同一套） */
function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) {
                bound = args as SQLInputValue[];
                return prepared;
            },
            all<T = Record<string, unknown>>() {
                return Promise.resolve({ results: stmt.all(...bound) as T[], success: true as const });
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return Promise.resolve((row ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({ success: true as const, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } });
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        batch: async (stmts: Array<{ all: () => Promise<{ success: boolean }> }>) =>
            // 走 all() 而不是 run()：D1 的 batch 返回每条语句的结果集，
            // createNote 等调用方要读 .results（run() 只有 meta，会被判「创建失败」）
            Promise.all(stmts.map(s => s.all())),
        async exec(sql: string) {
            db.exec(sql);
        },
    };
}

function makeApi(db: ReturnType<typeof makeRealD1>): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

test("真实 SQLite：exportNotesData 形状齐全，导出 → 导入闭环能走通", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();

    // 造一点有结构的数据：文件夹 + 笔记 + 标签 + 关联
    const folder = await api.createFolder({ name: "备份夹" });
    const note = await api.createNote({
        title: "被备份的笔记",
        content: "正文，含 [[双链]]",
        folder_id: folder.id,
    });
    const tag = await api.createTag({ name: "备份标签" });
    await api.setNoteTags(note.id!, [tag.id!]);

    // 导出：形状与 importNotesData 的入参一致（kind / notes / folders / tags / noteTags）
    const exported = await api.exportNotesData();
    assert.equal(exported.kind, "navihive-notes-backup");
    assert.ok(exported.exportedAt);
    assert.ok(Array.isArray(exported.notes) && exported.notes.length === 1);
    assert.ok(Array.isArray(exported.folders) && exported.folders.length === 1);
    assert.ok(Array.isArray(exported.tags) && exported.tags.length === 1);
    const noteTags = exported.noteTags ?? {};
    assert.deepEqual(noteTags[String(note.id)], [tag.id]);
    // 导出的笔记带全文（备份的意义就在这里）
    assert.equal(exported.notes[0].content, "正文，含 [[双链]]");

    // 闭环：把这份导出原样喂回 importNotesData —— 每条都是同 uuid 同更新时间，
    // 应该全部「保留本地」，不产生重复、也不覆盖
    const stats = await api.importNotesData(exported);
    assert.equal(stats.created, 0);
    assert.equal(stats.updated, 0);
    assert.equal(stats.skipped, 1);
    const notesAfter = await api.listNotes();
    assert.equal(notesAfter.length, 1, "闭环导入不该产生重复笔记");
    assert.equal(notesAfter[0].content, "正文，含 [[双链]]");

    // 账号隔离：别人的库里没有这些数据
    api.setCurrentUser(4242);
    const other = await api.exportNotesData();
    assert.equal(other.notes?.length ?? 0, 0);
    assert.equal(other.folders?.length ?? 0, 0);
    api.setCurrentUser(null);
});

test("真实 SQLite：卡片绑定的笔记，指纹随备份导出、跨库按 URL 重连", async () => {
    resetMigrationCacheForTests();
    const dbA = makeRealD1();
    const apiA = makeApi(dbA);
    await apiA.migrate();
    const groupA = await apiA.createGroup({ name: "组", order_num: 0 } as never);
    const siteA = await apiA.createSite({
        group_id: groupA.id,
        name: "示例站",
        url: "https://example.com/a",
        icon: "",
        description: "",
        order_num: 0,
    } as never);
    await apiA.createNote({ title: "绑卡片的笔记", content: "正文", site_id: siteA.id });
    await apiA.createNote({ title: "没绑定的笔记", content: "正文2" });

    const exported = await apiA.exportNotesData();
    assert.deepEqual(
        (exported.boundSites ?? []).map(s => [s.id, s.name, s.url]),
        [[siteA.id, "示例站", "https://example.com/a"]],
        "只带被笔记引用的站点指纹"
    );

    // 模拟另一台服务器：全新库，先建一个别的站点占住 id 1 —— A 里的绑定 id 也是 1，
    // 老行为「原样插 site_id」在这里会错绑到「占位站」头上
    const dbB = makeRealD1();
    const apiB = makeApi(dbB);
    // 迁移缓存是模块级的：换新库必须重置，否则 dbB 会跳过迁移（no such table）
    resetMigrationCacheForTests();
    await apiB.migrate();
    const groupB = await apiB.createGroup({ name: "组", order_num: 0 } as never);
    await apiB.createSite({ group_id: groupB.id, name: "占位站", url: "https://b.example.com", icon: "", description: "", order_num: 0 } as never);
    const siteB = await apiB.createSite({
        group_id: groupB.id,
        name: "改了名的示例站", // 名字都变了 —— 只能靠 URL 指纹对上
        icon: "",
        description: "",
        url: "https://example.com/a",
        order_num: 0,
    } as never);

    const stats = await apiB.importNotesData(exported);
    assert.equal(stats.created, 2);
    const notesB = await apiB.listNotes();
    const bound = notesB.find(n => n.title === "绑卡片的笔记")!;
    assert.equal(
        bound.site_id,
        siteB.id,
        "按 URL 指纹重连到 B 库的新 id"
    );
    assert.notEqual(bound.site_id, siteA.id, "不能照抄 A 的旧 id（那会错绑到「占位站」）");
    const unbound = notesB.find(n => n.title === "没绑定的笔记")!;
    assert.equal(unbound.site_id ?? null, null, "没绑定的笔记导入后也不该凭空出现绑定");
});

test("真实 SQLite：有 boundSites 但解析失败仍置空（兜底不介入）；无 boundSites 时同库空闲 id 才重绑", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    const group = await api.createGroup({ name: "组", order_num: 0 } as never);
    const site = await api.createSite({ group_id: group.id, name: "本地站", url: "https://local.example.com", icon: "", description: "", order_num: 0 } as never);

    // 关键回归：note 的 site_id 指向一个**当前库里存在且空闲**的站点，
    // 但 boundSites 的 URL / 名称都解析不到它。有指纹时兜底绝不许介入 ——
    // 否则会把旧 id 当成「同库有效」留下来，等于错绑到这张无关的卡上。
    // 断言 t1 仍为 null，才证明「有 boundSites 时完全走原逻辑」这条约束没被破坏。
    const newer = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [
            { uuid: "u1", title: "t1", content: "c1", site_id: site.id! } as never,
            { uuid: "u2", title: "t2", content: "c2", site_id: null } as never,
        ],
        boundSites: [{ id: site.id!, name: "不存在的名字", url: "https://ghost.example.com" }],
    });
    assert.equal(newer.created, 2);
    let notes = await api.listNotes();
    assert.equal(notes.find(n => n.title === "t1")!.site_id ?? null, null, "有指纹但解析失败 → 置空，兜底没介入");
    assert.equal(notes.find(n => n.title === "t2")!.site_id ?? null, null);

    // 老备份 / 前端手动导出：没有 boundSites 字段。同一个库里删掉绑定笔记再导入，
    // 站点没动过、这个 id 也还没被别的笔记占用 → 按新规则保留，绑定自动恢复
    //（旧行为无条件置空，正是需求 4 要修的「站点显示绑定笔记已删除」）。
    const older = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [{ uuid: "u3", title: "t3", content: "c3", site_id: site.id! } as never],
    });
    assert.equal(older.created, 1);
    notes = await api.listNotes();
    assert.equal(notes.find(n => n.title === "t3")!.site_id, site.id, "同库有效且空闲的 site_id → 保留（重绑成功）");
});

test("真实 SQLite：无 boundSites 兜底 —— 站点不存在 / 已被别的笔记占用一律置 null", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    const group = await api.createGroup({ name: "组", order_num: 0 } as never);
    const site = await api.createSite({ group_id: group.id, name: "站", url: "https://x.example.com", icon: "", description: "", order_num: 0 } as never);

    // 同一次导入：空闲有效 id 保留；库里根本不存在的 id 置 null
    const first = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [
            { uuid: "b1", title: "占位的笔记", content: "c", site_id: site.id! } as never,
            { uuid: "b2", title: "指向不存在站点", content: "c", site_id: 99999 } as never,
        ],
    });
    assert.equal(first.created, 2);
    let notes = await api.listNotes();
    assert.equal(notes.find(n => n.title === "占位的笔记")!.site_id, site.id, "有效且空闲 → 保留");
    assert.equal(notes.find(n => n.title === "指向不存在站点")!.site_id ?? null, null, "sites 表里没有这个 id → 置 null");

    // 再导入一条指向同一站点：此时它已被 b1 占用 → 置 null，且 b1 不受影响
    const second = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [{ uuid: "b3", title: "后来的笔记", content: "c", site_id: site.id! } as never],
    });
    assert.equal(second.created, 1);
    notes = await api.listNotes();
    assert.equal(notes.find(n => n.title === "后来的笔记")!.site_id ?? null, null, "已被别的笔记占用 → 置 null（避免双绑）");
    assert.equal(notes.find(n => n.title === "占位的笔记")!.site_id, site.id, "占用者不受影响");
});

test("真实 SQLite：有 boundSites 且 URL 唯一命中到重排后的新 id → 重连成功（原行为不回归）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    const group = await api.createGroup({ name: "组", order_num: 0 } as never);
    // 旧 id 现在是一张无关的卡；URL 唯一命中的是后面新建、id 已重排的目标站
    const oldSite = await api.createSite({ group_id: group.id, name: "占位站", url: "https://other.example.com", icon: "", description: "", order_num: 0 } as never);
    const target = await api.createSite({ group_id: group.id, name: "改了名的站", url: "https://target.example.com", icon: "", description: "", order_num: 0 } as never);

    const stats = await api.importNotesData({
        kind: "navihive-notes-backup",
        notes: [{ uuid: "e1", title: "按 URL 重连", content: "c", site_id: oldSite.id! } as never],
        boundSites: [{ id: oldSite.id!, name: "不存在的名字", url: "https://target.example.com" }],
    });
    assert.equal(stats.created, 1);
    const notes = await api.listNotes();
    // 既不是照抄旧 id，也不是兜底把它留下，而是按 URL 重连到唯一命中的新 id
    assert.equal(notes[0].site_id, target.id, "按 URL 唯一命中重连到重排后的新 id");
    assert.notEqual(notes[0].site_id, oldSite.id, "不能照抄旧 id / 被兜底救回来");
});

test("真实 SQLite：一站一篇 —— 同批抢同一站点先到先得，本地占位被解绑", async () => {
    resetMigrationCacheForTests();
    const dbA = makeRealD1();
    const apiA = makeApi(dbA);
    await apiA.migrate();
    const groupA = await apiA.createGroup({ name: "组", order_num: 0 } as never);
    const siteA = await apiA.createSite({ group_id: groupA.id, name: "站", url: "https://x.example.com", icon: "", description: "", order_num: 0 } as never);
    await apiA.createNote({ title: "a", content: "a" });
    await apiA.createNote({ title: "b", content: "b" });
    // 手工把两条都指向同一站点，模拟「导出方违反约束的脏数据」
    const exported = await apiA.exportNotesData();
    const payload = {
        ...exported,
        notes: exported.notes!.map(n => ({ ...n, site_id: siteA.id })),
        // 手工补指纹（导出时库里还没有绑定，boundSites 是空的）：模拟「导出方带指纹的脏数据」
        boundSites: [{ id: siteA.id!, name: "站", url: "https://x.example.com" }],
    };

    const dbB = makeRealD1();
    const apiB = makeApi(dbB);
    // 迁移缓存是模块级的：换新库必须重置，否则 dbB 会跳过迁移（no such table）
    resetMigrationCacheForTests();
    await apiB.migrate();
    const groupB = await apiB.createGroup({ name: "组", order_num: 0 } as never);
    const siteB = await apiB.createSite({ group_id: groupB.id, name: "站", url: "https://x.example.com", icon: "", description: "", order_num: 0 } as never);
    // 本地已有一篇绑定同站点的笔记（不在备份里）：导入后应被解绑
    await apiB.createNote({ title: "本地占位", content: "x", site_id: siteB.id });

    const stats = await apiB.importNotesData(payload);
    assert.equal(stats.created, 2);
    const notesB = await apiB.listNotes();
    const bound = notesB.filter(n => n.site_id === siteB.id);
    assert.equal(bound.length, 1, "一站一篇：全库只允许一条绑定");
    assert.equal(bound[0].title, "a", "先到先得（按备份文件顺序）");
    assert.ok(!notesB.some(n => n.title === "本地占位" && n.site_id === siteB.id), "本地占位被解绑");
});

test("真实 SQLite：运行记录经 configs 读写（含坏 JSON 容错）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();

    // 没有记录 → 空列表（不抛错）
    assert.deepEqual(await readNotesBackupRuns(api), []);

    const run: NotesBackupRun = {
        id: "r1",
        startedAt: "2026-01-09T03:00:00.000Z",
        trigger: "auto",
        status: "success",
        filename: "navihive-notes-backup-auto-20260109-030000-000.json.gz",
        noteCount: 3,
        bytes: 1234,
        durationMs: 800,
    };
    // 经真实 setConfig/getConfig（notesBackup.* 已归入按账号私有配置）
    await api.setConfig(NOTES_BACKUP_RUNS_KEY, JSON.stringify(appendNotesBackupRun([], run)));
    const loaded = await readNotesBackupRuns(api);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "r1");
    assert.equal(loaded[0].status, "success");

    // 落在 user_configs 表里（按账号隔离），不是全局 configs
    api.setCurrentUser(7);
    assert.deepEqual(await readNotesBackupRuns(api), [], "别的账号不该看到这条记录");
    api.setCurrentUser(null);

    // 库里的 JSON 坏了 → 空列表，绝不抛错把备份页/调度带崩
    await api.setConfig(NOTES_BACKUP_RUNS_KEY, "{oops");
    assert.deepEqual(await readNotesBackupRuns(api), []);
});

// ============ 真实 SQLite：D1 参数上限（附件元数据查询必须切批） ============
//
// 背景（2026-11-02）：readBackupAttachmentEntries 原来把「正文里引用到的全部附件 id」
// 一次塞进 `IN (...)`。D1 单条语句最多 100 个绑定参数，引用超过 99 个附件时线上必抛
// "too many SQL variables"，整次备份静默失败；而本机 SQLite 的上限是 32766，
// **这个缺陷在本机永远测不出来** —— 所以这里不靠「跑通了」，靠数每批绑了几个参数。

/** 只实现 readAttachmentObject 用到的 KV 面（与 notesBackupZip.test.ts 同一套） */
function makeFakeKvEnv(ids: ReadonlyArray<string>) {
    const objects = new Map<string, ArrayBuffer>();
    for (const id of ids) objects.set(`attach/1/${id}`, new Uint8Array([1, 2, 3, 4]).buffer);
    const env = {
        FILES_KV: {
            async get(key: string) {
                return objects.get(key) ?? null;
            },
        },
    };
    return env as unknown as Parameters<typeof readBackupAttachmentEntries>[1];
}

/**
 * 在真实 SQLite 替身上加一层「参数计数」：只统计附件元数据查询
 * （`FROM attachments` + `IN (...)`），迁移 / 种数据的 SQL 不参与上限断言。
 */
function makeCountingD1(inner: ReturnType<typeof makeRealD1>) {
    /** 每次附件查询绑定的参数个数，按执行顺序 */
    const boundCounts: number[] = [];
    const db = {
        prepare(sql: string) {
            const prepared = inner.prepare(sql);
            if (!/FROM\s+attachments/i.test(sql) || !/\bIN\s*\(/i.test(sql)) return prepared;
            return {
                bind(...args: unknown[]) {
                    boundCounts.push(args.length);
                    return prepared.bind(...args);
                },
            };
        },
        batch: inner.batch,
        exec: inner.exec,
    };
    return { db, boundCounts };
}

async function seedAttachments(api: NavigationAPI, ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) {
        await api.createAttachment({
            id,
            note_id: null,
            filename: `${id}.png`,
            mime: "image/png",
            size: 4,
            storage: "kv",
            object_key: `attach/1/${id}`,
        });
    }
}

test("真实 SQLite：正文引用 200 个附件时按 D1 上限切批，每批绑定参数 ≤ 100", async () => {
    resetMigrationCacheForTests();
    const { db, boundCounts } = makeCountingD1(makeRealD1());
    const api = makeApi(db as unknown as ReturnType<typeof makeRealD1>);
    await api.migrate();
    api.setCurrentUser(1);

    const ids = Array.from({ length: 200 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`);
    await seedAttachments(api, ids);

    const payload = {
        notes: [{ content: ids.map(id => `![x](/api/notes/attachments/${id})`).join(" ") }],
    };
    const { entries, skipped } = await readBackupAttachmentEntries(api, makeFakeKvEnv(ids), payload);

    // 切批不能丢批：合并后 200 个附件一个不少
    assert.equal(entries.length, 200, "切批后合并的结果必须覆盖全部引用到的附件");
    assert.equal(skipped, 0);

    // 回归抓手：若实现退回「一条 SQL 拼 200 个占位符」，boundCounts 就是 [200]，
    // 下面三条同时失败（本机 SQLite 会照跑成功，只有这里能拦住）
    assert.ok(
        boundCounts.length >= 3,
        `200 个 id + 每批 1 个 user_id 至少要切 3 批，实际 ${boundCounts.length} 条`
    );
    assert.ok(
        boundCounts.every(n => n <= 100),
        `每批绑定参数必须 ≤ 100（D1 上限），实际 ${JSON.stringify(boundCounts)}`
    );
    // 99 个 id + 1 个 user_id 正好用满预算，不该退化成更小的批
    assert.equal(Math.max(...boundCounts), 100);
    // 每批都带 user_id：总参数数 = 200 个 id + 批数 × 1
    assert.equal(
        boundCounts.reduce((a, b) => a + b, 0),
        200 + boundCounts.length,
        "每批都要带 user_id 条件（账号隔离不能在切批时丢掉）"
    );
});

test("真实 SQLite：99 个 id 一条查完、100 个 id 必须切两条（user_id 占掉 1 个参数位）", async () => {
    const measure = async (count: number) => {
        resetMigrationCacheForTests();
        const { db, boundCounts } = makeCountingD1(makeRealD1());
        const api = makeApi(db as unknown as ReturnType<typeof makeRealD1>);
        await api.migrate();
        api.setCurrentUser(1);

        const ids = Array.from({ length: count }, (_, i) => `edge-${count}-${String(i).padStart(3, "0")}`);
        await seedAttachments(api, ids);
        const payload = {
            notes: [{ content: ids.map(id => `![x](/api/notes/attachments/${id})`).join(" ") }],
        };
        const result = await readBackupAttachmentEntries(api, makeFakeKvEnv(ids), payload);
        return { entries: result.entries, boundCounts };
    };

    // 边界：99 个 id + 1 个 user_id = 100，正好卡在上限上 —— 多预留就会白切一批，
    // 少预留就会在 100 个 id 时越界，所以这条必须钉死
    const edge99 = await measure(99);
    assert.deepEqual(edge99.boundCounts, [100], "99 个 id 刚好一条查完（不切批）");
    assert.equal(edge99.entries.length, 99);

    const edge100 = await measure(100);
    assert.deepEqual(
        edge100.boundCounts,
        [100, 2],
        "100 个 id 必须切两条：99 + user_id，剩 1 个 + user_id（每条都带账号条件）"
    );
    assert.equal(edge100.entries.length, 100);
});
