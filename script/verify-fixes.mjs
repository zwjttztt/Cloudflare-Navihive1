// script/verify-fixes.mjs
// 2026-10-19 四项交互回归的**真实浏览器**验收（不跑完整站体检，只盯这两项
// 最容易假绿的地方）：
//   1. 即时渲染代码块的**实体**横向滚动条：按住拖动后 scrollLeft 真的变化，
//      且 widget 没有被拆回源码（pre 仍然在 .note-live-block 里）。
//   2. 笔记右键菜单关闭的**逐帧**状态：关闭窗口内行内圆形操作按钮既不能被
//      焦点还原点亮，也不能有可见帧（用户看到的「一闪而过的白圈」）。
//   3. TXT 附件：真走一遍文件选择，上传成功后笔记正文里要出现下载链接
//      （用户报「添加 txt 附件在笔记中看不到」）。
//
// 为什么单独写一个：site-audit 跑全站要一分多钟，改一处想复验一次太慢；
// 而且它默认 hideScrollbars=true（headless 用 overlay 滚动条，量不到实体
// 滚动条几何），这两项必须关掉那个开关才验得了。
//
// 用法：先按 auditEnv 的说明把自托管服务起起来，再
//   node script/verify-fixes.mjs http://127.0.0.1:8799
// 退出码：0 = 两项都过，1 = 有没过项，2 = 环境问题（服务没起 / 登录失败）。
import { setTimeout as sleep } from "node:timers/promises";
import { openBrowser } from "./auditEnv.mjs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const ADMIN = process.env.AUDIT_USER ?? "root";
// ⚠️ 这两个口令都写在中性命名里、值本身也是「一眼假的占位」：
// 同一行出现 password 关键字 + 高熵字符串会被 gitleaks 的 generic-api-key
// 规则拦下（CI 红过一次：PASSWORDS 数组里第二个元素熵 3.68 > 3.5）。
const SEED_PASSWORD = process.env.AUDIT_PASSWORD ?? "seed-password";
const ROTATED_PASSWORD = "verify-fixes-example-password";
const PASSWORDS = [SEED_PASSWORD, ROTATED_PASSWORD];
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9527);

let problems = 0;
const ok = (label, extra = "") => console.log(`  ok    ${label}${extra ? `  ${extra}` : ""}`);
const bad = (kind, where, detail) => {
    problems += 1;
    console.log(`  [${kind}] ${where}  ${detail}`);
};

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

console.log(`验收目标：${BASE}`);

const init = await api("GET", "/api/init");
if (init.status !== 200) {
    console.error(`打不到 ${BASE}/api/init（status=${init.status}）`);
    process.exit(2);
}

let logged = null;
for (const pw of PASSWORDS) {
    const res = await api("POST", "/api/login", { username: ADMIN, password: pw });
    if (res.status !== 200) continue;
    if (res.json?.mustChangePassword !== true) { logged = pw; break; }
    const changed = await api("PUT", "/api/auth/credentials", {
        username: ADMIN, currentPassword: pw, password: PASSWORDS[1],
    });
    if (changed.status !== 200) continue;
    const again = await api("POST", "/api/login", { username: ADMIN, password: PASSWORDS[1] });
    if (again.status === 200) logged = PASSWORDS[1];
    break;
}
if (!logged) {
    console.error(`登录失败（试过 ${PASSWORDS.join(" / ")}）`);
    process.exit(2);
}
ok(`登录 ${ADMIN} 成功`);

// 一条笔记，正文带一段 300 列的超长代码行 —— 正是用户报「滚动条点不动」那一档
const LONG_LINE = `const line = '${"x".repeat(300)}';`;
const content = `# 验收标题\n\n超长代码块：\n\n\`\`\`js\n${LONG_LINE}\n\`\`\`\n`;
const created = await api("POST", "/api/notes", { title: "验收笔记", content });
if (created.status !== 200 && created.status !== 201) {
    console.error(`铺笔记失败：status=${created.status} ${created.text.slice(0, 200)}`);
    process.exit(2);
}
ok("铺了一条带超长代码块的笔记");

const { evaluate, send, done, ws } = await openBrowser({
    cdpPort: CDP_PORT,
    windowSize: "1440,950",
    hideScrollbars: false,
});
process.on("uncaughtException", err => { console.error("验收脚本异常：", err?.stack || err); done(1); });
process.on("unhandledRejection", err => { console.error("验收脚本异常：", err?.stack || err); done(1); });

await send("Network.enable");
for (const c of cookieHeader.split("; ").filter(Boolean)) {
    const i = c.indexOf("=");
    await send("Network.setCookie", {
        name: c.slice(0, i),
        value: c.slice(i + 1),
        domain: new URL(BASE).hostname,
        path: "/",
    });
}

const safeEval = async expr => {
    try { return await evaluate(expr); } catch { return null; }
};

// ---------- 打开记事本，等即时渲染把代码块换成 widget ----------
await send("Page.navigate", { url: `${BASE}/?t=${Date.now()}` });
await sleep(2500);
await safeEval(`document.querySelector('[aria-label*=\"记事本\"],button') && [...document.querySelectorAll('button')].find(b => b.textContent.includes('记事本'))?.click()`);
await sleep(4000);

let live = null;
for (let i = 0; i < 20 && !live; i++) {
    live = await safeEval(`(() => {
      const pre = document.querySelector('.note-live-block pre');
      if (!pre) return null;
      const r = pre.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height,
               clientW: pre.clientWidth, scrollW: pre.scrollWidth,
               gutter: pre.offsetHeight - pre.clientHeight,
               scrollLeft: pre.scrollLeft };
    })()`);
    if (!live) await sleep(500);
}
if (!live) {
    bad("验收缺口", "即时渲染代码块", "打开记事本后看不到 .note-live-block pre（渲染没起来？）");
} else {
    ok("渲染态代码块就绪", JSON.stringify(live));

    // ---------- 1. 实体横向滚动条：按住 → 拖 → 松手 ----------
    if (live.scrollW <= live.clientW) {
        bad("验收缺口", "实体滚动条", `内容没有横向溢出（scrollW=${live.scrollW} clientW=${live.clientW}），拖无可拖`);
    } else if (live.gutter <= 0) {
        bad("验收缺口", "实体滚动条", `没有实体滚动条高度（gutter=${live.gutter}），headless 仍在用 overlay 滚动条`);
    } else {
        const startX = live.left + 30;
        const y = live.top + live.height - live.gutter / 2;
        const endX = Math.min(startX + 200, live.left + live.width - 10);
        await safeEval(`document.querySelector('.note-live-block pre').scrollIntoView({block:'center'})`);
        await sleep(300);
        const r2 = await safeEval(`(() => { const r = document.querySelector('.note-live-block pre').getBoundingClientRect(); return { left: r.left, top: r.top, height: r.height, gutter: document.querySelector('.note-live-block pre').offsetHeight - document.querySelector('.note-live-block pre').clientHeight }; })()`);
        const y2 = r2.top + r2.height - r2.gutter / 2;
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r2.left + 30, y: y2, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: y2, button: "left", buttons: 1 });
        await sleep(200);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: y2, button: "left", buttons: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: y2, button: "left", clickCount: 1 });
        await sleep(400);
        const after = await safeEval(`(() => { const pre = document.querySelector('.note-live-block pre'); return { exists: !!pre, inLive: !!pre?.closest('.note-live-block'), scrollLeft: pre?.scrollLeft ?? 0, activeInEditor: !!(document.activeElement && document.activeElement.closest('.cm-editor')) }; })()`);
        if (after?.exists && after.inLive && after.scrollLeft > 0) {
            ok("实体滚动条拖动生效且仍是渲染态", JSON.stringify(after));
        } else {
            bad("交互", "实体滚动条", `拖动后状态：${JSON.stringify(after)}`);
        }
    }
}

// ---------- 2. 右键菜单关闭的逐帧状态 ----------
const menu = await safeEval(`(async () => {
  const row = document.querySelector('[data-note-id]');
  if (!row) return { missing: 'note row' };
  const r = row.getBoundingClientRect();
  row.scrollIntoView({ block: 'center' });
  await new Promise(res => setTimeout(res, 200));
  const r2 = row.getBoundingClientRect();
  const CX = Math.round(r2.left + 14), CY = Math.round(r2.top + r2.height / 2);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: CX, clientY: CY }));
  await new Promise(res => setTimeout(res, 150));
  const menu = [...document.querySelectorAll('[role=menu]')].find(m => m.querySelector('[data-row-op]'));
  if (!menu) return { noMenu: true };
  const samples = [];
  const started = performance.now();
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  do {
    await new Promise(requestAnimationFrame);
    const btn = row.querySelector('.note-row-actions');
    if (!btn) { samples.push({ gone: true }); continue; }
    const cs = getComputedStyle(btn);
    // 白圈第六报：退出过渡 Grow 会把 paper 缩到锚点（= 鼠标点）上，
    // 「覆盖锚点且 opacity>0」的帧就是用户看到的「一闪而过的白圈」。
    const open = document.querySelector('[role=menu]');
    const paper = open ? (open.closest('.MuiPopover-paper') || open) : null;
    const pr = paper?.getBoundingClientRect();
    const pcs = paper ? getComputedStyle(paper) : null;
    samples.push({
      focused: btn === document.activeElement,
      visibility: cs.visibility,
      opacity: Number(cs.opacity),
      paperAtAnchor: !!pr && !!pcs && pr.left <= CX && pr.left + pr.width >= CX && pr.top <= CY && pr.top + pr.height >= CY && Number(pcs.opacity) > 0,
    });
  } while (performance.now() - started < 600);
  return {
    samples: samples.length,
    stillOpen: !!document.querySelector('[role=menu] [data-row-op]'),
    anyFocused: samples.some(s => s.focused),
    anyVisible: samples.some(s => s.visibility !== 'hidden' && s.opacity > 0),
    anyPaperAtAnchor: samples.some(s => s.paperAtAnchor),
    first: samples.slice(0, 3),
  };
})()`);
if (!menu || menu.missing || menu.noMenu) {
    bad("验收缺口", "右键菜单", JSON.stringify(menu));
} else if (menu.anyFocused || menu.anyVisible || menu.anyPaperAtAnchor) {
    bad("交互", "右键关闭白圈", JSON.stringify(menu));
} else {
    ok("右键菜单关闭逐帧无白圈", JSON.stringify(menu));
}

// ---------- 3. TXT 附件：真上传后笔记正文里看得见 ----------
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const attachDir = mkdtempSync(join(tmpdir(), "navihive-attach-"));
const attachFile = join(attachDir, "验收附件[一].txt");
writeFileSync(attachFile, "这是附件正文，下载后要能看得到。", "utf8");

const attached = await safeEval(`(() => {
  const input = document.querySelector("[data-attach-input='1']");
  const btn = document.querySelector("[data-tool='attach']");
  return { hasInput: !!input, btnDisabled: btn ? btn.disabled : null };
})()`);
if (!attached?.hasInput) {
    bad("验收缺口", "TXT 附件", "工具栏上看不到附件选择框");
} else if (attached.btnDisabled) {
    bad("交互", "TXT 附件", "附件按钮被禁用（没在编辑态？），传不了文件");
} else {
    const doc = await send("DOM.getDocument", {});
    const { nodeId } = await send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "[data-attach-input='1']",
    });
    await send("DOM.setFileInputFiles", { files: [attachFile], nodeId });
    await sleep(2500);
    // ⚠️ 不能只查 .cm-content 的 textContent：行内渲染会把 `[` `]` `(` `)` 藏掉，
    // 看着像「没插进去」。要查渲染出的 <a>，再拿后端正文做终审。
    const seen = await safeEval(`(() => {
      const links = [...document.querySelectorAll('.cm-content a, .note-live-block a')]
        .map(a => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') || '' }))
        .filter(l => l.text.includes('.txt'));
      return { links };
    })()`);
    // 自动保存有 debounce，等它落库再查（最多 ~8s）
    let savedContent = "";
    let savedStatus = 0;
    let savedRaw = "";
    let which = "";
    for (let i = 0; i < 16; i++) {
        await sleep(500);
        const list = await api("GET", "/api/notes");
        const items = list.json?.notes ?? list.json ?? [];
        for (const n of Array.isArray(items) ? items : []) {
            if (/\[[^\]]*\.txt\]\([^)]+\)/.test(n.content ?? "")) {
                which = String(n.id);
                savedContent = n.content;
                break;
            }
        }
        if (which) break;
        const saved = await api("GET", `/api/notes/${created.json?.id ?? created.json?.note?.id}`);
        savedStatus = saved.status;
        savedRaw = saved.text.slice(0, 160);
    }
    const linkOk = (seen?.links ?? []).some(l => l.href.includes("/api/notes/attachments/") || l.href.includes("/api/attachments/"));
    if (linkOk && which) {
        ok("TXT 附件上传后正文出现下载链接且已持久化", `落库笔记 #${which}`);
    } else {
        const editorText = await safeEval(`document.querySelector('.cm-content')?.textContent?.slice(0,80) ?? ''`);
        bad("交互", "TXT 附件", `dom=${JSON.stringify(seen)} which=${which} status=${savedStatus} raw=${savedRaw} editor=${editorText}`);
    }
}

console.log(problems === 0 ? "\n三项验收全部通过" : `\n有 ${problems} 项未通过`);
done(problems === 0 ? 0 : 1);
process.exit(problems === 0 ? 0 : 1);
