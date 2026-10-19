// script/verify-attachments.mjs
// 2026-10-19 附件四项改造的**真实浏览器**验收：
//   1. 正文里点 txt 链接 → 开预览弹窗（不整页跳走）；
//   2. 弹窗里编辑 + 保存 → 服务端字节真的变了；
//   3. 弹窗里重命名 → 服务端元数据与**正文链接文字**都变了；
//   4. 左下角「附件」入口 → 抽屉打开；点文件名也能开预览。
//
// 为什么必须真浏览器 + 真后端：这四项全是「跨层」的（渲染层 → context →
// 弹窗 → fetch → 路由 → D1 + KV）。单测每层都绿，仍然可能整条链路不通
// （比如 preventDefault 漏了会整页跳走、PATCH 端点没挂上会 404 而界面只弹一句提示）。
//
// 用法：先起自托管服务（见 auditEnv.mjs），再
//   node script/verify-attachments.mjs http://127.0.0.1:8799
// 退出码：0 = 全过，1 = 有不过项，2 = 环境问题。

import { setTimeout as sleep } from "node:timers/promises";
import { openBrowser } from "./auditEnv.mjs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const ADMIN = process.env.AUDIT_USER ?? "root";
const SEED_PASSWORD = process.env.AUDIT_PASSWORD ?? "seed-password";
const LOGIN_PASSWORDS = [
    SEED_PASSWORD,
    "verify-attach-example-password",
    // 同一台库上先跑过 site-audit 时，种子口令已经被它改成这个
    process.env.AUDIT_NEW_PASSWORD ?? "site-audit-pw-2026",
];
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9531);

let problems = 0;
const ok = (label, extra = "") => console.log(`  ok    ${label}${extra ? `  ${extra}` : ""}`);
const bad = (kind, where, detail) => {
    problems += 1;
    console.log(`  [${kind}] ${where}  ${detail}`);
};

let cookieHeader = "";
const api = async (method, path, body, raw) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(raw ? { "Content-Type": "text/plain; charset=utf-8" } : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) cookieHeader = setCookies.map(c => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（附件字节） */ }
    return { status: res.status, json, text };
};

console.log(`验收目标：${BASE}`);

const init = await api("GET", "/api/init");
if (init.status !== 200) {
    console.error(`打不到 ${BASE}/api/init（status=${init.status}）`);
    process.exit(2);
}
const login = await (async () => {
    let last = null;
    for (const pw of LOGIN_PASSWORDS) {
        const res = await api("POST", "/api/login", { username: ADMIN, password: pw });
        if (res.status === 200) return res;
        last = res;
    }
    return last;
})();
if (login.status !== 200) {
    console.error(`登录失败：${login.status} ${login.text.slice(0, 160)}`);
    process.exit(2);
}
// 首次登录会被要求改密（自托管种子账号）：改一次，后面用新口令重登
if (login.json?.mustChangePassword === true) {
    const changed = await api("PUT", "/api/auth/credentials", {
        username: ADMIN, currentPassword: LOGIN_PASSWORDS[0], password: "verify-attach-example-password",
    });
    if (changed.status !== 200) {
        console.error(`改密失败：${changed.status} ${changed.text.slice(0, 160)}`);
        process.exit(2);
    }
    const again = await api("POST", "/api/login", { username: ADMIN, password: "verify-attach-example-password" });
    if (again.status !== 200) {
        console.error(`改密后重登失败：${again.status}`);
        process.exit(2);
    }
}
ok(`登录 ${ADMIN} 成功`);

// ---------- 铺数据：一条带 txt 附件的笔记 ----------
const upload = await fetch(`${BASE}/api/notes/attachments?filename=${encodeURIComponent("说明.txt")}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8", Cookie: cookieHeader },
    body: "第一版内容",
});
if (upload.status !== 201 && upload.status !== 200) {
    console.error(`上传附件失败：${upload.status} ${(await upload.text()).slice(0, 200)}`);
    process.exit(2);
}
const att = await upload.json();
ok("上传了一个 txt 附件", JSON.stringify({ id: att.id, filename: att.filename, mime: att.mime }));

const noteContent = `# 附件验收\n\n点这个：[${att.filename}](</api/notes/attachments/${att.id}>)\n`;
const created = await api("POST", "/api/notes", { title: "附件验收笔记", content: noteContent });
if (created.status !== 200 && created.status !== 201) {
    console.error(`铺笔记失败：${created.status} ${created.text.slice(0, 200)}`);
    process.exit(2);
}
const noteId = created.json?.id;
ok("铺了一条引用该附件的笔记", `id=${noteId}`);

// ---------- 浏览器 ----------
const { evaluate, send, done } = await openBrowser({ cdpPort: CDP_PORT, windowSize: "1440,950" });
process.on("uncaughtException", err => { console.error("验收脚本异常：", err?.stack || err); done(1); });
process.on("unhandledRejection", err => { console.error("验收脚本异常：", err?.stack || err); done(1); });

await send("Network.enable");
for (const c of cookieHeader.split("; ").filter(Boolean)) {
    const i = c.indexOf("=");
    await send("Network.setCookie", {
        name: c.slice(0, i), value: c.slice(i + 1), domain: new URL(BASE).hostname, path: "/",
    });
}

const safeEval = async expr => {
    try { return await evaluate(expr); } catch { return null; }
};
/** 轮询等到条件成立（返回最后取到的值） */
const waitFor = async (expr, tries = 24, gap = 300) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
        last = await safeEval(expr);
        if (last) return last;
        await sleep(gap);
    }
    return last;
};
const clickText = async (sel, text) => safeEval(
    `(() => { const el = [...document.querySelectorAll('${sel}')].find(e => (e.textContent||'').includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`
);

// ---------- 打开记事本并打开那条笔记，切到「仅预览」 ----------
await send("Page.navigate", { url: `${BASE}/?t=${Date.now()}` });
await sleep(2200);
await clickText("button", "记事本");
await sleep(2600);

const opened = await safeEval(`(() => {
  const row = [...document.querySelectorAll('[data-note-id]')].find(r => (r.textContent||'').includes('附件验收笔记'));
  if (!row) return false;
  row.click();
  return true;
})()`);
if (!opened) bad("验收缺口", "打开笔记", "笔记列表里找不到刚铺的那条");
await sleep(1200);

// 编辑态是 CodeMirror 的 live preview（链接是纯文本），要看 <a> 必须切预览
await safeEval(`document.querySelector('[data-pane-modes] button[aria-label="预览"]')?.click()`);
await sleep(1500);

const linkBox = await waitFor(`(() => {
  const a = document.querySelector("[data-attachment-link]");
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, href: a.getAttribute("href") };
})()`);
if (!linkBox) {
    bad("验收缺口", "预览里的附件链接", "预览态看不到 [data-attachment-link]（渲染层没挂上？）");
} else {
    ok("预览里渲染出附件链接", JSON.stringify(linkBox));
    const before = await safeEval(`location.pathname + location.search`);
    // 真点（CDP 鼠标）而不是 el.click()：要验的就是「默认行为被拦掉」
    const cx = Math.round(linkBox.left + linkBox.width / 2);
    const cy = Math.round(linkBox.top + linkBox.height / 2);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
    await sleep(900);

    const after = await safeEval(`location.pathname + location.search`);
    if (after !== before) {
        bad("功能", "点附件链接", `整页跳走了：${before} → ${after}（preventDefault 没生效）`);
    } else {
        ok("点链接没有整页跳转", after);
    }

    const dialog = await waitFor(`(() => {
      const d = document.querySelector("[data-attachment-preview]");
      if (!d) return null;
      const body = d.querySelector("[data-att-body]");
      return { text: body ? (body.textContent || '') : null, title: d.querySelector('[data-att-filename]')?.textContent || '' };
    })()`);
    if (!dialog) {
        bad("功能", "预览弹窗", "点了链接没有出现 [data-attachment-preview]");
    } else {
        if ((dialog.text || "").includes("第一版内容")) ok("弹窗里读到了附件内容", `title=${dialog.title}`);
        else bad("功能", "弹窗内容", `期望「第一版内容」，实际：${JSON.stringify(dialog.text)?.slice(0, 120)}`);

        // ---------- 编辑 + 保存 ----------
        await safeEval(`document.querySelector("[data-att-action='edit']")?.click()`);
        await sleep(400);
        const typed = await safeEval(`(() => {
          const ta = document.querySelector("[data-att-editor='1'] textarea");
          if (!ta) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          setter.call(ta, "第二版内容（弹窗里改的）");
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`);
        if (!typed) bad("功能", "弹窗编辑", "点「编辑」后没有出现可写区域");
        await sleep(300);
        await safeEval(`document.querySelector("[data-att-action='save']")?.click()`);
        await sleep(1500);
        const reread = await fetch(`${BASE}/api/notes/attachments/${att.id}`, { headers: { Cookie: cookieHeader } });
        const bytes = await reread.text();
        if (bytes.includes("第二版内容")) ok("保存后服务端字节确实变了", `size=${bytes.length}`);
        else bad("功能", "保存内容", `服务端读回的是：${JSON.stringify(bytes).slice(0, 120)}`);

        // ---------- 重命名 ----------
        await safeEval(`document.querySelector("[data-att-action='rename']")?.click()`);
        await sleep(400);
        const renamed = await safeEval(`(() => {
          const input = document.querySelector("[data-att-rename-input]");
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(input, "改名后的说明.txt");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`);
        if (!renamed) bad("功能", "重命名", "点「重命名」后没有出现输入框");
        await sleep(200);
        await safeEval(`document.querySelector("[data-att-action='rename-confirm']")?.click()`);
        await sleep(2000);

        const list = await api("GET", `/api/notes/attachments/list`);
        const row = Array.isArray(list.json) ? list.json.find(a => a.id === att.id) : null;
        if (row?.filename === "改名后的说明.txt") ok("元数据已改名", row.filename);
        else bad("功能", "重命名元数据", `列表里是：${JSON.stringify(row?.filename)}`);

        const note = await api("GET", `/api/notes/${noteId}`);
        const content = note.json?.content ?? "";
        if (content.includes("[改名后的说明.txt]") && content.includes(`/api/notes/attachments/${att.id}`)) {
            ok("正文里的链接文字同步改了，URL 没动");
        } else {
            bad("功能", "正文同步", content.slice(0, 200));
        }

        await safeEval(`document.querySelector("[data-att-action='close']")?.click()`);
        await sleep(600);
    }
}

// ---------- 手机宽度：整页不能横向溢出 ----------
// 左下角这一行从「待办」换成了「附件」，多出来的是图标 + 文本 + 计数，
// 窄栏（导航列 128px）最容易把它顶出边界。
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
await sleep(800);
const notesOverflow = await safeEval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
if (typeof notesOverflow === "number" && notesOverflow > 0) bad("布局", "390px 记事本", `横向溢出 ${notesOverflow}px`);
else ok("390px 记事本不横向溢出", `overflow=${notesOverflow}`);
await send("Emulation.clearDeviceMetricsOverride");
await sleep(600);

// ---------- 左下角「附件」入口 ----------
const navOk = await safeEval(`(() => {
  const btn = document.querySelector("[data-nav-attachments='1']");
  if (!btn) return false;
  btn.click();
  return true;
})()`);
if (!navOk) {
    bad("缺口", "左下角附件入口", "找不到 [data-nav-attachments]（能力门控没通过？）");
} else {
    // ⚠️ 等到**行真的出来**再算数：抽屉一挂上就有 [data-attachment-manager]，
    // 但附件列表是异步拉的，早一步读就是 rows:0（第一版脚本就栽在这，
    // 顺带把「点文件名预览」那一步静默跳过了）。
    const drawer = await waitFor(`(() => {
      const d = document.querySelector("[data-attachment-manager='1']");
      if (!d) return null;
      const rows = d.querySelectorAll('[data-attachment-row]').length;
      if (!rows) return null;
      return { rows, hasPreviewBtn: !!d.querySelector("[data-attachment-action='preview']") };
    })()`, 30, 400);
    if (!drawer) bad("功能", "附件抽屉", "点了入口没打开抽屉");
    else ok("附件抽屉打开", JSON.stringify(drawer));

    if (drawer?.hasPreviewBtn) {
        await safeEval(`document.querySelector("[data-attachment-action='preview']")?.click()`);
        await sleep(1200);
        const opened2 = await safeEval(`!!document.querySelector("[data-attachment-preview]")`);
        if (opened2) ok("管理器点文件名也能开预览");
        else bad("功能", "管理器预览", "点了文件名没有出现预览弹窗");

        // 弹窗本身在手机宽度下不能把页面撑出横向滚动
        await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
        await sleep(700);
        const dlgOverflow = await safeEval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
        const dlgWidth = await safeEval(`(() => { const p = document.querySelector("[data-attachment-preview] .MuiDialog-paper"); return p ? Math.round(p.getBoundingClientRect().width) : -1; })()`);
        if (dlgWidth < 0 || dlgWidth > 390) bad("布局", "390px 预览弹窗", `弹窗宽 ${dlgWidth}px（应 ≤ 390）`);
        else ok("390px 预览弹窗宽度合规", `${dlgWidth}px，页面溢出 ${dlgOverflow}px`);
        await send("Emulation.clearDeviceMetricsOverride");
        await sleep(400);
    }

    // 窄窗下抽屉不能把横向撑破（420px 固定宽 + maxWidth 92vw）
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await sleep(700);
    const overflow = await safeEval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    if (typeof overflow === "number" && overflow > 0) bad("布局", "390px 抽屉", `横向溢出 ${overflow}px`);
    else ok("390px 下抽屉不横向溢出", `overflow=${overflow}`);
    await send("Emulation.clearDeviceMetricsOverride");
}

console.log(problems === 0 ? "\n附件四项验收全部通过" : `\n有 ${problems} 项没过`);
done(problems === 0 ? 0 : 1);
