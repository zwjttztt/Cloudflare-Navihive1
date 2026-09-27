// worker/cron.ts
// 每周定时任务（wrangler.jsonc 的 triggers.crons 触发）：
//   1. WebDAV 自动备份 —— 原有行为，只有开启「每周自动备份」且 WebDAV 已配置时才执行；
//   2. 死链巡检 —— 服务端探活站点链接，结果以 max 时间戳合并进 link.health 快照。
//      开启「失效记录同步」的设备下次拉取时按时间戳合并（src/utils/linkHealth.ts 的
//      mergeLinkHealth），没开同步的设备不受影响。

import { NavigationAPI } from "../src/API/http";
import type { Env } from "./types";
import { configFromStored, readAllConfigs, runWebDavBackup } from "./webdav";

// Workers 每次调用能发出的 subrequest 数有上限（免费版 50），除去 D1 查询后
// 一轮最多探这么多站点，超出的留给下一轮 —— 巡检每周跑，多跑几周总会覆盖完。
const MAX_PROBES_PER_RUN = 30;
const PROBE_TIMEOUT_MS = 6000;
/** 探测结果新鲜期：这个窗口内探过的不再重探 */
const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const HEALTH_KEY = "link.health";

/** 与 src/utils/linkHealth.ts 的 LinkHealthSnapshot 保持一致（服务端只读写，不解释语义） */
interface LinkHealthSnapshot {
    v: 1;
    dead: Record<string, number>;
    probe: Record<string, number>;
    white: string[];
}

/**
 * 每周自动备份：导出 → 压缩上传 → 删旧备份 → 记录文件名。
 * 与页面上的手动备份共用 runWebDavBackup，行为完全一致。
 */
async function runWeeklyBackup(env: Env): Promise<void> {
    const api = new NavigationAPI(env);
    const stored = await readAllConfigs(api);

    if (stored["webdav.autoBackup"] === "false") {
        return;
    }

    const config = configFromStored(stored);
    if (!config.url) {
        console.log("定时备份跳过：尚未配置 WebDAV");
        return;
    }

    const result = await runWebDavBackup(api, config, stored["webdav.lastBackup"] || "");
    console.log(
        result.success
            ? `定时备份完成：${result.data?.filename}`
            : `定时备份失败：${result.message}`
    );
}

/**
 * 探活单个链接。HEAD 优先（省流量）；服务器不支持 HEAD（405/501）时退回 GET，
 * 拿到响应头立刻 cancel 掉 body，避免整页下载。
 */
async function probeUrl(url: string): Promise<boolean> {
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
        // 404/410 = 资源确实没了；其余 4xx（登录墙/防盗链的 403 等）说明站点还在，算活着；
        // 5xx 按探测失败处理（与前端「能不能连上」的口径一致）
        if (res.status === 404 || res.status === 410) return false;
        return res.status < 400 || res.status < 500;
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
async function runLinkSweep(env: Env): Promise<void> {
    const api = new NavigationAPI(env);

    let snapshot: LinkHealthSnapshot = { v: 1, dead: {}, probe: {}, white: [] };
    try {
        const raw = await api.getConfig(HEALTH_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<LinkHealthSnapshot>;
            if (parsed && typeof parsed === "object") {
                snapshot = {
                    v: 1,
                    dead: parsed.dead && typeof parsed.dead === "object" ? parsed.dead : {},
                    probe: parsed.probe && typeof parsed.probe === "object" ? parsed.probe : {},
                    white: Array.isArray(parsed.white) ? parsed.white : [],
                };
            }
        }
    } catch {
        // 读不到就当空快照，从零开始巡
    }

    const sites = await api.getSites();
    const whitelist = new Set(snapshot.white);
    const now = Date.now();

    // 只探：没被手动纠偏、且超出新鲜期的链接；按上次探测时间从旧到新排
    const candidates = sites
        .filter(site => {
            if (!site.url || whitelist.has(site.url)) return false;
            const last = snapshot.probe[site.url] ?? snapshot.dead[site.url] ?? 0;
            return now - last >= FRESH_WINDOW_MS;
        })
        .sort((a, b) => (snapshot.probe[a.url] ?? 0) - (snapshot.probe[b.url] ?? 0))
        .slice(0, MAX_PROBES_PER_RUN);

    if (candidates.length === 0) {
        console.log("死链巡检跳过：没有需要重探的链接");
        return;
    }

    for (const site of candidates) {
        const alive = await probeUrl(site.url);
        if (alive) {
            snapshot.probe[site.url] = now;
        } else {
            // max 时间戳合并：不要把客户端更新的探测记录打回去
            snapshot.dead[site.url] = Math.max(snapshot.dead[site.url] ?? 0, now);
        }
    }

    // 超长快照裁剪：与前端 MAX_ENTRIES 一致，丢最旧的
    const trim = (map: Record<string, number>) => {
        const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
        return Object.fromEntries(entries.slice(0, 2000));
    };
    snapshot.dead = trim(snapshot.dead);
    snapshot.probe = trim(snapshot.probe);

    await api.setConfig(HEALTH_KEY, JSON.stringify(snapshot));
    console.log(`死链巡检完成：本轮探测 ${candidates.length} 个链接`);
}

/** cron 入口：备份优先，巡检兜底，互不拖累 */
export async function runScheduledTasks(env: Env): Promise<void> {
    try {
        await runWeeklyBackup(env);
    } catch (error) {
        console.error("定时备份异常:", error);
    }

    try {
        await runLinkSweep(env);
    } catch (error) {
        console.error("死链巡检异常:", error);
    }
}
