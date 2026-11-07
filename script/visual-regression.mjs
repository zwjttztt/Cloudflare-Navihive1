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
 * 「设置」中心里那三屏（保险库 / 回收站 / 审计）共用的采集面。
 *
 * 一律用**稳定**选择器，不用 emotion hash：
 *   - `[role="dialog"]` / `.MuiDialog-paper`：中心外壳（SettingsWorkspaceDialog）
 *   - `[data-workspace-nav]`：左栏条目（SettingsWorkspaceNav 的稳定 data 属性）。
 *     手机视口点进面板后左栏会卸载，所以这一档在 mobile 基线上是 0 个 —— 那是
 *     预期形态，不是缺测。
 *   - `.MuiTextField-root` / `.MuiButton-root` / `.MuiAlert-root`：面板正文里的
 *     表单、按钮、提示条（回收站与审计的行控件也落在这里）。
 *
 * ⚠️ 采集时机**不靠选择器自己稳**，靠调用方先等正文文字就绪（waitForText /
 *    waitForExtraText）再采。理由：`.MuiButton-root` 的个数会随列表数据从 0 涨到 N
 *    （每行一个按钮），`.MuiListItem-root` 更是纯行数。它们只在「数据已经落地」
 *    之后才是稳定量 —— 文字闸门就是用来保证这个前提的。
 *    三屏都**没有**收 `.MuiListItem-root`：行数完全相同、又多了 0→3 的抖动面，
 *    收益不值这个风险。
 */
const NAV_CENTER_SELECTORS = [
    "[role='dialog']",
    ".MuiDialog-paper",
    "[data-workspace-nav]",
    ".MuiTextField-root",
    ".MuiButton-root",
    ".MuiAlert-root",
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

    // ---------------- 2026-11-03 D4：补 4 个高危面 ----------------
    //
    // 审计第 19 项列了 5 个「有实现、没基线」的缺口。这一批补其中 4 个
    // （登录页是浮层、不是弹窗，且不属于「3 类高风险弹窗」，另议）。
    // 这四屏的共同点：**用户点得到、但以前的视觉回归从来看不见它们** ——
    // 一旦跑位 / 变色，只有真用户才会发现。
    {
        // 暗色记事本：notes-light 的暗色对照。
        // P2-7 把硬编码色收敛成 token 之后，「暗色下某个 token 没覆盖」正是这类回归的
        // 典型 —— 亮色全绿、暗色一处发白。所以选择器与 notes-light 保持**完全一致**，
        // 差别只有 theme：这样两边 diff 一旦分叉，原因必然是主题而不是采集面。
        name: "notes-dark",
        theme: "dark",
        openNotes: true,
        extraSelectors: [
            "[data-notes-root]",
            "[data-nav-col='1']",
            "[data-unfiled-notes='1']",
            "[data-nav-footer='1']",
        ],
    },
    {
        // 密码保险库（设置中心 → 密码保险库）。桩里的 /api/vault/keys 回 null，
        // 于是面板落在「建库」屏：Alert + 两个主密码输入框 + 创建按钮。
        // ⚠️ 只覆盖「没建库 / 解锁」这一屏，**不覆盖解锁后的条目列表** ——
        //    真解锁要跑 PBKDF2 并持有真密文，桩给不了（见报告里的边界说明）。
        name: "vault",
        theme: "light",
        openNavCenterPanel: "vault",
        waitForText: "主密码",
        // 建库屏的实体按钮：用来确认「已经进到面板了」，不是还停在左栏列表步
        waitForExtraText: ["创建保险库"],
        extraSelectors: NAV_CENTER_SELECTORS,
    },
    {
        // 回收站：已并入「数据安全」面板（数据保留 → 备份与恢复 → 回收站长页）。
        // 等桩里的条目名出现，而不是只等「回收站」三个字 —— 后者在左栏标签和
        // 分区标题里都有，骨架态也能匹配上，等于没等。
        // ⚠️ 只等**站点页签**的两条（默认 tab=0）：分组条目在 tab=1，不切页签
        //    根本不会渲染，把它写进来必然 20s 超时（第一版就是这么红的）。
        name: "recycle",
        theme: "light",
        openNavCenterPanel: "backup",
        waitForText: "回收站",
        waitForExtraText: ["旧站点", "测试卡片"],
        extraSelectors: NAV_CENTER_SELECTORS,
    },
    {
        // 审计日志（owner 专属；桩的 /api/auth/me 已给 owner）。
        // 同样等真实条目（detail 文案）出现，避免停在「读取中」的空壳上。
        name: "audit",
        theme: "light",
        openNavCenterPanel: "audit",
        waitForText: "审计",
        waitForExtraText: ["登录成功", "新增站点"],
        extraSelectors: NAV_CENTER_SELECTORS,
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
    // `.nav-header-compact` 已于 2026-11 删除（紧凑态只改字号、不再挂 CSS 类），
    // 从采样清单同步移除；基线里它一直是空数组，删除无数据损失。
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

// ---------------- 证据落盘（R17）----------------
//
// 背景（2026-11-04，R17）：这个脚本以前五条退出路径（中断 / 页面报错 / 有差异 /
// 无基线 / 全过）**都是直接 done(N)**，一分钟内什么也不留下。CI 上视觉回归是
// `continue-on-error: true` 的观察期步骤，失败时日志滚过去就没了 —— 「哪个用例
// 差在哪几个字段、差了多少像素」这唯一有价值的信息，只存在于当时的控制台里。
// 于是这条审计的实际价值等于「它绿的时候你不知道它在量什么，它红的时候你不知道
// 为什么红」。
//
// 现在每次运行都往 `artifacts/visual-regression/<时间戳>/` 落两份东西：
//   · `<case>.json` —— 每个用例一份：actual 指纹、基线指纹（有的话）、diff 明细；
//   · `summary.json` —— 一次运行一份：时间 / 模式 / 容差 / 用例状态表 / pageErrors。
//
// ⚠️ `flush()` 必须**幂等**：done() 在若干条路径上都会走一遍，重复调用不许写出
//    第二份 summary（那会让「一次运行 = 一个目录」这条约定失效，CI artifact 里
//    出现两份互相矛盾的结论）。
// ⚠️ `artifacts/` 已进 .gitignore —— 这是运行产物，不入库。
const ARTIFACT_ROOT = path.join(ROOT, "artifacts", "visual-regression");
const STARTED_AT = new Date().toISOString();
/** 目录名用时间戳：`:` 和 `.` 在 Windows 上不合法，全部换成 `-` */
const RUN_STAMP = STARTED_AT.replace(/[:.]/g, "-");
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, RUN_STAMP);

/** 逐用例结果（判定与报告共用；证据落盘也从这里取） */
const results = [];
/** 页面自身报错（flush 时一并落盘，否则「结果不作数」这句话在 CI 里查不到证据） */
const pageErrors = [];

/** 正在跑的用例：中断时靠它把「死在哪个用例、死在哪一步」写下来 */
let pendingCase = null;
/** 已经 flush 过：幂等标记 */
let flushed = false;
/** artifacts 目录建过了没 */
let evidenceReady = false;

/** 文件名只保留可移植字符：用例名是脚本拼的，理论上安全，但不值得赌 */
function caseFileName(caseName) {
    return `${String(caseName).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function ensureEvidenceDir() {
    if (evidenceReady) return;
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    evidenceReady = true;
}

/**
 * 落一个用例的证据。
 *
 * 写在**每个用例跑完之后立刻**，而不是最后统一写：中断分支（catch）里
 * 「能写多少写多少」要求前面已经跑完的用例先落了盘。
 */
function writeCaseEvidence(record) {
    try {
        ensureEvidenceDir();
        const payload = {
            case: record.caseName,
            viewport: record.viewport ?? null,
            scene: record.scene ?? null,
            mode: UPDATE ? "update" : "compare",
            tolerance: TOLERANCE,
            status: record.status,
            diffCount: (record.diffs ?? []).length,
            diffs: record.diffs ?? [],
            // 指纹整份留着：光有 diff 文案时，「实际长什么样」还是得重跑一次才知道
            actualFingerprint: record.actualFingerprint ?? null,
            baselineFingerprint: record.baselineFingerprint ?? null,
            error: record.error ?? null,
        };
        fs.writeFileSync(
            path.join(EVIDENCE_DIR, caseFileName(record.caseName)),
            JSON.stringify(payload, null, 2) + "\n"
        );
    } catch (err) {
        // 落盘失败绝不许掩盖判定结论：告警即可，脚本照常给出 exit code
        console.error(`证据落盘失败（${record.caseName}，不影响判定）：${err?.message || err}`);
    }
}

/**
 * 落 `summary.json`，并且**只落一次**。
 *
 * 每条退出路径都必须先调它再 `done()`：CI 上「什么都没留下」是这个审计最坏的形态。
 *
 * @param {{ status: string, exitCode: number, error?: string|null }} outcome
 */
function flush(outcome) {
    if (flushed) return;
    flushed = true;
    try {
        ensureEvidenceDir();
        const totals = {};
        for (const r of results) totals[r.status] = (totals[r.status] ?? 0) + 1;
        const summary = {
            script: "script/visual-regression.mjs",
            schema: 1,
            mode: UPDATE ? "update" : "compare",
            startedAt: STARTED_AT,
            finishedAt: new Date().toISOString(),
            tolerance: TOLERANCE,
            filter: FILTER ?? null,
            cdpPort: CDP_PORT,
            status: outcome.status,
            exitCode: outcome.exitCode,
            error: outcome.error ?? null,
            cases: results.map(r => ({
                case: r.caseName,
                status: r.status,
                diffCount: (r.diffs ?? []).length,
                error: r.error ?? null,
            })),
            totals,
            pageErrors,
        };
        fs.writeFileSync(
            path.join(EVIDENCE_DIR, "summary.json"),
            JSON.stringify(summary, null, 2) + "\n"
        );
        console.log(`证据已落盘：${path.relative(ROOT, EVIDENCE_DIR)}（summary.json + ${results.length} 个用例）`);
    } catch (err) {
        console.error(`证据落盘失败（不影响判定）：${err?.message || err}`);
    }
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

/**
 * 轮询一个页面内布尔表达式，直到为真或超时。
 *
 * 与 `waitRendered` 分开：那个等的是「整页按钮数」，这里等的是**某一个具体条件**
 * （dialog 挂上没 / 某段文字出现没）。条件不满足一律走 failMessage 抛出 ——
 * 视觉回归量错东西比量不到更糟，所以宁可中断整轮，也不要记一个「一致」。
 */
async function waitForCondition(evaluate, expression, timeoutMs, failMessage) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let ok = false;
        try {
            ok = await evaluate(expression);
        } catch {
            // 导航 / 重渲染中途 evaluate 可能抛，下一轮再试
            ok = false;
        }
        if (ok) return true;
        await sleep(250);
    }
    throw new Error(failMessage);
}

/**
 * 打开「设置」中心并落到指定面板（D4，2026-11-03）。
 *
 * 三步全是「失败即抛错」：选择器漂了就不该继续量，量到的会是错的东西。
 *   1. 点 `#navigation-button`（HeaderActions 的稳定 id，aria-haspopup="dialog"）
 *   2. 等 `[role="dialog"]`（中心外壳，懒加载块，给 20s）
 *   3. 点 `[data-workspace-nav="<id>"]`（SettingsWorkspaceNav 的稳定 data 属性）；
 *      拿不到就把当前页面上所有 nav id 列进报错
 *
 * 手机视口（390）不需要额外动作：中心在 fullScreen 下先显示**列表步**，
 * 点导航项本身就切到面板步（`SettingsWorkspaceDialog` 的 mobileStep）。
 * `.click()` 在列表项上照样有效，不用先去找「全部选项」之类的中间层。
 *
 * @param {Function} evaluate 页面内执行
 * @param {object} scene 带 openNavCenterPanel / waitForText / waitForExtraText
 * @param {string} caseName 报错用的用例名
 */
async function openNavCenterPanel(evaluate, scene, caseName) {
    const panelId = scene.openNavCenterPanel;
    const mustHave = [scene.waitForText, ...(scene.waitForExtraText ?? [])].filter(Boolean);

    // 1) 打开中心
    const clicked = await evaluate(`(() => {
        const btn = document.getElementById("navigation-button");
        if (!btn) return "missing";
        btn.click();
        return "clicked";
    })()`);
    if (clicked !== "clicked") {
        throw new Error(
            caseName + ": 找不到 #navigation-button（" + clicked + "）—— 入口选择器漂了，先修脚本再谈回归"
        );
    }

    // 2) 等中心外壳挂上（懒加载 chunk，20s 上限）
    await waitForCondition(
        evaluate,
        `!!document.querySelector('[role="dialog"]')`,
        20_000,
        caseName + ': 20 秒内没出现 [role="dialog"] —— 中心没打开，或懒加载块没落地'
    );

    // 3) 点左栏导航项
    const navResult = await evaluate(`(() => {
        const want = ${JSON.stringify(panelId)};
        const nodes = Array.from(document.querySelectorAll("[data-workspace-nav]"));
        const seen = nodes.map(n => String(n.getAttribute("data-workspace-nav")));
        const target = nodes.find(n => n.getAttribute("data-workspace-nav") === want);
        if (!target) return { ok: false, seen: seen };
        target.click();
        return { ok: true, seen: seen };
    })()`);
    if (!navResult || navResult.ok !== true) {
        const seen =
            navResult && Array.isArray(navResult.seen) && navResult.seen.length > 0
                ? navResult.seen.join("、")
                : "（一个都没有）";
        throw new Error(
            caseName +
                ': 左栏没有 data-workspace-nav="' +
                panelId +
                '"，页面上实际有的：' +
                seen
        );
    }

    // 4) 等面板正文真的就绪（不是骨架 / 不是报错态）
    //    文字类判据而不是元素数：元素数在「读取中」和「读完了但 0 条」两种状态下可能一样。
    const readyExpr = `(() => {
        const text = document.body.innerText || "";
        const need = ${JSON.stringify(mustHave)};
        return need.every(t => text.indexOf(t) >= 0);
    })()`;
    try {
        await waitForCondition(evaluate, readyExpr, 20_000, "__ready__");
    } catch {
        const diag = await evaluate(`(() => {
            const text = document.body.innerText || "";
            const need = ${JSON.stringify(mustHave)};
            return {
                missing: need.filter(t => text.indexOf(t) < 0),
                head: text.replace(/\\s+/g, " ").slice(0, 240),
            };
        })()`);
        const missing = diag && Array.isArray(diag.missing) ? diag.missing.join(" / ") : "（未知）";
        const head = diag && diag.head ? diag.head : "";
        throw new Error(
            caseName +
                ": 20 秒内面板正文没就绪（缺 " +
                missing +
                "）—— 停在骨架态或报错态，量到的会是空壳。当前正文开头：" +
                head
        );
    }
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
    const message = `没有 ${path.relative(ROOT, DIST)} —— 先跑 npm run build 再来量（量旧产物等于白量）`;
    console.error(message);
    // 这条也是「失败但没有任何可查证据」的老路：CI 上只留一行 stderr。
    // 落一份 summary 说明「一个用例都没跑、原因是缺构建产物」。
    flush({ status: "error", exitCode: 1, error: message });
    process.exit(1);
}

async function main() {
    requireDist();
    fs.mkdirSync(BASELINE_DIR, { recursive: true });

    const site = await startSiteServer(0);
    const { evaluate, send, done, getErrors } = await openBrowser({ cdpPort: CDP_PORT });

    try {
        for (const vp of VIEWPORTS) {
            for (const scene of SCENES) {
                const caseName = `${vp.name}-${scene.name}`;
                if (FILTER && !caseName.includes(FILTER)) continue;

                // 每个用例先登记「正在跑」：中途抛错时，flush 里能写下死在哪个用例
                const record = {
                    caseName,
                    viewport: vp.name,
                    scene: scene.name,
                    status: "运行中",
                    diffs: [],
                    actualFingerprint: null,
                    baselineFingerprint: null,
                    error: null,
                };
                pendingCase = record;

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

                if (scene.openNavCenterPanel) {
                    await openNavCenterPanel(evaluate, scene, caseName);
                }

                await waitAnimations(evaluate);
                const selectors = BASE_SELECTORS.concat(scene.extraSelectors ?? []);
                const fingerprint = await evaluate(collectExpression(selectors));
                if (!fingerprint || typeof fingerprint !== "object") {
                    throw new Error(`${caseName}: 采集失败（页面没渲染出可量元素？）`);
                }
                record.actualFingerprint = fingerprint;

                const file = path.join(BASELINE_DIR, `${caseName}.json`);
                if (UPDATE) {
                    fs.writeFileSync(file, JSON.stringify(fingerprint, null, 2) + "\n");
                    record.status = "录制基线";
                } else if (!fs.existsSync(file)) {
                    // 不静默录基线（2026-10-24）：老行为在这里 writeFileSync 后当
                    // 「通过」，等于新用例自动获得一张免检金牌。现在记为无基线，
                    // 由汇总段判失败，引导显式 --update。
                    record.status = "无基线";
                } else {
                    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
                    const diffs = diffFingerprint(baseline, fingerprint, TOLERANCE, caseName);
                    record.baselineFingerprint = baseline;
                    record.diffs = diffs;
                    record.status = diffs.length ? "有差异" : "一致";
                }

                // 每个用例跑完**立刻**落盘：中断时前面跑完的那些不能跟着丢
                results.push(record);
                writeCaseEvidence(record);
                pendingCase = null;
            }
        }
    } catch (error) {
        console.error(`\n视觉回归中断：${error?.stack || error}`);
        // 中断分支：能写多少写多少 —— 已跑完的用例各自有文件，再补一份
        // 「死在哪个用例、死在哪一步」的，最后 flush 一份 summary。
        if (pendingCase) {
            pendingCase.status = "中断";
            pendingCase.error = String(error?.message || error);
            results.push(pendingCase);
            writeCaseEvidence(pendingCase);
            pendingCase = null;
        }
        try {
            pageErrors.push(...getErrors());
        } catch {
            // 浏览器已经没了，取不到页面报错不影响落盘
        }
        try {
            site.close();
        } catch {
            // 已经关了：close() 抛错绝不能挡住下面的 flush（那才是要留下的东西）
        }
        flush({ status: "error", exitCode: 1, error: String(error?.stack || error) });
        done(1);
        return;
    }

    try {
        pageErrors.push(...getErrors());
    } catch {
        // 同上
    }
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
        flush({ status: "page-errors", exitCode: 1, error: `页面自身 ${pageErrors.length} 条报错` });
        done(1);
        return;
    }

    const failed = results.filter(r => r.status === "有差异");
    if (failed.length > 0) {
        console.error(
            `\n${failed.length} 个用例与基线不一致。确认是有意的改动就跑：` +
                `\n  npm run audit:visual -- --update`
        );
        flush({
            status: "diff",
            exitCode: 1,
            error: `${failed.length} 个用例与基线不一致（${failed.map(r => r.caseName).join("、")}）`,
        });
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
        flush({
            status: "no-baseline",
            exitCode: 1,
            error: `${missing.length} 个用例没有基线（${missing.map(r => r.caseName).join("、")}）`,
        });
        done(1);
        return;
    }

    console.log(`\n全部 ${results.length} 个用例通过。`);
    // 全过也落盘：证明「这次真的量了 N 个用例」，而不是什么都没跑
    flush({ status: "success", exitCode: 0 });
    done(0);
}

await main().catch(error => {
    // 走到这里说明失败发生在 main 的 try 之外（起本地服务 / 起浏览器 / 建基线目录）：
    // 那种情况既没有 site 也没有 done，但「红了却什么都没留下」同样不该发生。
    console.error(`\n视觉回归未能启动：${error?.stack || error}`);
    flush({ status: "error", exitCode: 1, error: String(error?.stack || error) });
    process.exit(1);
});
