// script/contrast-audit.mjs
// 扫描页面上所有可见文本的对比度（亮 / 暗两态），不达 WCAG AA 即失败。
// 只用标准库 + CDP，不引入 axe 之类的依赖。
//
// 判据：任一态出现「对比度 < 需要的阈值（正文 4.5、大字 3）」即 exit 1。
// 背景色不是简单取父元素：玻璃拟态用了 rgba 半透明层，得把每一层按 alpha
// 依次混上去，否则量出来的对比度是假的。
//
// 覆盖面（每段都亮 / 暗各扫一遍）：首页（**静态 + 悬停态**）→ 记事本
// （**即时渲染 / 源码态各一遍**）→ **记事本·附件抽屉**（常态 / 空态 / 失败 / 无命中）
// → 设置中心。
//
// 2026-11-01 补的三处盲区（同一个病根：缺陷没被审计发现，不是因为界面没问题，
// 而是审计**没走到那个界面态**）：
//   · 记事本原来只扫一遍，而编辑器**先以源码态挂载、useEffect 之后才装即时渲染**，
//     存在一个源码窗口：快机器扫到预览态（绿）、CI 落进源码窗口（红，暗色下
//     `#`/`-` 标记 1.55:1）。现在两态各自确定性切换 + 各自扫描，谁都不靠运气。
//   · 附件抽屉（AttachmentManager）从来不在扫描面上，所以它顶栏分段控件
//     「--accent 压 --accent-wash」的 4.04:1 绿了很久。现在它是独立一段。
//   · **悬停态**：静态那一帧量不到 `:hover` 才生效的颜色，也量不到「悬停才浮现」
//     的控件（它们平时 opacity:0，会被整组跳过）。现在用 CDP 真发鼠标移动补上。
//
// 设置中心是 2026-10-31 加的第 3 段：它的左栏是「选中态淡强调底 + 强调色字」，
// 这一对在亮色下曾只到 4.04:1（AA 要 4.5），前两段一直没扫过它，那条不达标在
// CI 里绿了很久；本轮把 --accent-on-wash 调到 #1565c0 后亮色回到 5.04、暗色 8.04
// 达标。凡是「改了界面但审计没看」的地方，绿灯都不算数 —— 这正是加这段的原因。
//
// ⚠️ **失败必须 fail-closed**：点不到「设置」按钮 / 中心没渲染出来 /
//    `[data-workspace-nav]` 条数不对 —— 一律报红并写明「打不开设置中心，这一阶段
//    没测到」，**绝不允许静默跳过**。一条会悄悄不跑的审计比没有审计更糟：
//    它给出的绿灯会被当成「量过了且没问题」。
//
// 用法：npm run audit:contrast（需要先 npm run build；CHROME_PATH 可指定浏览器）

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CONTRAST_CORE, DIST, openBrowser, setAttachmentMode, startSiteServer, waitRendered } from "./auditEnv.mjs";

if (!fs.existsSync(DIST)) {
    console.error(`找不到 ${DIST}，先跑 npm run build`);
    process.exit(1);
}

// 0 = 让系统分配端口（同 a11y-audit：固定端口撞车就是一次崩溃）
const SITE_PORT = Number(process.env.AUDIT_SITE_PORT || 0);
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9517);

const site = await startSiteServer(SITE_PORT);
const { evaluate, done, chromePath, getErrors, send } = await openBrowser({ cdpPort: CDP_PORT });

// 同为线性脚本的兜底：中途抛错时不处理就会留下孤儿 Chrome（见 a11y-audit 同款注释）
const bail = err => {
    console.error("审计脚本异常：", err?.stack || err);
    try {
        site.close();
    } catch {
        // 已经关了
    }
    done(1);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

console.log(`Chrome: ${chromePath}`);
console.log(`页面: ${site.url}\n`);

await evaluate(`location.href = ${JSON.stringify(site.url + "/?t=" + Date.now())}`);
await waitRendered(evaluate);
// 保证「亮色」轮真的是亮色：直接写 localStorage.theme=light 再重载，
// 不依赖 OS 偏好（本机若是深色，默认会直接进暗色，亮色轮就量错主题了）。
await evaluate(
    `localStorage.setItem('theme', 'light'); location.href = ${JSON.stringify(site.url + "/?t=" + Date.now())}`
);
const buttons = await waitRendered(evaluate);
console.log(`页面已渲染（button ${buttons} 个）\n`);

// 同 a11y-audit：页面报错时「0 处不合格」是假绿，先确认页面干净
const pageErrors = getErrors();
if (pageErrors.length) {
    console.error("页面控制台报错（审计结果不可信）：");
    for (const e of pageErrors.slice(0, 8)) console.error("  - " + String(e).slice(0, 200));
    site.close();
    done(1);
}

const SCAN = `(() => {${CONTRAST_CORE}
  // 数学部分在 auditEnv.mjs 的 CONTRAST_CORE 里（悬停/焦点扫描共用同一份，
  // 不复制 —— 两份数学迟早会漂开）。这里只负责「遍历 + 判定 + 去重」。
  NH.refresh();
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const rec = NH.measure(el);
    // 判据用 rec.ratio（两位小数、已 toFixed）—— 与打印出去的是同一个数
    if (rec && rec.ratio < rec.need) out.push(rec);
  }
  // 去重：同类问题只留一条样本
  const seen = new Set(), uniq = [];
  for (const o of out) {
    const k = o.cls + o.color + o.fontSize;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(o);
  }
  return { total: out.length, unique: uniq.slice(0, 14) };
})()`;

/**
 * 打开记事本并等它真的渲染出来。
 *
 * 为什么要轮询而不是固定 sleep：记事本整块是懒加载的独立 chunk（编辑器 + 预览 +
 * 视图，体量在 300KB 以上），加载时间随机器波动很大。固定等 2 秒在 CI 上大概率
 * 只等到骨架态 —— 而骨架态的对比度是「干净的」（没有文字），量出来 0 处不合格，
 * 正是那种「绿得毫无意义」的假绿。
 *
 * 判据用桩里那条笔记的标题：auditEnv 铺了「会议纪要 / 读书笔记 / 随手记」三条。
 */
const OPEN_NOTES = `(() => {
    const btn = [...document.querySelectorAll('button')]
        .find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
    if (!btn) return 'no-entry';
    btn.click();
    return 'clicked';
})()`;

async function openNotesAndWait() {
    const r = await evaluate(OPEN_NOTES);
    if (r !== "clicked") {
        throw new Error(`记事本入口找不到（${r}）—— 选择器漂了，这一阶段没测到`);
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (await evaluate(`(document.body.innerText || '').includes('会议纪要')`)) return;
        await sleep(300);
    }
    throw new Error("记事本 20 秒内没渲染出来（停在骨架态）—— 这一阶段没测到");
}

/**
 * 等**编辑器**真的挂上来（列表渲染出来 ≠ 正文渲染出来）。
 *
 * 列表与编辑器是两个 chunk：列表标题一出现就开扫，编辑器那块可能还是空的 ——
 * 空区域没有文字，扫出来 0 处，又是那种「绿得毫无意义」的假绿。
 * 判据取三件事同时成立：即时渲染开关在（下面切换两态要用它当把手）、
 * CodeMirror 的 `.cm-content` 在、且正文里真的有字。
 */
const NOTES_EDITOR_READY = `(() => {
  const sw = document.querySelector('input[aria-label="即时渲染"]');
  const cm = document.querySelector('.cm-content');
  return { sw: !!sw, cm: !!cm, len: cm ? (cm.innerText || '').trim().length : 0 };
})()`;

async function waitNotesEditorReady() {
    const deadline = Date.now() + 20_000;
    let st = null;
    while (Date.now() < deadline) {
        st = await evaluate(NOTES_EDITOR_READY);
        if (st && st.sw && st.cm && st.len > 0) return;
        await sleep(200);
    }
    throw new Error(
        `笔记编辑器 20 秒内没挂上来（即时渲染开关 ${st?.sw ? "有" : "没有"}、` +
            `.cm-content ${st?.cm ? "有" : "没有"}、正文 ${st?.len ?? 0} 字）—— 这一步没测到`
    );
}

/**
 * 即时渲染的两种状态**必须分别扫**。
 *
 * 病根：编辑器先以源码态挂载，`useEffect` 之后才把 livePreview 扩展装进 CodeMirror
 * （见 `src/components/NoteEditor.tsx` 里 `wantLive ? livePreview(...) : []` 那段）。
 * 原来的审计只等「笔记列表标题出现」就扫，于是扫到哪个态全看机器快慢 ——
 * 快机器扫到预览态（绿），CI 落进源码窗口（红，暗色下 `#`/`-` 1.55:1）。
 * 缺陷本身已经修好（`--notes-mark` + 自定义 CodeMirror HighlightStyle），
 * 但「到底有没有扫到」这件事没定下来，所以现在不靠运气：两态各切一次、各扫一遍。
 */

/** 切换开关。⚠️ 不要在 click 之后拿 `sw.checked` 当「已生效」—— */
const liveToggleExpr = on => `(() => {
  const sw = document.querySelector('input[aria-label="即时渲染"]');
  if (!sw) return 'no-switch';
  const want = ${on ? "true" : "false"};
  if (sw.checked !== want) sw.click();
  return sw.checked === want ? 'ok' : 'pending';
})()`;

/**
 * 「这一刻到底是预览态还是源码态」。
 *
 * ⚠️ 不能只看开关的 `checked`：MUI Switch 的 input 是受控的，`click()` 之后浏览器
 *    会先把 DOM 的 checked 翻过来，而 React 的状态更新与 CodeMirror 的扩展重配
 *    都还在后面 —— 那半拍里量到的是「开关翻了、正文还没换」，正是我们要堵的那种
 *    「看起来扫过了」。真正的判据是**正文里看不看得见 Markdown 标记**：
 *    源码态段落以 `# 标题` / `- 列表` 的文本形态出现；预览态标记被 widget 替换掉，
 *    行首一个 `#`/`-` 都不会剩（光标不在正文里时是整篇都替换）。
 */
const LIVE_STATE = `(() => {
  const sw = document.querySelector('input[aria-label="即时渲染"]');
  const cm = document.querySelector('.cm-content');
  if (!sw) return { ok: false, why: 'no-switch' };
  if (!cm) return { ok: false, why: 'no-editor' };
  const marked = /(^|\\n)\\s*(#{1,6}\\s|[-*+]\\s|\\d+\\.\\s)/.test(cm.innerText || '');
  return { ok: true, checked: !!sw.checked, sourceVisible: marked };
})()`;

async function setNotesLivePreview(on) {
    const name = on ? "即时渲染（预览态）" : "源码态";
    const r = await evaluate(liveToggleExpr(on));
    if (r === "no-switch") {
        throw new Error(
            '找不到「即时渲染」开关（input[aria-label="即时渲染"]）—— 选择器漂了，' +
                `${name} 这一阶段没测到`
        );
    }
    // 等的是「可观测条件」而不是固定时长：开关已翻 + 正文标记形态已换，两件事同时成立，
    // 且连续两次轮询都成立才算稳定（装饰块是异步重建的，一次命中可能正好落在半拍上）。
    const deadline = Date.now() + 10_000;
    let st = null;
    let hits = 0;
    while (Date.now() < deadline) {
        st = await evaluate(LIVE_STATE);
        if (st && st.ok && st.checked === on && st.sourceVisible === !on) {
            if (++hits >= 2) return;
        } else {
            hits = 0;
        }
        await sleep(150);
    }
    throw new Error(
        `「即时渲染」切到${name}后 10 秒内没稳定（checked=${st?.checked}、` +
            `正文可见 Markdown 标记=${st?.sourceVisible}；期望 checked=${on}、标记可见=${!on}）` +
            " —— 这一阶段没测到"
    );
}

/**
 * 打开设置中心（顶栏那颗「设置」）并等它的左栏渲染出来。
 *
 * ⚠️ 选择器必须**精确**：`显示设置`（DisplayControls）与 `网站设置`（站点卡片）都含
 *    「设置」二字，用 includes 会点到它们身上 —— `script/site-audit.mjs` 里
 *    踩过同一个坑，那里最后是加 `exact: true` 解决的。
 *    另外窄屏下顶栏那颗是 display:none，真能点的其实是底栏那颗，所以要跳过不可见节点。
 *
 * 等待用轮询而不是固定 sleep：中心外壳与九个面板是两级 lazy，落地时间随机器波动。
 * 固定等 2 秒在 CI 上大概率只等到空壳 —— 空壳里没有文字，扫出来 0 处不合格，
 * 正是我们最怕的那种「绿得毫无意义」。
 */
const OPEN_CENTER = `(() => {
  const vis = el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const btn = [...document.querySelectorAll('button,[role="button"]')]
      .filter(vis)
      .find(b => (b.textContent || '').trim() === '设置'
              || (b.getAttribute('aria-label') || '').trim() === '设置');
  if (!btn) return 'no-center-button';
  btn.click();
  return 'clicked';
})()`;

/** 左栏条目数的下限：站点所有者态是 9 条导航 + 1 条退出登录 = 10；
 *  非 owner 也会 ≥ 8。低于 8 说明面板没渲染出来，不能当成「扫过了」。 */
const CENTER_MIN_NAV = 8;

async function openCenterAndWait() {
    const r = await evaluate(OPEN_CENTER);
    if (r !== "clicked") {
        throw new Error(
            `找不到顶栏「设置」按钮（${r}）—— 选择器漂了，设置中心这一阶段没测到`
        );
    }
    const deadline = Date.now() + 20_000;
    let n = 0;
    while (Date.now() < deadline) {
        n = await evaluate(`document.querySelectorAll('[data-workspace-nav]').length`);
        if (typeof n === "number" && n >= CENTER_MIN_NAV) return n;
        await sleep(250);
    }
    throw new Error(
        `设置中心 20 秒内没渲染出左栏（[data-workspace-nav] ${n} 条，` +
            `至少要 ${CENTER_MIN_NAV} 条）—— 这一阶段没测到`
    );
}

/**
 * 等页面上的 CSS 动画 / 过渡停下来再量。
 *
 * 为什么（2026-11-01）：一旦把元素 opacity 混进对比度（见 SCAN 的 groupAlpha），
 * **测量时机会直接污染结果** —— 实测抓到的两处都不是界面问题而是时机问题：
 *   - 首页卡片的 `navReveal 0.5s` 进场动画还没跑完，`MuiPaper` 停在 opacity 0.53，
 *     整张卡片的文字被按 53% 可见度量，白字白底、比值 1.00；
 *   - 设置中心 `MuiDialog-container` 正在淡入（0.695），左栏每一条都被糊掉。
 * 旧扫描器不混 opacity，所以这些「半透明中途」的帧被当完全不透明量了 —— 一直是绿的，
 * 也一直没意义。判据用 `document.getAnimations()`（CSS animation 与 transition 都会
 * 出现在里面），比「轮询某个数字」准，也不会被常驻的 0.7 之类卡住。
 */
async function waitAnimationsSettled(limitMs = 6000) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
        const running = await evaluate(`(() => {
            try {
                // 只算「会改变 opacity 且会结束」的动画：
                //   - 装饰性动画（首页 .nav-aurora 的 navAurora 26s 无限循环，只动 transform）
                //     跟对比度无关，等它等于白等 6 秒 × 5 段 × 2 态；
                //   - 无限循环（spinner/呼吸灯）永远「没停」，等不出结果。
                return document.getAnimations().filter(a => {
                    if (a.playState !== 'running') return false;
                    const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
                    if (t.iterations === Infinity) return false;
                    if (a.transitionProperty) return a.transitionProperty === 'opacity';
                    const kf = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
                    return kf.some(k => Object.prototype.hasOwnProperty.call(k, 'opacity'));
                }).length;
            } catch {
                return 0; // 老浏览器没有 getAnimations：退化成「不等」
            }
        })()`);
        if (!running) return;
        await sleep(100);
    }
    // 超时不抛错，但要**说出来**：静默等满 6 秒会被误当成「等过了」。
    console.warn(`⚠️ 有透明度动画 ${limitMs / 1000}s 内没停，按当前状态量`);
}

/**
 * 附件抽屉（`src/components/AttachmentManager.tsx`）—— 2026-11-01 加的独立一段。
 *
 * 为什么必须单独一段：抽屉顶栏的四档筛选（全部 / 图片 / 文档 / 其他）用的是共用
 * 分段控件，选中文字曾经是 `var(--accent)` 压在 `var(--accent-wash)` 淡底上
 * = **4.04:1**（小字线 4.5）。这个缺陷在 24.0.0 里已经换成 `--accent-on-wash`
 * （亮 5.04 / 暗 8.04），但它**绿了很久**，原因不是界面没问题，而是附件抽屉
 * 从来不在这个脚本的扫描面上 —— 和记事本源码态是同一个病根。现在把它扫进来。
 *
 * ⚠️ 抽屉需要一份**非空**的列表数据才画得出来。`auditEnv.mjs` 的只读桩原先没实现
 *    `GET /api/notes/attachments/list`，请求落回通用的 `{ success: true }`，组件
 *    拿这个对象去 `.slice()` 直接抛 `TypeError: D.slice is not a function` ——
 *    抽屉连挂都挂不上（分段控件一起没了），那一刻扫出来的「0 处」是彻底的假绿。
 *    2026-11-01 起这份桩**下沉到 `auditEnv.mjs`**（见那里的 `ATTACHMENT_ROWS`）：
 *    本脚本原来在页面里内联过一段 `window.fetch` 补丁，只对自己生效、还要抢在
 *    点开抽屉之前注入；a11y-audit 拿不到那份补丁，一碰抽屉就整条崩掉。放到服务端
 *    之后两个审计走同一条路，「谁先注入」这种时序问题不复存在。
 */
/**
 * 打开附件抽屉并等它真的渲染出来。
 *
 * 选择器用 `[data-nav-attachments]`（NotesNavPanel 里那颗 NavRow 的 data 属性），
 * **不用可访问名**：那颗按钮没有 aria-label，名字来自内部文字「附件」——
 * 按文字找会随文案改写而漂。文字只作为 data 属性消失时的兜底。
 */
const OPEN_ATTACHMENTS = `(() => {
  const vis = el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const btn = document.querySelector('[data-nav-attachments]')
      || [...document.querySelectorAll('button,[role="button"]')]
          .filter(vis)
          .find(b => (b.textContent || '').trim() === '附件');
  if (!btn) return 'no-entry';
  btn.click();
  return 'clicked';
})()`;

/** 四档筛选：全部 / 图片 / 文档 / 其他（少一档就说明分段控件没画全）。 */
const ATT_MIN_OPTIONS = 4;

/**
 * 抽屉「真的画完了」的判据：分段控件 4 档都在 + 列表已经落地（没有 loading 态）
 * + 至少有一张卡片。
 *
 * ⚠️ 只等分段控件是不够的：它在抽屉头部同步渲染，而**列表是异步拉的** ——
 *    那一刻网格里是「正在读取附件列表…」的骨架态，卡片 / 文件名 / 引用次数
 *    一个都还没挂，扫出来 0 处不合格，又是「绿得毫无意义」。加这一段原本就是
 *    为了量这些控件，等错对象等于白加。
 * ⚠️ 卡片里的缩略图是**再异步一层**的（带凭据 fetch 字节 → objectURL），
 *    扫的时候它可能停在「图标 + 文件名」或「无法加载」两种占位态之一；
 *    这两种态的颜色都已在 2026-11-01 调到达标（text.secondary / --warn-on-wash），
 *    所以结果不受它影响，不需要为它再加等待条件。
 */
const ATTACHMENTS_READY = `(() => {
  return {
    options: document.querySelectorAll('[data-att-filter-option]').length,
    loading: document.querySelectorAll('[data-att-state="loading"]').length,
    rows: document.querySelectorAll('[data-attachment-row]').length,
    empty: document.querySelectorAll('[data-att-state="empty"]').length,
    error: document.querySelectorAll('[data-att-state="error"]').length,
  };
})()`;

async function openAttachmentsAndWait(expect = "rows") {
    // 列表数据由共用桩（auditEnv.mjs 的 ATTACHMENT_ROWS）提供，这里不再注入 fetch 补丁
    const r = await evaluate(OPEN_ATTACHMENTS);
    if (r !== "clicked") {
        throw new Error(
            `记事本里找不到「附件」入口（${r}）—— 选择器漂了，附件抽屉这一阶段没测到`
        );
    }
    const deadline = Date.now() + 20_000;
    let st = null;
    while (Date.now() < deadline) {
        st = await evaluate(ATTACHMENTS_READY);
        // ⚠️ 判据必须按期望的那一态来等：空态永远等不到「卡片 ≥1」，失败态也等不到。
        //    以前写死 rows>0，一旦桩切成空态就会 20 秒后抛错 —— 看着像「抽屉坏了」，
        //    实际是等待条件跟被测状态对不上。
        if (st && st.options >= ATT_MIN_OPTIONS && st.loading === 0) {
            if (expect === "rows" && st.rows > 0) return st.options;
            if (expect === "empty" && st.empty > 0) return st.options;
            if (expect === "error" && st.error > 0) return st.options;
        }
        await sleep(200);
    }
    throw new Error(
        `附件抽屉 20 秒内没画成「${expect}」态（筛选 ${st?.options ?? 0} 档 / 至少要 ${ATT_MIN_OPTIONS} 档、` +
            `加载中 ${st?.loading ?? "?"} 个、卡片 ${st?.rows ?? 0} 张、空态 ${st?.empty ?? 0} 个、` +
            `失败态 ${st?.error ?? 0} 个）—— 这一阶段没测到`
    );
}

/**
 * 关抽屉并等它真的消失。
 *
 * 用 Esc 而不是点遮罩 / 找关闭键：Drawer（Modal）认 Esc 是 MUI 的固定契约，
 * 而遮罩与关闭键在不同布局下不是同一个节点 —— 按位置点必然随界面漂，
 * 一次漂移就是「关不掉、后面全错」。关完必须确认它**没了**再往下扫，
 * 否则残影会把抽屉里的文字混进下一段（设置中心）的结果里。
 */
const CLOSE_ATTACHMENTS = `(() => {
  const paper = document.querySelector('.MuiDrawer-paper');
  (paper || document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  return true;
})()`;

async function closeAttachmentsAndWait() {
    await evaluate(CLOSE_ATTACHMENTS);
    const deadline = Date.now() + 10_000;
    let n = 1;
    while (Date.now() < deadline) {
        n = await evaluate(`document.querySelectorAll('[data-att-filter-option]').length`);
        if (n === 0) return;
        await sleep(150);
    }
    throw new Error(
        `附件抽屉按 Esc 后 10 秒内没关掉（还剩 ${n} 档筛选）—— 后面的阶段会量到残影，结果不可信`
    );
}

/**
 * 悬停态扫描（2026-11-01 补的第三个盲区）。
 *
 * 病根和前面两个一样，只是更隐蔽：**`SCAN` 只量「静态那一帧」**。而首页上大量文字的
 * 最终颜色是 `:hover` 才生效的 —— 卡片标题悬停转强调色、列表行悬停加深底色、
 * 顶栏按钮悬停换前景色。这些颜色从来没被任何审计看过一眼，因为它们只在指针压上去
 * 的那一刻存在。
 *
 * 更有甚者：`nav-group-tools` 这类「悬停才出现的工具条」平时恒为 `opacity: 0`，
 * 加了 opacity 混算之后会被 `A <= 0.02` 直接跳过 —— 跳过是对的（看不见的东西没有
 * 对比度可言），但也意味着**它们至今一次都没被量过**。悬停之后就看得见了，正好补上。
 *
 * ⚠️ 必须用 CDP 真发 `Input.dispatchMouseEvent`，不能拿 JS 派发合成事件：
 *    `new MouseEvent('mouseover')` 不会让浏览器更新 `:hover`，`getComputedStyle`
 *    拿到的还是未悬停的值 —— 量了等于没量，而且是「看起来很努力」的那种没量。
 */
const HOVER_TARGETS = `(() => {
  const sel = 'a[href], button:not([disabled]), [role="button"], [role="menuitem"], [role="tab"], [tabindex="0"], .MuiChip-root';
  const seen = new Set(), out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    // 只取完整落在视口里的：出界的元素鼠标压不到，:hover 不会生效
    if (r.top < 4 || r.left < 4 || r.bottom > innerHeight - 4 || r.right > innerWidth - 4) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.3) continue;
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    // 同一个坐标只压一次（卡片里套按钮、按钮里套图标，中心点往往是重合的）
    const k = x + ',' + y;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, y, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 14) });
  }
  return out;
})()`;

/**
 * 量「鼠标当前压着的这块」。只量悬停链 + 最深那个元素的后代：
 * 悬停链上是样式变化的元素，后代里是「悬停才浮现」的那些。
 */
const MEASURE_HOVER = `(() => {${CONTRAST_CORE}
  NH.refresh();
  const chain = [...document.querySelectorAll('body *')].filter(el => el.matches(':hover'));
  if (!chain.length) return { total: -1, unique: [] };
  // 最深的一个 = 鼠标真正压着的元素（其余都是它的祖先）
  const deep = chain.find(el => !chain.some(o => o !== el && el.contains(o))) || chain[chain.length - 1];
  const pool = new Set([...chain, ...deep.querySelectorAll('*')]);
  const out = [];
  for (const el of pool) {
    const rec = NH.measure(el);
    if (rec && rec.ratio < rec.need) out.push(rec);
  }
  const seen = new Set(), uniq = [];
  for (const o of out) {
    const k = o.cls + o.color + o.fontSize;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(o);
  }
  return { total: out.length, unique: uniq.slice(0, 14) };
})()`;

/** 把指针挪到不会碰到任何控件的地方，让 `:hover` 彻底失效 */
const PARK_MOUSE = { x: 1, y: 1 };

async function parkMouse() {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: PARK_MOUSE.x, y: PARK_MOUSE.y, button: "none" });
    await sleep(200);
}

/**
 * 扫一遍悬停态。
 *
 * 每个目标：移过去 → **等过渡跑完** → 量。等待用固定的 320ms 而不是
 * `waitAnimationsSettled()`：后者只认「会改 opacity」的动画，而悬停改的多半是
 * color / background-color（那些过渡它一条都不会等）；同时 320ms 也盖住了
 * 「悬停才浮现」的 opacity 过渡（项目里最长的是 220ms）。
 * 量早了会把中间帧当成终值 —— 24.4.0 那轮就是被半截动画喂出 24 条假红。
 */
async function scanHover(label) {
    const targets = await evaluate(HOVER_TARGETS);
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error(`首页找不到任何可悬停目标（${targets?.length ?? targets}）—— 选择器漂了，悬停态没测到`);
    }
    let total = 0;
    const seenKeys = new Set();
    const samples = [];
    for (const t of targets) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t.x, y: t.y, button: "none" });
        await sleep(320);
        const res = await evaluate(MEASURE_HOVER);
        // -1 = 鼠标下面一个 `:hover` 都没有：坐标算错了，不能当成「0 处」
        if (res.total < 0) {
            throw new Error(
                `移到「${t.label}」(${t.x},${t.y}) 之后没有任何元素处于 :hover —— ` +
                    "坐标或视口不对，悬停态没测到"
            );
        }
        total += res.total;
        for (const u of res.unique) {
            const k = u.cls + u.color + u.fontSize;
            if (seenKeys.has(k)) continue;
            seenKeys.add(k);
            samples.push({ ...u, via: t.label });
        }
    }
    await parkMouse();
    console.log(
        `=== ${label}·悬停态（${targets.length} 个目标）：不合格 ${total} 处（去重后前 ${Math.min(samples.length, 14)} 条）===`
    );
    for (const u of samples.slice(0, 14)) {
        console.log(
            `  ${String(u.ratio).padStart(5)} / 需 ${u.need}  ${String(u.fontSize).padStart(4)}px  ` +
                `${u.color} on ${u.bg}  「${u.text}」  ${u.cls}  ← 悬停「${u.via}」`
        );
    }
    return total;
}

/**
 * 附件抽屉对比度的预算：**0**，与 `NOTES_CONTRAST_BUDGET` 同一个口吻。
 *
 * 抽屉在 24.0.0 之前从没被这个脚本量过：顶栏分段控件「--accent 压 --accent-wash」
 * 只有 4.04:1（小字线 4.5），一直绿着。选中文字换成 `--accent-on-wash` 之后
 * 亮色 5.04、暗色 8.04 —— 达标，但达标不是重点，「以后不会再绿着」才是。
 *
 * 所以这里钉死 0，和首页 / 记事本 / 设置中心同一把尺子：抽屉里任何一处不达 AA
 * 都直接失败。以后要放宽必须改这个常量，而它就在 CI 日志第一屏 ——
 * 改不动声色的那种操作。
 */
const ATTACHMENTS_CONTRAST_BUDGET = 0;

/**
 * 记事本对比度的预算（2026-10-24 接入记事本时先设 4，同日修完后降到 0）。
 *
 * 当时那 4 处的根因是同一个：`NotesPage.tsx` 用内联 style 把 `--accent` 覆盖成
 * 记事本设置里的 `notesSettings.accent`，而它的默认值 `#b0433a` **在亮/暗两态
 * 都不达 AA**（亮 4.18:1 / 暗 3.19:1）—— 也就是「默认外观本身就不达标」。
 *
 * 修法（已完成）：
 *   ① `DEFAULT_NOTES_SETTINGS.accent` 改成空串 = 跟随主题；注入时写
 *      `--accent: var(--notes-accent)`，由 index.css 按亮/暗分态给值
 *      （亮 #a03c32 ≈ 4.85:1、暗 #c96e60 ≈ 5.19:1）；
 *   ② 账号 Avatar 的文字色改成 `var(--on-accent)`（「强调色底上的字」专用 token），
 *      不再落 MUI 默认的 `background.default`（暗色下那个是深色，压浅红底只有 3.31:1）；
 *   ③ 存量里存着 `#b0433a` 的视同「没设过」，跟着默认一起升级。
 *
 * 预算现在钉死 0：记事本与首页同一把尺子，任何一处不达 AA 都直接失败。
 * 以后要放宽必须改这个常量，而它就在 CI 日志的第一屏 —— 改不动声色的那种操作。
 */
const NOTES_CONTRAST_BUDGET = 0;

/** 报告一段扫描结果（首页 / 记事本 / 设置中心共用同一套输出格式） */
function report(label, res) {
    console.log(`=== ${label}：不合格 ${res.total} 处（去重后前 ${res.unique.length} 条）===`);
    for (const u of res.unique) {
        console.log(
            `  ${String(u.ratio).padStart(5)} / 需 ${u.need}  ${String(u.fontSize).padStart(4)}px  ${u.color} on ${u.bg}  「${u.text}」  ${u.cls}`
        );
    }
}

/**
 * 重载回首页并等它渲染完。
 *
 * 为什么不点「关闭」：关闭入口在不同布局下不是同一个控件（窄屏是返回、桌面是右上角 ×，
 * 中心还额外认 Esc），按文案找必然随界面漂移 —— 一次漂移就是一次「关不掉、后面全错」。
 * 重载是唯一稳的「回到起点」。
 */
async function reloadHome() {
    await evaluate(`location.href = ${JSON.stringify(site.url)}`);
    await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
}

/**
 * 切界面之后核对主题没漂。
 *
 * 为什么必须核：主题存在 localStorage 里，正常重载会保持；但**存储被清 / 持久化被改坏**
 * 时页面会悄悄退回亮色 —— 那样「暗色·设置中心」这一轮量的其实是亮色，
 * 暗色下的问题被整个跳过，而日志上仍然写着「暗色 0 处不合格」。宁可红。
 */
async function assertSameTheme(expected, where) {
    const now = await evaluate(`getComputedStyle(document.body).backgroundColor`);
    if (now !== expected) {
        console.error(
            `主题在切界面时漂了（${where}：期望背景 ${expected}，实际 ${now}）—— ` +
                "这一段量到的不是本轮主题，结果不可信"
        );
        site.close();
        done(1);
    }
}

let failed = 0;
let hoverFailed = 0;
let notesFailed = 0;
let attachmentsFailed = 0;
let centerFailed = 0;
let lightBg = null;
for (const label of ["亮色", "暗色"]) {
    if (label === "暗色") {
        lightBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
        // 走 app 真实的「持久化深色」路径：写 localStorage.theme=dark 再重载。
        // 不点「显示设置 → 深色」菜单——那个只给本次会话加 .dark class、**不写
        // localStorage**，重载就退回亮色，会让「暗色·设置中心」这轮量到的其实是
        // 亮色、暗色问题被整个跳过（2026-10-31 这一版踩过的坑）。
        await evaluate(
            `localStorage.setItem('theme', 'dark'); location.href = ${JSON.stringify(site.url + "/?t=" + Date.now())}`
        );
        await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
        // ⚠️ 切换没生效时必须报错而不是「照测一遍」：那样两态测的都是亮色，
        // 暗色态的对比度问题会被整个跳过，审计变成假绿。
        const darkBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
        if (darkBg === lightBg) {
            console.error(
                `主题切换没生效（背景 ${lightBg} → ${darkBg}）——` +
                    "暗色态实为亮色，审计结果不可信"
            );
            site.close();
            done(1);
        }
        console.log(`主题已切换（背景 ${lightBg} → ${darkBg}）`);
    }
    await waitAnimationsSettled();
    const res = await evaluate(SCAN);
    failed += res.total;
    report(label, res);

    // ---------- 悬停态（2026-11-01 加）----------
    //
    // 上一步量的是「静态那一帧」。首页上大量文字的终色是 :hover 才生效的
    // （卡片标题转强调色、行底色加深、按钮换前景色），这些颜色至今没被量过。
    // 详情见 scanHover / HOVER_TARGETS 上的注释。
    hoverFailed += await scanHover(label);

    // 本轮的主题背景色，后面每次重载/换界面都要拿它核对一遍（见下面的主题漂移断言）
    const roundBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);

    // ---------- 记事本（2026-10-24 加；2026-11-01 拆成两态 + 附件抽屉）----------
    //
    // 首页全绿只说明首页没问题。记事本是另一套界面（左栏 / 列表 / 编辑器 / 工具栏 /
    // 状态栏），而且它整块是懒加载的独立 chunk —— 从来没被对比度审计看过一眼。
    //
    // ⚠️ 两态必须分别扫：编辑器先以源码态挂载，`useEffect` 之后才装即时渲染，
    //    只扫一遍等于掷骰子（快机器扫到预览态、CI 落进源码窗口）。见 setNotesLivePreview。
    await openNotesAndWait();
    await waitNotesEditorReady();

    await setNotesLivePreview(true);
    await waitAnimationsSettled();
    const notesLive = await evaluate(SCAN);
    notesFailed += notesLive.total;
    report(`${label}·记事本·即时渲染`, notesLive);

    await setNotesLivePreview(false);
    await waitAnimationsSettled();
    const notesSource = await evaluate(SCAN);
    notesFailed += notesSource.total;
    report(`${label}·记事本·源码态`, notesSource);

    // 切回默认（预览态）再量抽屉：抽屉盖在记事本上，扫的是「用户日常看到的那个
    // 记事本 + 一个抽屉」，而不是「源码态 + 抽屉」这种谁都不会同时看到的组合。
    await setNotesLivePreview(true);
    const attOptions = await openAttachmentsAndWait();
    await waitAnimationsSettled();
    const attachments = await evaluate(SCAN);
    attachmentsFailed += attachments.total;
    report(`${label}·记事本·附件抽屉（筛选 ${attOptions} 档）`, attachments);
    await closeAttachmentsAndWait();

    // ---------- 抽屉的空态 / 拉取失败态（2026-11-01 加）----------
    //
    // 这三个分支各自有一套文字与配色，`data-att-state` 就是它们的钩子：
    //   empty（「还没有上传过任何附件。」）/ none-match（「没有符合筛选的附件。」）
    //   / error（`{error}` 渲染成 error.main）。
    // 以前一条都没进过扫描面 —— 而空态/失败态的说明文字恰恰是最没人核色的地方。
    // 桩态在 auditEnv.mjs（setAttachmentMode），必须在**重新打开抽屉之前**改。
    await setAttachmentMode("empty");
    await openAttachmentsAndWait("empty");
    await waitAnimationsSettled();
    const attEmpty = await evaluate(SCAN);
    attachmentsFailed += attEmpty.total;
    report(`${label}·附件抽屉·空态`, attEmpty);
    await closeAttachmentsAndWait();

    await setAttachmentMode("error");
    await openAttachmentsAndWait("error");
    await waitAnimationsSettled();
    const attError = await evaluate(SCAN);
    attachmentsFailed += attError.total;
    report(`${label}·附件抽屉·拉取失败`, attError);
    await closeAttachmentsAndWait();

    // 无命中态（「没有符合筛选的附件。」）：列表**非空**、但某一档筛不出东西。
    // 它和空态是两个分支（`files.length === 0` 与 `filtered.length === 0`），
    // 各自写了一遍 sx —— 前面两态改完才敢说「这两行都对了」，所以也要量。
    await setAttachmentMode("images");
    await openAttachmentsAndWait();
    const picked = await evaluate(`(() => {
        const b = document.querySelector('[data-att-filter-option="document"]');
        if (!b) return 'no-option';
        b.click();
        return 'clicked';
    })()`);
    if (picked !== "clicked") {
        throw new Error(`附件抽屉里找不到「文档」筛选档（${picked}）—— 无命中态没测到`);
    }
    {
        const deadline = Date.now() + 10_000;
        let hit = 0;
        while (Date.now() < deadline) {
            hit = await evaluate(`document.querySelectorAll('[data-att-state="none-match"]').length`);
            if (hit > 0) break;
            await sleep(150);
        }
        if (hit === 0) {
            throw new Error("点了「文档」筛选但 10 秒内没出现无命中态 —— 这一态没测到");
        }
    }
    await waitAnimationsSettled();
    const attNone = await evaluate(SCAN);
    attachmentsFailed += attNone.total;
    report(`${label}·附件抽屉·无命中`, attNone);
    await closeAttachmentsAndWait();
    // 复原：后面的段落（设置中心）不该被这个桩态影响
    await setAttachmentMode("rows");

    // 回首页：直接重载比「点关闭按钮」稳（关闭入口在不同布局下不是同一个按钮），
    // 而且重载后才能保证下一轮「切主题」是在首页上操作的。
    await reloadHome();
    await assertSameTheme(roundBg, `${label}·设置中心`);

    // ---------- 设置中心（2026-10-31 加）----------
    //
    // 前两段都在「首页 / 记事本」，而设置中心是另一套外壳（左栏导航 + 右栏面板），
    // 它的选中态走的是「淡强调底 + 强调色字」这对 token —— 和首页那些按钮不是一套。
    // 加这一段之前，中心左栏的对比度从来没被任何自动审计看过。
    //
    // 失败一律 fail-closed（见文件头）：打不开中心就报红，不许「跳过这一段继续绿」。
    const navCount = await openCenterAndWait();
    await waitAnimationsSettled();
    const center = await evaluate(SCAN);
    centerFailed += center.total;
    report(`${label}·设置中心（左栏 ${navCount} 条）`, center);

    // 收尾回首页：下一轮「切主题」必须在没有 Modal 遮挡的页面上操作
    await reloadHome();
}

console.log("");
if (failed > 0) {
    console.error(`对比度审计失败：首页（亮/暗两态）共 ${failed} 处不达 WCAG AA`);
    site.close();
    done(1);
}
// 悬停态：没有预算。只在指针压上去那一刻才存在的颜色，此前一处都没量过。
if (hoverFailed > 0) {
    console.error(
        `对比度审计失败：首页悬停态（亮/暗两态）共 ${hoverFailed} 处不达 WCAG AA —— ` +
            "这些颜色只在鼠标压上去的那一帧存在，静态扫描永远看不到"
    );
    site.close();
    done(1);
}
// 记事本：存量预算内放行，但明细已经打印在上面（见 NOTES_CONTRAST_BUDGET 的说明）
if (notesFailed > NOTES_CONTRAST_BUDGET) {
    console.error(
        `对比度审计失败：记事本（即时渲染 + 源码态）${notesFailed} 处不达 WCAG AA，` +
            `预算 ${NOTES_CONTRAST_BUDGET} 处（2026-10-24 起已清零，记事本与首页同一把尺子）`
    );
    site.close();
    done(1);
}
// 附件抽屉：与首页同一把尺子，预算 0 —— 见 ATTACHMENTS_CONTRAST_BUDGET 的说明
if (attachmentsFailed > ATTACHMENTS_CONTRAST_BUDGET) {
    console.error(
        `对比度审计失败：记事本·附件抽屉 ${attachmentsFailed} 处不达 WCAG AA，` +
            `预算 ${ATTACHMENTS_CONTRAST_BUDGET} 处（这个抽屉 2026-11-01 才第一次被量，` +
            "预算一开始就钉 0，别为了让绿灯好看去动它）"
    );
    site.close();
    done(1);
}
// 设置中心：与首页同一把尺子，没有预算 —— 一处都不许有
if (centerFailed > 0) {
    console.error(`对比度审计失败：设置中心（亮/暗两态）共 ${centerFailed} 处不达 WCAG AA`);
    site.close();
    done(1);
}
console.log(
    "\n对比度审计通过（首页（含悬停态）/ 记事本·即时渲染 / 记事本·源码态 / " +
        "记事本·附件抽屉（常态·空态·失败·无命中）/ 设置中心，亮暗两态各 0 处不合格）"
);
site.close();
done(0);
