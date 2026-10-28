// script/ui-probe.mjs
// 界面缺陷探针：**只测量 + 截图**，不改 src/、不 commit。
//
// 覆盖两个用户报告的界面缺陷：
//   1. 笔记列表「选中行下方的分隔线看不见」——三档列表样式各量一遍边框与取样点
//   2. 备份弹窗「从 WebDAV 恢复」的框在矮视口（浏览器缩放）下与底部按钮区重叠
//
// 复用 script/auditEnv.mjs 的现成设施（静态产物 + 只读 API 桩 + headless Chrome CDP），
// 骨架照抄 script/a11y-audit.mjs：顶层 await、bail 兜住异常、结束 done(0)。
//
// 用法：npm run build && node script/ui-probe.mjs
//       CHROME_PATH 可指定浏览器；AUDIT_CDP_PORT 可指定调试端口起点。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DIST, openBrowser, startSiteServer, waitRendered } from "./auditEnv.mjs";

if (!fs.existsSync(DIST)) {
    console.error(`找不到 ${DIST}，先跑 npm run build`);
    process.exit(1);
}

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui-probe-out");
fs.mkdirSync(OUT, { recursive: true });

// 0 = 让系统分配端口；固定端口撞上别的进程就是一次 EADDRINUSE
const SITE_PORT = Number(process.env.AUDIT_SITE_PORT || 0);
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9526);

const site = await startSiteServer(SITE_PORT);
const { evaluate, send, done, chromePath, getErrors } = await openBrowser({ cdpPort: CDP_PORT });

const bail = err => {
    console.error("探针脚本异常：", err?.stack || err);
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
console.log(`页面: ${site.url}`);
console.log(`产物: ${OUT}\n`);

// ---------------- 通用小工具 ----------------
const shots = [];

/** CDP 截图落盘。传 buf 时复用已有 base64（同一帧写多个文件名用） */
async function shoot(name, buf) {
    let data = buf;
    if (!data) {
        const r = await send("Page.captureScreenshot", { format: "png" });
        data = r.data;
    }
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    if (!shots.includes(file)) shots.push(file);
    console.log(`  [截图] ${name}`);
    return data;
}

async function setViewport(width, height, mobile = false) {
    await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
    });
    // 布局结算：改完立刻量会拿到过渡中的值
    await sleep(320);
}

/** 硬导航并等 load 完成（导航中 evaluate 会抛，这里吞掉重试） */
async function goto(url) {
    await send("Page.navigate", { url });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
        try {
            if ((await evaluate("document.readyState")) === "complete") return;
        } catch {
            // 导航中
        }
        await sleep(200);
    }
    throw new Error("页面加载超时：" + url);
}

/** 轮询直到表达式为真 */
async function waitFor(label, expr, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const v = await evaluate(expr);
            if (v) return v;
        } catch {
            // 导航/重渲染中
        }
        await sleep(250);
    }
    throw new Error(`等待「${label}」超时：${expr}`);
}

// ---------------- 表格输出（中文按 2 列宽对齐） ----------------
const dw = s =>
    [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
const padW = (s, w) => String(s) + " ".repeat(Math.max(0, w - dw(s)));

function table(headers, rows) {
    const cells = rows.map(r => r.map(c => (c === null || c === undefined ? "—" : String(c))));
    const widths = headers.map((h, i) => Math.max(dw(h), ...cells.map(r => dw(r[i] ?? ""))));
    const line = arr => "  " + arr.map((c, i) => padW(c, widths[i])).join("  ");
    console.log(line(headers));
    console.log("  " + widths.map(w => "─".repeat(w)).join("  "));
    for (const r of cells) console.log(line(r.map((c, i) => c ?? "")));
}

const n1 = v => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "—");
const rectText = r => (r ? `${n1(r.x)},${n1(r.y)} ${n1(r.w)}×${n1(r.h)}` : "—");
const boxText = r => (r ? `${n1(r.top)}~${n1(r.bottom)} (h ${n1(r.h)})` : "—");

// ---------------- 页面表达式：笔记行测量 ----------------
const measureRowsExpr = style => `(() => {
  const STYLE = ${JSON.stringify(style)};
  const px = v => Math.round((parseFloat(v || '0') || 0) * 10) / 10;
  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const parseColor = str => {
    if (!str) return null;
    const s = String(str).trim();
    let m = /^rgba?\\(([^)]+)\\)$/i.exec(s);
    if (m) { const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/i.exec(s);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) { const n = parseInt(m[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) { const h = m[1]; return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16), a: 1 }; }
    return null;
  };
  const rgbText = c => c ? 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')' : null;
  const over = (fg, bg) => {
    if (!fg) return null;
    if (!bg) return fg;
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  };
  // 找一个「完全不透明」的祖先底色，作为估算叠色的底板
  const opaqueBg = el => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.99) return c;
      n = n.parentElement;
    }
    const b = parseColor(getComputedStyle(document.body).backgroundColor);
    return b && b.a >= 0.99 ? b : { r: 255, g: 255, b: 255, a: 1 };
  };
  const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')];
  if (!rows.length) return { style: STYLE, error: 'no-rows' };
  const cs0 = getComputedStyle(rows[0]);
  const looksSelected = cs0.borderTopColor !== 'rgba(0, 0, 0, 0)' && cs0.borderTopColor !== 'transparent';
  let idx = looksSelected ? 0 : rows.findIndex(r => {
    const s = getComputedStyle(r);
    return s.borderTopColor !== 'rgba(0, 0, 0, 0)' && s.borderTopColor !== 'transparent';
  });
  if (idx < 0) idx = 0;
  const selEl = rows[idx];
  const nextEl = rows[idx + 1] || null;
  const base = opaqueBg(selEl);
  const read = el => {
    const s = getComputedStyle(el);
    const bt = parseColor(s.borderTopColor), bb = parseColor(s.borderBottomColor);
    const bl = parseColor(s.borderLeftColor), br = parseColor(s.borderRightColor);
    return {
      rect: rectOf(el),
      border: {
        top: { w: px(s.borderTopWidth), color: s.borderTopColor, effective: rgbText(over(bt, base)) },
        left: { w: px(s.borderLeftWidth), color: s.borderLeftColor, effective: rgbText(over(bl, base)) },
        right: { w: px(s.borderRightWidth), color: s.borderRightColor, effective: rgbText(over(br, base)) },
        bottom: { w: px(s.borderBottomWidth), color: s.borderBottomColor, effective: rgbText(over(bb, base)) },
      },
      borderRadius: s.borderRadius,
      backgroundColor: s.backgroundColor,
      backgroundEffective: rgbText(over(parseColor(s.backgroundColor), base)),
      marginBottom: s.marginBottom,
      noteId: el.getAttribute('data-note-id'),
      title: (el.getAttribute('title') || el.textContent || '').trim().slice(0, 24),
    };
  };
  const sel = read(selEl);
  const next = nextEl ? read(nextEl) : null;
  // 像素判据：命中点上真正被点到的元素（elementFromPoint 不吃 clip，按绘制区域算）
  const midX = sel.rect.left + sel.rect.w / 2;
  const probe = y => {
    const el = document.elementFromPoint(midX, y);
    if (!el) return { y: y, hit: null };
    const s = getComputedStyle(el);
    return {
      y: y,
      hit: el.tagName.toLowerCase() + (el.getAttribute('data-note-id') ? '[#' + el.getAttribute('data-note-id') + ']' : ''),
      cls: String(el.className || '').slice(0, 70),
      bg: s.backgroundColor,
      borderTop: px(s.borderTopWidth) + ' ' + s.borderTopColor,
      borderBottom: px(s.borderBottomWidth) + ' ' + s.borderBottomColor,
    };
  };
  const tokens = {};
  const root = getComputedStyle(document.documentElement);
  for (const k of ['--card-border', '--border-hairline', '--accent', '--notes-accent']) {
    tokens[k] = (root.getPropertyValue(k) || '').trim();
  }
  let lsRaw = null;
  try { lsRaw = localStorage.getItem('notes.uiSettings'); } catch (e) { lsRaw = 'ERR:' + e.message; }
  return {
    style: STYLE,
    rowCount: rows.length,
    selectedIndex: idx,
    selected: sel,
    next: next,
    probes: {
      insideBottom: probe(sel.rect.bottom - 0.5),
      belowBottom1_5: probe(sel.rect.bottom + 1.5),
      insideBottom2: probe(sel.rect.bottom - 2),
    },
    tokens: tokens,
    baseBg: rgbText(base),
    listSettingsRaw: lsRaw,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  };
})()`;

// ---------------- 页面表达式：备份弹窗测量 ----------------
const measureDialogExpr = `(() => {
  const px = v => Math.round((parseFloat(v || '0') || 0) * 10) / 10;
  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const paper = document.querySelector('.MuiDialog-paper');
  const content = document.querySelector('.MuiDialogContent-root');
  const actions = document.querySelector('.MuiDialogActions-root');
  if (!paper || !content || !actions) return { error: 'dialog-missing', paper: !!paper, content: !!content, actions: !!actions };
  const heading = [...content.querySelectorAll('.MuiTypography-root')].find(el => (el.textContent || '').trim() === '从 WebDAV 恢复');
  let section = null, box = null;
  if (heading) {
    section = heading.parentElement ? heading.parentElement.parentElement : null;
    if (section) box = [...section.children].find(el => el !== heading.parentElement) || null;
  }
  const cs = getComputedStyle(content);
  const boxCs = box ? getComputedStyle(box) : null;
  const secCs = section ? getComputedStyle(section) : null;
  const actCs = getComputedStyle(actions);
  const paintProbe = y => {
    const el = document.elementFromPoint(innerWidth / 2, y);
    if (!el) return null;
    const s = getComputedStyle(el);
    return el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] + ' | bg ' + s.backgroundColor;
  };
  const contentRect = rectOf(content);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    paper: rectOf(paper),
    content: Object.assign(rectOf(content), {
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollTop: content.scrollTop,
      overflowY: cs.overflowY,
      display: cs.display,
      flexDirection: cs.flexDirection,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
    }),
    box: box ? Object.assign(rectOf(box), {
      minHeight: boxCs.minHeight,
      flex: boxCs.flex,
      cssHeight: boxCs.height,
      overflow: boxCs.overflow,
      borderTopWidth: px(boxCs.borderTopWidth),
      borderBottomWidth: px(boxCs.borderBottomWidth),
    }) : null,
    section: section ? Object.assign(rectOf(section), { minHeight: secCs.minHeight, flex: secCs.flex, overflow: secCs.overflow }) : null,
    actions: Object.assign(rectOf(actions), { borderTopWidth: px(actCs.borderTopWidth), position: actCs.position }),
    // 绘制判据：内容区下沿内侧 / 按钮区上沿内侧，实际被哪个元素画到
    probes: {
      contentBottomMinus2: paintProbe(contentRect.bottom - 2),
      actionsTopPlus2: paintProbe(rectOf(actions).top + 2),
      actionsTopPlus12: paintProbe(rectOf(actions).top + 12),
    },
    bodyScrollHeight: document.documentElement.scrollHeight,
  };
})()`;

// ---------------- 1. 导航页：桌面 / 手机整页截图 ----------------
await goto(site.url + "/?t=" + Date.now());
await waitRendered(evaluate);
console.log("=== C. 整页截图 ===");
await setViewport(1440, 950, false);
await shoot("nav-1440.png");

// 手机视口：布局会切成移动端，多等一会儿让 media query + 底栏结算
await setViewport(390, 844, true);
await sleep(600);
await shoot("nav-390.png");
const navMobileOverflow = await evaluate(`(() => {
  const vw = innerWidth, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' || s.visibility === 'hidden' || s.display === 'none') continue;
    if (r.right > vw + 1) out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44), right: +r.right.toFixed(1), w: +r.width.toFixed(1) });
  }
  return { vw, scrollW: document.documentElement.scrollWidth, overflowing: out.length, samples: out.slice(0, 6) };
})()`);
await setViewport(1440, 950, false);

// ---------------- 2. 备份弹窗：CSS 视口高度阶梯 ----------------
console.log("\n=== 缺陷 2：备份弹窗「从 WebDAV 恢复」重叠 ===\n");

const openMenu = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '更多选项');
  if (!btn) return 'no-more-button';
  btn.click();
  return 'ok';
})()`);
if (openMenu !== "ok") throw new Error("顶栏「更多选项」按钮找不到：" + openMenu);
await waitFor("更多选项菜单", `!!document.querySelector('.MuiMenuItem-root')`, 10_000);

const clickBackupItem = await evaluate(`(() => {
  const items = [...document.querySelectorAll('.MuiMenuItem-root')];
  // 菜单文案是「备份与恢复」（命令面板里才叫「数据备份」）
  const item = items.find(i => (i.textContent || '').includes('备份'));
  if (!item) return JSON.stringify(items.map(i => (i.textContent || '').trim()).slice(0, 20));
  item.click();
  return 'ok';
})()`);
if (clickBackupItem !== "ok") throw new Error("菜单里没有「数据备份」，实际项：" + clickBackupItem);

await waitFor(
    "备份弹窗",
    `(() => { const p = document.querySelector('.MuiDialog-paper'); return !!p && (document.body.innerText || '').includes('数据备份与恢复'); })()`,
    20_000
);
const clickRestoreTab = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.MuiDialog-paper .MuiTab-root')].find(t => (t.textContent || '').trim().startsWith('恢复'));
  if (!tab) return 'no-tab';
  tab.click();
  return 'ok';
})()`);
if (clickRestoreTab !== "ok") throw new Error("「恢复 / 导入」标签找不到");
await waitFor("从 WebDAV 恢复", `(document.body.innerText || '').includes('从 WebDAV 恢复')`, 10_000);
await sleep(600);

const HEIGHTS = [950, 820, 720, 640, 560];
const dialogRows = [];
const dialogExtra = [];

for (const h of HEIGHTS) {
    await setViewport(1440, h, false);
    const m = await evaluate(measureDialogExpr);
    if (m.error) throw new Error(`备份弹窗测量失败（h=${h}）：` + JSON.stringify(m));
    // 滚到底再量一次：区分「框不肯缩」还是「内容区没滚动」
    const scrolled = await evaluate(`(async () => {
      const c = document.querySelector('.MuiDialogContent-root');
      if (!c) return null;
      c.scrollTop = c.scrollHeight;
      await new Promise(r => setTimeout(r, 250));
      const box = document.querySelector('.MuiDialogContent-root') && (function () {
        const heading = [...c.querySelectorAll('.MuiTypography-root')].find(el => (el.textContent || '').trim() === '从 WebDAV 恢复');
        if (!heading) return null;
        const section = heading.parentElement ? heading.parentElement.parentElement : null;
        return section ? [...section.children].find(el => el !== heading.parentElement) || null : null;
      })();
      const actions = document.querySelector('.MuiDialogActions-root');
      const r = box ? box.getBoundingClientRect() : null;
      const a = actions ? actions.getBoundingClientRect() : null;
      return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, boxBottom: r ? +r.bottom.toFixed(1) : null, actionsTop: a ? +a.top.toFixed(1) : null };
    })()`);
    // 恢复顶部再截图，保证截图是「用户一打开看到的样子」
    await evaluate(`(() => { const c = document.querySelector('.MuiDialogContent-root'); if (c) c.scrollTop = 0; })()`);
    await sleep(250);
    await shoot(`backup-restore-h${h}.png`);

    const overlap = m.box ? +(m.box.bottom - m.actions.top).toFixed(1) : null;
    const beyondContent = m.box ? +(m.box.bottom - m.content.bottom).toFixed(1) : null;
    const beyondPaper = m.box ? +(m.box.bottom - m.paper.bottom).toFixed(1) : null;

    dialogRows.push([
        String(h),
        boxText(m.paper),
        `${n1(m.content.h)} / ${m.content.scrollHeight} / ${m.content.clientHeight}`,
        m.content.overflowY,
        boxText(m.box),
        m.box ? n1(m.box.minHeight ? parseFloat(m.box.minHeight) : 0) : "—",
        n1(m.actions.top),
        overlap > 0 ? `+${overlap.toFixed(1)}` : overlap.toFixed(1),
        beyondContent > 0 ? `+${beyondContent.toFixed(1)}` : beyondContent.toFixed(1),
        beyondPaper > 0 ? `+${beyondPaper.toFixed(1)}` : beyondPaper.toFixed(1),
    ]);
    dialogExtra.push({
        h,
        paperH: m.paper.h,
        contentH: m.content.h,
        scrollH: m.content.scrollHeight,
        clientH: m.content.clientHeight,
        scrollable: m.content.scrollHeight - m.content.clientHeight,
        boxH: m.box ? m.box.h : null,
        boxMinHeight: m.box ? m.box.minHeight : null,
        boxFlex: m.box ? m.box.flex : null,
        sectionH: m.section ? m.section.h : null,
        probes: m.probes,
        scrolled,
        actionsPosition: m.actions.position,
    });
}

console.log("表 B-1：视口高度 × 弹窗几何（单位 px；重叠量 > 0 即 box 底边越过按钮区顶边）");
table(
    ["视口高", "paper top~bottom (h)", "content h / scrollH / clientH", "overflowY", "WebDAV 框 top~bottom (h)", "框 minH", "actions.top", "与按钮区重叠", "跑出 content 底", "跑出 paper 底"],
    dialogRows
);

console.log("\n表 B-2：内容区滚动能力与命中判据");
table(
    ["视口高", "内容可滚动量", "框高", "框 flex", "框 min-height", "滚到底后 box.bottom", "滚到底后 actions.top", "content 底内侧命中", "actions 顶+2 命中"],
    dialogExtra.map(d => [
        String(d.h),
        d.scrollable > 0 ? `${d.scrollable}` : "0（不可滚）",
        n1(d.boxH),
        String(d.boxFlex),
        String(d.boxMinHeight),
        d.scrolled ? n1(d.scrolled.boxBottom) : "—",
        d.scrolled ? n1(d.scrolled.actionsTop) : "—",
        String(d.probes.contentBottomMinus2 || "—"),
        String(d.probes.actionsTopPlus2 || "—"),
    ])
);

// 关掉弹窗（点「关闭」），回到导航页
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.MuiDialogActions-root button')].find(b => (b.textContent || '').trim() === '关闭');
  if (btn) { btn.click(); return 'ok'; }
  return 'no-close';
})()`);
await sleep(600);
await setViewport(1440, 950, false);

// ---------------- 3. 记事本：选中行几何 + 三档列表样式 ----------------
console.log("\n=== 缺陷 1：笔记列表选中行与分隔线 ===\n");

/** 进记事本 → 等列表 → 点第一行选中 */
async function openNotesAndSelect() {
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
      if (!btn) return 'no-entry';
      btn.click();
      return 'clicked';
    })()`);
    if (clicked !== "clicked") throw new Error("记事本入口找不到：" + clicked);
    await waitFor("笔记列表渲染", `(document.body.innerText || '').includes('会议纪要')`, 25_000);
    const sel = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')];
      if (!rows.length) return { ok: false, rows: 0 };
      rows[0].click();
      return { ok: true, rows: rows.length, id: rows[0].getAttribute('data-note-id') };
    })()`);
    if (!sel.ok) throw new Error("笔记列表里没有 [data-note-id] 行");
    await sleep(700);
    return sel;
}

const styles = [];
const defaultSelection = await openNotesAndSelect();
console.log(`已进入记事本（${defaultSelection.rows} 行，选中 #${defaultSelection.id}）\n`);

// 默认档（DEFAULT_NOTES_SETTINGS.listStyle = "divider"）
const mDefault = await evaluate(measureRowsExpr("divider（默认档）"));
styles.push(mDefault);
const defaultShot = await shoot("notes-selected.png");
await shoot("notes-selected-divider.png", defaultShot);
await shoot("notes-1440.png", defaultShot);

// ---------------- 3b. P3：左栏搜索框在默认列宽下放得下占位符吗（2026-10-27） ----------------
// 用户报「左上角最左栏上方太拥挤」。实测真因不是「白框太大」，而是搜索框内部被挤爆：
// 左栏默认 128 → 字段 112，减掉 MUI 内部左右各 14 内填充、放大镜 20+8、⌘K 胶囊 26.6+8
// ⇒ 输入区只剩 19.4px，16px 字号下连一个字都放不下，占位符被裁成半个字。
// 修法：窄列里让 ⌘K 提示按容器查询自动隐身。这条断言就是把「放得下」钉死。
const p3Fails = [];
const navSearch = await evaluate(`(() => {
  const col = document.querySelector('[data-nav-col]');
  const header = document.querySelector('[data-nav-header]');
  const field = header && header.querySelector('.MuiOutlinedInput-root');
  if (!field) return { error: 'no-field' };
  const kbd = field.querySelector('kbd');
  const input = field.querySelector('input');
  const w = el => +el.getBoundingClientRect().width.toFixed(1);
  const cv = document.createElement('canvas').getContext('2d');
  const cs = getComputedStyle(input);
  cv.font = cs.fontSize + ' ' + cs.fontFamily;
  return {
    colW: col ? w(col) : null,
    fieldW: w(field),
    inputW: w(input),
    placeholder: input.getAttribute('placeholder'),
    placeholderPx: +cv.measureText(input.getAttribute('placeholder') || '').width.toFixed(1),
    kbdDisplay: kbd ? getComputedStyle(kbd).display : 'no-kbd',
  };
})()`);
if (navSearch.error) {
    p3Fails.push(`左栏搜索框量不到：${navSearch.error}`);
} else {
    console.log(
        `\n  左栏搜索框 @${navSearch.colW}：字段 ${navSearch.fieldW}px｜输入区 ${navSearch.inputW}px｜` +
            `占位符「${navSearch.placeholder}」${navSearch.placeholderPx}px｜⌘K ${navSearch.kbdDisplay}`
    );
    if (navSearch.inputW < navSearch.placeholderPx) {
        p3Fails.push(
            `占位符放不下：输入区 ${navSearch.inputW}px < 占位符 ${navSearch.placeholderPx}px（用户报的「被切成半个字」就是这个）`
        );
    }
    if (navSearch.kbdDisplay !== "none") {
        p3Fails.push(`默认列宽下 ⌘K 提示还占着 ${navSearch.fieldW}px 字段里的位置（应 display:none）`);
    }
}

// ---------- P4：中栏分割线上移 + 左栏搜索框（2026-10-27 后续） ----------
// 用户最新要求：① 左栏搜索框上移一点点、并去掉它上面的分隔线；② 中栏「所有笔记 /
// 全文搜索」下方的分割线上移（原来贴在 78，下方空太多）；③ 三栏上方**不用**对齐。
// 所以这条不再钉「四底边同高」，改成钉三件事：中栏分割线确实上移了、
// 搜索框没被撑厚（仍 30）、搜索框仍包在左栏头部内（没溢出）。
// ⚠️ 这条只有真浏览器能量：jsdom 不算布局，calc() 在单测里永远是 0。
const p4Fails = [];
const bands = await evaluate(`(() => {
  const R = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { t:+b.top.toFixed(1), b:+b.bottom.toFixed(1), h:+b.height.toFixed(1) }; };
  const out = {};
  out.navHeader = R(document.querySelector('[data-nav-header]'));
  out.listHeader = R(document.querySelector('[data-list-header]'));
  out.search = R(document.querySelector('[data-nav-header] .MuiOutlinedInput-root'));
  return out;
})()`);
const bandKeys = ["navHeader", "listHeader", "search"];
const bandVals = bandKeys.map(k => bands[k] || null);
if (bandVals.some(v => !v)) {
    p4Fails.push(`头部测量量不全：${bandKeys.map((k, i) => k + "=" + (bandVals[i] ? bandVals[i].b : "null")).join(" / ")}`);
} else {
    console.log(
        `\n  中栏分割线 listHeader.b=${bands.listHeader.b}（≤66 即已上移）｜左栏头 ${bands.navHeader.b}｜` +
            `搜索框 ${bands.search.h}px 高、顶 ${bands.search.t} / 底 ${bands.search.b}`
    );
    // ① 中栏分割线要上移：不能还贴在 78
    if (bands.listHeader.b > 66) {
        p4Fails.push(`中栏分割线还在 ${bands.listHeader.b}（应 ≤66，已上移自 78）`);
    }
    if (bands.listHeader.b < 50) {
        p4Fails.push(`中栏分割线 ${bands.listHeader.b} 太矮（应 ≥50，别把标题挤没）`);
    }
    // ② 搜索框高度保持 30，没被撑厚
    if (bands.search.h > 34) {
        p4Fails.push(`搜索框被撑到 ${bands.search.h}px 高（应保持 30 —— 头部变高不等于把控件撑厚）`);
    }
    // ③ 搜索框仍包在左栏头部内（底边不越过头部底边，顶边不低于头部顶边）
    if (bands.search.b > bands.navHeader.b + 1.5) {
        p4Fails.push(`左栏搜索框底 ${bands.search.b} 越过左栏头部底 ${bands.navHeader.b}（搜索框溢出了）`);
    }
    if (bands.search.t < bands.navHeader.t - 1.5) {
        p4Fails.push(`左栏搜索框顶 ${bands.search.t} 高于左栏头部顶 ${bands.navHeader.t}（搜索框溢出了）`);
    }
}

// 首行（会议纪要）是「置顶」分组里唯一一条，它下方紧接的是「本月」分组标题，
// 不是另一行笔记。为了量「它下面那一行」，再选一次同组相邻的读书笔记做对照。
const adjClicked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')];
  if (rows.length < 2) return { ok: false };
  rows[1].click();
  return { ok: true, id: rows[1].getAttribute('data-note-id') };
})()`);
if (adjClicked.ok) {
    await sleep(700);
    styles.push(await evaluate(measureRowsExpr("divider（相邻行对照）")));
    await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')]; if (rows[0]) rows[0].click(); })()`);
    await sleep(500);
}

// 手机视口（仍是默认档）：先拍，再切档重载
await setViewport(390, 844, true);
await sleep(600);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')];
  if (rows[0]) rows[0].click();
})()`);
await sleep(500);
await shoot("notes-390.png");
// ---- 断言：390×844 下记事本必须是「单栏」且「状态栏一行」（2026-10-26 用户报的两个缺陷）----
// 判据用「预览占编辑区的宽度比」而不是某个元素在不在：分屏时预览只拿 ~50%，
// 单栏时它吃满整条（减去 px:2 的内边距），两种状态差得很远，不会误判。
const notesMobileLayout = await evaluate(`(() => {
  const pane = document.querySelector('[data-editor-pane]');
  const prev = document.querySelector('[data-preview-scroll]');
  const bar = document.querySelector("[data-statusbar='1']");
  const sep = [...document.querySelectorAll('[role=\\"separator\\"]')]
    .filter(el => el.getAttribute('aria-label') === '拖动调整源码与预览的比例').length;
  const modes = [...document.querySelectorAll("[data-pane-modes='1'] button")]
    .map(b => b.getAttribute('aria-label'));
  const pe = pane ? pane.getBoundingClientRect() : null;
  const pr = prev ? prev.getBoundingClientRect() : null;
  const br = bar ? bar.getBoundingClientRect() : null;
  const kids = bar ? [...bar.children].map(c => c.getBoundingClientRect()) : [];
  return {
    sep,
    modes,
    editorMounted: !!document.querySelector('.cm-editor'),
    paneW: pe ? +pe.width.toFixed(1) : null,
    previewW: pr ? +pr.width.toFixed(1) : null,
    ratio: pe && pr && pe.width ? +(pr.width / pe.width).toFixed(3) : null,
    barH: br ? +br.height.toFixed(1) : null,
    barKids: kids.filter(r => r.width > 0).length,
    barMaxKidH: kids.length ? +Math.max(...kids.map(r => r.height)).toFixed(1) : null,
    barCutX: bar ? bar.scrollWidth > bar.clientWidth + 1 : null,
    barCutY: bar ? bar.scrollHeight > bar.clientHeight + 1 : null,
    barText: bar ? (bar.textContent || '').trim().slice(0, 60) : null,
  };
})()`);
const notesMobileFails = [];
// 单栏的「另一半」：切到「编辑」也要独占整条宽度。
// 只要源码栏的宽度表达式还在读 pane 而不是 finePane，这里就会量到 ~50%（窄缝）。
const notesMobileEdit = await evaluate(`(async () => {
  const pick = label => [...document.querySelectorAll("[data-pane-modes='1'] button")]
    .find(b => b.getAttribute('aria-label') === label);
  const btn = pick('编辑');
  if (!btn) return { ok: false, why: '找不到「编辑」键' };
  btn.click();
  await new Promise(r => setTimeout(r, 450));
  const pane = document.querySelector('[data-editor-pane]');
  const cm = document.querySelector('.cm-editor');
  const sep = [...document.querySelectorAll('[role=\\"separator\\"]')]
    .filter(el => el.getAttribute('aria-label') === '拖动调整源码与预览的比例').length;
  const pw = pane ? pane.getBoundingClientRect().width : 0;
  const cw = cm ? cm.getBoundingClientRect().width : 0;
  const out = { ok: true, paneW: +pw.toFixed(1), srcW: +cw.toFixed(1), sep, ratio: pw ? +(cw / pw).toFixed(3) : 0 };
  const back = pick('预览');
  if (back) { back.click(); await new Promise(r => setTimeout(r, 350)); }
  return out;
})()`);
if (!notesMobileEdit.ok) notesMobileFails.push(`窄屏切「编辑」失败：${notesMobileEdit.why}`);
if (notesMobileEdit.ok) {
    if (notesMobileEdit.sep !== 0) notesMobileFails.push("切到「编辑」后仍出现分隔条");
    if (notesMobileEdit.ratio < 0.85) {
        notesMobileFails.push(`切到「编辑」后源码栏只占 ${Math.round(notesMobileEdit.ratio * 100)}%（应 ≈100%，说明宽度还在按 splitRatio 算）`);
    }
}
if (notesMobileLayout.sep !== 0) notesMobileFails.push(`仍有源码/预览分隔条（${notesMobileLayout.sep} 条）—— 说明还在分屏`);
if (notesMobileLayout.ratio !== null && notesMobileLayout.ratio < 0.9) {
    notesMobileFails.push(`预览只占编辑区 ${Math.round(notesMobileLayout.ratio * 100)}%（应 ≈100%，分屏才会是一半）`);
}
if (notesMobileLayout.editorMounted) notesMobileFails.push("降级到预览后编辑器仍挂载 —— 说明 finePane 没生效");
if (notesMobileLayout.modes.includes("分栏")) notesMobileFails.push("窄屏仍渲染「分栏」键（应条件渲染掉）");
if (notesMobileLayout.barCutY) notesMobileFails.push("状态栏内容纵向溢出 —— 折行后第二行被 26px 裁掉");
if (notesMobileLayout.barCutX) notesMobileFails.push("状态栏内容横向溢出 —— 右端被裁");
if (notesMobileLayout.barMaxKidH !== null && notesMobileLayout.barMaxKidH > 20) {
    notesMobileFails.push(`状态栏里有 ${notesMobileLayout.barMaxKidH}px 高的项（单行应 ≤20px，说明折了）`);
}
if (notesMobileLayout.barText && /字符|分钟读完|创建于/.test(notesMobileLayout.barText)) {
    notesMobileFails.push(`状态栏窄屏仍在渲染非关键项：${notesMobileLayout.barText}`);
}

const notesMobileOverflow = await evaluate(`(() => {
  const vw = innerWidth, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' || s.visibility === 'hidden' || s.display === 'none') continue;
    if (r.right > vw + 1) out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44), right: +r.right.toFixed(1), w: +r.width.toFixed(1) });
  }
  return { vw, scrollW: document.documentElement.scrollWidth, overflowing: out.length, samples: out.slice(0, 6) };
})()`);
await setViewport(1440, 950, false);

// 其余两档：写 localStorage → 整页重载 → 重新进记事本（设置只在启动时读一次）
for (const style of ["plain", "card"]) {
    await evaluate(`localStorage.setItem('notes.uiSettings', JSON.stringify({ listStyle: ${JSON.stringify(style)} }))`);
    await goto(site.url + "/?t=" + Date.now());
    await waitRendered(evaluate);
    await setViewport(1440, 950, false);
    await openNotesAndSelect();
    const m = await evaluate(measureRowsExpr(style));
    styles.push(m);
    await shoot(`notes-selected-${style}.png`);
}

// localStorage 全量 dump（前 2000 字符）
const lsDump = await evaluate(`(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
  return JSON.stringify(out).slice(0, 2000);
})()`);

// ---------------- 4. 输出：缺陷 1 ----------------
const stylesWithData = styles.filter(s => !s.error);
console.log("表 A-1：选中行四边边框（宽 px / 计算色 / 叠到底色后的视觉色）");
table(
    ["列表档", "上", "左", "右", "下", "圆角", "选中行背景"],
    stylesWithData.map(s => [
        s.style,
        `${n1(s.selected.border.top.w)} ${s.selected.border.top.color}`,
        `${n1(s.selected.border.left.w)} ${s.selected.border.left.color}`,
        `${n1(s.selected.border.right.w)} ${s.selected.border.right.color}`,
        `${n1(s.selected.border.bottom.w)} ${s.selected.border.bottom.color}`,
        s.selected.borderRadius,
        s.selected.backgroundColor,
    ])
);

console.log("\n表 A-2：矩形与下方那一行");
table(
    ["列表档", "选中行 x,y w×h", "选中行 top/bottom", "下行 x,y w×h", "下行 top", "行间空隙", "下行上边框", "下行下边框", "下行背景"],
    stylesWithData.map(s => [
        s.style,
        rectText(s.selected.rect),
        `${n1(s.selected.rect.top)}/${n1(s.selected.rect.bottom)}`,
        s.next ? rectText(s.next.rect) : "（无）",
        s.next ? n1(s.next.rect.top) : "—",
        s.next ? n1(s.next.rect.top - s.selected.rect.bottom) : "—",
        s.next ? `${n1(s.next.border.top.w)} ${s.next.border.top.color}` : "—",
        s.next ? `${n1(s.next.border.bottom.w)} ${s.next.border.bottom.color}` : "—",
        s.next ? s.next.backgroundColor : "—",
    ])
);

console.log("\n表 A-3：叠到底色后的视觉色（估算，边框 alpha 直接叠加到不透明祖先底色上）");
table(
    ["列表档", "上", "左", "右", "下", "底色"],
    stylesWithData.map(s => [
        s.style,
        s.selected.border.top.effective,
        s.selected.border.left.effective,
        s.selected.border.right.effective,
        s.selected.border.bottom.effective,
        s.baseBg,
    ])
);

console.log("\n表 A-4：elementFromPoint 取样（x = 选中行中线）");
for (const s of stylesWithData) {
    console.log(`  【${s.style}】选中行 bottom = ${n1(s.selected.rect.bottom)}`);
    table(
        ["取样 y", "命中元素", "命中元素背景", "命中元素 border-top", "命中元素 border-bottom"],
        [s.probes.insideBottom, s.probes.belowBottom1_5, s.probes.insideBottom2].map(p => [
            `${n1(p.y)}${p.y === s.selected.rect.bottom - 0.5 ? "（行内）" : p.y === s.selected.rect.bottom + 1.5 ? "（行外）" : ""}`,
            p.hit ? `${p.hit} .${p.cls}` : "null",
            p.bg || "—",
            p.borderTop || "—",
            p.borderBottom || "—",
        ])
    );
}

console.log("\n表 A-5：CSS token 实际取值 / 列表设置原文");
table(
    ["列表档", "--card-border", "--border-hairline", "--accent", "--notes-accent", "localStorage notes.uiSettings"],
    stylesWithData.map(s => [
        s.style,
        s.tokens["--card-border"],
        s.tokens["--border-hairline"] || "（未定义）",
        s.tokens["--accent"],
        s.tokens["--notes-accent"],
        s.listSettingsRaw ? s.listSettingsRaw.slice(0, 90) : "null",
    ])
);

console.log("\nlocalStorage 全量 dump（前 2000 字符）：");
console.log("  " + lsDump);

// ---------------- 5. 其它观察 ----------------
console.log("\n=== D. 其它布局/样式观察（只报告，不修） ===");
console.log(`  导航页 @390：scrollWidth=${navMobileOverflow.scrollW}（视口 ${navMobileOverflow.vw}），横向溢出元素 ${navMobileOverflow.overflowing} 个`);
for (const s of navMobileOverflow.samples) console.log(`    ${s.tag} .${s.cls} right=${s.right} w=${s.w}`);
console.log(`  记事本 @390：scrollWidth=${notesMobileOverflow.scrollW}（视口 ${notesMobileOverflow.vw}），横向溢出元素 ${notesMobileOverflow.overflowing} 个`);
for (const s of notesMobileOverflow.samples) console.log(`    ${s.tag} .${s.cls} right=${s.right} w=${s.w}`);
console.log(
    `  记事本 @390 编辑区：分隔条 ${notesMobileLayout.sep} 条｜编辑器挂载 ${notesMobileLayout.editorMounted ? "是" : "否"}｜` +
        `预览 ${notesMobileLayout.previewW}/${notesMobileLayout.paneW}px（占 ${
            notesMobileLayout.ratio === null ? "—" : Math.round(notesMobileLayout.ratio * 100) + "%"
        }）｜模式键 [${notesMobileLayout.modes.join(" / ")}]`
);
console.log(
    `  记事本 @390 状态栏：h=${notesMobileLayout.barH}px｜可见项 ${notesMobileLayout.barKids} 个｜最高项 ${notesMobileLayout.barMaxKidH}px｜` +
        `横向裁切 ${notesMobileLayout.barCutX}｜纵向裁切 ${notesMobileLayout.barCutY}｜文案「${notesMobileLayout.barText}」`
);
console.log(
    `  记事本 @390 切「编辑」：源码栏 ${notesMobileEdit.ok ? notesMobileEdit.srcW : "—"}/${notesMobileEdit.ok ? notesMobileEdit.paneW : "—"}px（占 ${
        notesMobileEdit.ok ? Math.round(notesMobileEdit.ratio * 100) + "%" : "—"
    }）｜分隔条 ${notesMobileEdit.ok ? notesMobileEdit.sep : "—"} 条`
);
if (notesMobileFails.length) {
    console.log("\n✗ 390×844 单栏 / 状态栏断言未通过：");
    for (const f of notesMobileFails) console.log("  - " + f);
} else {
    console.log("\n✓ 390×844 断言通过：单栏（无分隔条、预览吃满编辑区、模式键无「分栏」）+ 状态栏一行不折行不裁切");
}

for (const d of dialogExtra) {
    console.log(
        `  备份弹窗 h=${d.h}：paper ${n1(d.paperH)}，content ${n1(d.contentH)}（可滚 ${d.scrollable}），` +
            `WebDAV 框 ${n1(d.boxH)}（min-height ${d.boxMinHeight}, flex ${d.boxFlex}），section ${n1(d.sectionH)}，` +
            `actions position=${d.actionsPosition}`
    );
    if (d.scrolled) {
        console.log(
            `    滚到底：scrollTop=${n1(d.scrolled.scrollTop)}，box.bottom=${n1(d.scrolled.boxBottom)}，actions.top=${n1(d.scrolled.actionsTop)}，` +
                `仍重叠 ${n1(d.scrolled.boxBottom - d.scrolled.actionsTop)}`
        );
    }
}

const errs = getErrors();
if (errs.length) {
    console.log(`\n页面控制台报错 ${errs.length} 条（可能影响测量可信度）：`);
    for (const e of errs.slice(0, 8)) console.log("  - " + String(e).slice(0, 180));
} else {
    console.log("\n页面控制台无报错。");
}

// ---------------- 6. P1/P2 本轮改动的三处几何（2026-10-26） ----------------
// 这三处全是「CSS 写对了但没有量过」的高危项：头部基线、卡片密度、窄屏工具栏行数。
// 它们不会让单测变红（单测没有布局），所以必须靠真机量。
console.log("\n=== E. P1/P2 改动几何（头部基线 / 卡片密度 / 窄屏工具栏） ===");
const p1Fails = [];

await setViewport(1440, 950, false);
await goto(site.url + "/?t=" + Date.now());
await waitFor("导航页卡片渲染", `(document.querySelectorAll('[data-site-id]').length) > 0`, 25_000);

// E-1 头部：站名与时钟共享一条基线（P1-1）
const headerGeom = await evaluate(`(() => {
  const clock = document.querySelector('.nav-clock');
  const h1 = document.querySelector('h1');
  const row = clock ? clock.parentElement : null;
  const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, w: b.width, h: b.height }; };
  return {
    hasClock: !!clock,
    alignItems: row ? getComputedStyle(row).alignItems : null,
    flexDirection: clock ? getComputedStyle(clock).flexDirection : null,
    clockH: clock ? +clock.getBoundingClientRect().height.toFixed(1) : null,
    h1: h1 ? r(h1) : null,
    clock: clock ? r(clock) : null,
    text: clock ? (clock.textContent || '').trim().slice(0, 40) : null,
  };
})()`);
console.log(
    `  头部：alignItems=${headerGeom.alignItems}（要 baseline）｜时钟 flexDirection=${headerGeom.flexDirection}（要 row）｜` +
        `时钟盒高 ${headerGeom.clockH}px（单行应 ≈16，两行 ≈32）`
);
console.log(`    站名 ${headerGeom.h1 ? `top=${n1(headerGeom.h1.top)} bottom=${n1(headerGeom.h1.bottom)}` : "—"}｜时钟「${headerGeom.text}」${headerGeom.clock ? `top=${n1(headerGeom.clock.top)} bottom=${n1(headerGeom.clock.bottom)}` : ""}`);
if (headerGeom.alignItems !== "baseline") p1Fails.push(`头部第一层 alignItems 不是 baseline（实为 ${headerGeom.alignItems}）—— 时钟又会浮在站名上方`);
if (headerGeom.flexDirection !== "row") p1Fails.push(`时钟仍是 ${headerGeom.flexDirection} 堆叠—— 要单行元信息块`);
if (headerGeom.clockH !== null && headerGeom.clockH > 24) p1Fails.push(`时钟盒高 ${headerGeom.clockH}px，说明还是两行`);

// E-2 卡片密度（P1-3）：少卡片的分组不该「缩在左边」，也不该有一张卡铺满整行
const cardGeom = await evaluate(`(() => {
  const grids = new Map();
  for (const c of [...document.querySelectorAll('[data-site-id]')]) {
    const cell = c.parentElement;
    const grid = cell ? cell.parentElement : null;
    if (!grid) continue;
    if (!grids.has(grid)) grids.set(grid, []);
    grids.get(grid).push(Math.round(cell.getBoundingClientRect().width));
  }
  return {
    groups: [...grids.values()],
    gridWidths: [...grids.keys()].map(g => Math.round(g.getBoundingClientRect().width)),
  };
})()`);
const allCardW = cardGeom.groups.flat();
const wMin = allCardW.length ? Math.min(...allCardW) : null;
const wMax = allCardW.length ? Math.max(...allCardW) : null;
console.log("\n表 E-1：卡片网格（每个分组一行；宽度 = 格子宽，单位 px）");
table(
    ["分组 #", "网格宽", "卡片数", "各卡宽度", "最宽/最窄（全站）"],
    cardGeom.groups.map((ws, i) => [
        i + 1,
        cardGeom.gridWidths[i],
        ws.length,
        ws.join(" / "),
        wMin && wMax ? `${wMax} / ${wMin} = ${(wMax / wMin).toFixed(2)}×` : "—",
    ])
);
if (wMin && wMax && wMax / wMin > 2.2) {
    p1Fails.push(`卡片最宽 ${wMax}px 与最窄 ${wMin}px 差 ${(wMax / wMin).toFixed(2)}×（应 ≤2.2 才算「同一档密度」）`);
}

// E-3 窄屏工具栏行数（P2-1）：390 下必须 ≤2 行、≤120px
await setViewport(390, 844, true);
await goto(site.url + "/?t=" + Date.now());
await waitFor("记事本入口", `[...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') || '') === '打开记事本')`, 25_000);
// 先进记事本，等编辑区真的挂载（模式键是它挂载完成的信号）
const notesOpened = await evaluate(`(() => {
  const open = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '打开记事本');
  if (!open) return 'no-entry';
  open.click();
  return 'clicked';
})()`);
if (notesOpened !== "clicked") {
    p1Fails.push(`窄屏工具栏量不到：记事本入口点不开（${notesOpened}）`);
} else {
await waitFor("笔记列表渲染", `(document.body.innerText || '').includes('会议纪要')`, 25_000);
await sleep(400);
// ⚠️ 必须先**选中一条笔记**：没选中时编辑区整块是 display:none，
// 于是模式键和工具栏的盒子都是 0（第一次量的时候就栽在这：模式键在 DOM 里但 h=0）。
const rowPicked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-note-list] [data-note-id]')];
  if (!rows.length) return 'no-rows';
  rows[0].click();
  return 'picked';
})()`);
if (rowPicked !== "picked") {
    p1Fails.push(`窄屏工具栏量不到：笔记列表没有可选行（${rowPicked}）`);
}
await waitFor("记事本编辑区挂载", `!!document.querySelector("[data-pane-modes='1']")`, 25_000);
await sleep(700);
const toolbarGeom = await evaluate(`(async () => {
  // ⚠️ 窄屏下页面里**同时挂载着两份**编辑区（主栏 + 侧栏），侧栏那份是 display:none。
  // 直接 querySelector / find 会抓到隐藏的那份，量出来全是 0 —— 0 还会让「行数≤2」
  // 假通过。所以下面所有 pick 都只认**真的有尺寸**的元素。
  const visible = el => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0;
  const pick = label => [...document.querySelectorAll("[data-pane-modes='1'] button")]
    .filter(visible)
    .find(b => b.getAttribute('aria-label') === label);
  // 轮询等「编辑」键可见：记事本浮层是带过渡进场的，刚挂载那会儿元素在 DOM 里
  // 但盒子还是 0 —— 一次性 pick 会误判成「没有这个键」。
  let edit = null;
  for (let i = 0; i < 20 && !edit; i++) {
    edit = pick('编辑') || null;
    if (!edit) await new Promise(r => setTimeout(r, 300));
  }
  if (!edit) {
    const seen = [...document.querySelectorAll("[data-pane-modes='1'] button")]
      .map(b => b.getAttribute('aria-label') + '(h=' + Math.round(b.getBoundingClientRect().height) + ')');
    return { ok: false, why: 'no-edit-btn', seen: seen.slice(0, 10) };
  }
  edit.click();
  await new Promise(r => setTimeout(r, 600));
  // 编辑区是异步挂载的（CodeMirror + 工具栏都晚一拍），量早了会拿到 height=0 ——
  // 而 height=0 会让下面的「行数 ≤2 / 高 ≤120」全部假通过。所以这里**轮询等高**：
  // 要么量到非 0，要么明确报「量不到」，绝不能拿 0 当「没有超标」。
  let bar = null;
  for (let i = 0; i < 20; i++) {
    // 只挑**可见**的那份工具栏（见上面 pick 那里的说明）
    bar = [...document.querySelectorAll('[aria-label="Markdown 格式"]')].find(visible);
    if (bar) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!bar) return { ok: false, why: 'no-toolbar' };
  const bb = bar.getBoundingClientRect();
  if (bb.height <= 0) {
    // 高 0 但有按钮 = 某个祖先被藏起来了（自身的 display 仍是 flex，所以光看自己查不出来）
    const all = [...document.querySelectorAll('[aria-label="Markdown 格式"]')];
    const chain = [];
    let n = bar;
    while (n && n !== document.body && chain.length < 12) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      let cls = '';
      if (typeof n.className === 'string' && n.className.trim()) {
        cls = '.' + n.className.split(' ').filter(Boolean).slice(0, 2).join('.');
      }
      chain.push(n.tagName.toLowerCase() + cls + '[d=' + cs.display + ',h=' + Math.round(r.height) + ',w=' + Math.round(r.width) + ']');
      n = n.parentElement;
    }
    return { ok: false, why: 'toolbar-zero-height', count: all.length, heights: all.map(e => Math.round(e.getBoundingClientRect().height)), chain };
  }
  const w = (bar.parentElement ? bar.parentElement.getBoundingClientRect().width : 0);
  // 行数 = 直接子元素的 top 值去重。
  // ⚠️ 只算**有高度**的子元素（≥16px）：那些竖分隔线 Divider 有上下内缩，
  // 它的 top 比按钮低几个 px，不滤掉就会被误判成额外的一行（实测把 1 行算成 2 行）。
  // 容差取 8px 而不是 4px：同一行内 28px 按钮与 24px 按钮的 top 本来就差一点。
  const tops = [...bar.children]
    .map(c => c.getBoundingClientRect())
    .filter(r => r.top > 0 && r.height >= 16)
    .map(r => r.top);
  const rows = [];
  for (const t of tops) if (!rows.some(r => Math.abs(r - t) < 8)) rows.push(t);
  return {
    ok: true,
    h: +bb.height.toFixed(1),
    paneW: +w.toFixed(1),
    rows: rows.length,
    buttons: [...bar.querySelectorAll('button')].length,
    labels: [...bar.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 14),
  };
})()`);
if (!toolbarGeom.ok) {
    p1Fails.push(`窄屏工具栏量不到：${toolbarGeom.why}`);
    if (toolbarGeom.chain) {
        console.log(`    匹配到 ${toolbarGeom.count} 个工具栏，高度 [${(toolbarGeom.heights || []).join(", ")}]`);
        console.log("    祖先链（由近及远）：");
        for (const c of toolbarGeom.chain) console.log("      " + c);
    }
    if (toolbarGeom.seen) console.log("    模式键候选：" + toolbarGeom.seen.join(" / "));
} else {
    console.log(
        `\n  窄屏工具栏 @390：高 ${toolbarGeom.h}px｜占用 ${toolbarGeom.rows} 行｜常驻按钮 ${toolbarGeom.buttons} 个`
    );
    console.log(`    第一行可见：[${toolbarGeom.labels.join(" / ")}]`);
    if (toolbarGeom.rows > 2) p1Fails.push(`窄屏工具栏占 ${toolbarGeom.rows} 行（应 ≤2）`);
    if (toolbarGeom.h > 120) p1Fails.push(`窄屏工具栏高 ${toolbarGeom.h}px（应 ≤120）`);
}
}

if (p4Fails.length) {
    console.log("\n✗ P4 断言未通过：");
    for (const f of p4Fails) console.log("  - " + f);
} else {
    console.log("\n✓ P4 断言通过：中栏分割线上移（≤66）、左栏搜索框保持 30px 高且仍在头部内");
}

if (p3Fails.length) {
    console.log("\n✗ P3 左栏搜索框断言未通过：");
    for (const f of p3Fails) console.log("  - " + f);
} else {
    console.log("\n✓ P3 左栏搜索框断言通过：默认列宽下占位符放得下、⌘K 提示自动隐身");
}

if (p1Fails.length) {
    console.log("\n✗ P1/P2 几何断言未通过：");
    for (const f of p1Fails) console.log("  - " + f);
} else {
    console.log("\n✓ P1/P2 几何断言通过：头部共享基线 / 卡片密度同档 / 窄屏工具栏 ≤2 行");
}

console.log("\n=== 截图清单（绝对路径） ===");
for (const f of shots) console.log("  " + f);

site.close();
// 断言挂了就以非 0 退出：探针要能当门禁用，不能只打印一行字却仍然绿
done(notesMobileFails.length + p1Fails.length + p3Fails.length + p4Fails.length ? 1 : 0);
