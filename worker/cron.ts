// worker/cron.ts
// 每周定时任务（wrangler.jsonc 的 triggers.crons 触发）：
//   1. WebDAV 自动备份 —— 原有行为，只有开启「每周自动备份」且 WebDAV 已配置时才执行；
//   2. 死链巡检 —— 服务端探活站点链接，结果以 max 时间戳合并进 link.health 快照。
//      开启「失效记录同步」的设备下次拉取时按时间戳合并（src/utils/linkHealth.ts 的
//      mergeLinkHealth），没开同步的设备不受影响。
//
// 判定与合并的纯逻辑都在 ./cronLogic.ts（单测覆盖）；这里只负责「真的发请求、读写 D1」。
// 巡检/备份只用到 NavigationAPI 的三个读写字，用 SchedulerDB 接口隔离，便于不依赖真实
// D1 做端到端验证（harness/cron-check.mjs）。生产路径下 makeApi 默认 new NavigationAPI，
// 行为和拆分前完全一致。

import { NavigationAPI, type Site } from "../src/API/http";
import type { Env } from "./types";
import { configFromStored, readAllConfigs, runWebDavBackup } from "./webdav";
import {
    HEALTH_KEY,
    PROBE_TIMEOUT_MS,
    isAliveHttpStatus,
    parseSnapshot,
    selectSweepCandidates,
    applyProbeResult,
    trimSnapshot,
    type LinkHealthSnapshot,
    type SweepSite,
} from "./cronLogic";

/** 巡检/备份实际只用到的三个读写字，避免过度依赖 NavigationAPI 的全量签名 */
export interface SchedulerDB {
    getConfig(key: string): Promise<string | null>;
    getSites(): Promise<Site[]>;
    setConfig(key: string, value: string): Promise<boolean>;
}

/**
 * 每周自动备份：导出 → 压缩上传 → 删掉上一次的自动备份 → 记录文件名。
 * 与页面上的手动备份共用 runWebDavBackup，但保留策略不同：自动备份只滚动清理
 * 自己那一份（auto 前缀），手动备份一份都不删。
 * 只有开启「每周自动备份」且 WebDAV 已配置时才执行，否则直接跳过。
 *
 * 备份口令从库里的配置读（webdav.backupPassword），不用 AUTH_SECRET：
 * 定时任务无人值守，用不了页面上的临时输入；而轮换 AUTH_SECRET 不该让备份解不开。
 */
export async function runWeeklyBackup(
    api: SchedulerDB,
    stored: Record<string, string>
): Promise<void> {
    if (stored["webdav.autoBackup"] === "false") {
        return;
    }

    const config = configFromStored(stored);
    if (!config.url) {
        console.log("定时备份跳过：尚未配置 WebDAV");
        return;
    }

    const result = await runWebDavBackup(api as unknown as NavigationAPI, config, {
        mode: "auto",
        stored,
        password: config.backupPassword,
    });
    console.log(
        result.success
            ? `定时备份完成：${result.data?.filename}`
            : `定时备份失败：${result.message}`
    );
}

/**
 * 探活单个链接。HEAD 优先（省流量）；服务器不支持 HEAD（405/501）时退回 GET，
 * 拿到响应头立刻 cancel 掉 body，避免整页下载。死活判定交给 isAliveHttpStatus。
 */
export async function probeUrl(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        let res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; NavihiveBot/1.0; +https://github.com/zwjttztt/Cloudflare-Navihive1)",
            },
        });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, {
                method: "GET",
                redirect: "follow",
                signal: controller.signal,
                headers: { Range: "bytes=0-0" },
            });
        }
        return isAliveHttpStatus(res.status);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 死链巡检：读 link.health 快照，挑「最久没探过」的站点重探一轮，max 时间戳写回。
 * 任何失败都不抛出 —— 巡检失败不能影响同一次触发里的备份。
 */
export async function runLinkSweep(api: SchedulerDB): Promise<void> {
    let snapshot: LinkHealthSnapshot = parseSnapshot(await api.getConfig(HEALTH_KEY));

    const sites = await api.getSites();
    const now = Date.now();

    const candidates = selectSweepCandidates(sites as SweepSite[], snapshot, now);
    if (candidates.length === 0) {
        console.log("死链巡检跳过：没有需要重探的链接");
        return;
    }

    for (const url of candidates) {
        const alive = await probeUrl(url);
        snapshot = applyProbeResult(snapshot, url, alive, now);
    }

    snapshot = trimSnapshot(snapshot);

    await api.setConfig(HEALTH_KEY, JSON.stringify(snapshot));
    console.log(`死链巡检完成：本轮探测 ${candidates.length} 个链接`);
}

/**
 * cron 入口：备份优先，巡检兜底，互不拖累。
 * makeApi 默认 new NavigationAPI(env)，与拆分前行为一致；验证脚本可注入假实现。
 */
export async function runScheduledTasks(
    env: Env,
    makeApi: (env: Env) => SchedulerDB = (e) => new NavigationAPI(e)
): Promise<void> {
    try {
        const api = makeApi(env);
        const stored = await readAllConfigs(api as unknown as NavigationAPI);
        await runWeeklyBackup(api, stored);
    } catch (error) {
        console.error("定时备份异常:", error);
    }

    try {
        const api = makeApi(env);
        await runLinkSweep(api);
    } catch (error) {
        console.error("死链巡检异常:", error);
    }
}
