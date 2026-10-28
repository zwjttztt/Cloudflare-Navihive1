// 分享功能端到端（补充面）——与 script/share-e2e.mjs 互补。
//
// 现有 e2e:share 跑在 wrangler dev（workerd）上，覆盖「创建 → 匿名 401 needPassword
// → 口令错/对 → 撤销后 404」的主干。本脚本补它没碰的三块：
//   1. 浏览次数防刷：同一浏览器当天重复访问不重复计数（cookie 当日戳）
//   2. 附件公开取图：无口令分享的图匿名可取；受口令分享的图必须先验对口令
//      （拿到 shareAsset 会话 cookie）才能取，且必须带 ?share=<token>
//   3. 分组分享的口令流程与脱敏（sites 只回 name/url/description/icon）
// 外加 PUT 改口令后旧口令立即失效、撤销后公开读取回 not-found 等边界。
//
// 跑在**自托管 server/**（Node + SQLite）上而不是 workerd：
//   - server/ 打包的就是同一套 worker 路由（routes/*.ts 共享），测的是同一份逻辑；
//   - Windows 本地 workerd 起不来（access violation），这条通道本地 CI 两边都能跑；
//   - 顺带覆盖 <your-host> 实际部署形态（自托管）的链路。
//
// 需要 dist-server/（npm run build:server），package.json 的 e2e:share-extra 已串联。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirnameOf();
function dirnameOf() {
    return resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
}

const PORT = 8801 + (process.pid % 100); // 并发跑批时避让
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE_PW = "note-pw-测试123";
const GROUP_PW = "group-pw-456";

let passed = 0;
const failures = [];
function ok(cond, label) {
    if (cond) { passed += 1; console.log(`  ok  ${label}`); }
    else { failures.push(label); console.error(`  FAIL ${label}`); }
}

/** 手动 cookie jar：absorb 吃掉 set-cookie，header() 拼回 Cookie 头 */
class Jar {
    constructor() { this.map = new Map(); }
    absorb(response) {
        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(";");
            const eq = pair.indexOf("=");
            if (eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            // 过期/删除标记就不留了（分享链路目前只用会话 cookie，简单处理）
            if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(line)) this.map.delete(name);
            else this.map.set(name, value);
        }
    }
    header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function req(method, path, { jar, body, headers, raw } = {}) {
    const h = { ...(headers ?? {}) };
    if (jar?.header()) h.Cookie = jar.header();
    let payload = body;
    if (raw !== undefined) { payload = raw; }
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const response = await fetch(`${BASE}/api${path}`, { method, headers: h, body: payload, redirect: "manual" });
    jar?.absorb(response);
    return response;
}

/** 1x1 透明 PNG（嗅探按文件头判定，这个能过） */
const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
);

async function waitForServer(deadlineMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const r = await fetch(`${BASE}/api/init`);
            if (r.ok) return;
        } catch { /* 还没起来 */ }
        await new Promise(s => setTimeout(s, 300));
    }
    throw new Error("自托管服务 20 秒内没起来");
}

const scratch = mkdtempSync(join(tmpdir(), "navihive-share-e2e-"));
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist-server/entry.mjs"], {
    cwd: here,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
        ...process.env,
        NAVIHIVE_PORT: String(PORT),
        NAVIHIVE_HOST: "127.0.0.1",
        NAVIHIVE_DB: join(scratch, "navihive.db"),
        NAVIHIVE_FILES: join(scratch, "files"),
        NAVIHIVE_CRON: "0",
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "share-e2e-extra-secret",
    },
});
child.stdout.on("data", () => { /* 静默；失败时靠断言报 */ });
child.stderr.on("data", d => process.stderr.write(d));

try {
    await waitForServer();
    console.log(`# 分享补充面 E2E（自托管通道 ${BASE}）`);

    // ---- 登录 + 备料 ----
    const owner = new Jar();
    const login = await req("POST", "/login", { jar: owner, body: { username: "root", password: "seed-password" } });
    ok(login.status === 200, "种子账号登录 200");
    const loginBody = await login.json();
    ok(loginBody.success === true, "登录返回 success");

    // 新库首次登录强制改密（改密会使旧令牌失效）→ 改完重登再备料
    if (loginBody.mustChangePassword) {
        const ch = await req("PUT", "/auth/credentials", {
            jar: owner,
            body: { username: "root", password: "e2e-changed-pw", currentPassword: "seed-password" },
        });
        ok(ch.status === 200, "首次改密 200");
        const relogin = await req("POST", "/login", { jar: owner, body: { username: "root", password: "e2e-changed-pw" } });
        ok(relogin.status === 200, "改密后重新登录 200");
    }

    const groupRes = await req("POST", "/groups", { jar: owner, body: { name: "分享测试组", icon: "🌐", order_num: 0 } });
    const group = await groupRes.json().catch(() => ({}));
    if (!Number.isFinite(group?.id)) {
        console.log(`  [diag] login cookies=${owner.map.size} groups POST status=${groupRes.status} body=${JSON.stringify(group).slice(0, 300)}`);
    }
    ok(Number.isFinite(group?.id), "创建分组（带 icon）");
    const siteRes = await req("POST", "/sites", {
        jar: owner,
        body: { name: "机密站点", url: "https://secret.example.com", group_id: group.id, icon: "https://icons.example.com/{domain}.png", username: "user-secret", password: "pass-secret", order_num: 0 },
    });
    const site = await siteRes.json().catch(() => ({}));
    if (!Number.isFinite(site?.id)) {
        console.log(`  [diag] sites POST status=${siteRes.status} body=${JSON.stringify(site).slice(0, 300)}`);
    }
    ok(Number.isFinite(site?.id), "创建带账号密码的站点");

    // 笔记 A：无口令分享，正文内嵌附件
    const noteA = await (await req("POST", "/notes", { jar: owner, body: { title: "公开笔记A", content: "正文A" } })).json();
    ok(Number.isFinite(noteA?.id), "创建笔记A");
    const up1 = await req("POST", `/notes/attachments?noteId=${noteA.id}&filename=a.png`, {
        jar: owner, raw: PNG_1PX, headers: { "Content-Type": "image/png" },
    });
    const att1 = await up1.json();
    ok(up1.status === 201 && att1?.id, "上传附件1（201）");
    await req("PUT", `/notes/${noteA.id}`, { jar: owner, body: { ...noteA, content: `![图](${att1.url})` } });

    // 笔记 B：受口令分享，正文内嵌另一个附件
    const noteB = await (await req("POST", "/notes", { jar: owner, body: { title: "机密笔记B", content: "正文B" } })).json();
    const up2 = await req("POST", `/notes/attachments?noteId=${noteB.id}&filename=b.png`, {
        jar: owner, raw: PNG_1PX, headers: { "Content-Type": "image/png" },
    });
    const att2 = await up2.json();
    ok(up2.status === 201 && att2?.id, "上传附件2（201）");
    await req("PUT", `/notes/${noteB.id}`, { jar: owner, body: { ...noteB, content: `![图](${att2.url})` } });

    // ---- 无口令笔记分享：访问、防刷、附件匿名可取 ----
    const shareA = await (await req("POST", `/notes/${noteA.id}/share`, { jar: owner, body: { days: null } })).json();
    ok(/^[a-f0-9]{64}$/.test(shareA?.token ?? ""), "创建无口令分享（token 64hex）");

    const anon1 = new Jar();
    const r1 = await req("GET", `/note-shares/${shareA.token}`, { jar: anon1 });
    const b1 = await r1.json();
    ok(r1.status === 200 && b1.title === "公开笔记A", "匿名读分享 200 + 标题");
    const cfg1 = await (await req("GET", `/notes/${noteA.id}/share`, { jar: owner })).json();
    ok(cfg1.views === 1, "首次匿名访问 views=1");
    ok((cfg1.hasPassword ?? cfg1.haspassword ?? 0) === 0, "分享配置 hasPassword=0");

    await req("GET", `/note-shares/${shareA.token}`, { jar: anon1 });
    const cfg1b = await (await req("GET", `/notes/${noteA.id}/share`, { jar: owner })).json();
    ok(cfg1b.views === 1, "同浏览器当天重复访问不再计数（防刷当日戳）");

    const anon2 = new Jar();
    await req("GET", `/note-shares/${shareA.token}`, { jar: anon2 });
    const cfg1c = await (await req("GET", `/notes/${noteA.id}/share`, { jar: owner })).json();
    ok(cfg1c.views === 2, "新访客正常计数 views=2");

    const img1a = await req("GET", `/note-shares/attachments/${att1.id}?share=${shareA.token}`, { jar: new Jar() });
    ok(img1a.status === 200 && img1a.headers.get("content-type") === "image/png", "无口令分享的附件匿名可取（200 image/png）");
    const img1b = await req("GET", `/note-shares/attachments/${att1.id}`, { jar: new Jar() });
    ok(img1b.status === 200, "无口令分享的附件不带 ?share 也可取（无口令分享本身放行）");

    // ---- 受口令笔记分享：401 needPassword → 口令错/对 → 附件凭会话取 ----
    const shareB = await (await req("POST", `/notes/${noteB.id}/share`, { jar: owner, body: { days: 7, password: NOTE_PW } })).json();
    ok(/^[a-f0-9]{64}$/.test(shareB?.token ?? ""), "创建受口令分享");
    ok(shareB.hasPassword === 1 || shareB.hasPassword === true, "创建响应 hasPassword=1");

    const anonB = new Jar();
    const r401 = await req("GET", `/note-shares/${shareB.token}`, { jar: anonB });
    const e401 = await r401.json();
    ok(r401.status === 401 && e401?.needPassword === true, "匿名访问 401 + needPassword 顶层标记");
    ok(r401.headers.get("cache-control")?.includes("no-store") === true, "401 响应 no-store");
    const rWrong = await req("POST", `/note-shares/${shareB.token}`, { jar: anonB, body: { password: "错口令" } });
    ok(rWrong.status === 401, "口令错 → 401");
    const rRight = await req("POST", `/note-shares/${shareB.token}`, { jar: anonB, body: { password: NOTE_PW } });
    const bRight = await rRight.json();
    ok(rRight.status === 200 && bRight.title === "机密笔记B", "口令对 → 200 + 正文");
    const assetCookie = rRight.headers.getSetCookie().find(c => c.startsWith("nh_share_"));
    ok(!!assetCookie, "口令对后签发分享资产会话 cookie（nh_share_<token>）");
    const assetJar = new Jar();
    assetJar.absorb(rRight);

    const cfgB = await (await req("GET", `/notes/${noteB.id}/share`, { jar: owner })).json();
    ok(cfgB.views === 1, "口令对的那次访问计一次 views");

    const img2no = await req("GET", `/note-shares/attachments/${att2.id}?share=${shareB.token}`, { jar: new Jar() });
    ok(img2no.status === 404, "受口令分享的附件：无会话 → 404（不区分没分享/没权限）");
    const img2nos = await req("GET", `/note-shares/attachments/${att2.id}`, { jar: assetJar });
    ok(img2nos.status === 404, "受口令分享的附件：有会话但不带 ?share → 404");
    const img2bad = await req("GET", `/note-shares/attachments/${att2.id}?share=${shareA.token}`, { jar: assetJar });
    ok(img2bad.status === 404, "受口令分享的附件：?share 指到别的分享 → 404");
    const img2ok = await req("GET", `/note-shares/attachments/${att2.id}?share=${shareB.token}`, { jar: assetJar });
    ok(img2ok.status === 200 && img2ok.headers.get("content-type") === "image/png", "受口令分享的附件：会话 + 正确 ?share → 200");

    // ---- PUT 改口令：token 不变，旧口令立即失效 ----
    const upd = await (await req("PUT", `/notes/${noteB.id}/share`, { jar: owner, body: { days: 7, password: "新口令789" } })).json();
    ok(upd?.token === shareB.token, "PUT 更新后 token 不变（链接不换）");
    const reOld = await req("POST", `/note-shares/${shareB.token}`, { jar: new Jar(), body: { password: NOTE_PW } });
    ok(reOld.status === 401, "旧口令立即失效 → 401");
    const reNew = await req("POST", `/note-shares/${shareB.token}`, { jar: new Jar(), body: { password: "新口令789" } });
    ok(reNew.status === 200, "新口令 → 200");

    // ---- 分组分享：口令流程 + 脱敏 + 防刷 ----
    const gshare = await (await req("POST", `/groups/${group.id}/share`, { jar: owner, body: { days: 7, password: GROUP_PW } })).json();
    ok(/^[a-f0-9]{64}$/.test(gshare?.token ?? ""), "创建受口令分组分享");

    const anonG = new Jar();
    const g1 = await req("GET", `/group-shares/${gshare.token}`, { jar: anonG });
    const gb1 = await g1.json();
    ok(g1.status === 200 && gb1.status === "need-password", "分组匿名读 200 + status=need-password（与笔记分享的 401 形状不同，公开页按此分支）");
    const gWrong = await (await req("POST", `/group-shares/${gshare.token}`, { jar: anonG, body: { password: "错" } })).json();
    ok(gWrong.status === "need-password", "分组口令错 → need-password");
    const gRight = await (await req("POST", `/group-shares/${gshare.token}`, { jar: anonG, body: { password: GROUP_PW } })).json();
    ok(gRight.status === "ok" && gRight.group?.name === "分享测试组", "分组口令对 → ok + 组名");
    const siteKeys = (gRight.sites ?? []).map(s => Object.keys(s).sort().join(","));
    ok(gRight.sites?.length === 1 && siteKeys[0] === "description,icon,name,url", "公开分组只回 name/url/description/icon（无 username/password）");
    ok(gRight.views === 1, "分组首次访问 views=1");
    await req("POST", `/group-shares/${gshare.token}`, { jar: anonG, body: { password: GROUP_PW } });
    const gAgain = await (await req("POST", `/group-shares/${gshare.token}`, { jar: anonG, body: { password: GROUP_PW } })).json();
    ok(gAgain.views === 1, "分组同浏览器当天重复访问不计数（防刷）");

    // PUT 清除分组口令 → 匿名 GET 直接 ok
    await req("PUT", `/groups/${group.id}/share`, { jar: owner, body: { days: 7, password: null } });
    const gClear = await (await req("GET", `/group-shares/${gshare.token}`, { jar: new Jar() })).json();
    ok(gClear.status === "ok", "清除口令后匿名直读 ok");

    // ---- 非法 token / 撤销 ----
    const badNote = await req("GET", `/note-shares/zzzz`, { jar: new Jar() });
    ok(badNote.status === 404, "非法 token（笔记）→ 404");
    const badGroup = await (await req("GET", `/group-shares/zzzz`, { jar: new Jar() })).json();
    ok(badGroup?.status === "not-found", "非法 token（分组）→ not-found");

    const delA = await req("DELETE", `/notes/${noteA.id}/share`, { jar: owner });
    ok(delA.status === 200, "撤销笔记分享 200");
    const afterA = await req("GET", `/note-shares/${shareA.token}`, { jar: new Jar() });
    ok(afterA.status === 404, "撤销后匿名读 → 404");
    const afterB = await req("GET", `/note-shares/attachments/${att1.id}?share=${shareA.token}`, { jar: new Jar() });
    ok(afterB.status === 404, "撤销后附件通道也关死 → 404");

    await req("DELETE", `/groups/${group.id}/share`, { jar: owner });
    const afterG = await (await req("GET", `/group-shares/${gshare.token}`, { jar: new Jar() })).json();
    ok(afterG?.status === "not-found", "撤销分组分享后 → not-found");

    console.log(`\n# pass ${passed} / fail ${failures.length}`);
    if (failures.length) {
        console.error("失败项:\n  - " + failures.join("\n  - "));
        process.exitCode = 1;
    }
} catch (error) {
    console.error("E2E 异常中断:", error);
    process.exitCode = 1;
} finally {
    child.kill("SIGTERM");
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，忽略 */ }
}
