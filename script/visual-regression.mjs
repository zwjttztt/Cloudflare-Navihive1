// script/visual-regression.mjs
// 视觉回归：**布局指纹**比对（不是像素截图）。
//
// 为什么不截图像素比对：
//   · CI 机器与开发机的字体不同（Linux 容器往往没装中文字体，回退字体宽度差一大截），
//     同一个页面截出来必然「整页位移」，像素比对在 CI 上是**稳定的假红**；
//   · 像素比对还要引图像库，而这里只需要知道「东西有没有跑位 / 变色 / 变号」。
//
// 所以采的是**结构化指纹**：一批稳定语义 class（.nav-*，都在 src/index.css 里有定义，
// 不是 emotion 生成的随机 class）的几何 + 关键计算样式，存成 JSON 基线再比对。
// 它能抓住真正的视觉回归：卡片跑位、圆角变了、字号变了、主题色被写死覆盖掉了；
// 又不会被字体渲染差异整片误报（几何给了容差，颜色 / 字号要求完全一致）。
//
// 用法：
//   npm run audit:visual                  比对（有差异 → 退出码 1）
//   npm run audit:visual -- --update      重录基线（改了布局 / 主题之后主动跑）
//   npm run audit:visual -- --filter mobile   只跑名字含 mobile 的用例
//   npm run audit:visual -- --tolerance 4     放宽几何容差（默认 2px）
//
// ⚠️ 基线是**本机录的**：换机器 / 换字体请先 --update 重录，再提交新的基线文件。
//    这也是它没进 npm run ci 的原因 —— 门禁留给人工确认，别在 CI 上字体一变就红。
//
// ⚠️ 只读：只发 GET，不登录、不写库（与 prod-smoke 同一条底线）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DIST, ROOT, openBrowser, startSiteServer, waitRendered, SHARE_TOKENS } from "./auditEnv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(ROOT, "tests", "visual-baseline");

// ---------------- 用例矩阵 ----------------

/**
 * 视口：桌面 / 窄窗 / 手机。
 *
 * 窄窗 864 是「125% 缩放的 1080p」的等效视口（项目里判窄屏的实测分界），
 * 手机 390 是 iPhone 逻辑宽度。三个都量，才不会改了移动端却只在桌面看过。
 */
const VIEWPORTS = [
    { name: "desktop", width: 1440, height: 950 },
    { name: "narrow", width: 864, height: 900 },
    { name: "mobile", width: 390, height: 844 },
];

/**
 * 场景。
 *
 * 原来只有首页三档，注释里写的原因是「只读桩只实现了首页要用的接口，
 * 记事本 / 分享页在桩里渲染不出来，硬量只会量到骨架态（假红）」。
 * 2026-10-24 起 auditEnv 的桩补齐了笔记 / 文件夹 / 标签 / 两个分享接口，
 * 于是这两个页面可以真量了 —— 它们此前**从来没有视觉基线**，
 * 也就是说「记事本布局跑了位」这件事，此前只能靠人眼看出来。
 */
const SCENES = [
    { name: "home-light", theme: "light" },
    // 暗色必须单独一档：P2-7 刚把一批硬编码颜色收敛成 token，
    // 「暗色下某个 token 没覆盖」正是这类回归的典型 —— 亮色全绿、暗色一处发白。
    { name: "home-dark", theme: "dark" },
    { name: "settings", theme: "light", openSettings: true, extraSelectors: [".nav-settings-dialog"] },
    {
        name: "notes-light",
        theme: "light",
        openNotes: true,
        // 记事本里稳定的是 `data-*` 属性（下面这几个都实测存在），不是 emotion hash。
        // 刻意**不采编辑器正文区**（.cm-content / .cm-line）：CodeMirror 的排版随字体与
        // 操作系统差得远，采进来就是稳定的假红（与「别采 .nav-clock」同一个理由）。
        extraSelectors: [
            "[data-notes-root]",
            "[data-nav-col='1']",
            "[data-unfiled-notes='1']",
            "[data-nav-footer='1']",
        ],
    },
    {
        name: "share-note",
        theme: "light",
        urlPath: `/s/${SHARE_TOKENS.note}`,
        // 公开页控件极少，waitRendered 的默认门槛（25 个按钮）永远等不到
        minButtons: 1,
        extraSelectors: ["[data-s]", "[data-share-brand='1']"],
    },
];

/**
 * 稳定语义选择器：全部来自 src/index.css 的顶层 class，改 emotion 不会动它们。
 * ⚠️ 别往里加 `.nav-clock*` —— 那是当前时间，每次跑宽度都不一样，稳定的假红。
 */
const BASE_SELECTORS = [
    ".nav-root",
    ".nav-group-rail",
    ".nav-group-panel",
    ".nav-group-accent-bar",
    ".nav-card-in",
    ".nav-card-icon",
    ".nav-card-actions",
    ".nav-star-btn",
    ".nav-header-compact",
    ".nav-header-divider",
    ".nav-settings-btn",
    ".nav-tag-bar",
];

/** 每个选择器最多记几个元素：够抓「第一个跑位」，又不至于让基线随数据量抖动 */
const PER_SELECTOR = 3;

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const valueOf = name => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const UPDATE = flag("--update") || flag("--update-baseline");
const FILTER = valueOf("--filter");
const TOLERANCE = Number(valueOf("--tolerance") ?? 2);
const CDP_PORT = Number(valueOf("--cdp-port") ?? process.env.AUDIT_CDP_PORT ?? 9531);

if (!Number.isFinite(TOLERANCE) || TOLERANCE < 0) {
    console.error("--tolerance 得是个非负数字");
    process.exit(1);
}

// ---------------- 指纹采集 ----------------

/** 在页面里跑：采一批选择器的几何 + 关键计算样式 */
function collectExpression(selectors) {
    return `(() => {
    const SEL = ${JSON.stringify(selectors)};
    const PER = ${PER_SELECTOR};
    const out = { counts: {}, elements: {} };
    out.counts.buttons = document.querySelectorAll("button").length;
    out.counts.groupPanels = document.querySelectorAll(".nav-group-panel").length;
    out.counts.cards = document.querySelectorAll(".nav-card-in").length;
    out.counts.railDots = document.querySelectorAll(".nav-rail-dot").length;
    out.dark = document.documentElement.classList.contains("dark");
    for (const sel of SEL) {
        out.elements[sel] = Array.from(document.querySelectorAll(sel)).slice(0, PER).map(n => {
            const r = n.getBoundingClientRect();
            const cs = getComputedStyle(n);
            return {
                // 取整：亚像素抖动每次跑都不一样，四舍五入掉
                rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                style: {
                    color: cs.color,
                    background: cs.backgroundColor,
                    fontSize: cs.fontSize,
                    radius: cs.borderTopLeftRadius,
                    display: cs.display,
                    visibility: cs.visibility,
                    // ⚠️ 刻意**不采 opacity**：入场淡入动画的中间值每次跑到哪一帧都不一样，
                    // 采了就是稳定的假红（实测两次之间差 0.03，全用例飘红）。
                    // 透明度是不是被改坏，留给专项；这里只盯「跑位 / 变色 / 变号」。
                },
            };
        });
    }
    return out;
})()`;
}

/**
 * 等入场动画跑完再采。
 *
 * 固定 sleep 不可靠：卡片是逐个淡入上移的，采在半路上量到的 y 会矮几像素，
 * 于是「同一个页面连跑两次」都能差 3px —— 那种假红会让人直接把门禁关掉。
 *
 * ⚠️ 只等**有限次**动画：背景极光（.nav-aurora）是无限循环的，等它的 finished
 * 就是等到天荒地老（外加一个 3 秒兜底，宁可少等也别挂死）。
 */
async function waitAnimations(evaluate) {
    await evaluate(`(() => {
        const anims = (document.getAnimations?.() ?? []).filter(a => {
            const t = a.effect?.getComputedTiming?.();
            return t && t.iterations !== Infinity;
        });
        return Promise.race([
            Promise.all(anims.map(a => a.finished.catch(() => {}))).then(() => true),
            new Promise(r => setTimeout(() => r(true), 3000)),
        ]);
    })()`);
}

/** 比对：几何给容差，其余（颜色 / 字号 / 数量）必须完全一致 */
function diffFingerprint(baseline, actual, tolerance, label) {
    const diffs = [];
    const push = msg => diffs.push(`${label}: ${msg}`);

    for (const key of Object.keys(baseline.counts)) {
        if (baseline.counts[key] !== actual.counts[key]) {
            push(`元素数量 counts.${key} ${baseline.counts[key]} → ${actual.counts[key]}`);
        }
    }
    if (baseline.dark !== actual.dark) push(`深浅模式 ${baseline.dark} → ${actual.dark}`);

    for (const sel of Object.keys(baseline.elements)) {
        const b = baseline.elements[sel] ?? [];
        const a = actual.elements[sel] ?? [];
        if (b.length !== a.length) {
            push(`${sel} 元素个数 ${b.length} → ${a.length}`);
            continue;
        }
        for (let i = 0; i < b.length; i++) {
            for (let k = 0; k < 4; k++) {
                const d = Math.abs(b[i].rect[k] - a[i].rect[k]);
                if (d > tolerance) {
                    push(
                        `${sel}[${i}] 几何 ${["x", "y", "w", "h"][k]} ${b[i].rect[k]} → ${a[i].rect[k]}（差 ${d}px > ${tolerance}px）`
                    );
                }
            }
            for (const [prop, expected] of Object.entries(b[i].style)) {
                const got = a[i].style?.[prop];
                if (got !== expected) push(`${sel}[${i}] ${prop} ${expected} → ${got}`);
            }
        }
    }
    return diffs;
}

// ---------------- 主流程 ----------------

function requireDist() {
    if (fs.existsSync(path.join(DIST, "index.html"))) return;
    console.error(
        `没有 ${path.relative(ROOT, DIST)} —— 先跑 npm run build 再来量（量旧产物等于白量）`
    );
    process.exit(1);
}

async function main() {
    requireDist();
    fs.mkdirSync(BASELINE_DIR, { recursive: true });

    const site = await startSiteServer(0);
    const { evaluate, send, done, getErrors } = await openBrowser({ cdpPort: CDP_PORT });

    const results = [];
    try {
        for (const vp of VIEWPORTS) {
            for (const scene of SCENES) {
                const caseName = `${vp.name}-${scene.name}`;
                if (FILTER && !caseName.includes(FILTER)) continue;

                // 视口先设好再导航：加载时才量得对（Emulation 覆盖了窗口尺寸）
                await send("Emulation.setDeviceMetricsOverride", {
                    width: vp.width,
                    height: vp.height,
                    deviceScaleFactor: 1,
                    mobile: vp.width < 500,
                });

                // 目标地址：分享页走自己的路由前缀（/s/<token>），其余是首页
                const targetUrl = site.url + (scene.urlPath ?? "");
                // 公开页的按钮数比首页少一个量级，门槛要跟着场景走，否则永远等不到
                const minButtons = scene.minButtons ?? 8;

                // 主题要在应用启动前落盘，否则读到的还是默认值（跟随系统 = 浅色）
                await send("Page.navigate", { url: targetUrl });
                await waitRendered(evaluate, { minButtons, timeoutMs: 20_000 });
                await evaluate(`(() => {
                    try { localStorage.setItem("theme", ${JSON.stringify(scene.theme)}); } catch {}
                    return true;
                })()`);
                // 重新加载：让主题在初始化路径上生效（与用户改设置后刷新等价）
                await send("Page.navigate", { url: targetUrl });
                await waitRendered(evaluate, { minButtons, timeoutMs: 20_000 });

                // 记事本：点顶栏「打开记事本」，等懒加载 chunk 落地并渲染出桩里的笔记。
                // 等标题而不是固定 sleep —— 那块是独立 chunk，加载时间随机器波动很大。
                if (scene.openNotes) {
                    const opened = await evaluate(`(() => {
                        const btn = [...document.querySelectorAll("button")]
                            .find(b => (b.getAttribute("aria-label") || "") === "打开记事本");
                        if (!btn) return "no-entry";
                        btn.click();
                        return "clicked";
                    })()`);
                    if (opened !== "clicked") {
                        throw new Error(
                            `${caseName}: 记事本入口找不到（${opened}）—— 选择器漂了，先修脚本再谈回归`
                        );
                    }
                    const deadline = Date.now() + 20_000;
                    let ready = false;
                    while (Date.now() < deadline) {
                        ready = await evaluate(
                            `!!document.querySelector("[data-notes-root]") && (document.body.innerText || "").includes("会议纪要")`
                        );
                        if (ready) break;
                        await sleep(300);
                    }
                    if (!ready) {
                        throw new Error(
                            `${caseName}: 记事本 20 秒内没渲染出来（停在骨架态）—— 量到的是空壳`
                        );
                    }
                }

                if (scene.openSettings) {
                    const opened = await evaluate(`(() => {
                        const btn = document.querySelector(".nav-settings-btn");
                        if (!btn) return false;
                        btn.click();
                        return true;
                    })()`);
                    if (!opened) {
                        throw new Error(
                            `${caseName}: 找不到 .nav-settings-btn —— 选择器漂了，先修脚本再谈回归`
                        );
                    }
                    // 弹窗有入场动画，等它落定（不靠固定 sleep：动画时长改了就白等）
                    await sleep(300);
                    await waitAnimations(evaluate);
                    const hasDialog = await evaluate(
                        `!!document.querySelector(".nav-settings-dialog")`
                    );
                    if (!hasDialog) {
                        throw new Error(`${caseName}: 点了设置按钮但弹窗没出来 —— 界面坏了`);
                    }
                }

                await waitAnimations(evaluate);
                const selectors = BASE_SELECTORS.concat(scene.extraSelectors ?? []);
                const fingerprint = await evaluate(collectExpression(selectors));
                if (!fingerprint || typeof fingerprint !== "object") {
                    throw new Error(`${caseName}: 采集失败（页面没渲染出可量元素？）`);
                }

                const file = path.join(BASELINE_DIR, `${caseName}.json`);
                if (UPDATE) {
                    fs.writeFileSync(file, JSON.stringify(fingerprint, null, 2) + "\n");
                    results.push({ caseName, status: "录制基线" });
                    continue;
                }
                if (!fs.existsSync(file)) {
                    // 不静默录基线（2026-10-24）：老行为在这里 writeFileSync 后当
                    // 「通过」，等于新用例自动获得一张免检金牌。现在记为无基线，
                    // 由汇总段判失败，引导显式 --update。
                    results.push({ caseName, status: "无基线" });
                    continue;
                }

                const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
                const diffs = diffFingerprint(baseline, fingerprint, TOLERANCE, caseName);
                results.push({ caseName, status: diffs.length ? "有差异" : "一致", diffs });
            }
        }
    } catch (error) {
        console.error(`\n视觉回归中断：${error?.stack || error}`);
        site.close();
        done(1);
        return;
    }

    const pageErrors = getErrors();
    site.close();

    // ---- 报告 ----
    console.log(`\n视觉回归（${UPDATE ? "录制基线" : "比对"}，几何容差 ${TOLERANCE}px）`);
    console.log("-".repeat(60));
    for (const r of results) {
        console.log(`  ${r.status.padEnd(8)} ${r.caseName}`);
        for (const d of r.diffs ?? []) console.log(`      · ${d}`);
    }
    console.log("-".repeat(60));

    // 页面自己报错过就别算过：页面是坏的，量出来的「一致」是假绿
    if (pageErrors.length > 0) {
        console.error(`\n页面自身有 ${pageErrors.length} 条报错，本次结果不作数：`);
        for (const e of pageErrors.slice(0, 8)) console.error(`  - ${e}`);
        done(1);
        return;
    }

    const failed = results.filter(r => r.status === "有差异");
    if (failed.length > 0) {
        console.error(
            `\n${failed.length} 个用例与基线不一致。确认是有意的改动就跑：` +
                `\n  npm run audit:visual -- --update`
        );
        done(1);
        return;
    }

    // 没有基线的用例**算失败**（2026-10-24 全站复查行动项）。
    // 老行为：!existsSync 时静默录一份当通过 —— 新场景/新组件第一次跑就绿，
    // 之后再改版比对自己刚录的基线，回归检测对它静默失效。
    const missing = results.filter(r => r.status === "无基线");
    if (missing.length > 0) {
        console.error(
            `\n${missing.length} 个用例没有基线（${missing.map(r => r.caseName).join("、")}）。\n` +
                `确认当前样子就是想要的，跑：\n  npm run audit:visual -- --update`
        );
        done(1);
        return;
    }

    console.log(`\n全部 ${results.length} 个用例通过。`);
    done(0);
}

await main();
