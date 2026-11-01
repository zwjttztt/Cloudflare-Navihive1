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

import { DIST, ROOT, openBrowser, setAttachmentMode, startSiteServer, waitRendered } from "./auditEnv.mjs";
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
const SCAN_FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const outlineVisible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth || '0') > 0;
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
    };
  }
  return {
    tag: el.tagName,
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18),
    outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle,
    boxShadow: s.boxShadow === 'none' ? 'none' : 'has',
    visible: outlineVisible || s.boxShadow !== 'none', via,
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

// ---------- 判定 ----------
const failures = [];
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
