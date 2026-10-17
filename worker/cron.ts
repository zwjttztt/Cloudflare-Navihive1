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
import {
    NOTES_BACKUP_NOT_CONFIGURED_MESSAGE,
    notesWebDavConfigFrom,
    readNotesBackupStored,
    runNotesWebDavBackup,
    shouldRunNotesBackup,
} from "./notesBackup";
import { safeFetch } from "./safeFetch";
import { retryAttachmentDeletions } from "./attachments";
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
 * D1 读操作的重试：D1 偶发 `D1_ERROR` / 网络抖动，重试一次通常就好。
 *
 * 为什么值得单独立一项：定时任务**每周一次、无人盯守**，一次抖动就等于这一周
 * 没有备份/没有巡检。而这些入口读（listUsers / readAllConfigs / getSites）
 * 都是纯读，重试没有副作用。
 *
 * ⚠️ 只包**读**：写操作（setConfig / writeAudit）重试可能重复写，
 * 而且备份上传本身已有 putWithRetry，不需要在这里再包一层。
 */
export async function withD1Retry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 500): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (i < attempts - 1) {
                console.warn(`D1 读操作第 ${i + 1} 次失败，${delayMs}ms 后重试:`, error);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastError;
}

/** 定时任务失败的留痕的键：按任务分开存（cron.lastError.<task>） */
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
        const users = await withD1Retry(() => nav.listUsers!());

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
        const stored = await withD1Retry(() => readAllConfigs(nav as unknown as NavigationAPI));
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
 * 记事本自动备份调度（2026-10-09 照 inkstone 的频率选项）。
 *
 * 触发器每小时打一次（wrangler crons 的 "0 * * * *"），到没到点由
 * shouldRunNotesBackup 按账号配置的频率 + 上次自动备份时间判定 ——
 * 所以 hourly/sixHourly/daily/weekly/monthly/yearly 七档共用一个触发器。
 * 与导航页的每周备份分开：各认各的配置键（notesBackup.* vs webdav.autoBackup）。
 */
export async function runNotesBackupSchedule(api: SchedulerDB, env?: Env): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;
    const failures: string[] = [];

    if (typeof nav.listUsers !== "function" || typeof nav.setCurrentUser !== "function") {
        const reason = await notesBackupOneAccount(api, null, env);
        if (reason) failures.push(reason);
    } else {
        const users = await withD1Retry(() => nav.listUsers!());
        const targets: (number | null)[] =
            users.length > 0
                ? users.filter(u => u.status !== "disabled").map(u => u.id)
                : [null];
        for (const uid of targets) {
            const reason = await notesBackupOneAccount(api, uid, env);
            if (reason) failures.push(reason);
        }
    }

    if (failures.length > 0) {
        await recordCronFailure(api, "notesBackup", `记事本自动备份失败：${failures.join("；")}`);
    } else {
        await clearCronError(api, "notesBackup");
    }
}

/** 记事本自动备份单个账号。返回失败原因（null = 成功或本来就该跳过） */
async function notesBackupOneAccount(api: SchedulerDB, uid: number | null, env?: Env): Promise<string | null> {
    const nav = api as unknown as Partial<NavigationAPI> & SchedulerDB;
    const label = `账号 ${uid ?? "全局"}`;

    try {
        if (typeof nav.setCurrentUser === "function") nav.setCurrentUser(uid);
        const stored = await readNotesBackupStored(nav as unknown as NavigationAPI);
        const lastAutoAt = stored["notesBackup.lastAutoBackupAt"] || null;
        if (!shouldRunNotesBackup(stored["notesBackup.schedule"] || "off", lastAutoAt, Date.now())) {
            return null;
        }
        const config = notesWebDavConfigFrom(stored);
        if (!config.url) {
            console.log(`记事本定时备份跳过：${label}尚未配置网盘`);
            return null;
        }
        const result = await runNotesWebDavBackup(nav as unknown as NavigationAPI, config, {
            mode: "auto",
            stored,
            // env 传下去：配置了附件存储时自动备份也是 ZIP（含正文引用的附件）
            env,
        });
        console.log(
            result.success
                ? `记事本定时备份完成（${label}）：${result.data?.filename}`
                : `记事本定时备份失败（${label}）：${result.message}`
        );
        return result.success ? null : `${label}：${result.message || NOTES_BACKUP_NOT_CONFIGURED_MESSAGE}`;
    } catch (error) {
        console.error(`${label} 记事本定时备份异常:`, error);
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
    let snapshot: LinkHealthSnapshot = parseSnapshot(await withD1Retry(() => api.getConfig(HEALTH_KEY)));

    const sites = await withD1Retry(() => api.getSites());
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
    // 免得污染既有用例（沉睡扫描 2026-10-17 下线前也是这个套路）。
    if (typeof nav.listUsers !== "function" || typeof nav.setCurrentUser !== "function") {
        await sweepOneAccount(api);
        return;
    }

    const users = await withD1Retry(() => nav.listUsers!());
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
 * 沉睡账号扫描：**已按站点所有者要求关闭（2026-10-17）**。
 *
 * 原实现：长期不登录的账号先停用（数据留着），宽限期满再清除。原来挂在下面的
 * 每小时触发器里，每周跑一次。关闭时把任务块与这个函数一并删掉 ——
 * 只删调用点的话，函数和它的测试会变成「挂着但没人跑」的半死代码，
 * 下一个人读 cron 入口时会以为沉睡治理还在自动跑。
 *
 * 服务端能力（sweepInactiveUsers / setUserStatus / DELETE /api/account 等）
 * 一并保留但不再有可达路径：账号体系与登录拦截（403 停用态）依赖它们，
 * 真到要恢复那天，把任务块加回来就行。
 */

/**
 * 过期数据清理：审计日志、回收站、令牌黑名单、用过的恢复令牌标记、过期邀请码。
 * 这些表 / 键只增不减，不清就一直线性涨。详见 http.ts 的 cleanupExpiredRows。
 */
export async function runRetentionCleanup(api: SchedulerDB): Promise<void> {
    const nav = api as unknown as Partial<NavigationAPI>;
    if (typeof nav.cleanupExpiredRows !== "function") return;
    const result = await nav.cleanupExpiredRows();
    const total =
        result.audit + result.recycle + result.blacklist + result.invites + result.recoveryJti + (result.sessions ?? 0);
    if (total > 0) {
        console.log(
            `过期数据清理完成：审计 ${result.audit} 条、回收站 ${result.recycle} 条、` +
                `黑名单 ${result.blacklist} 条、邀请码 ${result.invites} 条、` +
                `恢复标记 ${result.recoveryJti} 条、过期会话 ${result.sessions ?? 0} 条`
        );
    }
}

/**
 * cron 入口：备份优先，巡检兜底，互不拖累。
 * makeApi 默认 new NavigationAPI(env)，与拆分前行为一致；验证脚本可注入假实现。
 *
 * cronExpr：本次触发用的是哪条 crons 表达式（worker/index.ts 从 ScheduledController
 * 传入）。
 *
 * ⚠️ 免费版账号的 cron 触发器**全账号总共只有 5 个**（2026-10-09 CI 部署时撞过上限：
 * 给这个 worker 加第二个触发器直接把 triggers 更新打挂）。所以这里**只有一条每小时
 * 触发器**（wrangler.jsonc 的 "0 * * * *"），所有任务共用，各认各的到点判定：
 *   - 记事本备份调度：每次触发都检查，到没到点由各账号的频率配置 + 上次自动备份
 *     时间判定（shouldRunNotesBackup）；
 *   - 导航页每周备份：在每小时触发器下按「UTC 周一 02 点」的墙上时钟窗口判定
 *     （isNavBackupWindow）—— 与原来的每周触发器同一场（北京时间周一 10 点），
 *     只是判定从「Cloudflare 挑时间」搬到了「代码挑时间」；
 *   - 其它表达式（验证脚本的通配 "* * * * *"、历史上配过的每周触发器）：保持老
 *     行为，全量任务照跑 —— cron-e2e 每次触发都必须真的跑一遍导航备份。
 * cronExpr 缺省（验证脚本直调）同理：全量照跑。
 */
export const HOURLY_CRON = "0 * * * *";
/** 导航页每周备份的窗口：UTC 周一 02:00-02:59（北京时间周一 10 点那一场） */
export function isNavBackupWindow(now: Date = new Date()): boolean {
    return now.getUTCDay() === 1 && now.getUTCHours() === 2;
}
/**
 * 这次触发要不要跑导航页每周备份。
 * 抽成纯函数是为了能单测钉死 cron-e2e 的那类场景：e2e 用通配表达式
 * "* * * * *" 触发，如果这里把它当成「不是每周触发器」跳过，备份一次都不跑，
 * 六条断言全在测空气（2026-10-09 CI 实际发生过的红）。
 */
export function isNavBackupDue(cronExpr: string | undefined, now: Date = new Date()): boolean {
    return cronExpr === undefined || cronExpr !== HOURLY_CRON || isNavBackupWindow(now);
}
/**
 * 备份任务的耗时上限，按账号数放宽。
 *
 * 多账号备份是**串行**的，而且必须是串行的：`setCurrentUser` 是 API 实例上的
 * 状态，并发共享同一个实例会**串账号**（把 A 的数据传进 B 的网盘）——
 * 那比「备份慢」严重得多。要并发就得每个账号一个独立 API 实例，
 * 收益（快几分钟）远小于风险，所以不做。
 *
 * 串行的问题是耗时线性叠加：上传封顶 10 分钟/账号，5 个账号就是 50 分钟，
 * 固定 12 分钟的上限会让后几个账号必然超时。所以按账号数给时间
 * （每多一个账号 +10 分钟），自身再封顶 30 分钟 —— 真到 30 分钟还传不完，
 * 该做的是分卷或换网盘，不是继续等。
 */
export function backupDeadlineMs(accounts: number): number {
    const extra = Math.max(0, accounts - 1) * 10 * 60_000;
    return Math.min(30 * 60_000, CRON_TASK_TIMEOUT_MS.backup + extra);
}

/**
 * 单个 cron 任务的耗时上限。
 *
 * 为什么需要：剩下的几个任务是**串行**跑的，而备份上传最长可占 10 分钟
 * （`uploadTimeoutMs` 的封顶值）。没有单任务上限的话，后面几项只能干等 ——
 * 某一项卡住会让当次 cron 整体超时，死链巡检/笔记备份/保留清理
 * 整周都不执行，而它们各自都有独立的 try/catch，本来不该被拖累。
 *
 * 备份与笔记备份给 12 分钟（上传封顶 10 分钟 + 导出与列目录的余量）；
 * 其余两项 5 分钟足够（慢也就慢在网络往返）。
 */
export const CRON_TASK_TIMEOUT_MS: Record<string, number> = {
    backup: 12 * 60_000,
    linkSweep: 5 * 60_000,
    notesBackup: 12 * 60_000,
    retention: 5 * 60_000,
};

/**
 * 包一层「超时就地失败、继续往下跑」。
 *
 * 返回而不是抛：调用方还要根据结果记失败留痕，抛出去就得再包一层 try/catch。
 *
 * ⚠️ JS 的 Promise 不能取消：超时后底层任务仍在后台跑完（它的结果不再有人要），
 * 所以提前挂一个 no-op catch —— 否则它自己 reject 会变成未处理 rejection，
 * 在 Workers 里直接把这次调用判成失败。
 */
export async function withDeadline<T>(
    task: string,
    fn: () => Promise<T>,
    timeoutMs: number = CRON_TASK_TIMEOUT_MS[task] ?? 5 * 60_000
): Promise<{ ok: boolean; timedOut: boolean; ms: number; error?: unknown }> {
    const started = Date.now();
    console.log(`cron 任务开始：${task}（上限 ${(timeoutMs / 1000).toFixed(0)}s）`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = fn();
    work.catch(() => {
        // 只防未处理 rejection，结果由下面的 race 决定
    });
    try {
        await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("任务超时")), timeoutMs);
            }),
        ]);
        const ms = Date.now() - started;
        console.log(`cron 任务完成：${task}，耗时 ${(ms / 1000).toFixed(1)}s`);
        return { ok: true, timedOut: false, ms };
    } catch (error) {
        const ms = Date.now() - started;
        const timedOut = error instanceof Error && error.message === "任务超时";
        console.error(
            `cron 任务失败：${task}，耗时 ${(ms / 1000).toFixed(1)}s${timedOut ? "（超时）" : ""}`,
            error
        );
        return { ok: false, timedOut, ms, error };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function runScheduledTasks(
    env: Env,
    makeApi: (env: Env) => SchedulerDB = (e) => new NavigationAPI(e),
    cronExpr?: string
): Promise<void> {
    try {
        await retryAttachmentDeletions(env);
    } catch (error) {
        console.error("附件延后清理异常:", error);
    }
    const navBackupDue = isNavBackupDue(cronExpr);
    // 每项都过 withDeadline：单任务超时就地记失败并继续下一项，
    // 不再让某一项卡住把后面四项整周拖掉（它们各自有 try/catch，本就不该被连坐）
    if (navBackupDue) {
        let backupApi: SchedulerDB | undefined;
        // 先探一下账号数，把单任务上限按它放宽（多账号串行，耗时线性叠加）
        let accounts = 1;
        try {
            backupApi = makeApi(env);
            const nav = backupApi as unknown as Partial<NavigationAPI> & SchedulerDB;
            if (typeof nav.listUsers === "function") {
                const users = await withD1Retry(() => nav.listUsers!());
                accounts = users.filter(u => u.status !== "disabled").length || 1;
            }
        } catch {
            // 探不到就按单账号算：withDeadline 里面还会再试一次
        }
        const r = await withDeadline(
            "backup",
            async () => {
                backupApi = makeApi(env);
                await runWeeklyBackup(backupApi);
            },
            backupDeadlineMs(accounts)
        );
        if (!r.ok && backupApi) {
            // 超时也要留痕：用户看到「备份失败」时至少知道是超时而不是别的
            const why = r.timedOut ? "超过单任务耗时上限" : `异常：${(r.error as Error)?.message || "未知错误"}`;
            await recordCronFailure(backupApi, "backup", `每周自动备份${why}`);
        }
    }

    {
        let sweepApi: SchedulerDB | undefined;
        const r = await withDeadline("linkSweep", async () => {
            sweepApi = makeApi(env);
            await runLinkSweep(sweepApi);
        });
        if (!r.ok && sweepApi) {
            const why = r.timedOut ? "超过单任务耗时上限" : `异常：${(r.error as Error)?.message || "未知错误"}`;
            await recordCronFailure(sweepApi, "linkSweep", `死链巡检${why}`);
        }
    }

    // 记事本自动备份调度：到没到点由各账号自己的频率配置判定，任何触发频率下行为都正确
    {
        const r = await withDeadline("notesBackup", async () => {
            await runNotesBackupSchedule(makeApi(env), env);
        });
        if (!r.ok) console.error("记事本自动备份调度未完成:", r.error);
    }

    {
        const r = await withDeadline("retention", () => runRetentionCleanup(makeApi(env)));
        if (!r.ok) console.error("过期数据清理未完成:", r.error);
    }
}
