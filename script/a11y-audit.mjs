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
// 用法：npm run audit:a11y（需要先 npm run build；CHROME_PATH 可指定浏览器）

import { DIST, ROOT, openBrowser, startSiteServer, waitRendered } from "./auditEnv.mjs";
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

// ---------- 1. 可访问性：无名按钮 / 无 alt 图片 / 无标签输入 ----------
const a11y = await evaluate(`(() => {
  const q = s => [...document.querySelectorAll(s)];
  const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const noNameBtns = q('button').filter(b => !nameOf(b)).length;
  const noAltImgs  = q('img').filter(i => !i.getAttribute('alt')).length;
  const inputsNoLabel = q('input, select, textarea').filter(i => {
      if (i.type === 'hidden') return false;
      if (i.getAttribute('aria-label')) return false;
      if (i.id && document.querySelector('label[for="' + i.id + '"]')) return false;
      return !i.closest('label');
  }).length;
  const focusables = q('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])').length;
  const negTab = q('[tabindex="-1"]').length;
  const h1 = q('h1').length;
  const land = { header: q('header').length, main: q('main').length, nav: q('nav').length };
  return { buttons: q('button').length, noNameBtns, imgs: q('img').length, noAltImgs, inputsNoLabel, focusables, negTab, h1, land };
})()`);
console.log("=== 可访问性 ===");
console.log(JSON.stringify(a11y, null, 1));

// ---------- 2. 触控目标尺寸（桌面视口 1440）----------
// 判定线 WCAG 2.5.8 的 24px；24~31px 只提示不判失败（卡片浮层控件按用户要求收小过）
const touch = await evaluate(`(() => {
  const els = [...document.querySelectorAll('button, a[href], [role="button"], [role="option"]')];
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
          w: Math.round(r.width),
          h: Math.round(r.height),
      };
      if (r.height < 24 || r.width < 24) small.push(rec);
      else if (r.height < 32 || r.width < 32) warn.push(rec);
  }
  return { total: els.length, tooSmall: small.length, samples: small.slice(0, 20), borderline: warn.length, warnSamples: warn.slice(0, 10) };
})()`);
console.log("=== 触控目标（判定线 24px = WCAG 2.5.8）===");
console.log(`   可点元素 ${touch.total} 个：低于 24px 的 ${touch.tooSmall} 个，24~31px 的 ${touch.borderline} 个`);
for (const s of touch.samples) {
    console.log(`   ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}  (父 .${s.parent})`);
}
for (const s of touch.warnSamples) {
    console.log(`   ~ ${String(s.w).padStart(4)}×${String(s.h).padStart(3)}  「${s.label}」  .${s.cls}`);
}

// ---------- 3. 破图 ----------
const broken = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(2000);
  const imgs = [...document.querySelectorAll('img')];
  const bad = imgs.filter(i => i.complete && i.naturalWidth === 0);
  return { total: imgs.length, broken: bad.length, srcs: bad.slice(0,5).map(i => i.src.slice(0, 90)) };
})()`);
console.log("=== 图片加载 ===");
console.log(JSON.stringify(broken, null, 1));

// ---------- 4. 焦点可见性（真 Tab 键 → :focus-visible，作为判据）----------
//
// ⚠️ 曾经这一节「只打印不判据」，理由是 `el.focus()` 不触发 `:focus-visible`，
// 量出来恒为不可见 —— 那是**测量方法错了**，不是页面没问题。老脚本量出来的
// 「常用工具」outlineWidth 3px 而 outlineStyle none，等于全员不可见，纯假数据。
// 现在改用 CDP 发真 Tab 键（Input.dispatchKeyEvent）：由浏览器按真实键盘规则
// 决定什么时候挂 :focus-visible，量出来的才是用户看到的样子。
const focusVis = [];
for (let i = 0; i < 30; i++) {
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
    const info = await evaluate(`(() => {
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
    })()`);
    if (info) focusVis.push(info);
}
console.log("=== 焦点可见性（真 Tab 键，作为判据）===");
focusVis.forEach(f => console.log("  ", f.visible ? "ok  " : "MISS", JSON.stringify(f)));

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

console.log("");
if (failures.length) {
    console.error("可访问性审计失败：\n  - " + failures.join("\n  - "));
    site.close();
    done(1);
}
console.log("可访问性审计通过（0 项不合格）");
site.close();
done(0);
