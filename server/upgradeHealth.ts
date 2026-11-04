// server/upgradeHealth.ts
// 「升级后健康门禁 + 失败自动回滚 previous」的**纯逻辑与 shell 片段生成**。
//
// 背景（P1 #9，X-8 / D-15）：原来升级只有「拉镜像 → 重建 → 报告 done」，没有确认
// 新容器真的能服务。compose 重建成功、容器却起不来（镜像坏、迁移卡死、配置错）时，
// 站点直接停摆，要人半夜爬起来手动回滚（selfhost.md 8.2 那套三步）。
//
// 现在两条升级路径（spool 模式的 upgrader 容器、sock 模式的 helper 容器）都在
// rebuild 之后多一段：探活 → 不健康就回滚到 navihive:previous。
//
// R05（升级状态协议）：回滚**本身**也可能是假的 —— 以前回滚的 `docker compose up`
// 不看返回码、回滚后也不再探活，却无条件写 `done` / echo「完成」。现在回滚结果
// 必须被判成两个终态之一，两条路径都要如实写出来，且都带人读 error 与 finishedAt：
//   - rolled_back     ：回滚命令成功 **且** 回滚后旧容器二次探活拿到 healthy；
//   - rollback_failed ：回滚命令非 0，或二次探活仍不健康 —— 需人工介入。
// 判定抽成 classifyRollback 纯函数，与 shouldRollback 并列，供单测逐格钉死。
//
// 为什么抽成文件：upgraderCommand（entry.ts 里）会 import 这里的片段生成函数，
// 而「探活结果 → 是否回滚 / 回滚完算什么」的决策抽成纯函数后能被单测逐格钉死；
// entry.ts 因为一 import 就起服务，本就不能被单测引入（同 upgradeAudit.ts 的理由）。
//
// ⚠️ 本机没有 Docker daemon，这两段 shell 对**真实 daemon** 的行为无法在本地验证。
// 能验证的是：① shouldRollback / classifyRollback 纯决策的单元测试；② 两条路径的
// 脚本里都出现了相同的锚点 tag / 探活字段 / 回滚命令 / 终态相位
//（由 tests/systemUpgradeGuard.test.ts 钉住，含探活预算 40×3s / 20×3s）。
// ③ 2026-11 起 spool 那一份搬到了 deploy/upgrader/upgrade-loop.sh，于是可以被
// tests/upgraderLoop.test.ts 用假 docker **真跑**：done / rolled_back /
// rollback_failed 三个终局都有行为覆盖。本文件（sock 路径）仍只有锚点 + 纯函数覆盖。
// 真实的 daemon 行为要等 CI 或 VPS 验证。

import { FAILURE_EVENTS, type FailureEvent } from "../shared/failureEvents";

/** 升级前给当前 navihive 容器打的回滚锚点 tag */
export const NAVIHIVE_PREVIOUS_TAG = "navihive:previous";

/** 每次探活间隔（秒） */
export const HEALTHCHECK_POLL_SECONDS = 3;
/** 最多探多少次：40 × 3s = 120s，覆盖 HEALTHCHECK 的 start-period(15s)+retries(3)×interval(30s) */
export const HEALTHCHECK_MAX_ATTEMPTS = 40;
/** 回滚后二次探活次数：20 × 3s = 60s。旧镜像是刚才还在跑的那一份，起来应该更快 */
export const ROLLBACK_RECHECK_MAX_ATTEMPTS = 20;

/** 回滚结束后的两个终态相位（spool 的 state.json 与 sock 的 upgradeStatus.phase 共用） */
export type RollbackTerminalPhase = "rolled_back" | "rollback_failed";

/**
 * helper 以非 0 退出时区分两个回滚终态的退出码。
 * 刻意避开脚本里已有的 1（重建失败）/ 21（找不到 compose 文件）/ 22（docker CLI 没挂进来）。
 */
export const HELPER_EXIT_ROLLED_BACK = 40;
export const HELPER_EXIT_ROLLBACK_FAILED = 41;

/**
 * 升级前：把**当前正在跑的** navihive 镜像记成 previous 锚点。
 *
 * 必须在 pull / recreate 之前打 —— 此时 navihive 还是旧镜像。
 * 不能 `docker tag navihive:latest navihive:previous`：pull 之后 latest 已是新镜像，
 * 旧镜像只剩正在跑的那一份 ImageID。所以先 `docker inspect` 拿当前 ImageID，再 tag 它。
 *
 * @param containerName 被升级的容器名（compose 里是 navihive）
 */
export function tagPreviousBeforeRecreate(containerName: string): string {
    return [
        `# 升级前把当前镜像记成回滚锚点（recreate 之后 latest 就是新镜像，旧镜像只剩这一份 ImageID）`,
        `PREV_ID=$(docker inspect --format='{{.Image}}' ${containerName} 2>/dev/null || true)`,
        `if [ -n "$PREV_ID" ]; then docker tag "$PREV_ID" ${NAVIHIVE_PREVIOUS_TAG} 2>/dev/null || true; fi`,
    ].join("\n");
}

/**
 * 「重建后该不该回滚」的纯决策 —— 唯一会被单元测试逐格钉死的分支。
 *
 * 返回 true = 应回滚到 previous。
 * 约定：探活循环结束时，timedOut 表示「一直没拿到 healthy」（start-period + retries 都过了
 * 仍是 starting）；healthStatus 为 "unhealthy" 表示容器自身已宣告不健康 —— 这两种都是
 * 「新版本跑不起来」的实锤，回滚；"healthy" 且未超时则过门禁、不回滚。
 */
export function shouldRollback(healthStatus: string, timedOut: boolean): boolean {
    if (timedOut) return true;
    return healthStatus === "unhealthy";
}

/**
 * 「回滚命令返回码 + 回滚后二次探活结果 → 终态」的纯决策（R05）。
 *
 * 与 shouldRollback 并列：那个管「要不要回滚」，这个管「回滚完算成功还是失败」。
 * 两条升级路径的 shell 都按同一张表展开（见 healthGuardAfterRecreate 与
 * deploy/upgrader/upgrade-loop.sh —— spool 升级器的执行体，是**另一份实现**），
 * 改动必须同步，否则 tests/systemUpgradeGuard.test.ts 会红。
 *
 * @param rollbackExitCode    回滚用的 `docker compose up -d` 退出码（0 = 成功）
 * @param recheckHealthStatus 二次探活循环结束时的 Health.Status
 * @param recheckTimedOut     二次探活耗尽次数仍没拿到 healthy
 * @returns 只有「命令成功 + 二次探活 healthy + 未超时」才是 rolled_back；其余一律 rollback_failed
 */
export function classifyRollback(
    rollbackExitCode: number,
    recheckHealthStatus: string,
    recheckTimedOut: boolean,
): RollbackTerminalPhase {
    if (rollbackExitCode !== 0) return "rollback_failed";
    if (recheckTimedOut) return "rollback_failed";
    if (recheckHealthStatus !== "healthy") return "rollback_failed";
    return "rolled_back";
}

/**
 * 终态相位 → helper 退出码。
 * 两个回滚终态都让 helper **非 0 退出**：entry.ts 才会走失败分支，不再落到
 * 「完成：容器已按新镜像重建」那句假成功上。
 */
export function rollbackHelperExitCode(phase: RollbackTerminalPhase): number {
    return phase === "rolled_back" ? HELPER_EXIT_ROLLED_BACK : HELPER_EXIT_ROLLBACK_FAILED;
}

/**
 * helper 退出码 → 终态相位；其它非 0 退出码（1 / 21 / 22…）返回 null，按普通失败处理。
 * entry.ts 的失败分支用它把「已回滚」和「回滚失败」如实分开报给前端。
 */
export function classifyHelperExitCode(code: number): RollbackTerminalPhase | null {
    if (code === HELPER_EXIT_ROLLED_BACK) return "rolled_back";
    if (code === HELPER_EXIT_ROLLBACK_FAILED) return "rollback_failed";
    return null;
}

/**
 * 回滚终态 → 结构化事件（`upgrade.rollback.failed`，2026-11）。
 *
 * 为什么放在这里而不是 entry.ts 里直接拼：entry.ts 一 import 就起服务、单测引不进来
 *（见文件头），所以「哪个相位该报什么级别、带哪些字段」必须是纯函数才能被逐格钉死。
 * 调用点只负责把它交给 logger（sock 模式的失败分支、spool 模式的轮询观察各一处）。
 *
 * 两个相位共用**一个事件名**、靠 `phase` 字段区分，级别不同：
 *   · rollback_failed → error：回滚命令失败或回滚后仍不健康，此时**站点大概率已经不可用**，
 *     这是「立刻有人看」的那一档；一条告警规则就够（出现即告警）。
 *   · rolled_back     → warn：站点已恢复在旧版本上服务，属于「需要人知道、但不必半夜叫醒」。
 *     不能不发 —— 「今晚自动回滚了三次」和「一次都没回滚过」是两种完全不同的运维状态，
 *     而前者在用户侧什么都不说。
 */
export function rollbackTerminalEvent(
    phase: RollbackTerminalPhase,
    detail: { reason?: string; toVersion?: string; fromVersion?: string } = {}
): FailureEvent {
    const failed: boolean = phase === "rollback_failed";
    const fields: FailureEvent["fields"] = {
        event: FAILURE_EVENTS.UPGRADE_ROLLBACK,
        component: "upgrade",
        phase,
    };
    // reason 给人读（rollback_failed 的原文里带着回滚退出码与最后探活状态，别丢）
    const reason: string = (detail.reason ?? "").replace(/\s+/g, " ").trim();
    fields.reason =
        reason ||
        (failed
            ? "回滚命令失败或回滚后二次探活仍不健康（升级器未给出原因）"
            : "新版本健康门禁未通过，已回滚到上一版本（升级器未给出原因）");
    // 版本信息「有就带」：sock 模式能拿到目标镜像引用；升级前的旧版本只剩 ImageID
    //（见 tagPreviousBeforeRecreate 的注释），拿不到就不编。
    if (typeof detail.toVersion === "string" && detail.toVersion) fields.toVersion = detail.toVersion;
    if (typeof detail.fromVersion === "string" && detail.fromVersion) fields.fromVersion = detail.fromVersion;
    return {
        level: failed ? "error" : "warn",
        message: failed
            ? "升级失败且回滚未成功（站点可能不可用，需人工介入）:"
            : "升级失败，已自动回滚到上一版本:",
        fields,
    };
}

/**
 * 升级后：探活 → 不健康就回滚到 previous，并把回滚结果判成终态后**直接 exit**。
 *
 * 探活用 `docker inspect` 的 Health.Status（Dockerfile 自带 HEALTHCHECK 探 /api/readyz），
 * 不依赖容器内有没有 curl/wget —— 那正是 upgrade 链路最容易踩的坑（轻量镜像根本没这些工具）。
 * 决策交给 shouldRollback：明确 unhealthy 立刻回滚，超时（一直 starting）也回滚，
 * 只有 healthy 才算过门禁。
 *
 * ⚠️ 探针**故意**打 readyz（会跑一条 SELECT 1）而不是 healthz（零 DB）：库打不开的
 * 新镜像在 healthz 下会被判 healthy，自动回滚就永远不触发 —— 而那正是最需要回滚的情形。
 *
 * ⚠️ 回滚也要走 compose（不是直接 docker create）：保持与重建一致的坐标解析，
 * 否则下一轮 upgrade 会读歪 working_dir 标签（v4.3.0 的已知坑）。
 *
 * ⚠️ R05：回滚命令的返回码必须看，回滚后必须再探一轮活。两个终态都以**非 0 退出**
 * （40 / 41），这样调用方 entry.ts 会走进失败分支如实报相位，脚本末尾那两句「成功」
 * 只在 GUARD_OK 非空（门禁通过）时才跑得到 —— 回滚绝不可能再报升级完成。
 *
 * @param containerName 被升级的容器名
 * @param project       compose 工程名
 * @param composeFile   compose 配置文件（bare 路径，函数会自己加 -f；一般取解析到的第一个文件）
 */
export function healthGuardAfterRecreate(
    containerName: string,
    project: string,
    composeFile: string
): string {
    const rolledBackExit = rollbackHelperExitCode("rolled_back");
    const rollbackFailedExit = rollbackHelperExitCode("rollback_failed");
    const lines = [
        `# ---- 健康门禁：重建后新容器必须 healthy，否则回滚 previous ----`,
        `GUARD_OK=""`,
        `for _i in $(seq 1 ${HEALTHCHECK_MAX_ATTEMPTS}); do`,
        `  ST=$(docker inspect --format='{{.State.Health.Status}}' ${containerName} 2>/dev/null || echo starting)`,
        `  if [ "$ST" = "healthy" ]; then GUARD_OK=1; break; fi`,
        `  if [ "$ST" = "unhealthy" ]; then break; fi`,
        `  sleep ${HEALTHCHECK_POLL_SECONDS}`,
        `done`,
        `if [ -z "$GUARD_OK" ]; then`,
        `  echo "[upgrader] 新容器未在限期内 healthy（最后状态：$ST），回滚到 ${NAVIHIVE_PREVIOUS_TAG}"`,
        `  docker tag ${NAVIHIVE_PREVIOUS_TAG} ${containerName}:latest 2>/dev/null || true`,
        `  # ---- 回滚命令：必须看返回码，别像以前那样裸跑完就当成功 ----`,
        `  RB_OUT=$(docker compose -f ${composeFile} -p ${project} up -d --force-recreate --no-deps ${containerName} 2>&1) ; RB_CODE=$?`,
        `  echo "$RB_OUT"`,
        `  # ---- 回滚后二次探活：确认旧容器真的能服务（classifyRollback 的第二个输入）----`,
        `  RB_OK=""`,
        `  RB_ST="unknown"`,
        `  for _j in $(seq 1 ${ROLLBACK_RECHECK_MAX_ATTEMPTS}); do`,
        `    RB_ST=$(docker inspect --format='{{.State.Health.Status}}' ${containerName} 2>/dev/null || echo starting)`,
        `    if [ "$RB_ST" = "healthy" ]; then RB_OK=1; break; fi`,
        `    if [ "$RB_ST" = "unhealthy" ]; then break; fi`,
        `    sleep ${HEALTHCHECK_POLL_SECONDS}`,
        `  done`,
        `  # classifyRollback 的 shell 展开：RB_CODE=0 且二次探活 healthy → rolled_back，否则 rollback_failed`,
        `  if [ "$RB_CODE" -eq 0 ] && [ -n "$RB_OK" ]; then`,
        `    echo "[upgrader] rolled_back：已成功回滚到上一版本，旧容器二次探活 healthy"`,
        `    echo "[upgrader] ROLLBACK_RESULT=rolled_back"`,
        `    exit ${rolledBackExit}`,
        `  else`,
        `    echo "[upgrader] rollback_failed：回滚命令失败或旧容器二次探活仍不健康（回滚退出码 $RB_CODE，最后状态 $RB_ST），需人工介入"`,
        `    echo "[upgrader] ROLLBACK_RESULT=rollback_failed"`,
        `    exit ${rollbackFailedExit}`,
        `  fi`,
        `fi`,
    ];
    return lines.join("\n");
}
