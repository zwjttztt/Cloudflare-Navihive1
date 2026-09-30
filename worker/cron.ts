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

import { CRON_LAST_ERROR_KEY, type Site } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import type { Env } from "./types";
import { configFromStored, readAllConfigs, runWebDavBackup } from "./webdav";
import { safeFetch } from "./safeFetch";
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

/** 定时任务失败留痕的键：按任务分开存（cron.lastError.<task>） */
function cronErrorKey(task: string): string {
    return `${CRON_LAST_ERROR_KEY}.${task}`;
}

/**
 * 定时任务失败的留痕：写审计日志 + 写一条 cron.lastError 给页面看。
 *
 * 以前失败只有一行 console —— 定时任务没人盯着看控制台，「自动备份其实已经连着
 * 失败好几个月」只能等到真要恢复那天才发现。留痕写两处：审计日志给人查历史，
 * cron.lastError 给前端弹一条当前状态（成功时由 clearCronError 清掉）。
 *
 * 两个方法都可能不存在（验证脚本注入的是 SchedulerDB 三件套的假实现），
 * 探测不到就只留 console —— 留痕失败绝不能反过来把定时任务搞挂。
 */
async function recordCronFailure(
    api: SchedulerDB,
    task: string,
    message: string
): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;
    const short = (message || "未知错误").slice(0, 300);
    try {
        if (typeof nav.writeAudit === "function") {
            await nav.writeAudit(`cron.${task}.failed`, "system", "cron", short);
        }
        if (typeof nav.setSystemConfig === "function") {
            // 按任务分键：备份成功不该把巡检的失败提示一起清掉
            await nav.setSystemConfig(
                cronErrorKey(task),
                JSON.stringify({ task, message: short, at: new Date().toISOString() })
            );
        }
    } catch (error) {
        console.error("记录定时任务失败留痕时出错:", error);
    }
}

/** 见 recordCronFailure：任务成功（或不需要执行）后把那条失败提示撤掉 */
async function clearCronError(api: SchedulerDB, task: string): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;
    try {
        if (typeof nav.deleteSystemConfig === "function") {
            await nav.deleteSystemConfig(cronErrorKey(task));
        }
    } catch (error) {
        console.error("清除定时任务失败留痕时出错:", error);
    }
}

/**
 * 每周自动备份：导出 → 压缩上传 → 删掉上一次的自动备份 → 记录文件名。
 * 与页面上的手动备份共用 runWebDavBackup，但保留策略不同：自动备份只滚动清理
 * 自己那一份（auto 前缀），手动备份一份都不删。
 *
 * WebDAV 配置现在每个账号一份（user_configs），所以这里逐个账号来：
 * 先把自己绑成「当前账号」，读到的就是它自己的网盘地址 / 账号 / 口令，
 * 导出的也是它自己的分组与卡片 —— 不会把 A 的数据传进 B 的网盘。
 * 没配 WebDAV 或关了自动备份的账号直接跳过。
 *
 * 备份口令从库里的配置读（webdav.backupPassword），不用 AUTH_SECRET：
 * 定时任务无人值守，用不了页面上的临时输入；而轮换 AUTH_SECRET 不该让备份解不开。
 */
export async function runWeeklyBackup(api: SchedulerDB): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;

    // 失败原因攒到最后统一留痕：一次都没失败就顺手把上一次的失败提示撤掉
    const failures: string[] = [];

    // 验证脚本注入的假实现只有 SchedulerDB 三件套，没有 listUsers / setCurrentUser，
    // 直接调会 TypeError 把整个备份任务带崩 —— 与 runLinkSweep 同一套路，探测到就退回
    // 「按全局配置备份一次」的旧行为（那时也确实只有一个账号）。
    if (typeof nav.listUsers !== "function" || typeof nav.setCurrentUser !== "function") {
        const reason = await backupOneAccount(api, null);
        if (reason) failures.push(reason);
    } else {
        const users = await nav.listUsers();

        // 没有 users 表数据（极老的库）时退回「按全局配置备份一次」的旧行为。
        // 已停用的账号跳过：数据还在库里但人已经进不来，每周给它们传一份备份
        // 只是白烧 D1 读行数与网盘空间 —— 真要恢复，先「重新启用」再备份即可。
        const targets: (number | null)[] =
            users.length > 0
                ? users.filter(u => u.status !== "disabled").map(u => u.id)
                : [null];

        for (const uid of targets) {
            // 某个账号备份失败不影响其它账号
            const reason = await backupOneAccount(api, uid);
            if (reason) failures.push(reason);
        }
    }

    if (failures.length > 0) {
        await recordCronFailure(api, "backup", `每周自动备份失败：${failures.join("；")}`);
    } else {
        await clearCronError(api, "backup");
    }
}

/**
 * 备份单个账号。返回失败原因（null = 成功或本来就该跳过）。
 *
 * 抽出来是因为「多账号逐个备份」和「老库 / 假实现退回单账号」走的是同一段逻辑；
 * 异常在这里就地兜住，一个账号出问题不该让后面几个跟着不备份。
 */
async function backupOneAccount(api: SchedulerDB, uid: number | null): Promise<string | null> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;
    const label = `账号 ${uid ?? "全局"}`;

    try {
        if (typeof nav.setCurrentUser === "function") nav.setCurrentUser(uid);
        const stored = await readAllConfigs(nav as unknown as NavigationAPI);
        if (stored["webdav.autoBackup"] === "false") return null;

        const config = configFromStored(stored);
        if (!config.url) {
            console.log(`定时备份跳过：${label} 尚未配置 WebDAV`);
            return null;
        }

        const result = await runWebDavBackup(nav as unknown as NavigationAPI, config, {
            mode: "auto",
            stored,
            password: config.backupPassword,
        });
        console.log(
            result.success
                ? `定时备份完成（${label}）：${result.data?.filename}`
                : `定时备份失败（${label}）：${result.message}`
        );
        return result.success ? null : `${label}：${result.message || "上传失败"}`;
    } catch (error) {
        console.error(`${label} 定时备份异常:`, error);
        return `${label}：${(error as Error)?.message || "备份异常"}`;
    } finally {
        if (typeof nav.setCurrentUser === "function") nav.setCurrentUser(null);
    }
}

/**
 * 探活单个链接。HEAD 优先（省流量）；服务器不支持 HEAD（405/501）时退回 GET，
 * 拿到响应头立刻 cancel 掉 body，避免整页下载。死活判定交给 isAliveHttpStatus。
 *
 * M3：全程走 safeFetch，而不是裸 fetch + redirect:"follow"。裸 fetch 跟随重定向时
 * 不会重验目标主机，攻击者可借 302 把 Worker 引到 169.254.169.254 / 内网（SSRF）。
 * safeFetch 每跳重验 scheme/端口/主机名黑名单、手动跟随重定向（上限 4 跳），
 * 与 meta / icon / webdav 共用同一套出站安全策略。
 */
export async function probeUrl(url: string): Promise<boolean> {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return false;
    }

    const ua = {
        "User-Agent":
            "Mozilla/5.0 (compatible; NavihiveBot/1.0; +https://github.com/zwjttztt/Cloudflare-Navihive1)",
    };

    const head = await safeFetch(target, {
        timeoutMs: PROBE_TIMEOUT_MS,
        headers: ua,
        fetchInit: { method: "HEAD" },
    });
    if (head.ok) {
        return isAliveHttpStatus(head.response.status);
    }
    // HEAD 不被支持（405/501）时退回 GET；其它非 2xx 直接按状态码判定死活。
    if (head.kind === "http" && (head.upstreamStatus === 405 || head.upstreamStatus === 501)) {
        const get = await safeFetch(target, {
            timeoutMs: PROBE_TIMEOUT_MS,
            headers: { ...ua, Range: "bytes=0-0" },
            fetchInit: { method: "GET" },
        });
        if (get.ok) {
            return isAliveHttpStatus(get.response.status);
        }
        if (get.kind === "http") {
            return isAliveHttpStatus(get.upstreamStatus);
        }
        return false;
    }
    // blocked / timeout / redirect 跳板：判为死链（宁可误杀，不可 SSRF）
    return false;
}

/**
 * 单个账号的死链巡检：读它的 link.health 快照，挑「最久没探过」的站点重探一轮写回。
 * 任何失败都不抛出 —— 巡检失败不能影响同一次触发里的备份。
 */
async function sweepOneAccount(api: SchedulerDB): Promise<void> {
    let snapshot: LinkHealthSnapshot = parseSnapshot(await api.getConfig(HEALTH_KEY));

    const sites = await api.getSites();
    const now = Date.now();

    const candidates = selectSweepCandidates(sites as SweepSite[], snapshot, now);
    if (candidates.length === 0) return;

    for (const url of candidates) {
        const alive = await probeUrl(url);
        snapshot = applyProbeResult(snapshot, url, alive, now);
    }

    snapshot = trimSnapshot(snapshot);

    await api.setConfig(HEALTH_KEY, JSON.stringify(snapshot));
    console.log(`死链巡检完成：本轮探测 ${candidates.length} 个链接`);
}

/**
 * 死链巡检（全部账号）。
 *
 * 过去这是一把梭：以「无账号」身份读出**所有人**的站点、探完再写回全站共享的一份
 * `link.health`。多账号上线后，任何开了「失效记录同步」的人都能顺手看到别人收藏的
 * 网址清单 —— 虽然只是 URL 和死活，没有标题和凭据，但这已经是库里唯一一处
 * 跨账号混合的数据了。现在改成逐个账号巡检，各写各的快照（`link.health` 已归入
 * 按账号私有配置，见 http.ts 的 PRIVATE_USER_CONFIG_KEYS）。
 *
 * 副作用：升级前那份共享快照不再被读到，等于每人重新探一遍。
 * 快照本来就是 7 天内可重测的临时数据，代价只是一次性的探测流量。
 */
export async function runLinkSweep(api: SchedulerDB): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;

    // 验证脚本注入的假实现没有 listUsers / setCurrentUser，退回单账号的旧行为，
    // 免得污染既有用例（与 runInactiveSweep 同一套路）。
    if (typeof nav.listUsers !== "function" || typeof nav.setCurrentUser !== "function") {
        await sweepOneAccount(api);
        return;
    }

    const users = await nav.listUsers();
    // 没有 users 数据（极老的库）时退回「不带账号巡检一次」的旧行为。
    // 已停用的账号跳过：人进不来看不到结果，白烧探测流量。
    const targets: (number | null)[] =
        users.length > 0 ? users.filter(u => u.status !== "disabled").map(u => u.id) : [null];

    const failures: string[] = [];

    for (const uid of targets) {
        try {
            nav.setCurrentUser(uid);
            await sweepOneAccount(api);
        } catch (error) {
            console.error(`账号 ${uid ?? "全局"} 死链巡检异常:`, error);
            failures.push(`账号 ${uid ?? "全局"}：${(error as Error)?.message || "巡检异常"}`);
        } finally {
            nav.setCurrentUser(null);
        }
    }

    if (failures.length > 0) {
        await recordCronFailure(api, "linkSweep", `死链巡检失败：${failures.join("；")}`);
    } else {
        await clearCronError(api, "linkSweep");
    }
}

/**
 * 沉睡账号扫描：长期不登录的账号先停用（数据留着），宽限期满再清除，把 D1 行数还回来。
 *
 * 只用到 NavigationAPI 里的方法，不属于 SchedulerDB 那三件套 ——
 * 验证脚本注入的假实现没有它们，这里探测一下直接跳过，免得污染既有用例。
 */
export async function runInactiveSweep(api: SchedulerDB): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI>;
    if (typeof nav.sweepInactiveUsers !== "function") return;
    const result = await nav.sweepInactiveUsers();
    if (result.disabled > 0 || result.deleted > 0) {
        console.log(`沉睡账号扫描完成：停用 ${result.disabled} 个、清除 ${result.deleted} 个`);
    }
}

/**
 * 过期数据清理：审计日志、回收站、令牌黑名单、用过的恢复令牌标记、过期邀请码。
 * 这些表 / 键只增不减，不清就一直线性涨。详见 http.ts 的 cleanupExpiredRows。
 */
export async function runRetentionCleanup(api: SchedulerDB): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI>;
    if (typeof nav.cleanupExpiredRows !== "function") return;
    const result = await nav.cleanupExpiredRows();
    const total =
        result.audit + result.recycle + result.blacklist + result.invites + result.recoveryJti;
    if (total > 0) {
        console.log(
            `过期数据清理完成：审计 ${result.audit} 条、回收站 ${result.recycle} 条、` +
                `黑名单 ${result.blacklist} 条、邀请码 ${result.invites} 条、` +
                `恢复标记 ${result.recoveryJti} 条`
        );
    }
}

/**
 * cron 入口：备份优先，巡检兜底，互不拖累。
 * makeApi 默认 new NavigationAPI(env)，与拆分前行为一致；验证脚本可注入假实现。
 */
export async function runScheduledTasks(
    env: Env,
    makeApi: (env: Env) => SchedulerDB = (e) => new NavigationAPI(e)
): Promise<void> {
    // 外层兜底也要留痕：runWeeklyBackup 只在「按账号循环」内部兜了异常，
    // 取账号列表这一步就炸的话（D1 抽风、listUsers 抛错）里面根本轮不到执行
    let backupApi: SchedulerDB | undefined;
    try {
        backupApi = makeApi(env);
        await runWeeklyBackup(backupApi);
    } catch (error) {
        console.error("定时备份异常:", error);
        if (backupApi) {
            await recordCronFailure(
                backupApi,
                "backup",
                `每周自动备份异常：${(error as Error)?.message || "未知错误"}`
            );
        }
    }

    let sweepApi: SchedulerDB | undefined;
    try {
        sweepApi = makeApi(env);
        await runLinkSweep(sweepApi);
    } catch (error) {
        console.error("死链巡检异常:", error);
        if (sweepApi) {
            await recordCronFailure(
                sweepApi,
                "linkSweep",
                `死链巡检异常：${(error as Error)?.message || "未知错误"}`
            );
        }
    }

    try {
        const api = makeApi(env);
        await runInactiveSweep(api);
    } catch (error) {
        console.error("沉睡账号扫描异常:", error);
    }

    try {
        const api = makeApi(env);
        await runRetentionCleanup(api);
    } catch (error) {
        console.error("过期数据清理异常:", error);
    }
}
