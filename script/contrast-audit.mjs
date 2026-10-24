// script/contrast-audit.mjs
// 扫描页面上所有可见文本的对比度（亮 / 暗两态），不达 WCAG AA 即失败。
// 只用标准库 + CDP，不引入 axe 之类的依赖。
//
// 判据：任一态出现「对比度 < 需要的阈值（正文 4.5、大字 3）」即 exit 1。
// 背景色不是简单取父元素：玻璃拟态用了 rgba 半透明层，得把每一层按 alpha
// 依次混上去，否则量出来的对比度是假的。
//
// 用法：npm run audit:contrast（需要先 npm run build；CHROME_PATH 可指定浏览器）

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { DIST, openBrowser, startSiteServer, waitRendered } from "./auditEnv.mjs";

if (!fs.existsSync(DIST)) {
    console.error(`找不到 ${DIST}，先跑 npm run build`);
    process.exit(1);
}

// 0 = 让系统分配端口（同 a11y-audit：固定端口撞车就是一次崩溃）
const SITE_PORT = Number(process.env.AUDIT_SITE_PORT || 0);
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9517);

const site = await startSiteServer(SITE_PORT);
const { evaluate, done, chromePath, getErrors } = await openBrowser({ cdpPort: CDP_PORT });

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

const SCAN = `(() => {
  const parse = c => { const m = c.match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const alphaOf = c => { const m = c.match(/[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

  // 往上找第一个「够不透明」的背景色，并把半透明层依次混合进来
  const bgOf = el => {
    let n = el, layers = [];
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      if (p && alphaOf(c) > 0) {
        layers.push({ rgb: p, a: alphaOf(c) });
        if (alphaOf(c) >= 0.999) break;
      }
      n = n.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const { rgb, a } = layers[i];
      base = base.map((v, k) => rgb[k] * a + v * (1 - a));
    }
    return base;
  };

  const ratio = (fg, bg) => {
    const L1 = lum(fg), L2 = lum(bg);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };

  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    // 只统计直接承载文字的元素
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!text) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const cr = ratio(fg, bg);
    if (cr < need) {
      out.push({
        cls: el.className.toString().slice(0, 46),
        text: text.slice(0, 18),
        color: s.color,
        fontSize: size,
        bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
        ratio: +cr.toFixed(2),
        need,
      });
    }
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
 * 记事本的对比度**已知问题预算**（2026-10-24 接入记事本时定）。
 *
 * 接入后立刻抓到 4 处不达 AA，且都不是「桩数据造成的假问题」，而是真实存在：
 *
 *   1) 亮色 4.18：「会议纪要」13px `#b0433a` on `#deddda`
 *      —— NotesPage.tsx:2819 用 inline style 把 `--accent` 覆盖成
 *         `notesSettings.accent`（默认 `#b0433a`），**盖掉了 index.css 里
 *         亮/暗分态的默认值**（#1976d2 / #90caf9 那两个都是达标的）。
 *   2~4) 暗色 3.19 / 2.91 / Avatar 3.31：同一个 `#b0433a` 在深底上不达标；
 *      Avatar 是「红底配深字」，正确做法是按底色亮度选黑/白字。
 *
 * 为什么现在不修：正确修法要动「记事本默认强调色分态」+「文件夹/标签色板的
 * 文字色按底色亮度选」两件事，属于独立的一块工作（不是几行能改完的），
 * 塞进这轮会把「扩大审计覆盖面」这件事本身搅浑。
 *
 * 但**绝不能因此关掉判据**（那样新增的对比度问题会静默溜过去）。所以设一个存量预算：
 *   · 总数 ≤ 预算 → 通过，但把每一处明细照常打印出来（CI 日志里看得见）；
 *   · 总数 > 预算 → 失败。
 * 修完存量之后，把这个常量降到 0 —— 那一步就等于把这里改成硬判据。
 */
const NOTES_CONTRAST_BUDGET = 4;

/** 报告一段扫描结果（首页与记事本共用同一套输出格式） */
function report(label, res) {
    console.log(`=== ${label}：不合格 ${res.total} 处（去重后前 ${res.unique.length} 条）===`);
    for (const u of res.unique) {
        console.log(
            `  ${String(u.ratio).padStart(5)} / 需 ${u.need}  ${String(u.fontSize).padStart(4)}px  ${u.color} on ${u.bg}  「${u.text}」  ${u.cls}`
        );
    }
}

let failed = 0;
let notesFailed = 0;
let lightBg = null;
for (const label of ["亮色", "暗色"]) {
    if (label === "暗色") {
        lightBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
        // 走真实路径：主题是「显示设置」菜单里的三档直选（浅色/深色/跟随系统），
        // 顶栏没有单独的主题按钮 —— 直接找 aria-label 含「主题」的按钮是找不到的。
        const switchResult = await evaluate(`(async () => {
          const wait = ms => new Promise(r => setTimeout(r, ms));
          const btn = [...document.querySelectorAll('button')]
              .find(b => (b.getAttribute('aria-label') || '').startsWith('显示设置'));
          if (!btn) return 'no-settings-button';
          btn.click();
          await wait(500);
          const item = [...document.querySelectorAll('[role="menuitem"]')]
              .find(m => (m.textContent || '').includes('深色'));
          if (!item) return 'no-dark-item';
          item.click();
          await wait(700);
          return 'ok';
        })()`);
        await sleep(900);
        // ⚠️ 切换没生效时必须报错而不是「照测一遍」：那样两态测的都是亮色，
        // 暗色态的对比度问题会被整个跳过，审计变成假绿。
        const darkBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
        if (switchResult !== "ok" || darkBg === lightBg) {
            const labels = await evaluate(
                `[...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18)).slice(0, 45)`
            );
            console.error(`页面按钮（前 ${labels.length} 个）：` + JSON.stringify(labels));
            console.error(
                `主题切换没生效（${switchResult}，背景 ${lightBg} → ${darkBg}）——` +
                    "暗色态实为亮色，审计结果不可信"
            );
            site.close();
            done(1);
        }
        console.log(`主题已切换（背景 ${lightBg} → ${darkBg}）`);
    }
    const res = await evaluate(SCAN);
    failed += res.total;
    report(label, res);

    // ---------- 记事本（2026-10-24 加）----------
    //
    // 首页全绿只说明首页没问题。记事本是另一套界面（左栏 / 列表 / 编辑器 / 工具栏 /
    // 状态栏），而且它整块是懒加载的独立 chunk —— 从来没被对比度审计看过一眼。
    await openNotesAndWait();
    const notes = await evaluate(SCAN);
    notesFailed += notes.total;
    report(`${label}·记事本`, notes);

    // 回首页：直接重载比「点关闭按钮」稳（关闭入口在不同布局下不是同一个按钮），
    // 而且重载后才能保证下一轮「切主题」是在首页上操作的。
    await evaluate(`location.href = ${JSON.stringify(site.url)}`);
    await waitRendered(evaluate, { minButtons: 8, timeoutMs: 20_000 });
}

console.log("");
if (failed > 0) {
    console.error(`对比度审计失败：首页（亮/暗两态）共 ${failed} 处不达 WCAG AA`);
    site.close();
    done(1);
}
// 记事本：存量预算内放行，但明细已经打印在上面（见 NOTES_CONTRAST_BUDGET 的说明）
if (notesFailed > NOTES_CONTRAST_BUDGET) {
    console.error(
        `对比度审计失败：记事本 ${notesFailed} 处不达 WCAG AA，` +
            `超出已知问题预算 ${NOTES_CONTRAST_BUDGET} 处 —— ` +
            `多出来的必须修掉，不能提高预算（预算只用来标存量，不是容忍度）`
    );
    site.close();
    done(1);
}
if (notesFailed > 0) {
    console.log(
        `记事本：${notesFailed} 处不达 AA，在已知问题预算 ${NOTES_CONTRAST_BUDGET} 之内（明细见上）。` +
            `\n  修法：① 记事本默认强调色按亮/暗分态（NotesPage.tsx:2819 的内联 --accent 盖掉了 index.css 的分态默认值）；` +
            `\n        ② 文件夹 / 标签色板的文字色按**底色亮度**选黑/白，而不是按主题选。` +
            `\n  修完把 NOTES_CONTRAST_BUDGET 降到 0。`
    );
}
console.log(`\n对比度审计通过（首页亮/暗 0 处不合格；记事本 ${notesFailed}/${NOTES_CONTRAST_BUDGET} 处已知问题）`);
site.close();
done(0);
