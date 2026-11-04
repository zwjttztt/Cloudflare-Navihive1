// script/perf-audit.mjs
// 首屏**体感**审计：FCP / LCP / CLS（移动端 Slow-4G + 4× CPU 节流）。
//
// 为什么要有它（2026-10-21，质量评估 C6 后半）：
// 项目已经有很严格的**体积**守卫（`check:budget`：首屏 raw / gzip 双口径），
// 但「体积小」不等于「看起来快」—— 关键渲染路径上多一个 40KB 的阻塞块，
// 和尾部多 200KB 的懒加载块，体积账上差不多，体感差一个数量级。
// 体积守卫拦不住的正是后者。
//
// 判据取 PerformanceObserver：
//   - FCP：第一个非空白内容绘制（用户第一次看到「有东西了」）
//   - LCP：视口内最大内容块绘制（用户认为「页面加载完了」）
//   - CLS：布局偏移累积（用户觉得「页面在跳」）
// 三个都由浏览器自己算，比任何手写埋点都可信。
//
// ⚠️ 预算的定法（很重要）：**先测量，再留余量，之后才收紧**。
// 这里给的是「不许明显退步」的上限，不是目标值 —— CI 机器负载波动很大，
// 卡着实测值定预算只会得到一条随时乱红的用例，然后大家开始无视它。
// 想看真实趋势请看输出表格里的数字，别只看红绿。
//
// ---------------------------------------------------------------------------
// 2026-11-04 重做（审查项 R14「性能首访证据不足」）
//
// 报告指出的问题与这里的对应改法：
//   ① **冷热混在一份中位数里**。原来同一个浏览器/服务会话连跑多轮，HTTP 缓存首轮
//      就预热了 —— 中位数反映的是「回访」体感；可首轮冷态又被算进了中位数，于是
//      这个数字既不是冷启动也不是回访，是两者的混合物。现在拆成两组、各自采样、
//      各自一份预算（`--mode=cold|warm|both`，默认两组都跑）：
//        · cold：**每一轮**导航前都 Network.setCacheDisabled + clearBrowserCache +
//          Storage.clearDataForOrigin(service_workers,cache_storage)，量的是首访；
//        · warm：缓存保持启用，**首轮只作预热、不计入中位数**，量的是回访稳态。
//   ② **CLS 只打印不断言，且取的是最后一轮**。现在 CLS 是门禁项，取该组**所有轮次
//      的最大值**（含预热轮）：CLS 是「最差一次」指标，丢掉最差那轮等于自废门禁。
//   ③ **JSON 模式静默成功**。原来 `if (failures.length && !JSON_ONLY)` 把失败输出
//      整段跳过，`--json` 下退出码还是 0。现在退出码只由 `decidePerf` 决定，
//      `--json` 失败**照样非零**；要「只报告不拦」必须**显式**传 `--report-only`。
//   ④ **本机口径比线上乐观/悲观不一致**。`auditEnv.mjs` 的静态服务原来不做 gzip，
//      而线上（Cloudflare）文本资源一律压缩传输 —— 量到的 FCP/LCP 与线上不可比。
//      现在静态服务按 `Accept-Encoding` 协商对文本资源 gzip。
//   ⑤ **pageErrors 跨轮累加**。原来 flatMap 会把同一个错误按轮数放大成「N 条报错」。
//      现在逐轮切窗 + `dedupeErrors` 去重（保序）。
//
// 判定逻辑在 `script/perfGate.mjs`（纯函数，`tests/perfAuditGate.test.ts` 表驱动覆盖），
// 本文件只负责：起浏览器 → 采样 → 打印 → 按判定结果给退出码。
//
// 用法：
//   node script/perf-audit.mjs                  冷+热两组都采并断言（默认 3 轮）
//   node script/perf-audit.mjs --mode=cold      只采冷启动
//   node script/perf-audit.mjs --mode=warm      只采回访（首轮预热）
//   node script/perf-audit.mjs --json           只输出 JSON（失败仍非零退出）
//   node script/perf-audit.mjs --json --report-only   报告模式：列出未达标项但退出 0
//   PERF_ROUNDS=5 node script/perf-audit.mjs    多采几轮更稳（上限 9）
//   PERF_ROUNDS=1 node script/perf-audit.mjs    最快一档（回访组不再有预热余量）
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { startSiteServer, openBrowser, waitRendered } from "./auditEnv.mjs";
import { decidePerf, parsePerfMode, summarizeGroup, PERF_USAGE, GROUP_LABELS } from "./perfGate.mjs";

/** 移动端 Slow-4G：Lighthouse 的口径，比真实 4G 差一档，属于保守侧 */
const NETWORK = {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
};
/** CPU 节流倍数：4× 大致相当于中端安卓机 */
const CPU_SLOWDOWN = 4;

/**
 * 预算（毫秒 / 无量纲 CLS）。**这不是目标值，是「明显退步」的报警线。**
 *
 * ⚠️ 定法：**先测量，再留余量，之后才收紧**。卡着实测值定预算只会得到一条随时
 * 乱红的用例，然后大家开始无视它。冷热两组各一份预算，因为它们的分布本来就不一样
 * （冷启动没有缓存可复用，本来就更慢；拿同一个数字卡两组，等于逼着热组放水）。
 *
 * ---- 标定记录（日后再改预算，请按同样的格式补一段，别只改数字）----
 *
 * 量于：2026-11-04（R14 落地当天，本文件重做后）。
 * 机器口径：Windows 10.0.26300 工作站，Intel i5-13490F（16 线程）/ 32 GB；
 *          **本机单跑**（不与 build / 单测 / 其它审计并行）；
 *          Chrome headless=new，视口 390×844 @DPR3；
 *          移动端 Slow-4G（150 ms RTT，1.6 Mbps 下行 / 750 kbps 上行），CPU 节流 4×；
 *          静态服务**已开 gzip**（与线上 Cloudflare 同口径，见 auditEnv.mjs）；
 *          `dist/client` 为当日干净构建产物；PERF_ROUNDS=3。
 *
 * 实测（三轮中位数；括号里是三轮的区间）：
 *          冷启动  FCP 1988 ms（1924–2028）· LCP 3424 ms（3176–3548）· CLS 0.034
 *          回访    FCP  208 ms（ 172– 280）· LCP  848 ms（ 728– 960）· CLS 0.034
 *          冷启动传输 334 KB / 100+ 请求；回访传输 4 KB（资源全在 HTTP 缓存里）
 *
 * ⚠️ 冷热差了一个数量级（FCP 1988 vs 208）——这就是 R14 说的「混在一份中位数里
 *    既不是冷启动也不是回访」。旧版把两者混采后得到 5000 ms 上下的中位数，
 *    再拿 5112 ms 的「首访实测」去定预算，两头都不成立。
 *
 * 余量怎么留的（**故意分两种口径**，因为两组数字的成因不同）：
 *   · 冷启动 ×1.7：这一档是**带宽**口径 —— 334 KB 压在模拟的 1.6 Mbps 上，
 *     时间几乎全由 emulation 决定，与机器快慢关系不大（两次独立实测 FCP 1976 / 1988，
 *     差 0.6%）。所以比例余量就够，1.7 倍是为了吃掉「首屏再多几十 KB」这类真实增长。
 *     旧文件里写的「×1.35~1.4 给更慢的 CI 机器」在这档上是多余的谨慎 —— 慢机器
 *     慢在 CPU，不慢在模拟带宽。
 *   · 回访 ×1.7 但**加一条 +300 ms 的下限**（FCP）/ LCP 直接取 ×2：
 *     这一档是 **CPU** 口径 —— 只传 4 KB，FCP 只有 200 ms，纯比例余量在慢机器上
 *     根本不够（CI 的 2 vCPU runner 比这台 16 线程台式机慢一倍是常态，
 *     208×1.7=354 ms 那样的预算一条就会红）。所以 FCP 取 max(×1.7, +300) = 500 ms，
 *     LCP（画最大块那一下，对 CPU 更敏感）取 ×2 = 1700 ms。
 *   · CLS 两组都 0.1：0.1 是 Core Web Vitals 的「good」上限，实测三轮全 0.034
 *     （首屏有一次骨架→内容的切换）。**不按比例留余量** —— CLS 是分值不是耗时，
 *     「比实测松 70%」没有意义；0.1 这条线本身就是「用户能看出来在跳」的界线。
 *
 * 下一次收紧的触发条件：首屏体积（`check:budget` 的 raw/gzip 口径）明显下降后，
 * 按上面的格式**重新量一遍再改数字**。只改数字不写理由的 PR 应该被打回 ——
 * 那样这条守卫会一路放水到没人看。
 */
const BUDGET_MS = {
    cold: { fcp: 3400, lcp: 5800, cls: 0.1 },
    warm: { fcp: 500, lcp: 1700, cls: 0.1 },
};

const JSON_ONLY = process.argv.includes("--json");
/**
 * 报告模式：**必须显式传**。
 *
 * 为什么要有：需要「先看数字、暂时不阻断」的场合是真实存在的（比如刚拆完一个大依赖、
 * 想先量一版基线）。但这件事必须是人**主动选的**，不能是默认行为 ——
 * 默认放行等于门禁不存在。所以：不传 `--report-only`，失败了就非零退出。
 */
const REPORT_ONLY = process.argv.includes("--report-only");

/**
 * 采样轮数（P4，2026-10-25）：CI 机器负载波动很大，单次采样会把噪声当信号，
 * 得到一条随时乱红的用例。改成多轮采样取中位数 —— 中位数对偶发的 GC/调度抖动
 * 不敏感，既能稳住绿率，又能保留「真实退步」的灵敏度。
 * 想要更稳就 PERF_ROUNDS=5，想快就 PERF_ROUNDS=1（回访组此时没有预热余量）。
 */
const ROUNDS = Math.min(9, Math.max(1, Number(process.env.PERF_ROUNDS) || 3));

/** 在页面加载前装好观察器：LCP 只在导航期间累积，装晚了就永远拿不到 */
const OBSERVER_SNIPPET = `
(() => {
    window.__perf = { lcp: 0, fcp: 0, cls: 0 };
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch { /* 老浏览器没有 LCP */ }
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime;
            }
        }).observe({ type: "paint", buffered: true });
    } catch { /* 同上 */ }
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                if (!e.hadRecentInput) window.__perf.cls += e.value;
            }
        }).observe({ type: "layout-shift", buffered: true });
    } catch { /* 同上 */ }
})();
`;

/** 读到「当前这一轮」的指标（含参考量：TTFB / DCL / 传输量 / 请求数） */
const READ_METRICS = `(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    return {
        ...window.__perf,
        ttfb: nav.responseStart || 0,
        domContentLoaded: nav.domContentLoadedEventEnd || 0,
        transferred: performance.getEntriesByType("resource")
            .reduce((sum, r) => sum + (r.transferSize || 0), 0),
        resources: performance.getEntriesByType("resource").length,
    };
})()`;

/**
 * 发一条 CDP 命令，失败时给出「这一步是干什么的」。
 *
 * 为什么包装：冷启动隔离的三条命令（禁缓存 / 清缓存 / 清 SW）任何一条静默失败，
 * 量出来的就是「半冷的回访」—— 报告里那张表看着一切正常，但**证据是假的**。
 * 这正是 R14 要治的病，所以这里宁可整体失败，也不要带着未隔离的缓存继续跑。
 */
async function mustSend(session, method, params, purpose) {
    try {
        return await session.send(method, params);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `冷启动隔离失败（${purpose} / ${method}）：${detail}\n` +
                "  冷启动组不能在没有隔离的情况下采样 —— 那量到的是「半冷的回访」，比不量更糟。"
        );
    }
}

/**
 * 采样一轮：按需隔离缓存 → 导航 → 等渲染 → 让 LCP 收敛 → 读指标。
 *
 * @param {{ session: object, url: string, origin: string, cold: boolean, round: number }} args
 * @returns {Promise<object>} 逐轮采样记录（形状见 script/perfGate.d.mts 的 PerfRound）
 */
async function measureOnce({ session, url, origin, cold, round }) {
    if (cold) {
        // ⚠️ **每一轮**都要重新隔离。只隔离一次的话，从第二轮开始浏览器手里就有
        // 上一轮的缓存副本，「冷启动」变成「第二个人来」—— 这正是原来那版的病根。
        await mustSend(session, "Network.setCacheDisabled", { cacheDisabled: true }, "禁用 HTTP 缓存");
        await mustSend(session, "Network.clearBrowserCache", {}, "清空浏览器缓存");
        await mustSend(
            session,
            "Storage.clearDataForOrigin",
            { origin, storageTypes: "service_workers,cache_storage" },
            "清 Service Worker / Cache Storage"
        );
    }
    await session.send("Page.navigate", { url });
    // 渲染完成 = 卡片挂出来（判据与两个审计脚本一致：全页 button 数）
    await waitRendered(session.evaluate, { minButtons: 25, timeoutMs: 60_000 });
    // LCP 会随「更大的一块内容」继续更新，等一会儿让它收敛
    await sleep(1200);
    const perf = await session.evaluate(READ_METRICS);
    return {
        round,
        fcp: Math.round(perf.fcp),
        lcp: Math.round(perf.lcp),
        cls: Number(Number(perf.cls).toFixed(3)),
        ttfb: Math.round(perf.ttfb),
        domContentLoaded: Math.round(perf.domContentLoaded),
        transferredKb: Math.round(perf.transferred / 1024),
        resources: perf.resources,
        pageErrors: [],
    };
}

/**
 * 采一组。
 *
 * 回访组比冷启动组多导航一次：第一轮只用来把 HTTP 缓存填上（预热），
 * 不进中位数。少这一轮，等于把「首访的冷态」掺进回访数字里 —— 那正是原来那版的问题。
 *
 * pageErrors 按「轮窗口」切：CDP 的报错是跨导航累积的，每轮结束时只取新增的那一段，
 * 免得同一个错误被轮数放大（去重仍由 perfGate 的 dedupeErrors 兜底）。
 *
 * @param {{ session: object, url: string, origin: string, kind: "cold" | "warm", rounds: number }} args
 * @returns {Promise<object>} 汇总结果（形状见 script/perfGate.d.mts 的 PerfGroupResult）
 */
async function runGroup({ session, url, origin, kind, rounds }) {
    const cold = kind === "cold";
    const navigations = cold ? rounds : rounds + 1;
    const samples = [];
    let errorOffset = session.getErrors().length;
    for (let i = 1; i <= navigations; i++) {
        const one = await measureOnce({ session, url, origin, cold, round: i });
        const all = session.getErrors();
        one.pageErrors = all.slice(errorOffset);
        errorOffset = all.length;
        samples.push(one);
    }
    return summarizeGroup(samples, { dropWarmup: !cold });
}

/**
 * 把一组结果排成给人看的几行。
 *
 * @param {string} kind
 * @param {object} result summarizeGroup 的产物
 * @returns {string[]}
 */
function groupLines(kind, result) {
    const label = GROUP_LABELS[kind];
    const budget = BUDGET_MS[kind];
    const mark = (value, limit) => (value > limit ? "✖" : "✔");
    const head = result.warmupDropped
        ? `[${label}] ${result.sampledRounds} 轮导航（首轮预热已剔除），${result.rounds} 轮计入中位数`
        : `[${label}] ${result.rounds} 轮计入中位数`;
    return [
        head,
        `  FCP ${result.fcp} ms（区间 ${result.fcpMin}–${result.fcpMax}，预算 ≤ ${budget.fcp}）${mark(result.fcp, budget.fcp)}`,
        `  LCP ${result.lcp} ms（区间 ${result.lcpMin}–${result.lcpMax}，预算 ≤ ${budget.lcp}）${mark(result.lcp, budget.lcp)}`,
        `  CLS ${result.cls}（所有轮次最大值${result.clsWorstRound ? `，最差在第 ${result.clsWorstRound} 轮` : ""}，` +
            `预算 ≤ ${budget.cls}）${mark(result.cls, budget.cls)}`,
        `  参考：TTFB ${result.ttfb} ms / DCL ${result.domContentLoaded} ms / ` +
            `传输 ${result.transferredKb} KB / ${result.resources} 个请求`,
    ];
}

/**
 * CI 上把数字写进「步骤摘要」：日志会随 runner 一起消失，而摘要在 PR 页面上
 * 一直挂着 —— 「这次改动把首屏拖慢了多少」要能一眼看到，不是翻日志才看得到。
 * （GITHUB_STEP_SUMMARY 只有 GitHub Actions 会设，本地跑到这里是 undefined，直接跳过。）
 *
 * @param {{ mode: string, groups: Record<string, object | null>, decision: object, reportOnly: boolean }} args
 */
function writeStepSummary({ mode, groups, decision, reportOnly }) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    const pct = (value, budget) => `${Math.round((1 - value / budget) * 100)}%`;
    const lines = [
        `## 首屏体感（移动端 Slow-4G + CPU ${CPU_SLOWDOWN}×，模式 ${mode}，每组 ${ROUNDS} 轮中位数）`,
        "",
        reportOnly ? "> ⚠ 本轮为 `--report-only`：未达标项只列不判，不阻断。\n" : "",
        "| 组 | 指标 | 值 | 预算 | 余量 |",
        "| --- | --- | --- | --- | --- |",
    ];
    const details = [];
    for (const kind of ["cold", "warm"]) {
        const result = groups[kind];
        if (!result) continue;
        const label = GROUP_LABELS[kind];
        const budget = BUDGET_MS[kind];
        lines.push(`| ${label} | FCP | ${result.fcp} ms | ${budget.fcp} ms | ${pct(result.fcp, budget.fcp)} |`);
        lines.push(`| ${label} | LCP | ${result.lcp} ms | ${budget.lcp} ms | ${pct(result.lcp, budget.lcp)} |`);
        lines.push(`| ${label} | CLS | ${result.cls} | ${budget.cls} | ${pct(result.cls, budget.cls)} |`);
        lines.push(`| ${label} | FCP 区间 | ${result.fcpMin}–${result.fcpMax} ms | — | — |`);
        lines.push(`| ${label} | LCP 区间 | ${result.lcpMin}–${result.lcpMax} ms | — | — |`);
        lines.push(`| ${label} | TTFB / 传输 / 请求 | ${result.ttfb} ms / ${result.transferredKb} KB / ${result.resources} | — | — |`);
        details.push(
            [
                `<details><summary>${label}逐轮明细</summary>`,
                "",
                "| 轮次 | FCP | LCP | CLS |",
                "| --- | --- | --- | --- |",
                ...result.rows.map(r => `| #${r.round} | ${r.fcp} ms | ${r.lcp} ms | ${r.cls} |`),
                "",
                "</details>",
            ].join("\n")
        );
    }
    if (decision.failures.length > 0) {
        lines.push("", "**未达标项**", "", ...decision.failures.map(f => `- ${f.split("\n")[0]}`));
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [...lines, "", ...details, ""].join("\n"), "utf8");
}

async function main() {
    // ⚠️ 参数在起浏览器**之前**校验：非法 --mode 花 5 秒起个 Chrome 再报错，
    // 万一报错路径上漏了收尾，就是一个孤儿进程。
    const modeResult = parsePerfMode(process.argv);
    if (!modeResult.ok) {
        console.error(`✖ ${modeResult.error}\n\n${PERF_USAGE}`);
        process.exit(1);
    }
    const mode = modeResult.mode;
    const wantedGroups = mode === "both" ? ["cold", "warm"] : [mode];

    const server = await startSiteServer(0);
    const session = await openBrowser({ cdpPort: 9333, windowSize: "390,844", hideScrollbars: true });
    const started = Date.now();
    const groups = { cold: null, warm: null };
    try {
        // 手机视口 + DPR 3，和真实设备一致；不然量的是桌面布局
        await session.send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
        });
        await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
        await session.send("Network.enable");
        await session.send("Network.emulateNetworkConditions", NETWORK);
        await session.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER_SNIPPET });

        const origin = new URL(server.url).origin;
        for (const kind of wantedGroups) {
            // 回访组先把缓存打开（冷启动组每轮自己隔离）；不清也行 —— 这里只是确保
            // 上一组留下的 cacheDisabled=true 不会渗到这一组来。
            await session.send("Network.setCacheDisabled", { cacheDisabled: kind !== "cold" });
            groups[kind] = await runGroup({ session, url: server.url, origin, kind, rounds: ROUNDS });
        }
        // 测完把缓存恢复成默认（进程马上要退出，但别把「我改过浏览器状态」这件事留成谜）
        await session.send("Network.setCacheDisabled", { cacheDisabled: false });
    } catch (error) {
        console.error("首屏体感审计执行失败：", error instanceof Error ? error.message : error);
        server.close?.();
        session.done(1);
        return;
    } finally {
        // 正常路径也会走这里（session.done 之后的 finally 不再执行，但 done 之前
        // 我们已经手动 close 过一次，close 是幂等的）
        server.close?.();
    }

    const wallMs = Date.now() - started;
    const decision = decidePerf({
        mode,
        cold: groups.cold,
        warm: groups.warm,
        budgets: BUDGET_MS,
        reportOnly: REPORT_ONLY,
    });

    const report = {
        // 与旧版 JSON 的差别（有意为之）：旧版把冷热混成一组扁平数字，消费方没法判断
        // 那到底是冷启动还是回访。现在改成 mode + cold/warm 两组，各自带预算与轮次。
        mode,
        modeSource: modeResult.source,
        reportOnly: REPORT_ONLY,
        rounds: ROUNDS,
        budgets: BUDGET_MS,
        cold: groups.cold,
        warm: groups.warm,
        exitCode: decision.exitCode,
        failures: decision.failures,
        notes: decision.notes,
        wallMs,
        environment: {
            network: "Slow-4G（150ms RTT，1.6Mbps↓ / 750kbps↑）",
            cpuThrottle: `${CPU_SLOWDOWN}×`,
            viewport: "390×844 @DPR3",
            chrome: session.chromePath,
            gzip: "静态服务已开（与线上 Cloudflare 同口径）",
        },
    };

    writeStepSummary({ mode, groups, decision, reportOnly: REPORT_ONLY });

    if (JSON_ONLY) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`首屏体感审计（移动端 Slow-4G + CPU ${CPU_SLOWDOWN}×，视口 390×844 @3x）`);
        const plan =
            mode === "cold"
                ? `冷启动 ${ROUNDS} 轮全部计入（每轮导航前清 HTTP 缓存 + SW/Cache Storage）`
                : mode === "warm"
                  ? `回访 ${ROUNDS + 1} 轮导航，首轮作预热不计入统计`
                  : `冷启动 ${ROUNDS} 轮全部计入 / 回访 ${ROUNDS + 1} 轮导航（首轮预热）`;
        console.log(`模式：${mode}（${plan}）`);
        console.log("");
        for (const kind of wantedGroups) {
            for (const line of groupLines(kind, groups[kind])) console.log(line);
            console.log("");
        }
        for (const note of decision.notes) console.log(`· ${note}`);
        console.log("");
    }

    // 失败一律打到 stderr：JSON 模式下 stdout 必须保持是**纯 JSON**（否则消费方解析不了），
    // 而失败信息无论如何都要看得见 —— 这与「JSON 模式静默成功」是同一件事的两面。
    if (decision.failures.length > 0) {
        console.error(
            REPORT_ONLY ? "\n首屏体感审计未达标（--report-only，本轮不阻断）：" : "\n首屏体感审计未通过："
        );
        for (const failure of decision.failures) console.error("  ✖ " + failure);
        if (!REPORT_ONLY) {
            console.error(
                "\n提示：体积没变但 LCP 变差，通常是关键渲染路径上多了阻塞块；" +
                    "真需要放宽预算的话，把实测数字与理由一起写进本文件的 BUDGET_MS 注释" +
                    "（冷热两组要分别写）。"
            );
        }
    } else if (!JSON_ONLY) {
        console.log("首屏体感审计通过");
    }

    // 「本轮不阻断」必须醒目。
    // ⚠️ `--json` 下这条**走 stderr**：stdout 要留给可解析的 JSON（往里插一行人话
    // 会让 `| jq` 直接失败），而 JSON 里同时有 `reportOnly: true` 与 notes 兜底。
    if (REPORT_ONLY) {
        const banner = `⚠ 本轮不阻断（--report-only）：${decision.failures.length} 项未达标只作报告，退出码 0`;
        if (JSON_ONLY) console.error(`\n${banner}`);
        else console.log(banner);
    }

    session.done(decision.exitCode);
}

main();
