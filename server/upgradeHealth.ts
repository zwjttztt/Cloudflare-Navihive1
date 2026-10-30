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
// 为什么抽成文件：upgraderCommand（entry.ts 里）会 import 这里的片段生成函数，
// 而「探活结果 → 是否回滚」的决策抽成纯函数后能被单测逐格钉死；entry.ts 因为
// 一 import 就起服务，本就不能被单测引入（同 upgradeAudit.ts 的理由）。
//
// ⚠️ 本机没有 Docker daemon，这两段 shell 的**端到端行为无法在本地验证**——
// 能验证的是：① shouldRollback 纯决策的单元测试；② 两条路径的脚本里都出现了
// 相同的锚点 tag / 探活字段 / 回滚命令（由 tests/systemUpgradeGuard.test.ts 钉住）。
// 真实的 daemon 行为要等 CI 或 VPS 验证。

/** 升级前给当前 navihive 容器打的回滚锚点 tag */
export const NAVIHIVE_PREVIOUS_TAG = "navihive:previous";

/** 每次探活间隔（秒） */
export const HEALTHCHECK_POLL_SECONDS = 3;
/** 最多探多少次：40 × 3s = 120s，覆盖 HEALTHCHECK 的 start-period(15s)+retries(3)×interval(30s) */
export const HEALTHCHECK_MAX_ATTEMPTS = 40;

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
 * 升级后：探活 → 不健康就回滚到 previous。
 *
 * 探活用 `docker inspect` 的 Health.Status（Dockerfile 自带 HEALTHCHECK 探 /api/init），
 * 不依赖容器内有没有 curl/wget —— 那正是 upgrade 链路最容易踩的坑（轻量镜像根本没这些工具）。
 * 决策交给 shouldRollback：明确 unhealthy 立刻回滚，超时（一直 starting）也回滚，
 * 只有 healthy 才算过门禁。
 *
 * ⚠️ 回滚也要走 compose（不是直接 docker create）：保持与重建一致的坐标解析，
 * 否则下一轮 upgrade 会读歪 working_dir 标签（v4.3.0 的已知坑）。
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
        `  docker compose -f ${composeFile} -p ${project} up -d --force-recreate --no-deps ${containerName}`,
        `  echo "[upgrader] 已回滚"`,
        `fi`,
    ];
    return lines.join("\n");
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
