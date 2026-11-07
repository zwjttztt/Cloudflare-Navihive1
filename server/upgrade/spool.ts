// server/upgrade/spool.ts
// spool 模式（2026-10-22）：把「执行重建」挪出本进程。
//
// 为什么：原先本进程直接调 Docker API、再起 helper 容器跑 `docker compose up`，
// 代价是**必须把 /var/run/docker.sock 挂进应用容器** —— 而 sock 等于宿主机 root：
// 容器一旦被攻破，攻击者能起特权容器、挂宿主目录、读全部数据。
// 试过用 socket-proxy 收权限（4.5），实测不可行：compose 需要 create/stop/networks/volumes，
// 而放开 `POST /containers/create` 的那一刻，加固就归零了。
//
// 所以变成：应用容器只往共享卷写一个请求文件，由独立的 upgrader 容器
// （持 sock、不开端口、不跑业务代码、不渲染用户内容）执行 compose。
// 应用容器从此**零 daemon 权限**。配了 NAVIHIVE_UPGRADE_SPOOL 就启用。
//
// 那台 upgrader 容器跑什么：`deploy/upgrader/upgrade-loop.sh`（仓库文件，compose 的
// `upgrader.command` 只是 exec 它）。它是本文件这套 sock 路径的**另一份实现**，
// 两份的锚点必须同步 —— 见 upgradeHealth.ts 文件头与 tests/systemUpgradeGuard.test.ts。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { logger } from "../../shared/logger";
import { rollbackTerminalEvent } from "../upgradeHealth";

const UPGRADE_SPOOL = (process.env.NAVIHIVE_UPGRADE_SPOOL || "").trim();

export interface SpoolState {
    phase?: string;
    image?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
}

export function spoolEnabled(): boolean {
    return UPGRADE_SPOOL.length > 0;
}

/** 读升级器写的状态；读不到/坏掉一律当 idle（前端会退化成「看版本号变没变」） */
export function readSpoolState(): SpoolState {
    if (!spoolEnabled()) return {};
    try {
        const parsed = JSON.parse(readFileSync(`${UPGRADE_SPOOL}/state.json`, "utf8")) as SpoolState;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * spool 模式的回滚终态**只能被读到**：相位是 upgrader 容器写进 state.json 的，
 * 本进程没参与那次判定 —— 唯一能观察到它的地方是 GET /api/system/upgrade 的轮询。
 * 所以在那里补一条结构化事件（`upgrade.rollback.failed`，见 upgradeHealth.ts）。
 *
 * 三条约束（缺一条这个事件就会变成噪音，而噪音型事件等于没有）：
 *   · 只对两个**回滚终态**发。`idle` / `pulling` / `recreating` / `failed` 都不是回滚，
 *     尤其 `failed`（重建失败、没走门禁）是另一类事，别混进来；
 *   · 按 `phase:时间戳` **去重**：前端点完升级会连着轮询好几秒，不去重就是每个请求一条；
 *   · 去重状态是模块级的（不是每个请求各自一份），进程被换掉后自然清零，
 *     不影响下一次升级 —— 同一进程里发生第二次回滚（换了新的 finishedAt）照样会报。
 *
 * ⚠️ 与 sock 模式那条（selfUpgrade 的失败分支）是同一事件名的两个触发点，字段由
 * rollbackTerminalEvent 统一生成，别在这里另拼一份。
 */
let lastReportedRollback = "";

export function reportRollbackOnce(state: SpoolState): void {
    const phase = state.phase;
    if (phase !== "rolled_back" && phase !== "rollback_failed") return;
    const stamp = typeof state.finishedAt === "number" ? state.finishedAt : (state.startedAt ?? 0);
    const key = `${phase}:${stamp}`;
    if (key === lastReportedRollback) return;
    lastReportedRollback = key;
    const event = rollbackTerminalEvent(phase, {
        reason: typeof state.error === "string" ? state.error : "",
        // 升级器只写目标镜像引用；升级前的旧版本在宿主机上只剩 ImageID，没法当版本号报
        toVersion: typeof state.image === "string" ? state.image : "",
    });
    logger[event.level](event.message, event.fields);
}

/**
 * 提交升级请求。
 * ⚠️ 先写临时文件再 rename：升级器可能在同一瞬间读到半截 JSON，
 *    原子替换能保证它要么看到完整文件、要么看不到。
 */
export function requestUpgradeViaSpool(by: string): void {
    const tmp = `${UPGRADE_SPOOL}/request.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), by }), "utf8");
    renameSync(tmp, `${UPGRADE_SPOOL}/request`);
}
