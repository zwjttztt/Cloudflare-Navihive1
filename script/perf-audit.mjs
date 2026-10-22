// script/perf-audit.mjs
// 首屏**体感**审计：FCP / LCP（移动端 Slow-4G + 4× CPU 节流）。
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
// 两个都由浏览器自己算，比任何手写埋点都可信。
//
// ⚠️ 预算的定法（很重要）：**先测量，再留余量，之后才收紧**。
// 这里给的是「不许明显退步」的上限，不是目标值 —— CI 机器负载波动很大，
// 卡着实测值定预算只会得到一条随时乱红的用例，然后大家开始无视它。
// 想看真实趋势请看输出表格里的数字，别只看红绿。
//
// 用法：
//   node script/perf-audit.mjs            采集并断言
//   node script/perf-audit.mjs --json     只输出 JSON（给别的脚本用）
import { appendFileSync } from "node:fs";
import { startSiteServer, openBrowser, waitRendered } from "./auditEnv.mjs";
import { setTimeout as sleep } from "node:timers/promises";

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
 * 预算（毫秒）。**这不是目标值，是「明显退步」的报警线。**
 *
 * 2026-10-21 首次落地实测（本机，移动端 Slow-4G + CPU 4×，首屏 872 KB / 79 个请求）：
 *   FCP 5112 ms · LCP 6028 ms · TTFB 11 ms · CLS 0.031
 * 也就是说**真实中端安卓 + 慢 4G 下，这个站首屏要 5–6 秒才有内容** ——
 * 这个数字本身就是「首屏 < 600 KB」（质量评估 C1）值得做的理由。
 *
 * 预算按实测值 +35~40% 留余量给更慢的 CI 机器：
 * 卡着实测定预算只会得到一条随时乱红的用例，然后大家开始无视它。
 * **哪天 C1 做成了，这里必须跟着收紧**（改成实测值 ×1.5），否则这条守卫会一路放水。
 */
const BASE_FCP_MS = 5112;
const BASE_LCP_MS = 6028;
const BUDGET_MS = {
    fcp: Math.round(BASE_FCP_MS * 1.4),
    lcp: Math.round(BASE_LCP_MS * 1.33),
};

const JSON_ONLY = process.argv.includes("--json");

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

async function main() {
    const server = await startSiteServer(0);
    const session = await openBrowser({ cdpPort: 9333, windowSize: "390,844", hideScrollbars: true });
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

        const started = Date.now();
        await session.send("Page.navigate", { url: server.url });
        // 渲染完成 = 卡片挂出来（判据与两个审计脚本一致：全页 button 数）
        const buttons = await waitRendered(session.evaluate, { minButtons: 25, timeoutMs: 60_000 });
        // LCP 会随「更大的一块内容」继续更新，等一会儿让它收敛
        await sleep(1200);

        const perf = await session.evaluate(`(() => ({
            ...window.__perf,
            ttfb: (performance.getEntriesByType("navigation")[0] || {}).responseStart || 0,
            domContentLoaded: (performance.getEntriesByType("navigation")[0] || {}).domContentLoadedEventEnd || 0,
            transferred: performance.getEntriesByType("resource")
                .reduce((sum, r) => sum + (r.transferSize || 0), 0),
            resources: performance.getEntriesByType("resource").length,
        }))()`);
        const errors = session.getErrors();

        const report = {
            wallMs: Date.now() - started,
            buttons,
            fcp: Math.round(perf.fcp),
            lcp: Math.round(perf.lcp),
            cls: Number(perf.cls.toFixed(3)),
            ttfb: Math.round(perf.ttfb),
            domContentLoaded: Math.round(perf.domContentLoaded),
            transferredKb: Math.round(perf.transferred / 1024),
            resources: perf.resources,
            pageErrors: errors,
        };

        // CI 上把数字写进「步骤摘要」：日志会随 runner 一起消失，而摘要在 PR 页面上
        // 一直挂着 —— 「这次改动把首屏拖慢了多少」要能一眼看到，不是翻日志才看得到。
        // （GITHUB_STEP_SUMMARY 只有 GitHub Actions 会设，本地跑到这里是 undefined，直接跳过。）
        if (process.env.GITHUB_STEP_SUMMARY) {
            const margin = (v, b) => `${Math.round((1 - v / b) * 100)}%`;
            appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                [
                    "## 首屏体感（移动端 Slow-4G + CPU " + CPU_SLOWDOWN + "×）",
                    "",
                    "| 指标 | 实测 | 预算 | 余量 |",
                    "| --- | --- | --- | --- |",
                    `| FCP | ${report.fcp} ms | ${BUDGET_MS.fcp} ms | ${margin(report.fcp, BUDGET_MS.fcp)} |`,
                    `| LCP | ${report.lcp} ms | ${BUDGET_MS.lcp} ms | ${margin(report.lcp, BUDGET_MS.lcp)} |`,
                    `| TTFB | ${report.ttfb} ms | — | — |`,
                    `| 传输量 | ${report.transferredKb} KB | — | — |`,
                    `| 请求数 | ${report.resources} | — | — |`,
                    `| CLS | ${report.cls} | — | 只报告 |`,
                    "",
                ].join("\n"),
                "utf8"
            );
        }

        if (JSON_ONLY) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(`移动端 Slow-4G + CPU ${CPU_SLOWDOWN}×：`);
            console.log(`  FCP ${report.fcp} ms（预算 ≤ ${BUDGET_MS.fcp}）`);
            console.log(`  LCP ${report.lcp} ms（预算 ≤ ${BUDGET_MS.lcp}）`);
            console.log(
                `  参考：TTFB ${report.ttfb} ms / DCL ${report.domContentLoaded} ms / ` +
                    `传输 ${report.transferredKb} KB / ${report.resources} 个请求`
            );
            console.log(`  CLS ${report.cls}（只报告，暂不断言）`);
        }

        const failures = [];
        // 页面自己是坏的（抛异常）时，FCP/LCP 可能很好看 —— 那是假绿。
        // 两个既有审计脚本也拿 pageErrors 当判据，这里保持一致。
        if (errors.length) failures.push(`页面有 ${errors.length} 条运行时报错：${errors[0]}`);
        if (report.fcp <= 0) failures.push("量不到 FCP（观察器没装上，或页面根本没渲染内容）");
        if (report.lcp <= 0) failures.push("量不到 LCP");
        if (report.fcp > BUDGET_MS.fcp) failures.push(`FCP ${report.fcp}ms 超过预算 ${BUDGET_MS.fcp}ms`);
        if (report.lcp > BUDGET_MS.lcp) failures.push(`LCP ${report.lcp}ms 超过预算 ${BUDGET_MS.lcp}ms`);

        if (failures.length && !JSON_ONLY) {
            console.error("\n首屏体感审计未通过：");
            for (const f of failures) console.error("  ✖ " + f);
            console.error(
                "\n提示：体积没变但 LCP 变差，通常是关键渲染路径上多了阻塞块；" +
                    "真需要放宽预算的话，把实测数字与理由一起写进本文件的 BUDGET_MS 注释。"
            );
            session.done(1);
            return;
        }
        if (!JSON_ONLY) console.log("\n首屏体感审计通过");
        session.done(0);
    } catch (error) {
        console.error("首屏体感审计执行失败：", error instanceof Error ? error.message : error);
        session.done(1);
    } finally {
        server.close?.();
    }
}

main();
