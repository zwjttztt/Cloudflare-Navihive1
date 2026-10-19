// script/site-audit.mjs
// 全站体检（2026-10-18）：页面功能 / 交互逻辑 / 路由跳转 / 接口调用 /
// 控制台报错 / 响应式横向溢出 —— 一次跑完，输出问题清单。
//
// 与 a11y-audit / contrast-audit 的区别：那两个量**静态样式**（对比度、可访问名），
// 这个跑**真实链路**：真后端（自托管服务）+ 真登录会话 + 多种视口，
// 采集「控制台报错 / 未捕获异常 / 4xx-5xx 请求 / 横向溢出」四类信号。
//
// ⚠️ 必须用**真后端**（自托管服务）：给只读桩的话接口那一侧全是 200，什么都查不出来。
//    起法见 deploy/selfhost.md；本地最省事的是先 `npm run build:server` 再：
//      AUTH_USERNAME=root AUTH_PASSWORD=seed-password AUTH_SECRET=xxx \
//      NAVIHIVE_PORT=8799 NAVIHIVE_DB=/tmp/audit-data/navihive.db \
//      NAVIHIVE_FILES=/tmp/audit-data/files NAVIHIVE_CRON=0 \
//      node dist-server/entry.mjs
// 用法：node script/site-audit.mjs http://127.0.0.1:8799
// 退出码：查出问题为 1，全清为 0，服务没起来为 2。

import { setTimeout as sleep } from "node:timers/promises";
import { openBrowser } from "./auditEnv.mjs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const ADMIN = process.env.AUDIT_USER ?? "root";
/** 自托管种子密码；上一轮 selfhost-smoke 跑过同一个库时会把它改掉，故再兜一个 */
const AUDIT_PASSWORD = process.env.AUDIT_PASSWORD ?? "seed-password";
/** 首次那次「请先改密」要改成的新口令：不能与种子密码相同，否则改密接口自己驳回 */
const AUDIT_NEW_PASSWORD = process.env.AUDIT_NEW_PASSWORD ?? "site-audit-pw-2026";
const PASSWORDS = [AUDIT_PASSWORD, AUDIT_NEW_PASSWORD, "smoke-new-password-2"];
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9521);

let pass = 0;
const problems = [];
const note = (kind, where, detail) => {
    problems.push({ kind, where, detail });
    console.log(`  [${kind}] ${where}  ${detail}`);
};
const ok = (label, extra = "") => {
    pass += 1;
    console.log(`  ok    ${label}${extra ? `  ${extra}` : ""}`);
};

// ---------------- 1. 取会话 ----------------
let cookieHeader = "";
const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) cookieHeader = setCookies.map(c => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON（静态资源 / 纯文本） */
    }
    return { status: res.status, json, text };
};

console.log(`体检目标：${BASE}\n`);

const init = await api("GET", "/api/init");
if (init.status !== 200) {
    console.error(`打不到 ${BASE}/api/init（status=${init.status}），先把自托管服务起起来`);
    process.exit(2);
}

/**
 * 登录（必要时先改密）。
 *
 * ⚠️ 自托管首次带的种子密码（seed-password）会要求「先改密」—— 不改的话
 * 后面每一个写请求都是 403，铺不到数据，量出来的是一张空页面：
 *「0 报错」看着全绿，其实什么都还没跑（假绿的又一种形态）。
 */
let logged = null;
for (const pw of PASSWORDS) {
    const res = await api("POST", "/api/login", { username: ADMIN, password: pw });
    if (res.status !== 200) continue;
    if (res.json?.mustChangePassword !== true) {
        logged = pw;
        break;
    }
    const changed = await api("PUT", "/api/auth/credentials", {
        username: ADMIN,
        currentPassword: pw,
        password: AUDIT_NEW_PASSWORD,
    });
    if (changed.status !== 200) continue;
    const again = await api("POST", "/api/login", { username: ADMIN, password: AUDIT_NEW_PASSWORD });
    if (again.status === 200) logged = AUDIT_NEW_PASSWORD;
    break;
}
if (!logged) {
    console.error(`登录失败（试过 ${PASSWORDS.join(" / ")}）`);
    process.exit(2);
}
ok(`登录 ${ADMIN} 成功`);

// ---------------- 2. 铺数据（空页面量不出交互问题） ----------------
//
// ⚠️ 每条都要核对 status：写请求被 403（未改密 / 会话失效）时这里静默失败，
// 后面跑的是一张空页面，「0 报错」看着全绿其实什么都没验到。
const mustOk = (label, res, codes = [200, 201]) => {
    if (!codes.includes(res.status)) {
        console.error(`铺数据失败：${label}  status=${res.status}  ${res.text.slice(0, 200)}`);
        process.exit(2);
    }
    return res;
};
const group = mustOk("POST /api/groups", await api("POST", "/api/groups", { name: "体检分组", order_num: 0 }));
const groupId = group.json?.id ?? group.json?.group?.id;
for (let i = 0; i < 3; i++) {
    mustOk(
        `POST /api/sites #${i + 1}`,
        await api("POST", "/api/sites", {
            group_id: groupId,
            name: `体检站点${i + 1}`,
            url: "https://example.com",
            description: `体检用站点 ${i + 1}，描述刻意写长，用来试探卡片换行与横向溢出`,
            order_num: i,
        })
    );
}
const folder = mustOk(
    "POST /api/notes/folders",
    await api("POST", "/api/notes/folders", { name: "体检文件夹", order_num: 0 })
);
const folderId = folder.json?.id ?? folder.json?.folder?.id;
// 正文刻意放一段超长代码行：正是用户报「开启渲染后代码块没有横向滚动条」那一档
const LONG_LINE = "const line = '" + "x".repeat(300) + "';";
const NBSP =
    "# 体检标题\n\n这是一段刻意写长的正文，用来试探编辑区换行、代码块横向滚动与状态栏字数统计。\n\n```js\n" +
    LONG_LINE +
    "\n```\n\n[[体检笔记]] 自指一下反向链接。\n";
mustOk(
    "POST /api/notes",
    await api("POST", "/api/notes", {
        title: "体检笔记",
        content: NBSP,
        folder_id: folderId ?? null,
    })
);
mustOk("POST /api/notes/tags", await api("POST", "/api/notes/tags", { name: "体检标签" }));
ok("铺数据完成（分组 / 站点 / 文件夹 / 笔记 / 标签）");

// ---------------- 3. 开浏览器 ----------------
const { evaluate, send, done, ws, getErrors } = await openBrowser({
    cdpPort: CDP_PORT,
    windowSize: "1440,950",
    hideScrollbars: false,
});
const bail = err => {
    console.error("体检脚本异常：", err?.stack || err);
    done(1);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

await send("Network.enable");
// 越界请求单独记账：接口打错、表缺列、鉴权漏口径，全在这一条上现形
let netFails = [];
ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.method !== "Network.responseReceived") return;
    const r = m.params?.response ?? {};
    if (r.status >= 400) netFails.push({ url: String(r.url), status: r.status });
});

// 把登录 cookie 塞进浏览器（Node fetch 的 cookie 不共享给 Chrome）
const jar = cookieHeader
    .split("; ")
    .filter(Boolean)
    .map(c => {
        const i = c.indexOf("=");
        return { name: c.slice(0, i), value: c.slice(i + 1) };
    });
for (const c of jar) {
    await send("Network.setCookie", {
        name: c.name,
        value: c.value,
        domain: new URL(BASE).hostname,
        path: "/",
    });
}
ok(`注入会话 cookie（${jar.length} 条）`);

/** getErrors() 返回的是快照副本，只能靠「长度游标」取增量，清不掉原数组 */
let errorCursor = 0;
const takeErrors = () => {
    const all = getErrors();
    const fresh = all.slice(errorCursor);
    errorCursor = all.length;
    return fresh;
};

const safeEval = async expr => {
    try {
        return await evaluate(expr);
    } catch {
        // 导航中上下文还没重建：下一轮再试
        return null;
    }
};

/** 等页面渲染出足够多的按钮（骨架态时量出来全是 0，那是假绿） */
async function waitRendered(minButtons = 12, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const n = await safeEval("document.querySelectorAll('button').length");
        if (typeof n === "number" && n >= minButtons) return n;
        await sleep(250);
    }
    return 0;
}

async function snapshot(where) {
    const errors = takeErrors();
    netFails = [];
    await sleep(500);
    const buttons = (await safeEval("document.querySelectorAll('button').length")) ?? 0;
    const overflow = (await safeEval(`(() => {
      const de = document.documentElement;
      const vw = de.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // 溢出容器 2px 以上才算（亚像素舍入不足 1px 的到处都是）
        if (r.right > vw + 2) {
          bad.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), right: Math.round(r.right) });
        }
      }
      return { vw, docScroll: de.scrollWidth, docClient: de.clientWidth, bad: bad.slice(0, 6) };
    })()`)) ?? { vw: 0, docScroll: 0, docClient: 0, bad: [] };
    await sleep(150);
    const allErrors = errors.concat(takeErrors());
    return { buttons, overflow, errors: allErrors.slice(0, 6), netFails: netFails.slice(0, 6) };
}

/** 按可见文本 / aria-label 点一个元素（找不到返回 false，不抛） */
async function clickByText(text) {
    return await safeEval(`(() => {
      const nodes = [...document.querySelectorAll('button,[role=button],a')];
      const hit = nodes.find(n => (n.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})
        || (n.textContent || '').trim().includes(${JSON.stringify(text)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
}

async function report(where, snap, { ignore = [] } = {}) {
    const net = snap.netFails.filter(f => !ignore.some(p => f.url.includes(p)));
    const hOverflow = snap.overflow.docScroll > snap.overflow.docClient + 1;
    for (const e of snap.errors) note("控制台", where, String(e).slice(0, 200));
    for (const f of net) note("请求", where, `${f.status} ${f.url.slice(0, 120)}`);
    if (hOverflow) {
        note("横向溢出", where, `scrollWidth ${snap.overflow.docScroll} > client ${snap.overflow.docClient}`);
        for (const b of snap.overflow.bad.slice(0, 3)) {
            note("越界元素", where, `<${b.tag} class="${b.cls}"> right=${b.right}`);
        }
    }
    if (!snap.errors.length && !net.length && !hOverflow) ok(where, `button ${snap.buttons}`);
    return !snap.errors.length && !net.length && !hOverflow;
}

const VIEWPORTS = [
    { name: "桌面 1440", width: 1440, height: 950 },
    { name: "窄窗 864", width: 864, height: 800, scale: true },
    { name: "平板 768", width: 768, height: 1024 },
    { name: "手机 390", width: 390, height: 844 },
];
async function setViewport(v) {
    await send("Emulation.setDeviceMetricsOverride", {
        width: v.width,
        height: v.height,
        deviceScaleFactor: 1,
        mobile: v.width < 900,
    });
}
async function goto(path) {
    await evaluate(`location.href = ${JSON.stringify(BASE + path)}`);
    await sleep(1200);
    await waitRendered();
    await sleep(600);
}

console.log("\n== A. 主页面多视口 ==");
await setViewport(VIEWPORTS[0]);
await goto("/?t=" + Date.now());
takeErrors();
// 会话没生效 / 数据没铺上时，后面每一「干净」都是空的：先把这条钉死
const authed = await safeEval(`document.body.innerText.includes("体检分组")`);
if (!authed) {
    note("会话", "首页", "看不到铺好的「体检分组」（登录态没带进去？还是渲染没起来？）—— 后续结论不可信");
} else {
    ok("首页已带登录态且能看到铺的数据");
}

for (const v of VIEWPORTS) {
    await setViewport(v);
    await sleep(1000);
    const label = `${v.name} 首页${v.scale ? "（125% 缩放 1080p 等效）" : ""}`;
    await report(label, await snapshot(label));
}

console.log("\n== B. 路由跳转 ==");
await setViewport(VIEWPORTS[0]);
const FAKE_TOKEN = "0".repeat(64);
const routes = [
    { path: "/", label: "根路径 /" },
    { path: `/s/${FAKE_TOKEN}`, label: "分享短链 /s/<不存在的 token>" },
    { path: `/sg/${FAKE_TOKEN}`, label: "分组分享 /sg/<不存在的 token>" },
    { path: "/not-a-real-page", label: "未知路径（SPA 兜底）" },
];
for (const r of routes) {
    await goto(r.path + "?t=" + Date.now());
    // 分享页拿不到这条分享必然 4xx：那是**预期**，要确认的是页面给出「不存在」而不是白屏
    const snap = await snapshot(r.label);
    await report(r.label, snap, { ignore: [FAKE_TOKEN] });
    if (r.path.startsWith("/s/") || r.path.startsWith("/sg/")) {
        const shown = await safeEval(
            `document.body.innerText.includes("不存在") || document.body.innerText.includes("失效") || document.body.innerText.includes("加载失败")`
        );
        if (shown) ok(`${r.label} 给出「不存在」提示`);
        else note("交互", r.label, "token 失效时页面没有给出可见的错误提示");
    }
}

console.log("\n== C. 交互：打开记事本 ==");
await setViewport(VIEWPORTS[0]);
await goto("/?t=" + Date.now());
takeErrors();
const opened = await clickByText("记事本");
if (!opened) {
    note("交互", "打开记事本", "页面上找不到「记事本」入口");
} else {
    await sleep(3500);
    await waitRendered(8, 15_000);
    const snap = await snapshot("记事本");
    const hasContent = await safeEval(`document.body.innerText.includes("体检笔记")`);
    if (!hasContent) note("交互", "记事本", "打开后看不到铺好的那条笔记（标题没渲染？）");
    await report("记事本", snap);
    // 代码块横向滚动：渲染态下 pre 必须自己能滚，而不是被裁
    const preScroll = await safeEval(`(() => {
      const pre = document.querySelector('pre');
      if (!pre) return null;
      return { clientW: pre.clientWidth, scrollW: pre.scrollWidth, overflowX: getComputedStyle(pre).overflowX };
    })()`);
    // 窄屏再开一次：历史上这一档有过「完全打不开记事本」
    await setViewport(VIEWPORTS[3]);
    await sleep(1400);
    await report("记事本 390", await snapshot("记事本 390"));
    await setViewport(VIEWPORTS[0]);
    await sleep(800);
    console.log(`  info   code pre = ${JSON.stringify(preScroll)}`);
    // 回归：必须操作即时渲染 widget 的原生滚动条，不以「有 overflow」冒充可拖动。
    // ⚠️ scrollIntoView 之后**必须等一帧再取坐标**：同一次 evaluate 里紧接着
    // getBoundingClientRect 拿到的是滚动前的布局，之后所有鼠标事件都打在空中
    // （症状：scrollLeft 恒为 0，看着像「产品拖不动」，其实是坐标没对上）。
    await safeEval(`document.querySelector('.note-live-block pre')?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
    const liveScroll = await safeEval(`(() => {
      const pre = document.querySelector('.note-live-block pre');
      if (!pre) return { missing: true };
      pre.scrollLeft = 0;
      const r = pre.getBoundingClientRect();
      return { x: r.left + 30, y: r.bottom - 5, width: r.width,
               gutter: pre.offsetHeight - pre.clientHeight };
    })()`);
    if (!liveScroll?.missing && liveScroll?.gutter === 0) {
        // Headless Chrome 使用 overlay 滚动条；用真实横向 wheel 验证原生滚动，
        // 另验证底部按下不退出 widget，但不将它报告为实体滚动条拖动通过。
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: liveScroll.x, y: liveScroll.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: liveScroll.x, y: liveScroll.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: liveScroll.x + 50, y: liveScroll.y - 20, deltaX: 240, deltaY: 0 });
        await sleep(300);
        const moved = await safeEval(`(() => { const pre = document.querySelector('.note-live-block pre'); return { exists: !!pre, left: pre?.scrollLeft ?? 0 }; })()`);
        if (moved?.exists && moved.left > 0) ok('overlay 代码滚动：底部按下保持渲染、横向 wheel 生效（非实体拖动验收）', JSON.stringify(moved));
        else note('交互', 'overlay 代码滚动', JSON.stringify(moved));
    } else if (!liveScroll?.missing && liveScroll?.gutter > 0) {
        const toX = Math.min(liveScroll.x + 200, liveScroll.x + liveScroll.width - 10);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: liveScroll.x, y: liveScroll.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y: liveScroll.y, button: 'left', buttons: 1 });
        await sleep(150);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y: liveScroll.y, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: liveScroll.y, button: 'left', clickCount: 1 });
        await sleep(400);
        const moved = await safeEval(`(() => { const pre = document.querySelector('.note-live-block pre'); return { exists: !!pre, inLive: !!pre?.closest('.note-live-block'), left: pre?.scrollLeft ?? 0 }; })()`);
        if (moved?.exists && moved.inLive && moved.left > 0) ok('即时渲染代码块横向滚动条可拖动且未切回源码', JSON.stringify(moved));
        else note('交互', '即时渲染代码滚动条', JSON.stringify(moved));
    } else {
        note('验收缺口', '即时渲染代码滚动条', JSON.stringify(liveScroll));
    }
}

console.log("\n== D. 交互深挖：弹窗 / 搜索 / 菜单 ==");
await setViewport(VIEWPORTS[0]);
await goto("/?t=" + Date.now());
takeErrors();

/**
 * 逐个开轻量弹窗：历史上一大半 bug 都出在「点开之后」（回填不对、缺项、
 * 布局溢出、控制台报错），不开就永远看不见。
 * 每个开完都 Esc 关掉，避免叠层影响下一项。
 */
// ⚠️ 「账号」这类二级入口藏在「更多选项」菜单里，主页面上本来就没有同名按钮：
// 只找顶层按钮会把「入口在菜单里」误报成「找不到入口」，所以要能再往下点一层。
const dialogs = [
    { open: "设置", label: "设置弹窗" },
    { open: "搜索", label: "搜索" },
    // ⚠️ 必须点全称「更多选项」：页面还有一个显示/外观的「更多」选择Menu，
    // 按「更多」去匹配会点到那边，然后把「菜单里没有账号」报成产品 bug。
    { open: "更多选项", label: "更多选项菜单" },
    { open: "更多选项", child: "账号", label: "账号弹窗（经更多选项）" },
];
for (const d of dialogs) {
    const clicked = await clickByText(d.open);
    if (!clicked) {
        note("交互", d.label, `找不到「${d.open}」入口`);
        continue;
    }
    await sleep(1800);
    if (d.child) {
        const items = await safeEval(
            `[...document.querySelectorAll('[role=menuitem]')].map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 20)`
        );
        const hasChild = (items ?? []).some(t => t.includes(d.child));
        if (!hasChild) {
            note("交互", d.label, `「${d.open}」菜单里没有「${d.child}」项（可见项：${(items ?? []).join(" / ").slice(0, 120)}）`);
            await safeEval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await sleep(500);
            continue;
        }
        await clickByText(d.child);
        await sleep(2500);
    }
    const snap = await snapshot(d.label);
    const visible = await safeEval(
        `!!document.querySelector('[role=dialog],[role=menu],[role=listbox]') || document.querySelectorAll('[role=menuitem]').length > 0`
    );
    if (!visible) note("交互", d.label, "点开后没有出现对话框 / 菜单");
    await report(d.label, snap);
    await safeEval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(600);
}

console.log("\n== E. 记事本：新功能与置顶耗时 ==");
await clickByText("记事本");
await sleep(3500);
await waitRendered(8, 15_000);
takeErrors();

// ① 工具栏「添加附件」按键（本批新加）要在工具栏上，且点到能选中文件
const attach = await safeEval(`(() => {
  const btn = document.querySelector("[data-tool='attach']");
  const input = document.querySelector("[data-attach-input='1']");
  return { btn: !!btn, disabled: btn ? btn.disabled : null, input: !!input,
           accept: input ? input.getAttribute('accept') : null };
})()`);
if (!attach.btn) note("交互", "记事本工具栏", "没有 [data-tool='attach']（添加附件按钮没渲染）");
else if (!attach.input) note("交互", "记事本工具栏", "有按钮但没有隐藏的 file input");
else if (!String(attach.accept ?? "").includes("json")) note("交互", "记事本工具栏", `accept 不含 json：${attach.accept}`);
else ok("工具栏添加附件按钮就绪", `accept=${attach.accept}`);

// 右键菜单关闭：逐帧记录焦点/圆形操作按钮显隐（不是只看最终一帧）。
const contextFocus = await safeEval(`(async () => {
  const row = document.querySelector('[data-note-id]');
  if (!row) return { missing: true };
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 15 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const menu = [...document.querySelectorAll('[role=menu]')].find(m => m.querySelector('[data-row-op]'));
  if (!menu) return { noMenu: true };
  const samples = [];
  // ⚠️ 计时起点必须在关闭动作**之后**：先把 end 设好再 dispatch，会把「菜单
  // 还开着」的那几帧一起算进去，opacity=1 被当成白圈误报（本脚本自己撞过）。
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const started = performance.now();
  do {
    await new Promise(requestAnimationFrame);
    const btn = row.querySelector('.note-row-actions');
    if (!btn) { samples.push({ gone: true }); continue; }
    const cs = getComputedStyle(btn);
    samples.push({
      focused: btn === document.activeElement,
      visibility: cs.visibility,
      opacity: Number(cs.opacity),
    });
  } while (performance.now() - started < 600);
  return {
    samples: samples.length,
    stillOpen: !!document.querySelector('[role=menu] [data-row-op]'),
    anyFocused: samples.some(s => s.focused),
    anyVisible: samples.some(s => s.visibility !== 'hidden' && s.opacity > 0),
    first: samples.slice(0, 3),
  };
})()`);
if (contextFocus && !contextFocus.missing && !contextFocus.noMenu && !contextFocus.anyFocused && !contextFocus.anyVisible) ok('右键菜单关闭逐帧检查：操作按钮未被焦点还原点亮', JSON.stringify(contextFocus));
else note('交互', '右键菜单关闭焦点检查', JSON.stringify(contextFocus));

// ② 置顶耗时（用户报卡顿那一项）：从点击到 pinned 状态落回 DOM 的时间
const pinTiming = await safeEval(`(async () => {
  const rows = [...document.querySelectorAll('[data-note-id],[class*=note-row],[data-folder-note]')];
  if (!rows.length) return { error: '找不到笔记行' };
  const target = rows[0];
  const id = target.getAttribute('data-note-id') || target.getAttribute('data-folder-note') || '(无 id)';
  const menu = target.querySelector("[aria-label*='更多'],[aria-label*='操作']");
  return { id, hasMenu: !!menu, rows: rows.length };
})()`);
if (pinTiming?.rows) ok("记事本列表行已渲染", `行数 ${pinTiming.rows}`);

const pinMs = await safeEval(`(async () => {
  const t0 = performance.now();
  const btn = document.querySelector("[data-tool='pin'],[aria-label*='置顶'],[aria-label*='取消置顶']");
  if (!btn) return -1;
  btn.click();
  // 等一帧够 DOM 反映乐观更新
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return Math.round(performance.now() - t0);
})()`);
if (typeof pinMs === "number" && pinMs >= 0) {
    ok("置顶点击到 UI 反馈耗时", `${pinMs}ms`);
    if (pinMs > 200) note("性能", "置顶", `点击后 ${pinMs}ms 才出反馈（>200ms 会觉得粘滞）`);
}
const snapNotes = await snapshot("记事本（交互后）");
await report("记事本（交互后）", snapNotes);

console.log("\n== F. 记事本：本批六项修复的实测证据 ==");
await setViewport(VIEWPORTS[0]);
await clickByText("记事本");
await sleep(3500);
await waitRendered(8, 15_000);
takeErrors();

// ⑤ 左栏文件夹下的内联笔记字号（用户报「过大」）：必须显式 12.5px
const picked = await clickByText("体检文件夹");
await sleep(1500);
const rows = await safeEval(`(() => {
  const el = document.querySelector("[data-folder-note]");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { fontSize: cs.fontSize, text: (el.textContent || '').trim().slice(0, 20) };
})()`);
if (!rows) {
    console.log(`  info   没选到内联笔记行（点中文件夹=${picked}），跳过字号核对`);
} else {
    const px = Number.parseFloat(rows.fontSize);
    if (px > 13.5) note("样式", "内联笔记字号", `${rows.fontSize}（应 12.5px，用户报过大）`);
    else ok("内联笔记字号", rows.fontSize);
}

// 计数一次遍历后的结果核对（folderCounts 改成单趟了，别算错）
const counts = await safeEval(
    `[...document.querySelectorAll("[data-folder-id],[data-nav-folder]")].map(n => (n.textContent||'').trim()).slice(0, 8)`
);
console.log(`  info   左栏分组行：${JSON.stringify(counts)}`);

await report("记事本（六项复核）", await snapshot("记事本（六项复核）"));

console.log("\n== G. 汇总 ==");
console.log(`  通过 ${pass} 项，问题 ${problems.length} 条`);
if (problems.length) {
    console.log("\n  问题清单：");
    for (const p of problems) console.log(`   - [${p.kind}] ${p.where}：${p.detail}`);
}
done(problems.length ? 1 : 0);
