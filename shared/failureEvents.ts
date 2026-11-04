// shared/failureEvents.ts
// 「静默失败」的结构化事件目录：**事件名常量 + 字段 + 级别**，一处定义、多处引用。
//
// 为什么需要这个文件（2026-11 审查报告：这三类失败「出问题时不会有任何人发现」）：
//   ① 导入 / 恢复只完成了一部分（`NoteImportStats.partial` / `.conflicts`）；
//   ② 数据库迁移失败（有失败步骤时 migrate() 只留一句自由文本）；
//   ③ 升级回滚失败 / 回滚成功（`rolled_back` / `rollback_failed` 两个终态）。
// 共同点：用户侧只是一句提示（甚至没有），运维侧**一条可用于告警的记录都没有**。
// 之前那几行 `logger.error("...自由文本...", { err })` 的问题不是「没打日志」，而是
// 「不能用来告警」—— 文案一改，按字符串匹配的检索与规则就全断了，且拿不到数值字段。
//
// 设计约束（改这个文件前先读）：
//   · **只在失败 / 降级路径触发**。正常成功路径一条都不发 —— 否则告警会被噪音淹掉，
//     而噪音型告警的结局一定是被人静音，等于没做。
//   · **message 恒定、数字进字段**。message 是给人读的一句话，不带任何变量（不进
//     数字、不进 id），这样同一事件的所有日志行的 message 完全一致，可以按 message
//     分组；「这次导入了多少条」「卡在第几批」这类变量全在 fields 里，告警规则也只能
//     依赖 fields —— 否则它就是一条会随数据量抖动的规则。
//   · **事件名带统一的域前缀**（`notes.` / `migration.` / `upgrade.`），见 FAILURE_EVENTS。
//
// ⚠️ 为什么这里是**叶子模块**（零 import，连 `import type` 都没有）：
//   shared/ 是 Q-3 严格层（tsconfig.shared.json 开了 noUncheckedIndexedAccess），
//   而「按构造即干净」的前提是 shared 内部**零相对 import**（否则严格层的检查闭包会
//   顺着相对路径漏到 src，报错数瞬间涨一片）—— 这条由 tests/q3StrictIsolation.test.ts
//   守着。所以这里不 import logger / 不 import src 的类型，只产出
//   「该用哪个级别、该说什么、带哪些字段」，由**调用点**交给 shared/logger 落下去：
//
//     const event = notesImportPartialEvent(stats, { failedBatch, batchCount, userId });
//     logger[event.level](event.message, event.fields);
//
//   代价是下面的 `NotesImportStatsSnapshot` 与 src/API/types.ts 的 NoteImportStats
//   结构对齐却各自声明 —— 但它是**结构性参数**（调用点传 NoteImportStats 进来天然可赋），
//   tests/failureEvents.test.ts 又逐字段比对过事件与 stats，漂了会红。

/**
 * 全部稳定事件名。**只在这里定义**，别在调用点各写一遍字符串。
 *
 * 命名约定：`<域>.<对象>.<结果>`，全小写、点分隔。事件名一旦上线就是对外契约
 * （运维手册、告警规则、检索脚本都引用它），改名的代价与改 API 路径同级。
 */
export const FAILURE_EVENTS = {
    /** 导入/恢复有提交批失败：已提交的批保留，其余未写入（可重导续传） */
    NOTES_IMPORT_PARTIAL: "notes.import.partial",
    /** 导入/恢复有 CAS 冲突：那几条被其它设备改过，本次不覆盖、保留本地较新内容 */
    NOTES_IMPORT_CONFLICTS: "notes.import.conflicts",
    /** 数据库迁移没有全部完成（有步骤失败，或迁移链路本身抛错） */
    MIGRATION_FAILED: "migration.failed",
    /**
     * 升级走了回滚。**一个名字两个相位**（`phase` 字段区分）：
     * rollback_failed = 回滚也失败了，站点大概率不可用 → error，必须人工介入；
     * rolled_back     = 回滚成功、站点恢复在旧版本上 → warn，要人知道但不必半夜叫醒。
     */
    UPGRADE_ROLLBACK: "upgrade.rollback.failed",
} as const;

export type FailureEventName = (typeof FAILURE_EVENTS)[keyof typeof FAILURE_EVENTS];

/** 只允许 warn / error：debug·info 在 production 构建里被 logger 丢掉，发告警等于没发 */
export type FailureLevel = "warn" | "error";

/**
 * 一条待落地的事件：级别 + 人读 message + 机器读字段（`fields.event` 恒为事件名）。
 *
 * `fields` 刻意声明成 `Record<string, unknown> & {...}`：shared/logger 的 LogFields
 * 是一个带字符串索引签名的开放结构，这样调用点可以直接
 * `logger[event.level](event.message, event.fields)` 而不需要任何断言。
 */
export interface FailureEvent {
    level: FailureLevel;
    message: string;
    fields: Record<string, unknown> & { event: FailureEventName; component: string };
}

/**
 * 笔记导入统计的**结构快照**（与 src/API/types.ts 的 NoteImportStats 对齐）。
 * 只声明事件真正要用的那几个字段：调用点传完整 stats 也天然可赋。
 */
export interface NotesImportStatsSnapshot {
    created: number;
    updated: number;
    skipped: number;
    removed: number;
    /** CAS 未命中数（只有 > 0 时才由调用方设置） */
    conflicts?: number;
    /** 给用户看的那句提示；事件里原样带上，方便「日志 ↔ 用户反馈」对上号 */
    warning?: string;
    /** true = 有提交批失败、统计不全 */
    partial?: boolean;
}

/** 导入事件的公共上下文：批次位置、账号（多账号部署用来定位「是谁的导入」）与原始异常 */
export interface NotesImportEventContext {
    /** 失败的是第几批（1 基）。0 / 省略 = 非提交阶段失败 */
    failedBatch?: number;
    /** 这次导入一共切成几批 —— 只带 failedBatch 看不出「差多少」 */
    batchCount?: number;
    /** 当前账号；null / undefined 表示单账号部署（不带这个字段） */
    userId?: number | null;
    /**
     * 原始异常。**保留引用、不做字符串化**（与 logger 的其余用法同款）：
     * 排障靠的是 cause / 自定义字段（如 D1 的错误码），压成一句话就没了。
     */
    err?: unknown;
}

/**
 * `notes.import.partial`：导入的**提交阶段**中途失败。
 *
 * 为什么级别是 error 而不是 warn：这不是「有点慢」，而是一次**数据不完整**的恢复
 * ——用户以为导入完了，实际只进来一部分。留 warn 的话它会被日常噪音埋掉。
 */
export function notesImportPartialEvent(
    stats: NotesImportStatsSnapshot,
    context: NotesImportEventContext = {}
): FailureEvent {
    const fields: FailureEvent["fields"] = {
        event: FAILURE_EVENTS.NOTES_IMPORT_PARTIAL,
        component: "notesBackup",
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        removed: stats.removed,
        conflicts: stats.conflicts ?? 0,
        partial: true,
        // 统计**只认真的提交成功的批**（见 importNotesData 的提交循环），所以这四个数
        // 天然就是「实际落库了多少」，不需要另算。
    };
    if (typeof context.failedBatch === "number") fields.failedBatch = context.failedBatch;
    if (typeof context.batchCount === "number") fields.batchCount = context.batchCount;
    if (typeof stats.warning === "string" && stats.warning) fields.warning = stats.warning;
    if (typeof context.userId === "number") fields.userId = context.userId;
    if (context.err !== undefined) fields.err = context.err;
    return {
        level: "error",
        message: "笔记导入中断（已提交的批保留，其余未写入）:",
        fields,
    };
}

/**
 * `notes.import.conflicts`：CAS 冲突（那几条被别的设备改过，本次没覆盖）。
 *
 * 为什么**单独一个事件名**、而不是并进 partial 的同一个名字里：
 *   · 两者语义相反。partial = 数据**没写进去**（要么补导、要么丢），
 *     conflicts = 数据**故意不写**（保住了用户更新的编辑，是正确的降级）。
 *     同一个名字下靠 `partial` 字段翻转含义，告警规则必须先解一层 if 才能判严重度，
 *     半年后没人记得该怎么判。
 *   · 严重度不同：partial 要人处理（error），conflicts 多数是「多开了一个标签页」的
 *     正常产物（warn），两者共用一条规则就只能按更严重的那个判，等于把 warn 也做成告警。
 *   · 触发点也互斥：提交循环里一旦某批失败就 `partial: true` 提前返回，走不到下面那段
 *     冲突判定。所以「前面的批有冲突、后面的批又失败」这种情况下**只发 partial 一条**，
 *     冲突数在那条的 `conflicts` 字段里 —— 用不着两条日志讲同一件事。
 */
export function notesImportConflictsEvent(
    stats: NotesImportStatsSnapshot,
    context: NotesImportEventContext = {}
): FailureEvent {
    const fields: FailureEvent["fields"] = {
        event: FAILURE_EVENTS.NOTES_IMPORT_CONFLICTS,
        component: "notesBackup",
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        removed: stats.removed,
        conflicts: stats.conflicts ?? 0,
        // 如实回显快照里的 partial，而不是硬写 false：这个构建器不替调用点假设
        // 「走到这里就没失败过」（现有调用点确实走不到 partial 分支，见上面的注释）。
        partial: stats.partial === true,
    };
    if (typeof stats.warning === "string" && stats.warning) fields.warning = stats.warning;
    if (typeof context.userId === "number") fields.userId = context.userId;
    return {
        level: "warn",
        message: "笔记导入存在 CAS 冲突（保留本地较新内容，未覆盖）:",
        fields,
    };
}

/**
 * 从一个「可能带 failed 数组」的异常里取出失败步骤 id。
 * 不 import MigrationIncompleteError：shared 不许相对 import，而这里只需要
 * 「有没有一个字符串数组」这个结构事实（鸭子类型），不需要那个类的类型。
 */
function failedStepIds(error: unknown): string[] {
    if (!error || typeof error !== "object") return [];
    const failed: unknown = (error as { failed?: unknown }).failed;
    if (!Array.isArray(failed)) return [];
    return failed.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * `migration.failed`：迁移链路抛错（migrate() 的 catch 分支）。
 *
 * `phase` 取**第一个**失败步骤 id，而不是把所有失败步骤拼成串：
 * 告警规则要按 phase 分组 / 计数，字段基数越高越没用（一次「库整个打不开」会让
 * 二十几个步骤全失败，拼成串之后每条日志的 phase 都不同，等于没有维度）。
 * 完整清单在 `steps` 字段里，是给人排查用的。
 */
export function migrationFailedEvent(error: unknown, context: { version?: string } = {}): FailureEvent {
    const steps: string[] = failedStepIds(error);
    const fields: FailureEvent["fields"] = {
        event: FAILURE_EVENTS.MIGRATION_FAILED,
        component: "migration",
        // 没有步骤清单 = 不是「部分步骤失败」，而是迁移链路里其它环节抛错
        //（读版本 / 探 FTS / 落库…），如实标 unknown 而不是编一个步骤名。
        phase: steps[0] ?? "unknown",
        failedSteps: steps.length,
        steps: steps.join(","),
        err: error,
    };
    if (typeof context.version === "string" && context.version) fields.version = context.version;
    return {
        level: "error",
        message: "数据库迁移失败:",
        fields,
    };
}
