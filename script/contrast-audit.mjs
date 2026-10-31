// script/contrast-audit.mjs
// 扫描页面上所有可见文本的对比度（亮 / 暗两态），不达 WCAG AA 即失败。
// 只用标准库 + CDP，不引入 axe 之类的依赖。
//
// 判据：任一态出现「对比度 < 需要的阈值（正文 4.5、大字 3）」即 exit 1。
// 背景色不是简单取父元素：玻璃拟态用了 rgba 半透明层，得把每一层按 alpha
// 依次混上去，否则量出来的对比度是假的。
//
// 覆盖面（三段，每段都亮 / 暗各扫一遍）：首页 → 记事本 → **设置中心**。
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

const SCAN = `(() => {
  // ⚠️ color-mix() 的背景色（如 --accent-wash = color-mix(主色 10%, transparent)）会被
  //    Chrome 序列化成 \`color(srgb 0.098 0.4627 0.8235 / 0.1)\` —— 分量是 **0~1 的浮点**。
  //    照 rgb() 那样当 0~255 解析，等于把一层 10% 的淡蓝当成「接近纯黑」，
  //    合成出来的底色会假性变暗、比值假性变低（实测同一条文字会从 4.04 报成 3.67）。
  const parse = c => {
    const m = c.match(/-?[\\d.]+/g);
    if (!m) return null;
    const nums = m.map(Number);
    const rgb = nums.slice(0, 3);
    const isColorFn = /^color\\(/.test(c.trim());
    return isColorFn && rgb.every(v => v <= 1) ? rgb.map(v => Math.round(v * 255)) : rgb;
  };
  const alphaOf = c => { const m = c.match(/-?[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
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
let notesFailed = 0;
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
    const res = await evaluate(SCAN);
    failed += res.total;
    report(label, res);

    // 本轮的主题背景色，后面每次重载/换界面都要拿它核对一遍（见下面的主题漂移断言）
    const roundBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);

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
// 记事本：存量预算内放行，但明细已经打印在上面（见 NOTES_CONTRAST_BUDGET 的说明）
if (notesFailed > NOTES_CONTRAST_BUDGET) {
    console.error(
        `对比度审计失败：记事本 ${notesFailed} 处不达 WCAG AA，` +
            `预算 ${NOTES_CONTRAST_BUDGET} 处（2026-10-24 起已清零，记事本与首页同一把尺子）`
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
console.log(`\n对比度审计通过（首页 / 记事本 / 设置中心，亮暗两态各 0 处不合格）`);
site.close();
done(0);
