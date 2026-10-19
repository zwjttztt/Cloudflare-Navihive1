// script/probe-white-dot.mjs
// 2026-10-19 白圈第六报的定位探针。
//
// 用户补充的关键信息：「白圈出现的地方是之前右键点击的地方」。前五轮修的都是
// 「行内 ⋯ 按钮被焦点还原点亮」，而这一报的点位是**鼠标右键那个坐标**。
//
// 本探针逐帧记录 `[role=menu]` 的 paper 的 rect / opacity / transform：
// MUI Menu 的退出过渡是 Grow（scale），anchor 是 `anchorAtMouse` 造的 0×0
// 虚拟元素 —— paper 缩到最小时正好停在**鼠标点**上，那几帧就是用户看到的
// 「一闪而过的白圈」。若记录到 paper 从大缩到 0，根因即证实。
import { setTimeout as sleep } from "node:timers/promises";
import { openBrowser } from "./auditEnv.mjs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const ADMIN = process.env.AUDIT_USER ?? "root";
const PASSWORDS = [process.env.AUDIT_PASSWORD ?? "seed-password", "probe-example-password"];
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9529);

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
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
};

let logged = null;
for (const pw of PASSWORDS) {
    const res = await api("POST", "/api/login", { username: ADMIN, password: pw });
    if (res.status !== 200) continue;
    if (res.json?.mustChangePassword !== true) { logged = pw; break; }
    await api("PUT", "/api/auth/credentials", { username: ADMIN, currentPassword: pw, password: PASSWORDS[1] });
    const again = await api("POST", "/api/login", { username: ADMIN, password: PASSWORDS[1] });
    if (again.status === 200) logged = PASSWORDS[1];
    break;
}
if (!logged) { console.error("登录失败"); process.exit(2); }
await api("POST", "/api/notes", { title: "定位笔记", content: "内容\n" });

const { evaluate, send, done } = await openBrowser({ cdpPort: CDP_PORT, windowSize: "1440,950" });
process.on("uncaughtException", e => { console.error("异常", e?.stack || e); done(1); });

for (const c of cookieHeader.split("; ").filter(Boolean)) {
    const i = c.indexOf("=");
    await send("Network.setCookie", { name: c.slice(0, i), value: c.slice(i + 1), domain: new URL(BASE).hostname, path: "/" });
}
const safeEval = async expr => { try { return await evaluate(expr); } catch { return null; } };

await send("Page.navigate", { url: `${BASE}/?t=${Date.now()}` });
await sleep(2500);
await safeEval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('记事本'))?.click()`);
await sleep(4000);

const probe = await safeEval(`(async () => {
  const row = document.querySelector('[data-note-id]');
  if (!row) return { missing: 'note row' };
  const r0 = row.getBoundingClientRect();
  const CX = Math.round(r0.left + 14), CY = Math.round(r0.top + r0.height / 2);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: CX, clientY: CY }));
  await new Promise(r => setTimeout(r, 200));
  const menu = document.querySelector('[role=menu]');
  if (!menu) return { noMenu: true };
  const paper = menu.closest('.MuiPopover-paper') || menu;

  const geo = () => {
    const r = paper.getBoundingClientRect();
    const cs = getComputedStyle(paper);
    const m = /matrix\\(([^)]+)\\)/.exec(cs.transform);
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             op: Number(cs.opacity), scale: m ? Number(m[1].split(',')[0]).toFixed(2) : '1',
             origin: cs.transformOrigin, exists: true };
  };

  const open = geo();
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const frames = [];
  const started = performance.now();
  do {
    await new Promise(requestAnimationFrame);
    const el = document.querySelector('[role=menu]');
    if (!el) { frames.push({ t: Math.round(performance.now() - started), exists: false }); continue; }
    frames.push({ t: Math.round(performance.now() - started), ...geo() });
  } while (performance.now() - started < 700);

  // 命中鼠标点的帧：paper 覆盖 (CX, CY) 的那些帧
  const covering = frames.filter(f => f.exists && f.l <= CX && f.l + f.w >= CX && f.t <= CY && f.t + f.h >= CY);
  // 用户看得见的「白圈」= 覆盖锚点且 opacity > 0 的帧
  const visible = covering.filter(f => f.op > 0);
  const ok = visible.length === 0;
  console.log(JSON.stringify({
    anchor: { CX, CY },
    open,
    frames: frames.length,
    coveringCount: covering.length,
    visibleCount: visible.length,
    minW: Math.min(...frames.filter(f => f.exists).map(f => f.w)),
    goneAt: frames.find(f => !f.exists)?.t,
    visible,
  }, null, 2));
  console.log(ok
    ? 'PASS 右键菜单关闭后锚点位置没有可见残留帧'
    : 'FAIL 右键菜单关闭后锚点位置仍有 ' + visible.length + ' 个可见帧（白圈）');
  return { ok, visibleCount: visible.length, minW: Math.min(...frames.filter(f => f.exists).map(f => f.w)) };
})()`);
console.log(JSON.stringify(probe, null, 2));
done(probe?.ok ? 0 : 1);
process.exit(probe?.ok ? 0 : 1);