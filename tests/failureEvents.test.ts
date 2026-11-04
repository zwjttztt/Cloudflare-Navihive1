// tests/failureEvents.test.ts
//
// 「静默失败」结构化事件（2026-11 审查报告）的钉子。它守的是**三件会静默出错的事**：
//
//   1. `notes.import.partial` 该发的时候**真的发**、字段与返回给调用方的 stats 逐字一致
//      （否则运维拿到的数是假的，比没有更糟）；
//   2. 正常成功路径**零事件** —— 这条最重要。多发一条，告警就会被噪音淹掉，
//      噪音型告警的结局一定是被人静音，等于没做；
//   3. `migration.failed` 与 `upgrade.rollback.failed` 的相位 / 级别如实反映严重度
//      （回滚成功 warn、回滚失败 error —— 前者站点还活着，后者大概率已经不可用）。
//
// 日志捕获方式：logger 最终落到 `console[level](message, fields)`（见 shared/logger.ts），
// 所以在用例内临时替换全局 console.warn / error 就能拿到**真实的调用点**（不是断言
// 「函数被调过」），跑完立刻还原。没有改产品代码的 API、没有给 logger 加测试专用出口。
//
// 失败注入也都是真实路径：
//   · 导入：沿用 tests/noteImportRecoveryRealSql.test.ts 那套「让第 2 个提交批抛错」
//     （真 SQLite，batch 是真事务）；
//   · 迁移：给一个「每条语句都抛」的库（磁盘挂了 / 权限错了的那种形态），
//     runMigrations 会逐步骤失败并抛出 MigrationIncompleteError。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeRealApi, makeRealD1, type RealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import type { NotesImportPayload, NoteImportStats } from "../src/API/types";
import { MIGRATION_STEPS } from "../src/API/methods/migration";
import { FAILURE_EVENTS, notesImportPartialEvent } from "../shared/failureEvents";
import { rollbackTerminalEvent } from "../server/upgradeHealth";

// ─────────────────────────── 日志捕获 ───────────────────────────

interface Emission {
    level: "warn" | "error";
    message: string;
    fields: Record<string, unknown>;
}

/** 在 fn 执行期间截获 logger 的全部输出（只截 warn / error：debug·info 在生产构建里会被丢掉） */
async function captureLogs(fn: () => Promise<void> | void): Promise<Emission[]> {
    const emissions: Emission[] = [];
    const original = { warn: console.warn, error: console.error };
    const record = (level: "warn" | "error") => (...args: unknown[]): void => {
        const fields: unknown = args[1];
        emissions.push({
            level,
            message: typeof args[0] === "string" ? args[0] : String(args[0]),
            fields: fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {},
        });
    };
    console.warn = record("warn");
    console.error = record("error");
    try {
        await fn();
    } finally {
        console.warn = original.warn;
        console.error = original.error;
    }
    return emissions;
}

/** 只挑出「带事件名」的那些行：非事件的自由文本日志（迁移逐步骤失败等）不算 */
function eventsIn(emissions: Emission[]): Emission[] {
    return emissions.filter(e => typeof e.fields.event === "string");
}

function eventsNamed(emissions: Emission[], name: string): Emission[] {
    return emissions.filter(e => e.fields.event === name);
}

// ─────────────────────────── 导入的失败注入 ───────────────────────────

/** 过去时间：保证「已导入的笔记」重导时判 skipped（本地 updated_at 是导入时的 now） */
const PAST_AT = "2020-01-01T00:00:00.000Z";
/** 80 条笔记 + 每条 2 个标签：即使 FTS 不可用也必然切成 ≥2 个提交批（切片 250 语句） */
const NOTE_COUNT = 80;

/** 与 tests/noteImportRecoveryRealSql.test.ts 同款 payload（文件夹 / 标签 / noteTags 全带） */
function makePayload(count: number): NotesImportPayload {
    const notes = Array.from({ length: count }, (_, i) => ({
        id: 1000 + i,
        uuid: `ev-${i}`,
        title: `ev标题${i}`,
        content: `ev正文${i}`,
        updated_at: PAST_AT,
        folder_id: 1,
    }));
    return {
        kind: "navihive-notes-backup",
        folders: [{ id: 1, name: "事件夹", parent_id: null, order_num: 0 }],
        tags: [{ id: 1, name: "事件标签甲" }, { id: 2, name: "事件标签乙" }],
        noteTags: Object.fromEntries(notes.map(n => [String(n.id), [1, 2]])),
        notes,
    };
}

/** 干净的库 + 已跑完迁移的 api（单账号部署：currentUserId 为 null） */
async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(null);
    return { db, api };
}

/**
 * 在 db.batch 外套一层可切换的钩子，用来在**提交阶段**制造故障。
 * arm 之前调用的 batch（迁移那条）不受影响：迁移缓存命中后 importNotesData 里那次
 * `await this.migrate()` 不会再调 batch。
 */
function installBatchHook(db: RealD1): { arm: () => void; disarm: () => void; calls: () => number; failOn: (call: number) => void } {
    type BatchFn = RealD1["batch"];
    const original = db.batch.bind(db) as BatchFn;
    let armed = false;
    let calls = 0;
    let failAt = 0;
    db.batch = (async (stmts: Parameters<BatchFn>[0]) => {
        if (armed) {
            calls += 1;
            if (calls === failAt) throw new Error(`注入：第 ${calls} 个提交批失败`);
        }
        return original(stmts as never);
    }) as BatchFn;
    return {
        arm: () => { armed = true; calls = 0; },
        disarm: () => { armed = false; },
        calls: () => calls,
        failOn: (call: number) => { failAt = call; },
    };
}

/** 「每条语句都抛」的库：磁盘挂了 / 权限错了 / 句柄失效时就是这个形态 */
function brokenDb(): RealD1 {
    const fail = (): never => { throw new Error("注入：数据库不可用（每条语句都抛）"); };
    return {
        prepare: fail,
        batch: () => Promise.reject(new Error("注入：数据库不可用（batch 抛）")),
        exec: () => Promise.reject(new Error("注入：数据库不可用（exec 抛）")),
    } as unknown as RealD1;
}

// ─────────────────── 1. 导入中途失败 → 恰好一条 partial ───────────────────

test("导入第 2 批失败：恰好一条 notes.import.partial，字段与 stats 逐字一致", async () => {
    const { db, api } = await fresh();
    const hook = installBatchHook(db);
    hook.failOn(2);
    hook.arm();
    let stats: NoteImportStats | undefined;
    const emissions = await captureLogs(async () => {
        stats = await api.importNotesData(makePayload(NOTE_COUNT));
    });
    hook.disarm();

    const partial = stats!;
    assert.equal(partial.partial, true, "前半段前提：这次导入确实断了（否则本用例没在测任何东西）");
    assert.ok(hook.calls() >= 2, "确实切成了至少两个提交批，注入点存在");
    assert.equal(eventsNamed(emissions, FAILURE_EVENTS.NOTES_IMPORT_PARTIAL).length, 1, "恰好一条");

    const event = eventsNamed(emissions, FAILURE_EVENTS.NOTES_IMPORT_PARTIAL)[0];
    assert.equal(event.level, "error", "数据不完整的恢复是 error 档，不能埋进 warn 里");
    // 字段必须与**返回给调用方的那份 stats** 完全一致：运维按日志判断「进来多少条」，
    // 对不上账的话日志比没有更糟。
    assert.equal(event.fields.created, partial.created);
    assert.equal(event.fields.updated, partial.updated);
    assert.equal(event.fields.skipped, partial.skipped);
    assert.equal(event.fields.removed, partial.removed);
    assert.equal(event.fields.conflicts, partial.conflicts ?? 0);
    assert.equal(event.fields.partial, true);
    assert.equal(event.fields.component, "notesBackup");
    assert.equal(event.fields.failedBatch, 2, "卡在第 2 批");
    assert.ok(typeof event.fields.batchCount === "number" && (event.fields.batchCount as number) >= 2);
    assert.equal(typeof event.fields.warning, "string");
    assert.ok((event.fields.warning as string).includes("续传"), "warning 必须仍是「重导可续传」那句");
    assert.ok(event.fields.err instanceof Error, "原始异常保留引用（排障要靠 cause，不能压成字符串）");
    assert.equal("userId" in event.fields, false, "单账号部署不该凭空造一个 userId");

    // 这次没有 CAS 冲突（新库、无并发），所以不该有冲突事件 —— 两个事件名互不越界
    assert.equal(eventsNamed(emissions, FAILURE_EVENTS.NOTES_IMPORT_CONFLICTS).length, 0);
    // 只有这一条事件：失败路径上不许顺手多发别的结构化事件
    assert.equal(eventsIn(emissions).length, 1);
});

test("`userId` 有就带：纯函数层面钉住（多账号部署要能定位「是谁的导入」）", () => {
    const event = notesImportPartialEvent(
        { created: 3, updated: 1, skipped: 2, removed: 0, conflicts: 4, warning: "w", partial: true },
        { failedBatch: 2, batchCount: 5, userId: 7 }
    );
    assert.equal(event.fields.userId, 7);
    assert.equal(event.fields.conflicts, 4, "conflicts 与 partial 可以同时非零（前面的批冲突、后面的批失败）");
    assert.equal(event.fields.component, "notesBackup");
    assert.equal(event.fields.event, FAILURE_EVENTS.NOTES_IMPORT_PARTIAL);
});

// ─────────────── 2. 正常路径零事件（最重要的一条：防噪音） ───────────────

test("完好导入：零条结构化事件（成功路径一条都不发）", async () => {
    const { api } = await fresh();
    let stats: NoteImportStats | undefined;
    const emissions = await captureLogs(async () => {
        stats = await api.importNotesData(makePayload(5));
    });
    assert.equal(stats!.created, 5, "前半段前提：这次导入是成功的");
    assert.equal(stats!.partial, undefined);
    assert.equal(stats!.conflicts, undefined);
    assert.deepEqual(
        eventsIn(emissions).map(e => e.fields.event),
        [],
        "成功路径不许发任何结构化事件 —— 发了就会把真事故淹掉"
    );
});

test("正常迁移：零条结构化事件", async () => {
    resetMigrationCacheForTests();
    const api = makeRealApi(makeRealD1());
    const emissions = await captureLogs(async () => {
        await api.migrate();
    });
    assert.deepEqual(eventsIn(emissions).map(e => e.fields.event), [], "正常迁移一条事件都不该有");
});

// ─────────────────── 3. 迁移失败 → 一条 migration.failed ───────────────────

test("迁移失败：一条 migration.failed，phase = 第一个失败步骤，带 err 与 version", async () => {
    resetMigrationCacheForTests();
    const api = makeRealApi(brokenDb());
    const emissions = await captureLogs(async () => {
        await api.migrate();
    });

    const failed = eventsNamed(emissions, FAILURE_EVENTS.MIGRATION_FAILED);
    assert.equal(failed.length, 1, `恰好一条（实际 ${failed.length}）`);
    const event = failed[0];
    assert.equal(event.level, "error");
    assert.equal(event.fields.component, "migration");
    // phase 必须是**第一个**上报失败的步骤 id：低基数才好按它分组 / 计数。
    // 「库整个打不开」会让一串步骤失败，拼成串等于没有维度。
    //
    // ⚠️ 不断言具体是哪个步骤：`core-tables` 那一步**故意**吞掉异常（batch 失败就退回
    // 逐条 exec、逐条也失败就忽略），所以它永远不上报；真正的第一个上报者是后面某个
    // 不吞异常的步骤。这里钉的是「phase 指向一个真实步骤」，不是步骤表的排列。
    const stepIds: string[] = MIGRATION_STEPS.map(step => step.id);
    assert.ok(stepIds.includes(event.fields.phase as string), `phase 必须是真实步骤 id，实际 ${String(event.fields.phase)}`);
    assert.notEqual(event.fields.phase, "unknown", "有步骤清单时不许退化成 unknown");
    const steps: string[] = String(event.fields.steps).split(",");
    assert.equal(steps[0], event.fields.phase, "phase 就是清单里的第一个");
    assert.equal(event.fields.failedSteps, steps.length);
    assert.equal(typeof event.fields.version, "string");
    assert.equal(event.fields.err instanceof Error, true);
    assert.equal((event.fields.err as Error).name, "MigrationIncompleteError");

    // 逐步骤的那些自由文本 error 不该被当成事件（否则一次故障刷出二十几条「事件」）
    const stepLogs = eventsIn(emissions).filter(e => e.fields.event !== FAILURE_EVENTS.MIGRATION_FAILED);
    assert.deepEqual(stepLogs, [], "迁移失败只发一条聚合事件");
});

// ─────────────── 4. 升级回滚：两个相位各自的级别 ───────────────

test("回滚失败 → error；回滚成功 → warn（站点还活着，但必须有人知道）", () => {
    const failedEvent = rollbackTerminalEvent("rollback_failed", {
        reason: "回滚退出码 1，最后状态 starting",
        toVersion: "ghcr.io/x/navihive:v25.0.0",
    });
    assert.equal(failedEvent.level, "error");
    assert.equal(failedEvent.fields.event, FAILURE_EVENTS.UPGRADE_ROLLBACK);
    assert.equal(failedEvent.fields.component, "upgrade");
    assert.equal(failedEvent.fields.phase, "rollback_failed");
    assert.equal(failedEvent.fields.reason, "回滚退出码 1，最后状态 starting");
    assert.equal(failedEvent.fields.toVersion, "ghcr.io/x/navihive:v25.0.0");

    const okEvent = rollbackTerminalEvent("rolled_back");
    assert.equal(okEvent.level, "warn", "回滚成功不叫醒人，但绝不能静默 —— 「今晚自动回滚三次」是有意义的信号");
    assert.equal(okEvent.fields.phase, "rolled_back");
    assert.equal(typeof okEvent.fields.reason, "string");
    assert.ok((okEvent.fields.reason as string).length > 0, "reason 不许为空：空字段等于没写");
    assert.equal("toVersion" in okEvent.fields, false, "拿不到版本就不带这个字段，别编空串");

    // 两个相位的 message 必须不同：靠 message 分组的人一眼能分清「回滚成功」和「回滚失败」
    assert.notEqual(failedEvent.message, okEvent.message);
});

test("entry.ts 的两个触发点与「事件名只在一处定义」", () => {
    const root: string = process.cwd();
    const entryTs: string = readFileSync(resolve(root, "server/entry.ts"), "utf8");

    // entry.ts 一 import 就起服务，单测引不进来 —— 用与 tests/systemUpgradeGuard.test.ts
    // 同一套「读源码断言锚点」的办法钉住接线。
    assert.ok(entryTs.includes("reportRollbackOnce(state);"), "spool 模式：GET /api/system/upgrade 里要观察回滚终态");
    assert.ok(entryTs.includes("rollbackTerminalEvent(rollbackPhase"), "sock 模式：失败分支要发同款事件");
    assert.ok(entryTs.includes("if (rollbackPhase) {"), "只有真的走过回滚才发，普通 failed 不发");

    // 事件名是常量：除了 shared/failureEvents.ts，任何文件都不许再写一遍字面量。
    // （文案可以改，事件名不能散 —— 散出去的那一刻，改一个漏一个就是必然。）
    // 扫之前先剥掉注释：注释里**提到**事件名是好事（读者要知道这条日志长什么样），
    // 和「在代码里再定义一个名字」完全是两件事（剥法同 tests/q3StrictIsolation.test.ts）。
    const stripComments = (text: string): string =>
        text
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("\n")
            .filter(line => !line.trim().startsWith("//"))
            .join("\n");
    const offenders: string[] = [];
    for (const rel of [
        "server/entry.ts",
        "server/upgradeHealth.ts",
        "src/API/methods/migration.ts",
        "src/API/methods/notes/notesBackup.ts",
    ]) {
        const code: string = stripComments(readFileSync(resolve(root, rel), "utf8"));
        for (const name of Object.values(FAILURE_EVENTS)) {
            if (code.includes(name)) offenders.push(`${rel} 直接写了 "${name}"`);
        }
    }
    assert.deepEqual(offenders, [], "事件名只能在 shared/failureEvents.ts 的 FAILURE_EVENTS 里出现一次");
});
