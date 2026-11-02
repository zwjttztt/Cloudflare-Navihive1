// script/a11y-audit.mjs
// 页面级可访问性审计：无名控件 / 触控目标尺寸 / 破图。
//
// 这是第 13 轮体检里那两个脚本的「能自动回归」版本：原先放在仓库外的 harness/
// 下，只能人工实跑，所以 10 月那次量出来的「分组圆点 14×14 不达 WCAG 2.5.8」
// 一直躺到这次专项才修。现在进 CI，每跑一次就有一次判据。
//
// 判据（任一项命中即 exit 1）：
//   - 无名按钮 / 无 alt 图片 / 无 label 输入
//   - 可点元素 < 24px（WCAG 2.5.8 底线）
//   - 破图
// 焦点可见性也是判据（用 CDP 发真 Tab 键触发 :focus-visible，见第 4 节）。
//   - 滚动帧耗时 / 堆内存：CI 机器性能差异太大，钉死阈值只会偶发假红。
//
// 覆盖面（2026-11-01 起四段）：首页 → 记事本 → 设置中心 → **记事本·附件抽屉**。
// 加第三段的理由：中心是另一个 Modal 外壳 + 左栏导航（`Box component="button"`，
// 行高随视口在 36/44 之间切），前面的「弹窗」一节只看命令面板（Ctrl+K），
// 中心那一整套从没被量过 —— 行高从 44 压到 36 那次，判据只能靠人肉确认。
// 加第四段的理由：附件抽屉是盖在记事本上的又一个界面态，里面的四档筛选、
// 「文件名 = 预览入口」的裸按钮、悬停浮出的删除按钮从没被量过；对比度审计把它
// 纳入扫描面时当场抓出 7 处不达标 —— 「没扫过的面 = 假的绿」已经应验过一次。
//
// ⚠️ 每一段都 **fail-closed**：入口找不到 / 界面没渲染出来 → 报红并写明「没测到」，
//    绝不静默跳过。一条会悄悄不跑的审计比没有审计更糟：它的绿灯会被当成
//    「量过了且没问题」。
//
// 用法：npm run audit:a11y（需要先 npm run build；CHROME_PATH 可指定浏览器）

import { CONTRAST_CORE, DIST, ROOT, openBrowser, setAttachmentMode, startSiteServer, waitRendered } from "./auditEnv.mjs";
import fs from "node:fs";

if (!fs.existsSync(DIST)) {
    console.error(`找不到 ${DIST}，先跑 npm run build`);
    process.exit(1);
}

// 0 = 让系统分配端口：固定端口撞上别的进程就是一次 EADDRINUSE
const SITE_PORT = Number(process.env.AUDIT_SITE_PORT || 0);
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9516);

const site = await startSiteServer(SITE_PORT);
const { evaluate, send, done, chromePath, getErrors } = await openBrowser({ cdpPort: CDP_PORT });

// 这两个脚本是「一路顶层 await 写下来」的，中途抛错不会进任何 try/catch：
// 不兜住的话脚本崩在半路，Chrome 与本地服务会变成孤儿进程留在后台
// （占着 CDP 端口，下一次跑直接连不上）。
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
// 标签栏（TagBar）在「没有标签、没有失效链接、没开星标筛选」时整条不渲染，
// 而它里面全是没有焦点环的 MuiChip —— 不塞数据的话焦点判据会**整类漏测**，
// 量出来一片绿其实什么都没验（2026-10-20 反向验证时就是这么被骗过去的）。
// 用 addScriptToEvaluateOnDocument 在**文档加载前**把标签写进 localStorage：
// 先 setItem 再 location.reload() 那条路走不通 —— reload 会让后续的
// Runtime.evaluate 撞上导航中，waitRendered 直接 30s 超时（实测）。
await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try{localStorage.setItem("navihive:tags",${JSON.stringify(JSON.stringify({ 11: ["工具"], 12: ["工具", "开发"] }))})}catch(e){}`,
});
const buttons = await waitRendered(evaluate);
console.log(`页面已渲染（button ${buttons} 个）\n`);

// 页面自己报错时，量出来的「0 项不合格」是假绿 —— 先确认页面是干净的
const pageErrors = getErrors();
if (pageErrors.length) {
    console.error("页面控制台报错（审计结果不可信）：");
    for (const e of pageErrors.slice(0, 8)) console.error("  - " + String(e).slice(0, 200));
    site.close();
    done(1);
}

// ---------- 扫描表达式（提成常量：首页与记事本要各扫一遍） ----------
//
// 2026-10-24 起审计覆盖**两个页面**：首页与记事本。提取常量而不是复制两份代码，
// 是因为「首页与记事本的判据必须是同一套」—— 各写一份迟早会漂移，
// 而漂移之后量出来的绿灯就说明不了任何事。

/**
 * 无名按钮 / 无 alt 图 / 无标签输入 / 焦点可及数量。
 *
 * 提成**可限根**的函数（2026-11-01），写法照下面的 `scanTouch`：
 *   · 不传 = 整页（首页 / 记事本两段的行为与参数化之前**一字不差**）
 *   · 传选择器 = 只在那一个根里扫
 *
 * 为什么必须能限根：附件抽屉盖在记事本上时，记事本整页的控件仍在 DOM 里，
 * 整页扫会把「记事本 94 个按钮」和「抽屉里那十几个」混成一个数 ——
 * 「抽屉里到底几个无名控件」就说不出来了。判据只有一份实现：
 * 各写一遍迟早漂移，漂移之后的绿灯说明不了任何事。
 *
 * ⚠️ 根找不到时返回 `{ missing: true }`（与 scanTouch 同一个约定），
 *    调用方必须 fail-closed，不许把「没找到根」当成「扫了 0 处问题」。
 *    注意 normal 分支**不返回** missing 字段 —— 首页 / 记事本两段的
 *    JSON 输出要跟参数化之前完全一致，多一个 false 也算变了。
 */
const scanA11y = rootSelector => `(() => {
  const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)}) || null` : "document"};
  if (!root) return { missing: true };
  const q = s => [...root.querySelectorAll(s)];
  const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const noNameBtns = q('button').filter(b => !nameOf(b)).length;
  const noAltImgs  = q('img').filter(i => !i.getAttribute('alt')).length;
  const inputsNoLabel = q('input, select, textarea').filter(i => {
      if (i.type === 'hidden') return false;
      // ⚠️ 隐藏的输入不算：记事本有 <input type="file" style="display:none">，
      // 由旁边的按钮调 .click() 触发。用户看不到、也 Tab 不到，
      // 给它加 aria-label 是形式主义；判据本意是「**可见**的输入要有可访问名」。
      // （2026-10-24 扩大到记事本时暴露的判据缺陷 —— 首页没有隐藏 file input，
      //   所以这条一直没被触发过。）
      const cs = getComputedStyle(i);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (i.getAttribute('aria-label')) return false;
      // 这里刻意用 **document** 而不是 root：<label for> 允许挂在根外面，
      // 限根扫描不该因为「标签在抽屉外」就把它判成无标签。
      if (i.id && document.querySelector('label[for="' + i.id + '"]')) return false;
      return !i.closest('label');
  }).length;
  const focusables = q('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])').length;
  const negTab = q('[tabindex="-1"]').length;
  const h1 = q('h1').length;
  const land = { header: q('header').length, main: q('main').length, nav: q('nav').length };
  return { buttons: q('button').length, noNameBtns, imgs: q('img').length, noAltImgs, inputsNoLabel, focusables, negTab, h1, land };
})()`;

/**
 * 触控目标尺寸（判 24px = WCAG 2.5.8；24~31px 只提示不判失败）。
 *
 * 提成函数而不是一个常量，是为了让「设置中心」那一段能**限定在弹窗里**扫：
 * 中心打开时首页的按钮仍在 DOM 里（只是被 Modal 盖住），整页扫会把两套界面
 * 混成一个数，「中心里 11 个」这种结论就说不出来了。
 * 判据只有一份实现 —— 各写一遍迟早漂移，漂移之后的绿灯说明不了任何事。
 */
const scanTouch = scopeSelector => `(() => {
  const root = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)}) || null` : "document"};
  if (!root) return { total: 0, tooSmall: 0, samples: [], borderline: 0, warnSamples: [], missing: true };
  // ⚠️ 亚像素容差（2026-11-01，CI 假红之后加的）。
  //    背景：记事本行尾的「⋯ 的操作」按钮是 padding 3px + 18px 图标 = **24.00**，
  //    本机实测正是 24.00；同版本代码在 CI 上被判「小于 24px 1 个」，日志里却打印
  //    「24×24」—— 因为**判据比的是原始浮点、打印用的是取整**，两个数字不是同一个。
  //    浏览器布局单位是 LayoutUnit（1/64 px），再加上 devicePixelRatio 贴齐，
  //    24px 的盒子完全可能报成 23.98 或 24.02；这不是缺陷，是渲染精度。
  //    容差取 0.5：远大于 LayoutUnit 舍入（≤1/64≈0.016）与 DPR 贴齐误差，
  //    又远小于任何有意义的尺寸差 —— 23.5 依然判红，真缩水到 22/20 抓得住。
  const EPS = 0.5;
  const els = [...root.querySelectorAll('button, a[href], [role="button"], [role="option"]')];
  const small = [], warn = [];
  for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      // 悬停才浮出、平时 pointer-events:none 的不算可点元素
      if (s.pointerEvents === 'none' || s.visibility === 'hidden') continue;
      const rec = {
          cls: el.className.toString().slice(0, 40),
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 16),
          parent: (el.parentElement && el.parentElement.className.toString().slice(0, 30)) || '',
          // 打印的就是**被判定**的那个数（两位小数）：日志里看到 24，就真的是 24 附近，
          // 不会出现「打印 24、却判小于 24」这种没法复现的鬼话。
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
      };
      if (r.height < 24 - EPS || r.width < 24 - EPS) small.push(rec);
      else if (r.height < 32 - EPS || r.width < 32 - EPS) warn.push(rec);
  }
  return { total: els.length, tooSmall: small.length, samples: small.slice(0, 20), borderline: warn.length, warnSamples: warn.slice(0, 10) };
})()`;

/** 破图（等 2s 让懒加载图落地） */
const SCAN_IMAGES = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(2000);
  const imgs = [...document.querySelectorAll('img')];
  const bad = imgs.filter(i => i.complete && i.naturalWidth === 0);
  return { total: imgs.length, broken: bad.length, srcs: bad.slice(0,5).map(i => i.src.slice(0, 90)) };
})()`;

/** 量当前焦点元素有没有可见的焦点指示（输入框认聚焦边框，见下面的说明） */
const SCAN_FOCUS = `(() => {${CONTRAST_CORE}
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const outlineVisible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth || '0') > 0;

  /**
   * 焦点环的**对比度**（2026-11-01 补的洞）。
   *
   * 以前这一节只判「有没有环」—— 有 2px 的环就算过。可 WCAG 1.4.11 要的是
   * 非文本对比 ≥ 3:1：一圈几乎与底色同色的细环，在键盘用户眼里等于没有。
   * 「有环」和「环看得见」是两件事，前者绿灯不代表后者。
   *
   * 量法：环的颜色按它自己的 alpha 混到**身后那层底**上，再与底色比比值。
   * 半透明环（rgba 主色 40% 之类）必须混算，否则会当纯色算出虚高的比值。
   */
  const ringOf = raw => {
    const bg = NH.bgBehind(el.parentElement || el);
    const rgb = NH.parse(raw || '');
    if (!rgb) return null;
    const a = NH.alphaOf(raw);
    const on = rgb.map((v, k) => v * a + bg[k] * (1 - a));
    return {
      color: raw,
      alpha: +a.toFixed(2),
      bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
      ratio: +NH.ratio(on, bg).toFixed(2),
      need: 3,
    };
  };

  // 输入框是例外：项目刻意不给它补外圈 outline（会与 MUI 的聚焦边框叠成
  // 双红圈，见 useThemeController 的 MuiInputBase 注释），焦点指示是
  // 「边框 1px 灰 → 2px 主色」。所以这里认 .Mui-focused + fieldset 加粗，
  // 不认 outline/boxShadow —— 否则输入框永远假红。
  let via = 'outline/boxShadow';
  if (el.tagName === 'INPUT' && !outlineVisible && s.boxShadow === 'none') {
    const root = el.closest('.MuiOutlinedInput-root, .MuiInputBase-root');
    const fs = root && root.querySelector('fieldset');
    const focused = !!root && root.classList.contains('Mui-focused');
    const w = fs ? parseFloat(getComputedStyle(fs).borderTopWidth || '0') : 0;
    if (focused && w >= 2) { via = 'focus-border'; }
    return {
      tag: el.tagName,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18),
      outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle,
      boxShadow: 'none',
      visible: true, via,
      // 聚焦边框本身就是那圈指示，颜色取 fieldset 的边框色
      ring: via === 'focus-border' && fs ? ringOf(getComputedStyle(fs).borderTopColor) : null,
    };
  }
  return {
    tag: el.tagName,
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18),
    outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle,
    boxShadow: s.boxShadow === 'none' ? 'none' : 'has',
    visible: outlineVisible || s.boxShadow !== 'none', via,
    ring: outlineVisible
      ? ringOf(s.outlineColor)
      // box-shadow 里的颜色：写明了就取那一个，没写明就是 currentColor
      : (s.boxShadow !== 'none' ? ringOf((s.boxShadow.match(/rgba?\\([^)]*\\)|color\\([^)]*\\)/) || [s.color])[0]) : null),
  };
})()`;

/**
 * 焦点指示由**子元素**承担的元素的兜底判定。
 *
 * 背景（2026-10-24 扩大审计面时发现）：记事本的两条列宽拖动条
 * （`paneChrome.tsx` 的 ColResizeHandle）刻意把宿主元素的 outline 设成 none，
 * 改用「聚焦时把那条 1px 发丝线变成 2px 主色」来表达焦点 —— 这是有效的焦点指示，
 * 但只量宿主的 outline/boxShadow 是量不到的，会被判成「键盘用户找不到焦点」。
 *
 * 判法：只对**显式带 `data-focus-indicator="child"` 标记**的元素做这个额外探测 ——
 * 先记子元素的计算样式，blur 后再记一次，有变化就说明指示确实由子元素承担。
 *
 * ⚠️ 必须是显式标记，不能让审计自己猜「凡是子元素有变化的都算」：
 * 那会把 hover 效果、过渡动画中间帧全算进来，等于给这类判据开后门。
 */
const SCAN_CHILD_INDICATOR = `(async () => {
  const el = document.activeElement;
  if (!el || !el.hasAttribute('data-focus-indicator')) return null;
  const child = el.firstElementChild;
  if (!child) return null;
  const read = () => {
    const s = getComputedStyle(child);
    return s.width + '|' + s.backgroundColor + '|' + s.borderTopWidth;
  };
  const focused = read();
  el.blur();
  // 过渡要跑完才有终值；两帧不够就等一会儿（transition 是 220ms）
  await new Promise(r => setTimeout(r, 320));
  const blurred = read();
  el.focus();
  await new Promise(r => setTimeout(r, 80));
  return { focused, blurred, changed: focused !== blurred };
})()`;

/**
 * Tab 一遍，收集每个焦点元素的可见性。
 *
 * ⚠️ 为什么必须发真 Tab 键（Input.dispatchKeyEvent）而不是 `el.focus()`：
 * `el.focus()` **不触发 :focus-visible**，量出来恒为「outline 0 + boxShadow none」，
 * 看着像全员不可见。2026-10-20 就是这么误判过一次，差点给所有 Chip 补一堆无用的焦点环。
 */
async function focusSweep(steps = 30) {
    const out = [];
    for (let i = 0; i < steps; i++) {
        await send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
        });
        await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
        });
        await new Promise(r => setTimeout(r, 70));
        const info = await evaluate(SCAN_FOCUS);
        if (!info) continue;
        // 宿主没有 outline/boxShadow 时，看看它是不是声明了「由子元素承担」
        if (!info.visible) {
            const childInfo = await evaluate(SCAN_CHILD_INDICATOR);
            if (childInfo?.changed) {
                info.visible = true;
                info.via = "child-indicator";
                info.childFrom = childInfo.blurred;
                info.childTo = childInfo.focused;
            }
        }
        out.push(info);
    }
    return out;
}

// ---------- 1. 可访问性：无名按钮 / 无 alt 图片 / 无标签输入 ----------
const a11y = await evaluate(scanA11y());
console.log("=== 可访问性 ===");
console.log(JSON.stringify(a11y, null, 1));

// ---------- 2. 触控目标尺寸（桌面视口 1440）----------
// 判定线 WCAG 2.5.8 的 24px；24~31px 只提示不判失败（卡片浮层控件按用户要求收小过）
const touch = await evaluate(scanTouch());
console.log("=== 触控目标（判定线 24px = WCAG 2.5.8）===");
console.log(`   可点元素 ${touch.total} 个：低于 24px 的 ${touch.tooSmall} 个，24~31px 的 ${touch.borderline} 个`);
for (const s of touch.samples) {
    console.log(`   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`);
}
for (const s of touch.warnSamples) {
    console.log(`   ~ ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}`);
}

// ---------- 3. 破图 ----------
const broken = await evaluate(SCAN_IMAGES);
console.log("=== 图片加载 ===");
console.log(JSON.stringify(broken, null, 1));

// ---------- 4. 焦点可见性（真 Tab 键 → :focus-visible，作为判据）----------
//
// ⚠️ 曾经这一节「只打印不判据」，理由是 `el.focus()` 不触发 `:focus-visible`，
// 量出来恒为不可见 —— 那是**测量方法错了**，不是页面没问题。老脚本量出来的
// 「常用工具」outlineWidth 3px 而 outlineStyle none，等于全员不可见，纯假数据。
// 现在改用 CDP 发真 Tab 键（Input.dispatchKeyEvent）：由浏览器按真实键盘规则
// 决定什么时候挂 :focus-visible，量出来的才是用户看到的样子。
const focusVis = await focusSweep(30);
console.log("=== 焦点可见性（真 Tab 键，作为判据）===");
focusVis.forEach(f => console.log("  ", f.visible ? "ok  " : "MISS", JSON.stringify(f)));

// ---------- 4.5 弹窗（2026-10-30 加）----------
//
// 为什么必须有这一节（F-7 / Y-3）：弹窗是**另一套焦点规则** —— 焦点陷阱、关闭后
// 归位、aria-modal。而首页与记事本那两遍扫描都是在「没有弹窗」的 DOM 上做的，
// 弹窗里那批控件从来没被任何自动审计看过。首页全绿推不出弹窗没问题。
//
// 入口选 Ctrl+K（命令面板），不点「设置 → 全站设置」：
//   ① 菜单是两步操作，选择器还会随菜单项文案漂移（文案一改就静默漏测）；
//   ② 快捷键是产品合同的一部分，用它当入口顺带把快捷键本身也验了。
//
// 判据三条：
//   ① 弹窗有可访问名 + aria-modal="true"，内部无「无名按钮」、无 <24px 可点元素；
//   ② 焦点陷阱：连按 Tab 12 次，焦点始终不出弹窗（出了就是键盘用户被丢回背景页）；
//   ③ 焦点归位：Esc 关掉后焦点回到打开前的那个元素（不是掉回 body）。

/** 弹窗状态 + 弹窗内部按同一套尺寸/命名判据量一遍 */
const SCAN_DIALOG = `(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return { open: false };
  const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const byId = id => (id && document.getElementById(id) && document.getElementById(id).textContent || '').trim();
  const labelled = ((dlg.getAttribute('aria-label') || '').trim()
      || byId(dlg.getAttribute('aria-labelledby'))).slice(0, 40);
  const btns = [...dlg.querySelectorAll('button')];
  const noNameBtns = btns.filter(b => !nameOf(b)).length;
  // 弹窗里 24px 以下的控件：判据与首页一致（WCAG 2.5.8）。隐藏元素不算。
  const tiny = [...dlg.querySelectorAll('button, a[href], [role="button"], [role="option"]')].filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.pointerEvents === 'none') return false;
      return r.width < 24 || r.height < 24;
  }).length;
  return {
      open: true,
      ariaModal: dlg.getAttribute('aria-modal') === 'true',
      labelled,
      buttons: btns.length,
      noNameBtns,
      tiny,
  };
})()`;

/** 焦点是否还在弹窗里（陷阱判据的每次取样） */
const SCAN_FOCUS_IN_DIALOG = `(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return 'no-dialog';
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return dlg.contains(el) ? 'inside' : 'outside:' + el.tagName;
})()`;

/** 记下打开前的焦点（用 window 上的引用做跨次比较，DOM 节点不能序列化过 CDP） */
const focusBefore = await evaluate(`(() => {
  // 刻意先真聚焦一颗稳定按钮：若此刻焦点是 body，MUI 的「归位」也只能回到 body，
  // 那样这条判据就永远成立 —— 等于没验。先有个具体元素，归位才有意义。
  const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
  if (btn) btn.focus();
  window.__a11yFocusBefore = document.activeElement;
  return (window.__a11yFocusBefore.getAttribute && (window.__a11yFocusBefore.getAttribute('aria-label') || window.__a11yFocusBefore.tagName)) || 'unknown';
})()`);

// Ctrl+K：modifiers=2 是 Ctrl。rawKeyDown 足够触发 React 的 onKeyDown（不需要 text）
await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    nativeVirtualKeyCode: 75,
    modifiers: 2,
});
await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    nativeVirtualKeyCode: 75,
    modifiers: 2,
});

// 命令面板是懒加载 chunk，落地有延迟 —— 轮询而不是固定 sleep
let dialog = { open: false };
{
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        dialog = await evaluate(SCAN_DIALOG);
        if (dialog.open) break;
        await new Promise(r => setTimeout(r, 250));
    }
}
if (!dialog.open) {
    // 快捷键打不开命令面板 = 键盘用户彻底够不到这个功能。宁可红也别静默跳过。
    console.error("Ctrl+K 之后 15 秒内没有出现 [role=\"dialog\"] —— 这一节没测到，审计结果不可信");
    site.close();
    done(1);
}
console.log("=== 弹窗（命令面板）：可访问性 ===");
console.log(JSON.stringify(dialog, null, 1));

// 焦点陷阱：连按 Tab，每按一次取一次样
const trapSamples = [];
for (let i = 0; i < 12; i++) {
    await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
    await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
    await new Promise(r => setTimeout(r, 70));
    trapSamples.push(await evaluate(SCAN_FOCUS_IN_DIALOG));
}
const escaped = trapSamples.filter(s => s !== "inside");
console.log("=== 弹窗：焦点陷阱（Tab 12 次）===");
console.log(`   取样 ${trapSamples.length} 次，逃出弹窗 ${escaped.length} 次${escaped.length ? "：" + escaped.join(" / ") : ""}`);

// Esc 关闭 + 焦点归位
await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
});
await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
});
let closed = false;
{
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const still = await evaluate(`!!document.querySelector('[role="dialog"]')`);
        if (!still) {
            closed = true;
            break;
        }
        await new Promise(r => setTimeout(r, 200));
    }
}
// 退场 Fade 播完才卸载，焦点归位也在那之后 —— 等一会儿再量，否则量到的是过渡中间态
await new Promise(r => setTimeout(r, 400));
const restored = await evaluate(`(() => {
  const now = document.activeElement;
  if (!now || now === document.body) return 'body';
  return now === window.__a11yFocusBefore ? 'restored' : 'moved:' + (now.getAttribute('aria-label') || now.tagName);
})()`);
console.log("=== 弹窗：Esc 关闭与焦点归位 ===");
console.log(`   关闭 ${closed ? "ok" : "MISS（Esc 关不掉）"}；焦点 ${restored}（打开前是「${focusBefore}」）`);

// ---------- 5. 记事本（2026-10-24 加）----------
//
// 为什么必须单独跑一遍：记事本是**另一个路由下的另一套界面**（左栏 + 列表 + 编辑器
// + 工具栏 + 状态栏，控件数是首页的两三倍），而且它整块是懒加载的独立 chunk。
// 首页全绿只能说明首页没问题 —— 记事本的工具栏 / 大纲 / 右键菜单从未被任何自动审计看过。
//
// 前置：审计桩（script/auditEnv.mjs）已实现笔记 / 文件夹 / 标签 / tag-links，
// 且铺了 3 条笔记（覆盖置顶、收藏、入文件夹、带标签四种渲染形态）。
// 桩缺接口时这里会停在骨架态 —— 所以下面先断言「真的打开了」，再谈判据。
const notesOpened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
        .find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
    if (!btn) return 'no-entry';
    btn.click();
    return 'clicked';
})()`);
if (notesOpened !== "clicked") {
    console.error(
        `记事本入口找不到（${notesOpened}）—— 选择器漂了，这一节没测到，` +
            `审计结果不可信（宁可红也别静默跳过）`
    );
    site.close();
    done(1);
}
// 等懒加载 chunk 落地 + 列表渲染完（不用固定 sleep 掩耳：直接轮询「有没有笔记标题」）
{
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
        ready = await evaluate(`(document.body.innerText || '').includes('会议纪要')`);
        if (ready) break;
        await new Promise(r => setTimeout(r, 300));
    }
    if (!ready) {
        console.error(
            "记事本 20 秒内没渲染出桩里的笔记（停在骨架态或空态）—— " +
                "这一节没测到，审计结果不可信"
        );
        site.close();
        done(1);
    }
}

const notesA11y = await evaluate(scanA11y());
console.log("=== 记事本：可访问性 ===");
console.log(JSON.stringify(notesA11y, null, 1));

const notesTouch = await evaluate(scanTouch());
console.log("=== 记事本：触控目标 ===");
console.log(
    `   可点元素 ${notesTouch.total} 个：低于 24px 的 ${notesTouch.tooSmall} 个，24~31px 的 ${notesTouch.borderline} 个`
);
for (const s of notesTouch.samples) {
    console.log(
        `   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`
    );
}

const notesBroken = await evaluate(SCAN_IMAGES);
console.log("=== 记事本：图片加载 ===");
console.log(JSON.stringify(notesBroken, null, 1));

// 记事本里的焦点扫一遍：工具栏是全新的一片控件，历史上从没被量过
const notesFocus = await focusSweep(30);
console.log("=== 记事本：焦点可见性 ===");
notesFocus.forEach(f => console.log("  ", f.visible ? "ok  " : "MISS", JSON.stringify(f)));

// ---------- 设置中心：触控目标（2026-10-31 加）----------
//
// 为什么单独一段：设置中心是**又一个 Modal 外壳**（左栏分组导航 + 右栏面板），
// 左栏那 9 条是 `Box component="button"` 而不是 MUI List，行高还随视口在 36 / 44
// 之间切（桌面紧凑 36、窄屏触控 44）—— 前面的「弹窗」一节只看命令面板（Ctrl+K），
// 这一整套从来没被任何自动审计量过。行高从 44 压到 36 那次，判据只能靠人肉确认，
// 这就是补它的理由。
//
// ⚠️ **fail-closed**：打不开中心、或左栏没渲染出来，一律报红并写明「没测到」。
//    静默跳过等于把「没量过」印成「量过且没问题」，比没有审计更糟。
await evaluate(`location.href = ${JSON.stringify(site.url)}`);
await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });

const centerOpened = await evaluate(`(() => {
    // 选择器必须精确：「显示设置」/「网站设置」都含「设置」二字，includes 会点错；
    // 窄屏下顶栏那颗是 display:none，能点的其实是底栏那颗，所以要跳过不可见节点。
    const vis = el => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const btn = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
        .find(b => (b.textContent || '').trim() === '设置'
                || (b.getAttribute('aria-label') || '').trim() === '设置');
    if (!btn) return 'no-center-button';
    btn.click();
    return 'clicked';
})()`);
if (centerOpened !== "clicked") {
    console.error(
        `设置中心打不开（${centerOpened}）—— 顶栏「设置」选择器漂了，这一节没测到，` +
            "审计结果不可信（宁可红也别静默跳过）"
    );
    site.close();
    done(1);
}
// 中心外壳与九个面板是两级 lazy；左栏条目数才是「真的渲染出来了」的判据
const CENTER_MIN_NAV = 8;
{
    const deadline = Date.now() + 20_000;
    let navCount = 0;
    while (Date.now() < deadline) {
        navCount = await evaluate(`document.querySelectorAll('[data-workspace-nav]').length`);
        if (navCount >= CENTER_MIN_NAV) break;
        await new Promise(r => setTimeout(r, 250));
    }
    if (!(navCount >= CENTER_MIN_NAV)) {
        console.error(
            `设置中心左栏没渲染出来（[data-workspace-nav] ${navCount} 条，` +
                `至少要 ${CENTER_MIN_NAV} 条）—— 这一节没测到，审计结果不可信`
        );
        site.close();
        done(1);
    }
}

// 只扫弹窗内部：中心打开时首页的按钮还在 DOM 里（被 Modal 盖住），整页扫会把
// 两套界面混成一个数，「中心里到底几个」就说不出来了
const centerTouch = await evaluate(scanTouch('[role="dialog"]'));
if (centerTouch.missing) {
    console.error("设置中心没有 [role=\"dialog\"] 外壳 —— 这一节没测到，审计结果不可信");
    site.close();
    done(1);
}
console.log("=== 设置中心：触控目标 ===");
console.log(
    `   可点元素 ${centerTouch.total} 个：低于 24px 的 ${centerTouch.tooSmall} 个，24~31px 的 ${centerTouch.borderline} 个`
);
for (const s of centerTouch.samples) {
    console.log(
        `   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`
    );
}
for (const s of centerTouch.warnSamples) {
    console.log(`   ~ ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}`);
}

// ---------- 记事本·附件抽屉（2026-11-01 加）----------
//
// 为什么单独一段：抽屉（`src/components/AttachmentManager.tsx`）是盖在记事本上的
// 又一个界面态 —— 顶栏四档筛选、卡片里那颗「文件名 = 预览入口」的裸 <button>、
// 悬停/聚焦才浮出的删除 IconButton、底部的加载更多 / 清理，这一整套从来没被任何
// 无障碍审计看过。对比度审计把它纳入扫描面时当场抓出 7 处不达标，「没扫过的面 =
// 假的绿」这条规律在这个抽屉上已经应验过一次，所以这里也补上。
//
// ⚠️ 抽屉要有**非空**列表才画得出来：列表接口的桩已下沉到 `auditEnv.mjs`
//    （那里的 `ATTACHMENT_ROWS`）。没有它，`mgr.list()` 拿到通用的
//    `{ success: true }` 去 `.slice()` 会抛 `TypeError`，抽屉整个挂不上 ——
//    那一刻量到的「0 处不合格」是彻底的假绿。
//
// ⚠️ **fail-closed**：找不到附件入口 / 抽屉画不完 / Esc 关不掉 —— 一律报错并写明
//    「这一节没测到」。一条会悄悄不跑的审计比没有审计更糟。

// 设置中心还盖着一个 Modal，先回首页再开记事本：重载是唯一稳的「回到起点」
// （关闭入口在窄屏/桌面不是同一个控件，按文案找必然随界面漂，见对比度审计同款说明）
await evaluate(`location.href = ${JSON.stringify(site.url)}`);
await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });

const drawerNotesOpened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
        .find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
    if (!btn) return 'no-entry';
    btn.click();
    return 'clicked';
})()`);
if (drawerNotesOpened !== "clicked") {
    console.error(
        `抽屉段：记事本入口找不到（${drawerNotesOpened}）—— 这一节没测到，审计结果不可信`
    );
    site.close();
    done(1);
}
{
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
        ready = await evaluate(`(document.body.innerText || '').includes('会议纪要')`);
        if (ready) break;
        await new Promise(r => setTimeout(r, 300));
    }
    if (!ready) {
        console.error("抽屉段：记事本 20 秒内没渲染出桩里的笔记 —— 这一节没测到，审计结果不可信");
        site.close();
        done(1);
    }
}

/**
 * 打开附件抽屉。
 *
 * 用 `[data-nav-attachments]`（NotesNavPanel 里那颗 NavRow 的 data 属性）而不是
 * 可访问名：那颗按钮没有 aria-label，名字来自内部文字「附件」，按文字找会随文案
 * 改写而漂。文字只作为 data 属性消失时的兜底 —— 与对比度审计同一套写法。
 */
const drawerOpened = await evaluate(`(() => {
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
})()`);
if (drawerOpened !== "clicked") {
    console.error(
        `记事本里找不到「附件」入口（${drawerOpened}）—— 抽屉这一节没测到，审计结果不可信`
    );
    site.close();
    done(1);
}

/** 四档筛选：全部 / 图片 / 文档 / 其他（少一档就说明分段控件没画全）。 */
const ATT_MIN_OPTIONS = 4;

/**
 * 「抽屉真的画完了」的判据：四档筛选都在 + 列表已落地（没有 loading 态）
 * + 至少一张卡片。
 *
 * ⚠️ 只等分段控件是不够的：它在抽屉头部**同步**渲染，而列表是**异步拉的** ——
 *    那一刻网格里还是「正在读取附件列表…」的骨架态，卡片 / 文件名 / 删除按钮
 *    一个都还没挂，扫出来 0 处不合格。加这一段原本就是为了量这些控件，
 *    等错对象等于白加（对比度审计那边踩过同一个坑）。
 */
const ATTACHMENTS_READY = `(() => {
  return {
    options: document.querySelectorAll('[data-att-filter-option]').length,
    loading: document.querySelectorAll('[data-att-state="loading"]').length,
    rows: document.querySelectorAll('[data-attachment-row]').length,
  };
})()`;
{
    const deadline = Date.now() + 20_000;
    let st = null;
    let ok = false;
    while (Date.now() < deadline) {
        st = await evaluate(ATTACHMENTS_READY);
        if (st && st.options >= ATT_MIN_OPTIONS && st.loading === 0 && st.rows > 0) {
            ok = true;
            break;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    if (!ok) {
        console.error(
            `附件抽屉 20 秒内没画完（筛选 ${st?.options ?? 0} 档 / 至少要 ${ATT_MIN_OPTIONS} 档、` +
                `加载中 ${st?.loading ?? "?"} 个、卡片 ${st?.rows ?? 0} 张）—— 这一节没测到，` +
                "审计结果不可信（宁可红也别静默跳过）"
        );
        site.close();
        done(1);
    }
}

// 只扫抽屉内部（`.MuiDrawer-paper`）：抽屉盖在记事本上时记事本的控件仍在 DOM 里，
// 整页扫会把「记事本 94 个按钮」和「抽屉里这十几个」混成一个数
const drawerA11y = await evaluate(scanA11y(".MuiDrawer-paper"));
if (drawerA11y.missing) {
    console.error("附件抽屉没有 .MuiDrawer-paper 外壳 —— 这一节没测到，审计结果不可信");
    site.close();
    done(1);
}
const drawerTouch = await evaluate(scanTouch(".MuiDrawer-paper"));
if (drawerTouch.missing) {
    console.error("附件抽屉没有 .MuiDrawer-paper 外壳 —— 这一节没测到，审计结果不可信");
    site.close();
    done(1);
}
console.log("=== 记事本·附件抽屉：可访问性 ===");
console.log(JSON.stringify(drawerA11y, null, 1));
console.log("=== 记事本·附件抽屉：触控目标 ===");
console.log(
    `   可点元素 ${drawerTouch.total} 个：低于 24px 的 ${drawerTouch.tooSmall} 个，24~31px 的 ${drawerTouch.borderline} 个`
);
for (const s of drawerTouch.samples) {
    console.log(
        `   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`
    );
}
for (const s of drawerTouch.warnSamples) {
    console.log(`   ~ ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}`);
}

/**
 * Esc 关抽屉，并等它**真的消失**再往下走。
 *
 * 用 Esc 而不是点遮罩 / 找关闭键：Drawer（Modal）认 Esc 是 MUI 的固定契约，
 * 而遮罩与关闭键在不同布局下不是同一个节点 —— 按位置点必然随界面漂，一次漂移
 * 就是「关不掉、后面全错」。关完必须确认它没了：残影会把抽屉里的控件混进后面的
 * 判定里（本轮后面虽然没有别的段，但下一轮插段就会中招）。
 */
await evaluate(`(() => {
  const paper = document.querySelector('.MuiDrawer-paper');
  (paper || document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  return true;
})()`);
{
    const deadline = Date.now() + 10_000;
    let left = 1;
    let closed = false;
    while (Date.now() < deadline) {
        left = await evaluate(`document.querySelectorAll('[data-att-filter-option]').length`);
        if (left === 0) {
            closed = true;
            break;
        }
        await new Promise(r => setTimeout(r, 150));
    }
    if (!closed) {
        console.error(
            `附件抽屉按 Esc 后 10 秒内没关掉（还剩 ${left} 档筛选）—— 这一节没测到/没关掉，审计结果不可信`
        );
        site.close();
        done(1);
    }
}
console.log(`=== 记事本·附件抽屉：Esc 关闭 ok（筛选 ${ATT_MIN_OPTIONS} 档已归零）===`);

// ---------- 抽屉的空态 / 拉取失败态（2026-11-01 加）----------
//
// 上面那一段量的是「有 3 条附件」的常态。抽屉还有两条**独立渲染分支**，
// 各自的文字与配色都不一样，而且从来没进过任何审计面：
//   - 空态：`data-att-state="empty"`「还没有上传过任何附件。」
//   - 失败：`data-att-state="error"`（error 文案走 `error.main`）
// 空态/失败态的说明文字是最没人核的地方 —— 加这一段当场就抓出亮色 2.68:1
// （`text.disabled` 压在抽屉底上）。桩态切换见 `auditEnv.mjs` 的 setAttachmentMode。
//
// ⚠️ 不要在「常态」那一段里就地改成循环：既有输出必须逐字节可对比，
//    所以这两态是**追加**的独立循环，不改上面任何一行。
const OPEN_DRAWER = `(() => {
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

const drawerStates = [];
for (const [mode, title] of [
    ["empty", "空态"],
    ["error", "拉取失败"],
]) {
    setAttachmentMode(mode);
    const opened = await evaluate(OPEN_DRAWER);
    if (opened !== "clicked") {
        console.error(`抽屉·${title}：入口找不到（${opened}）—— 这一态没测到，审计结果不可信`);
        site.close();
        done(1);
    }
    // 就绪判据按**期望的那一态**等：空态永远等不到卡片，失败态也等不到。
    {
        const deadline = Date.now() + 20_000;
        let st = null;
        let ok = false;
        while (Date.now() < deadline) {
            st = await evaluate(`(() => ({
                options: document.querySelectorAll('[data-att-filter-option]').length,
                loading: document.querySelectorAll('[data-att-state="loading"]').length,
                hit: document.querySelectorAll('[data-att-state="${mode}"]').length,
            }))()`);
            if (st && st.options >= ATT_MIN_OPTIONS && st.loading === 0 && st.hit > 0) {
                ok = true;
                break;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        if (!ok) {
            console.error(
                `抽屉·${title}：20 秒内没画成该状态（筛选 ${st?.options ?? 0} 档 / ` +
                    `加载中 ${st?.loading ?? "?"} 个 / 标记 ${st?.hit ?? 0} 个）—— 这一态没测到`
            );
            site.close();
            done(1);
        }
    }

    const a = await evaluate(scanA11y(".MuiDrawer-paper"));
    const t = await evaluate(scanTouch(".MuiDrawer-paper"));
    if (a.missing || t.missing) {
        console.error(`抽屉·${title}：没有 .MuiDrawer-paper 外壳 —— 这一态没测到`);
        site.close();
        done(1);
    }
    console.log(`=== 记事本·附件抽屉·${title}：可访问性 ===`);
    console.log(JSON.stringify(a, null, 1));
    console.log(
        `=== 记事本·附件抽屉·${title}：触控目标 ===\n` +
            `   可点元素 ${t.total} 个：低于 24px 的 ${t.tooSmall} 个，24~31px 的 ${t.borderline} 个`
    );
    for (const s of t.samples) {
        console.log(
            `   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`
        );
    }
    drawerStates.push({ title, a, t });

    // 关抽屉并等它真的没了：残影会让下一态的扫描混进上一态的控件
    await evaluate(`(() => {
      const paper = document.querySelector('.MuiDrawer-paper');
      (paper || document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      return true;
    })()`);
    {
        const deadline = Date.now() + 10_000;
        let left = 1;
        while (Date.now() < deadline) {
            left = await evaluate(`document.querySelectorAll('[data-att-filter-option]').length`);
            if (left === 0) break;
            await new Promise(r => setTimeout(r, 150));
        }
        if (left !== 0) {
            console.error(`抽屉·${title}：Esc 后 10 秒内没关掉（还剩 ${left} 档筛选）—— 结果不可信`);
            site.close();
            done(1);
        }
    }
}
// 复原：别让桩态漏到后面的判定里
setAttachmentMode("rows");

// ---------- 移动端双视口触控审计（2026-11-02 加，2026-11-02 翻闸为 **fail-closed**）----------
//
// 为什么必须有这一段：前面所有扫描面（首页 / 记事本 / 设置中心 / 附件抽屉）
// **全部跑在桌面视口**——`auditEnv.openBrowser` 只给 Chrome 传了一个
// `--window-size=1440,950`，既没有 `Emulation.setDeviceMetricsOverride`、
// 也没有触控仿真。于是有两件事从来没被量过：
//
//   ① 390 / 375 宽下 MUI 的 `useMediaQuery` 走的是**另一条分支**：底栏（MobileTabBar）
//      出现、顶栏同名入口隐藏、弹窗从「居中卡片」变成「贴底全宽面板」
//      （`src/index.css` 的 max-width: 599.95px 段）。桌面量到的 DOM 形状与真机
//      不是同一份，「桌面全绿」推不出「手机上没问题」。
//
//   ② `src/index.css` 的**触控目标守卫**挂在 `(hover: none) and (pointer: coarse)`
//      上，`src/utils/device.ts` 还要 `navigator.maxTouchPoints > 0` 才把
//      `nav-touch` 挂到 <html>。桌面视口下这两条都不成立 —— 也就是说，
//      桌面量到的 30px 图标按钮，在真机上可能已经被守卫/伪元素撑到 44，
//      也可能根本没有。不仿真就永远不知道是哪一种。
//
// ⚠️ 这一段是 **fail-closed** 硬判据（与前面五段同一套契约）：
//   · 仿真前提（viewport / matchMedia / maxTouchPoints / nav-touch）任意一条不成立
//     → 这一视口直接判红（push 进 failures），不是「嗯一声然后跳过」；
//   · 四个面（A 首页 / B 设置中心 / C 底部面板弹窗 / D 批量操作条）任一打不开
//     → 那个面判红；
//   · 量出来的有效热区 < 该档阈值的，判红，写明 w×h / className / surface / tier。
// 这样「手机上触控目标够不够大」第一次被 CI 真盯着，而不是靠人肉看报告。
//
// 判据口径：**有效热区 = max(边框盒, ::after 伪元素热区)**，再与逐层祖先可见区求交。
// 用有效热区而不是边框盒，是为了不冤枉「边框盒只有 30px、但伪元素已经把可点范围
// 撑到 44」的控件（底栏 6 颗 + 卡片浮层 6 颗就是这种）；反过来若只看伪元素、
// 不看祖先裁切，又会在 overflow 不是 visible 时高估。两者取并集再求交，是
// 最接近「真机上拇指实际能戳中多大」的口径。
//
// 三档阈值（写死）：critical = 44×44（平台触控规范）/ deco = 40×40（装饰性次要操作）
// / accept = 24×24（WCAG 2.5.8 底线）。分档理由见 docs/mobile-touch-audit-2026-11-02.md。
//
// 双视口：iPhone 12~15 逻辑分辨率 390×844，以及 SE/老机型常用的 375×844，
// 两档都过才放行（375 更窄，顶栏/底栏更容易挤）。

/**
 * 仿真参数（写死，不给环境变量开口子）。
 *
 * 390×844 是 iPhone 12~15 的逻辑分辨率，也是站内视觉基线 audit:visual 的
 * mobile 档所用的一档；deviceScaleFactor 3 + mobile:true 让 Chrome 走
 * 「移动设备」分支（布局视口 = 390，有 meta viewport 语义）。
 */
const MOBILE_VIEWPORTS = [
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, label: "390×844" },
    { width: 375, height: 844, deviceScaleFactor: 3, mobile: true, label: "375×844" },
];

/** 触控仿真：真机有触摸点，`maxTouchPoints` 与 `(pointer: coarse)` 一起变 */
const MOBILE_TOUCH = { enabled: true, maxTouchPoints: 5 };

/** 三档阈值（写死）：critical 44 / deco 40 / accept 24（WCAG 2.5.8 底线） */
const TIER_THRESHOLD = { critical: 44, deco: 40, accept: 24 };
const TIER_NAME = { critical: "关键", deco: "装饰", accept: "可接受" };
const MOBILE_EPS = 0.5;

/**
 * 仿真是否真的生效（**测量前提**，不是判据）。
 *
 * 必须验的三条：
 *   - `innerWidth === 390`：设备度量覆盖生效；
 *   - `(max-width: 599.95px)` 为 true：站内「小屏」那一档切过去了
 *     （弹窗变底部面板、顶栏入口隐藏都挂在这条线上）；
 *   - `(pointer: coarse)` / `maxTouchPoints > 0`：触控守卫与 `nav-touch` 生效。
 * 三条里任何一条不成立，量到的就还是桌面形态 —— 那这一段的数字全部无效，
 * 必须当「没测到」而不是「没问题」。
 */
const mobileProbe = (vpWidth) => `(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  touchPoints: navigator.maxTouchPoints || 0,
  qSmall: matchMedia('(max-width: 599.95px)').matches,
  qBelow900: matchMedia('(max-width: 899.98px)').matches,
  qCoarse: matchMedia('(pointer: coarse)').matches,
  qHoverNone: matchMedia('(hover: none)').matches,
  navTouch: document.documentElement.classList.contains('nav-touch'),
  tabbar: document.querySelectorAll('.nav-mobile-tabbar').length,
  expectWidth: ${vpWidth},
}))()`;

/**
 * 移动端触控目标的**全量**测量（与 `scanTouch` 同一套元素集与同一套跳过规则）。
 *
 * 与 `scanTouch` 的差别只在「报什么」：
 *   - `scanTouch` 只留 20 条采样、且只判 < 24px；
 *   - 这里留**全量**，并同时算 44 / 40 / 24 三档，外加有效热区（伪元素）。
 *
 * 元素集刻意与 `scanTouch` **逐字相同**（`button, a[href], [role="button"],
 * [role="option"]`）：两把尺子量同一批元素，结论才可对照。
 * 已知的覆盖面缺口（写在这里免得被当成「量过了」）：`[role="menuitem"]`
 * （MUI MenuItem 是 <li>）不在这个集合里 —— 菜单项本轮未测。
 */
const scanMobileTouch = (scopeSelector, surface) => `(() => {
  const root = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)}) || null` : "document"};
  if (!root) return { missing: true };
  // 与 scanTouch 同一套亚像素容差（LayoutUnit 1/64 + DPR 贴齐，见那里的长注释）
  const EPS = 0.5;
  // 三档**都只是报**：44 = 平台触控规范 / 40 = 装饰性折中 / 24 = WCAG 2.5.8 底线
  const T_STRICT = 44, T_DECO = 40, T_WCAG = 24;

  /**
   * 有效热区：元素自己 30×30，但 CSS 用 ::after 把可点范围补到 44×44
   * （src/index.css 的「卡片上那些小图标」「底部导航的自绘按钮」两段）。
   *
   * ⚠️ 这是测量上必须分开的一件事：getBoundingClientRect() 量的是**边框盒**，
   *    看不到伪元素撑出来的热区。若只按边框盒判 44，会把「真机上已经够大」的
   *    控件也判红；反过来若一律按伪元素算，又会在**祖先裁切**（overflow 不是
   *    visible）时高估 —— 被裁掉的那部分热区点不到。
   *
   * 做法：先按伪元素的宽高还原出热区盒，再与逐层祖先的可见区**求交**。
   *   · 还原方式：项目里这两处伪元素都是「以元素中心为心、固定 44×44」
   *     （inset: 50% … auto 50% + translate(-50%,-50%)），所以热区盒 =
   *     元素中心 ± max(伪元素, 元素自身) 的一半。不按这个写法写的伪元素
   *     还原不出盒子 —— 那种情况一律不认（宁可少算，也别虚报「已经够了」）。
   *   · 求交而不是「有裁切就整块否掉」：底栏那颗按钮的伪元素 44 高、按钮
   *     本身 43.19 高，祖先只要有 overflow 就整块否掉会误判成「热区不达标」，
   *     而实际上 44-43.19 那点外溢根本没被裁掉（周围有 padding）。
   */
  const effective = el => {
    const s = getComputedStyle(el, '::after');
    if (s.content === 'none' || s.content === 'normal') return null;
    const nums = (s.width + ' ' + s.height).match(/[\\d.]+/g);
    if (!nums || nums.length < 2) return null;
    const pw = Number(nums[0]), ph = Number(nums[1]);
    if (!(pw >= T_STRICT - EPS) && !(ph >= T_STRICT - EPS)) return null;
    const r = el.getBoundingClientRect();
    const bw = Math.max(pw, r.width), bh = Math.max(ph, r.height);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let box = { l: cx - bw / 2, t: cy - bh / 2, w: bw, h: bh };
    // 与逐层祖先求交，但**只在祖先真的裁切时才裁**：overflow 为 visible（默认）的
    // 祖先不会裁掉伪元素 —— 伪元素溢出后仍然参与命中测试，真机上手指能戳到那部分。
    // 只有 overflow 为 hidden/auto/scroll/clip 的祖先才会把热区截掉。若不论
    // overflow 一律求交，会把「分组工具条」那种 36 高容器 + 44 高伪元素误判成
    // 只有 36 高热区（其实 44 高那圈溢出后仍可点）。
    let n = el.parentElement, depth = 0;
    while (n && depth < 8) {
      const cs = getComputedStyle(n);
      const clipX = cs.overflowX !== 'visible';
      const clipY = cs.overflowY !== 'visible';
      if (clipX || clipY) {
        const nr = n.getBoundingClientRect();
        const l = clipX ? Math.max(box.l, nr.left) : box.l;
        const t = clipY ? Math.max(box.t, nr.top) : box.t;
        const rr = clipX ? Math.min(box.l + box.w, nr.right) : box.l + box.w;
        const b = clipY ? Math.min(box.t + box.h, nr.bottom) : box.t + box.h;
        box = { l, t, w: Math.max(0, rr - l), h: Math.max(0, b - t) };
      }
      n = n.parentElement;
      depth++;
    }
    return { w: +box.w.toFixed(2), h: +box.h.toFixed(2) };
  };

  /**
   * 三档的**机器判据**（顺序敏感，先命中先归类）。
   *
   * 判据只用「选择器 + MUI class + 所在容器」，没有一条依赖文案或序号 ——
   * 文案一改就会静默漂移。分档理由写在 docs/mobile-touch-audit-2026-11-02.md，
   * 这里是它的可执行版本。
   */
  const tierOf = el => {
    // ① 关键操作：拇指区 / 顶栏 / 弹窗操作区 / 批量条 / 弹窗标题栏（关闭键）
    if (el.closest('.nav-mobile-tabbar')) return 'critical';
    if (el.closest('header')) return 'critical';
    if (el.closest('.MuiDialogActions-root')) return 'critical';
    if (el.closest('.nav-bulk-bar')) return 'critical';
    // 设置中心左栏那 10 条分组导航：窄屏实测 44 高（桌面 36），是中心里的**主入口**
    if (el.closest('[data-workspace-nav]')) return 'critical';
    // 弹窗右上角那枚 ×：DialogCloseButton 统一挂了 data-dialog-close（32 个弹窗里
    // 有 8 个压根没有 ×，所以不能靠「有标题栏就有 ×」推断）。
    // 不用 MuiDialogTitle：设置中心那一套外壳根本没有 DialogTitle，
    // 按标题栏归类会让同一颗 × 在两个面里落到不同档。
    if (el.closest('[data-dialog-close]') || el.matches('[data-dialog-close]')) return 'critical';
    // ② 装饰性 / 次要操作：卡片浮层与分组工具条（触屏下常显，但不承担主流程）
    if (el.closest('.nav-card-actions')) return 'deco';
    if (el.matches('.nav-settings-btn, .nav-star-btn, .nav-note-btn')) return 'deco';
    if (el.closest('.nav-group-tools')) return 'deco';
    // 附件卡片里那颗「删除」是次要操作；同一张卡片里「文件名 = 预览入口」是主入口，不算
    if (el.closest('[data-attachment-row]') && el.matches('button.MuiIconButton-root')) return 'deco';
    // ③ 其余：WCAG 2.5.8 的 24px 底线已经够（列表行、chip、文本按钮…）
    return 'accept';
  };

  const els = [...root.querySelectorAll('button, a[href], [role="button"], [role="option"]')];
  const rows = [];
  let skippedHidden = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { skippedHidden++; continue; }
    const s = getComputedStyle(el);
    // 与 scanTouch 同一套跳过规则：悬停才浮出、平时 pointer-events:none 的不算
    if (s.pointerEvents === 'none' || s.visibility === 'hidden') { skippedHidden++; continue; }
    const eff = effective(el);
    rows.push({
      surface: ${JSON.stringify(surface)},
      tag: el.tagName.toLowerCase(),
      tier: tierOf(el),
      w: +r.width.toFixed(2),
      h: +r.height.toFixed(2),
      // 有效热区（有伪元素时才有值；已与祖先可见区求交）
      ew: eff ? eff.w : null,
      eh: eff ? eff.h : null,
      cls: (el.className && el.className.toString() || '').slice(0, 40),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 16),
      parent: (el.parentElement && el.parentElement.className && el.parentElement.className.toString() || '').slice(0, 30),
    });
  }
  // 按尺寸升序：先看「最小边」，同一边长再看宽 —— 越是方的越难靠加宽掩盖
  rows.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h) || a.w - b.w);

  const count = (pred, list = rows) => list.filter(pred).length;
  const boxed = (r, t) => r.w < t - EPS || r.h < t - EPS;      // 边框盒口径
  // 有效热区口径：伪元素撑出来的热区（已与祖先可见区求交）本身要到 44
  const hitter = r => r.ew !== null && r.eh !== null && r.ew >= T_STRICT - EPS && r.eh >= T_STRICT - EPS;
  return {
    total: els.length,
    skippedHidden,
    rows,
    lt44: count(r => boxed(r, T_STRICT)),
    lt40: count(r => boxed(r, T_DECO)),
    lt24: count(r => boxed(r, T_WCAG)),
    // 边框盒不达标、但伪元素已经把可点范围补够了的（= 不用改代码的那部分）
    lt44ButHit: count(r => boxed(r, T_STRICT) && hitter(r)),
    lt40ButHit: count(r => boxed(r, T_DECO) && hitter(r)),
    lt24ButHit: count(r => boxed(r, T_WCAG) && hitter(r)),
    tiers: {
      critical: count(r => r.tier === 'critical'),
      deco: count(r => r.tier === 'deco'),
      accept: count(r => r.tier === 'accept'),
    },
    // 分档 × 档位：真正要修的候选（边框盒不达标且有效热区也不达标）
    needFix: {
      critical44: count(r => r.tier === 'critical' && boxed(r, T_STRICT) && !hitter(r)),
      deco40: count(r => r.tier === 'deco' && boxed(r, T_DECO) && !hitter(r)),
      wcag24: count(r => boxed(r, T_WCAG) && !hitter(r)),
    },
  };
})()`;

/** 一行一条的可读输出（--padStart 对齐，方便人眼扫；判红行打 ❌） */
function printMobileRows(rows, limit = Number.POSITIVE_INFINITY) {
    for (const r of rows.slice(0, limit)) {
        const hit = r.ew !== null ? ` 热区${r.ew}×${r.eh}` : "";
        const mark = r.violation ? " ❌" : "";
        console.log(
            `   ${String(r.w).padStart(5)}×${String(r.h).padStart(5)}  ${TIER_NAME[r.tier].padEnd(3)}` +
                `${mark}「${r.label}」  .${r.cls}` +
                `  (父 .${r.parent})${hit}`
        );
    }
    if (rows.length > limit) console.log(`   …还有 ${rows.length - limit} 条（全量见下方 JSON 与 docs 文档）`);
}

/** 一面的汇总行：三档计数 + 违反项，一眼能看出「红多少」 */
function reportMobileSurface(vp, label, res) {
    console.log(`=== 移动端 ${vp.label}：${label} ===`);
    if (res.missing) {
        console.log(`   ⚠️ 未测到：${label} 的扫描根不存在（选择器漂了 / 界面没打开）—— 已判红`);
        return;
    }
    const needFix = res.rows.filter(r => r.violation).length;
    console.log(
        // ⚠️ 两个数必须分开写：`total` 是「选择器匹配到的元素数」（含隐藏的），
        // 清单里只有实测过的那批。混着写会让读者以为清单漏了 6 条。
        `   可点元素 ${res.rows.length} 个（另有 ${res.skippedHidden} 个隐藏/不可点已跳过，` +
            `选择器匹配 ${res.total} 个）：违反本档阈值 ${needFix} 个`
    );
    console.log(
        `   分档：关键 ${res.tiers.critical} / 装饰 ${res.tiers.deco} / 可接受 ${res.tiers.accept}`
    );
    printMobileRows(res.rows);
    console.log("");
}

/** 移动端审计累积的失效项（fail-closed：违反项 + 未测到的面都进这里） */
const mobileFailures = [];

/** 给一行打「是否判红」：有效热区 = max(边框盒, ::after)，与档位阈值比 */
function tagMobileViolation(r) {
    const effMin = (r.ew !== null && r.eh !== null)
        ? Math.min(r.ew, r.eh)
        : Math.min(r.w, r.h);
    const thr = TIER_THRESHOLD[r.tier] ?? 24;
    r.violation = effMin < thr - MOBILE_EPS;
    return r;
}

// ---- 跑一个视口：开仿真 → 四面扫描 → 清仿真 → 汇总（fail-closed）----
async function runMobileAudit(vp) {
    // 开仿真：设备度量 → 触控 → **重新加载**
    // 重新加载是必须的，不是保险：`useMediaQuery` 与 `matchMedia` 的结果在 React 里
    // 是「订阅 + 首帧取值」，只改设备度量不重载时，懒加载 chunk、`nav-touch` 这个
    // 挂在 <html> 上的一次性判定、以及 `dvh` 布局缓存都不会跟着重算。重载一次最省事，
    // 也和真机（冷启动即该宽度）一致。
    await send("Emulation.setDeviceMetricsOverride", {
        width: vp.width, height: vp.height,
        deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile,
    });
    await send("Emulation.setTouchEmulationEnabled", MOBILE_TOUCH);
    await evaluate(`location.href = ${JSON.stringify(site.url + "/?t=" + Date.now())}`);

    const vpRows = [];
    const vpMissing = [];
    let ready = false;
    try {
        const buttons = await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
        const probe = await evaluate(mobileProbe(vp.width));
        console.log(`=== 移动端 ${vp.label} 仿真：参数确认 ===`);
        console.log(`   ${JSON.stringify(probe)}`);
        ready =
            probe.innerWidth === vp.width &&
            probe.qSmall === true &&
            probe.touchPoints > 0 &&
            probe.qCoarse === true &&
            probe.tabbar > 0;
        if (ready) {
            console.log(
                `   生效：布局视口 ${probe.innerWidth}×${probe.innerHeight} @${probe.dpr}x、` +
                    `触摸点 ${probe.touchPoints}、matchMedia('(max-width:599.95px)')=${probe.qSmall}、` +
                    `(pointer: coarse)=${probe.qCoarse}、nav-touch=${probe.navTouch}、底栏 ${probe.tabbar} 条` +
                    `（重载后 button ${buttons} 个）\n`
            );
        } else {
            console.error(
                `   ⚠️ ${vp.label} 仿真未完全生效（视口 ${probe.innerWidth} / qSmall ${probe.qSmall} / ` +
                    `触摸点 ${probe.touchPoints} / coarse ${probe.qCoarse} / 底栏 ${probe.tabbar}）—— fail-closed 判红`
            );
        }
    } catch (e) {
        console.error(`   ⚠️ 移动端 ${vp.label} 仿真：重载后页面没渲染出来（${e?.message || e}）—— fail-closed 判红`);
    }

    if (!ready) {
        mobileFailures.push(`移动端${vp.label}：仿真未生效（fail-closed）—— 触控目标尺寸无法验证`);
        await send("Emulation.clearDeviceMetricsOverride");
        await send("Emulation.setTouchEmulationEnabled", { enabled: false });
        return;
    }

    // ---- 面 A：首页 ----
    {
        const res = await evaluate(scanMobileTouch(null, "A 首页"));
        if (res.missing) vpMissing.push("A 首页");
        else { for (const r of res.rows) tagMobileViolation(r); vpRows.push(...res.rows); }
        reportMobileSurface(vp, "A 首页", res);
    }

    // ---- 面 B：设置中心（限根在弹窗内）----
    // 交互步骤照抄上面「设置中心」那一节的选择器（文案/aria-label = 设置 + 可见性），
    // 不另发明一套点法：两处选择器漂了就是两处静默漏测。
    {
        const opened = await evaluate(`(() => {
            const vis = el => {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            };
            const btn = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
                .find(b => (b.textContent || '').trim() === '设置'
                        || (b.getAttribute('aria-label') || '').trim() === '设置');
            if (!btn) return 'no-center-button';
            btn.click();
            return 'clicked';
        })()`);
        if (opened !== "clicked") {
            console.error(`   面 B 设置中心：打不开（${opened}）—— fail-closed 判红`);
            vpMissing.push("B 设置中心");
        } else {
            const deadline = Date.now() + 20_000;
            let navCount = 0;
            while (Date.now() < deadline) {
                navCount = await evaluate(`document.querySelectorAll('[data-workspace-nav]').length`);
                if (navCount >= CENTER_MIN_NAV) break;
                await new Promise(r => setTimeout(r, 250));
            }
            if (navCount < CENTER_MIN_NAV) {
                console.error(
                    `   面 B 设置中心：左栏只渲染出 ${navCount} 条（要 ${CENTER_MIN_NAV} 条）—— fail-closed 判红`
                );
                vpMissing.push("B 设置中心");
            } else {
                const centerRes = await evaluate(scanMobileTouch('[role="dialog"]', "B 设置中心"));
                if (centerRes.missing) {
                    console.error("   面 B 设置中心：没有 [role=\"dialog\"] 外壳 —— fail-closed 判红");
                    vpMissing.push("B 设置中心");
                } else {
                    for (const r of centerRes.rows) tagMobileViolation(r);
                    vpRows.push(...centerRes.rows);
                    reportMobileSurface(vp, "B 设置中心", centerRes);
                    const navHeights = await evaluate(`(() => {
                        const hs = [...document.querySelectorAll('[data-workspace-nav]')]
                            .map(el => +el.getBoundingClientRect().height.toFixed(2));
                        const uniq = [...new Set(hs)].sort((a, b) => a - b);
                        return { count: hs.length, heights: uniq };
                    })()`);
                    console.log(`   设置中心左栏 ${navHeights.count} 条，实测行高：${JSON.stringify(navHeights.heights)}\n`);
                }
            }
            await escapeDialog();
        }
    }

    // ---- 面 C：走底部面板形态的弹窗 ----
    // 挑「添加站点」：窄屏下它必然是 `align-items: flex-end` 的贴底全宽面板
    // （`src/index.css` 的 max-width: 599.95px 段），底部那排「取消 / 保存」
    // 正是这一档最该量的关键操作。入口用底栏「新增」（`aria-label="新增"`）——
    // 与 MobileTabBar 的 items 一一对应，不按坐标点、不按第几个点。
    // 若桩里连一个分组都没有，`handleQuickAdd` 会退化成「新建分组」弹窗：
    // 那也是同一个外壳形态，同样量，只是把实际打开的标题打印出来。
    {
        await evaluate(`location.href = ${JSON.stringify(site.url)}`);
        await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
        const sheetOpened = await evaluate(`(() => {
            const btn = [...document.querySelectorAll('.nav-mobile-tabbar button')]
                .find(b => (b.getAttribute('aria-label') || '').trim() === '新增');
            if (!btn) return 'no-add-tab';
            btn.click();
            return 'clicked';
        })()`);
        if (sheetOpened !== "clicked") {
            console.error(`   面 C 底部面板：底栏「新增」找不到（${sheetOpened}）—— fail-closed 判红`);
            vpMissing.push("C 底部面板弹窗");
        } else {
            let sheetDlg = null;
            {
                const deadline = Date.now() + 20_000;
                while (Date.now() < deadline) {
                    sheetDlg = await evaluate(`(() => {
                        const dlg = document.querySelector('[role="dialog"]');
                        if (!dlg) return null;
                        const paper = dlg.querySelector('.MuiDialog-paper') || dlg;
                        const r = paper.getBoundingClientRect();
                        const byId = id => (id && document.getElementById(id) && document.getElementById(id).textContent || '').trim();
                        return {
                            name: ((dlg.getAttribute('aria-label') || '').trim() || byId(dlg.getAttribute('aria-labelledby'))).slice(0, 30),
                            w: +r.width.toFixed(2),
                            h: +r.height.toFixed(2),
                            bottom: +r.bottom.toFixed(2),
                            vh: window.innerHeight,
                            vw: window.innerWidth,
                            buttons: dlg.querySelectorAll('button').length,
                        };
                    })()`);
                    if (sheetDlg && sheetDlg.buttons > 0) break;
                    sheetDlg = null;
                    await new Promise(r => setTimeout(r, 250));
                }
            }
            if (!sheetDlg) {
                console.error("   面 C 底部面板：20 秒内没出现带按钮的 [role=\"dialog\"] —— fail-closed 判红");
                vpMissing.push("C 底部面板弹窗");
            } else {
                const isSheet = sheetDlg.bottom >= sheetDlg.vh - 1.5 && sheetDlg.w >= sheetDlg.vw - 1.5;
                console.log(
                    `=== 移动端${vp.label} 底部面板形态确认 ===\n` +
                        `   弹窗「${sheetDlg.name}」纸面 ${sheetDlg.w}×${sheetDlg.h}，底边 ${sheetDlg.bottom}` +
                        `（视口 ${sheetDlg.vw}×${sheetDlg.vh}）：${isSheet ? "贴底全宽面板 ✓" : "**不是贴底全宽面板**"}\n`
                );
                // 面名带上实际打开的那个弹窗标题：清单里的 `surface` 与汇总行必须逐字一致，
                // 否则「C 底部面板弹窗」和「C 底部面板弹窗（新增站点）」会变成两面。
                const sheetLabel = `C 底部面板弹窗（${sheetDlg.name || "未命名"}）`;
                const sheetRes = await evaluate(scanMobileTouch('[role="dialog"]', sheetLabel));
                if (sheetRes.missing) {
                    console.error("   面 C 底部面板：没有 [role=\"dialog\"] 外壳 —— fail-closed 判红");
                    vpMissing.push("C 底部面板弹窗");
                } else {
                    for (const r of sheetRes.rows) tagMobileViolation(r);
                    vpRows.push(...sheetRes.rows);
                    reportMobileSurface(vp, sheetLabel, sheetRes);
                }
            }
            await escapeDialog();
        }
    }

    // ---- 面 D：批量操作条（多选态）----
    // `.nav-bulk-bar` 是**只在多选态出现**的一条浮条，里面有
    // 「批量删除 / 移动 / 取消」——全是破坏性或批量写操作，正是 44px 判据最该
    // 覆盖的东西。它是懒加载块，桌面视口的任何一段都不会渲染它。
    // 交互路径（全部用 aria-label / class，不按坐标点）：
    //   ① 顶栏工具条「进入多选模式」（aria-label 固定）
    //   ② 点第一张卡片的 action area —— 多选态下点卡片 = 勾选（勾选标记是
    //      aria-hidden 的纯视觉节点，点它没用，真正接收点击的是卡片 <a>）
    //   ③ 等 `.nav-bulk-bar` 落地
    // ⚠️ 卡片**只点一次**：批量条是懒加载 chunk，若在轮询里反复点卡片，
    //    第二次点击会把刚勾上的又取消掉，然后一直等不到条子。
    {
        await evaluate(`location.href = ${JSON.stringify(site.url)}`);
        await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
        const selectModeOn = await evaluate(`(() => {
            const btn = [...document.querySelectorAll('button')]
                .find(b => (b.getAttribute('aria-label') || '') === '进入多选模式');
            if (!btn) return 'no-select-mode-btn';
            btn.click();
            return 'clicked';
        })()`);
        if (selectModeOn !== "clicked") {
            console.error(`   面 D 批量操作条：「进入多选模式」找不到（${selectModeOn}）—— fail-closed 判红`);
            vpMissing.push("D 批量操作条");
        } else {
            const cardPicked = await evaluate(`(() => {
                const card = document.querySelector('a.MuiCardActionArea-root');
                if (!card) return 'no-card';
                card.click();
                return 'clicked';
            })()`);
            if (cardPicked !== "clicked") {
                console.error(`   面 D 批量操作条：没有可勾选的卡片（${cardPicked}）—— fail-closed 判红`);
                vpMissing.push("D 批量操作条");
            } else {
                let barState = null;
                {
                    const deadline = Date.now() + 15_000;
                    while (Date.now() < deadline) {
                        barState = await evaluate(`(() => {
                            const bar = document.querySelector('.nav-bulk-bar');
                            if (!bar) return null;
                            return { buttons: bar.querySelectorAll('button').length };
                        })()`);
                        if (barState && barState.buttons > 0) break;
                        barState = null;
                        await new Promise(r => setTimeout(r, 250));
                    }
                }
                if (!barState) {
                    console.error(
                        "   面 D 批量操作条：勾选后 15 秒内没出现带按钮的 .nav-bulk-bar —— fail-closed 判红"
                    );
                    vpMissing.push("D 批量操作条");
                } else {
                    const barRes = await evaluate(scanMobileTouch(".nav-bulk-bar", "D 批量操作条"));
                    if (barRes.missing) vpMissing.push("D 批量操作条");
                    else { for (const r of barRes.rows) tagMobileViolation(r); vpRows.push(...barRes.rows); }
                    reportMobileSurface(vp, "D 批量操作条", barRes);
                }
            }
        }
    }

    // ---- 收尾：**必须清掉 override / 触控仿真** ----
    // 不清的话，之后任何人往这个脚本尾巴上加一段，拿到的都是该宽度 + 触控的视口，
    // 量出来的东西会莫名其妙（而且没有任何报错提示）。
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });

    // ---- 四面汇总（fail-closed：违反项 + 未测到的面都进 mobileFailures）----
    {
        console.log(`=== 移动端${vp.label} 触控：四面汇总（fail-closed）===`);
        if (vpRows.length === 0 && vpMissing.length) {
            console.log("   ⚠️ 一面都没测到");
        } else {
            const byTier = { critical: 0, deco: 0, accept: 0 };
            let viol = 0;
            for (const r of vpRows) { byTier[r.tier] = (byTier[r.tier] || 0) + 1; if (r.violation) viol++; }
            console.log(
                `   合计 ${vpRows.length} 个可点元素：违反本档阈值 ${viol} 个` +
                    `（关键 ${byTier.critical} / 装饰 ${byTier.deco} / 可接受 ${byTier.accept}）`
            );
        }
        if (vpMissing.length) console.log(`   ⚠️ 未测到的面：${vpMissing.join(" / ")}`);
        console.log(`   本视口 mobileFailures 累计 ${mobileFailures.length} 条（含此前视口）\n`);
    }

    summarizeMobile(vp, vpRows, vpMissing);
}

/** Esc 关掉弹窗（MUI 固定契约），轮询到 [role="dialog"] 消失 */
async function escapeDialog() {
    await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "Escape", code: "Escape",
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Escape", code: "Escape",
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const still = await evaluate(`!!document.querySelector('[role="dialog"]')`);
        if (!still) break;
        await new Promise(r => setTimeout(r, 200));
    }
}

/** 一个视口跑完：把违反项与未测到的面转成 failures（fail-closed） */
function summarizeMobile(vp, vpRows, vpMissing) {
    for (const r of vpRows) {
        if (r.violation) {
            const eff = r.ew !== null ? `${r.ew}×${r.eh}` : `${r.w}×${r.h}`;
            mobileFailures.push(
                `移动端${vp.label} ${r.surface}：控件 .${r.cls}「${r.label}」` +
                    `（${TIER_NAME[r.tier]}档，要求≥${TIER_THRESHOLD[r.tier]}）` +
                    ` 有效热区 ${eff} < ${TIER_THRESHOLD[r.tier]}`
            );
        }
    }
    for (const m of vpMissing) {
        mobileFailures.push(`移动端${vp.label}：${m} 未测到（fail-closed）`);
    }
}

// ---- 双视口跑：390×844 与 375×844，两档都过才放行 ----
for (const vp of MOBILE_VIEWPORTS) {
    await runMobileAudit(vp);
}

// ---------- 判定 ----------
const failures = [];
// 移动端双视口审计累积的失效项并入总判定（fail-closed）
for (const m of mobileFailures) failures.push(m);
if (a11y.noNameBtns > 0) failures.push(`无名按钮 ${a11y.noNameBtns} 个`);
if (a11y.noAltImgs > 0) failures.push(`无 alt 图片 ${a11y.noAltImgs} 张`);
if (a11y.inputsNoLabel > 0) failures.push(`无 label 输入 ${a11y.inputsNoLabel} 个`);
if (touch.tooSmall > 0) failures.push(`触控目标小于 24px 的 ${touch.tooSmall} 个`);
if (broken.broken > 0) failures.push(`破图 ${broken.broken} 张`);
// 键盘焦点环：Tab 一遍，任何控件量不到轮廓/阴影就是 keyboard 用户找不到焦点
const noRing = focusVis.filter(f => !f.visible);
if (noRing.length > 0) {
    failures.push(`焦点环不可见 ${noRing.length} 个：${noRing.slice(0, 3).map(f => `${f.tag}「${f.label}」`).join(" / ")}`);
}
/**
 * 焦点环的**对比度**（2026-11-01）：有环 ≠ 环看得见。
 *
 * WCAG 1.4.11 要求非文本指示与相邻色 ≥ 3:1。以前只判「有没有环」，
 * 一圈与底色几乎同色的细环一直是绿的 —— 对键盘用户等于没有。
 * `ring: null` 的只有「由子元素承担指示」（child-indicator）那一类：
 * 那种指示是尺寸/描边变化，取不到单一「环色」，量不了；它已经有
 * `visible` 这条判据兜着，不算漏。
 */
const dimRing = focusVis.filter(f => f.ring && typeof f.ring.ratio === "number" && f.ring.ratio < f.ring.need);
if (dimRing.length > 0) {
    failures.push(
        `焦点环对比不足 3:1 的 ${dimRing.length} 个：` +
            dimRing.slice(0, 3).map(f => `${f.tag}「${f.label}」${f.ring.ratio}:1`).join(" / ")
    );
}

// 弹窗（命令面板）：可访问名 / aria-modal / 内部控件 / 焦点陷阱 / 焦点归位
if (!dialog.ariaModal) failures.push("弹窗：缺 aria-modal=\"true\"");
if (!dialog.labelled) failures.push("弹窗：没有可访问名（aria-label / aria-labelledby 都空）");
if (dialog.noNameBtns > 0) failures.push(`弹窗：无名按钮 ${dialog.noNameBtns} 个`);
if (dialog.tiny > 0) failures.push(`弹窗：触控目标小于 24px 的 ${dialog.tiny} 个`);
if (escaped.length > 0) {
    failures.push(`弹窗：焦点陷阱失效，Tab 逃出 ${escaped.length} 次（${escaped.slice(0, 3).join(" / ")}）`);
}
if (!closed) failures.push("弹窗：Esc 关不掉");
else if (restored !== "restored") failures.push(`弹窗：关闭后焦点没归位（${restored}）`);

// 记事本：同一套判据
if (notesA11y.noNameBtns > 0) failures.push(`记事本：无名按钮 ${notesA11y.noNameBtns} 个`);
if (notesA11y.noAltImgs > 0) failures.push(`记事本：无 alt 图片 ${notesA11y.noAltImgs} 张`);
if (notesA11y.inputsNoLabel > 0) failures.push(`记事本：无 label 输入 ${notesA11y.inputsNoLabel} 个`);
if (notesTouch.tooSmall > 0) failures.push(`记事本：触控目标小于 24px 的 ${notesTouch.tooSmall} 个`);
if (notesBroken.broken > 0) failures.push(`记事本：破图 ${notesBroken.broken} 张`);
const notesNoRing = notesFocus.filter(f => !f.visible);
if (notesNoRing.length > 0) {
    failures.push(
        `记事本：焦点环不可见 ${notesNoRing.length} 个：${notesNoRing.slice(0, 3).map(f => `${f.tag}「${f.label}」`).join(" / ")}`
    );
}
// 记事本：焦点环对比度，与首页同一把尺子（3:1，WCAG 1.4.11）
const notesDimRing = notesFocus.filter(f => f.ring && typeof f.ring.ratio === "number" && f.ring.ratio < f.ring.need);
if (notesDimRing.length > 0) {
    failures.push(
        `记事本：焦点环对比不足 3:1 的 ${notesDimRing.length} 个：` +
            notesDimRing.slice(0, 3).map(f => `${f.tag}「${f.label}」${f.ring.ratio}:1`).join(" / ")
    );
}

// 设置中心：同一把尺子（< 24px 就是 WCAG 2.5.8 违规；24~31px 只提示）
if (centerTouch.tooSmall > 0) {
    failures.push(`设置中心：触控目标小于 24px 的 ${centerTouch.tooSmall} 个`);
}

// 记事本·附件抽屉：与设置中心同一条尺子（< 24px 就是 WCAG 2.5.8 违规；
// 24~31px 只提示不判失败）。这一段 2026-11-01 才第一次被量 ——
// 之前它的无名控件与触控目标一次都没进过审计面，绿灯纯粹是没扫过。
if (drawerA11y.noNameBtns > 0) {
    failures.push(`记事本·附件抽屉：无名按钮 ${drawerA11y.noNameBtns} 个`);
}
if (drawerA11y.noAltImgs > 0) {
    failures.push(`记事本·附件抽屉：无 alt 图片 ${drawerA11y.noAltImgs} 张`);
}
if (drawerA11y.inputsNoLabel > 0) {
    failures.push(`记事本·附件抽屉：无 label 输入 ${drawerA11y.inputsNoLabel} 个`);
}
if (drawerTouch.tooSmall > 0) {
    failures.push(`记事本·附件抽屉：触控目标小于 24px 的 ${drawerTouch.tooSmall} 个`);
}
// 空态 / 拉取失败态（2026-11-01 加）：和常态同一把尺子
for (const st of drawerStates) {
    if (st.a.noNameBtns > 0) {
        failures.push(`记事本·附件抽屉·${st.title}：无名按钮 ${st.a.noNameBtns} 个`);
    }
    if (st.a.noAltImgs > 0) {
        failures.push(`记事本·附件抽屉·${st.title}：无 alt 图片 ${st.a.noAltImgs} 张`);
    }
    if (st.a.inputsNoLabel > 0) {
        failures.push(`记事本·附件抽屉·${st.title}：无 label 输入 ${st.a.inputsNoLabel} 个`);
    }
    if (st.t.tooSmall > 0) {
        failures.push(`记事本·附件抽屉·${st.title}：触控目标小于 24px 的 ${st.t.tooSmall} 个`);
    }
}

console.log("");
if (failures.length) {
    console.error("可访问性审计失败：\n  - " + failures.join("\n  - "));
    site.close();
    done(1);
}
console.log("可访问性审计通过（0 项不合格）");
site.close();
done(0);
