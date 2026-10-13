// script/share-e2e.mjs
// 分享功能的真实端到端：起一个 wrangler dev（本地 D1），把「建分享 → 访客访问 →
// 口令校验 → 撤销」这条链按匿名访客的顺序打一遍。
//
// 为什么单独写一份而不是并进 api-e2e.mjs：
// api-e2e 走的是**已登录**的会话，而分享的坑全在**匿名**那一侧 —— 访客没有
// cookie、要过口令、要看错误码与脱敏。混在一起会两边都看不清楚。
//
// 盯的具体是这五件事，都是「不跑一次永远不知道」的：
//   1. 受口令的分享，匿名 GET 必须回 401 + 顶层的 needPassword（公开页靠它弹框）；
//   2. 口令错也要 401，且**不能**把正文漏出去；
//   3. 口令对才回正文，且 Set-Cookie 打上防刷当日戳；
//   4. 撤销之后同一 token 必须 404 + code=not_found（旧链接当场失效）；
//   5. 公开分组页**不能**带出 sites 表里的 username / password（脱敏由 SELECT 保证）。
//
// 顺带把上一轮错误码迁移新加的 code 一起钉住：405 method_not_allowed（PATCH 分享）、
// 400 bad_request（有效期非法）、404 not_found（撤销后）。
//
// 用法：npm run e2e:share   （需要先 npm run build，跑的是 dist/ 下构建出来的那份产物）

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
    ROOT,
    isWin,
    resolveWorkerConfig,
    pickPort,
    startWrangler,
    waitReady,
    createChecker,
} from "./e2eEnv.mjs";

const resolved = resolveWorkerConfig();
if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
}
const CONFIG = resolved.config;

const PORT = await pickPort("SHARE_E2E_PORT");
const BASE = `http://127.0.0.1:${PORT}/api`;

// 每次跑都用一套全新的凭据与独立的持久化目录：上一次跑会把管理员密码改掉，
// 库要是复用，第二次登录就「用户名或密码错误」，而且失败原因看不出是数据没清。
// 不删旧目录（本机 rmSync 走回收站 shim，删带 sqlite 文件的目录会抛错），
// 旧目录留给系统自己清（.wrangler-e2e/ 已进 .gitignore）。
const ADMIN = "e2e-share-admin";
const OLD_PW = "E2e-share-old-1";
const NEW_PW = "E2e-share-new-2";
const SHARE_PW = "share-secret-123";
const SECRET = "e2e".padEnd(64, "0").slice(0, 64);

const persistBase = path.join(ROOT, ".wrangler-e2e");
fs.mkdirSync(persistBase, { recursive: true });
const persistDir = fs.mkdtempSync(path.join(persistBase, "share-"));

const { check, state } = createChecker();
let failures = 0;

const proc = startWrangler({
    config: CONFIG,
    port: PORT,
    persistDir,
    logName: "navihive-share-e2e.log",
    vars: {
        AUTH_ENABLED: "true",
        AUTH_USERNAME: ADMIN,
        AUTH_PASSWORD: OLD_PW,
        AUTH_SECRET: SECRET,
    },
});

process.on("exit", () => {
    proc.stop();
    try {
        fs.rmSync(persistDir, { recursive: true, force: true });
    } catch {
        // 清不掉不影响结论
    }
});

const ready = await waitReady(BASE, 120_000, proc.child);
if (!ready) {
    console.error("wrangler 没起来（多半是 workerd 崩了）。日志：", proc.logFile);
    console.error(proc.getLog().slice(-3000));
    process.exit(1);
}

// ---------------- 会话 ----------------

let cookie = "";
function rememberCookie(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(";")[0];
        if (pair.startsWith("navihive_token=")) cookie = pair;
    }
}

/**
 * 打一个接口。
 *
 * 带一层重试是**必要的**，不是为了掩盖业务错误：wrangler dev 的 ProxyWorker 与
 * UserWorker 之间会偶发 "Network connection lost"（日志里能看到
 * "recovered on attempt N after a dropped connection"）。表现是 500 + 空响应体，
 * 看着像接口炸了，其实是本地 dev 服务器的抖动。所以只对「连接丢了 / 空响应体的 500」
 * 重试，业务错误（4xx 或带 JSON 体的 5xx）直接返回。
 */
async function call(pathAndQuery, method = "GET", body, attempt = 0) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
        res = await fetch(`${BASE}/${pathAndQuery}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    } catch (err) {
        if (attempt < 2) {
            await sleep(300);
            return call(pathAndQuery, method, body, attempt + 1);
        }
        throw err;
    }
    rememberCookie(res);
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    // 空响应体的 500 视为 dev 服务器抖动，重试
    if (res.status === 500 && data === null && attempt < 2) {
        await sleep(300);
        return call(pathAndQuery, method, body, attempt + 1);
    }
    return { status: res.status, data, headers: res.headers };
}

/** 匿名访客：不带 cookie、不带任何凭据 */
async function anon(pathAndQuery, method = "GET", body) {
    const res = await fetch(`${BASE}/${pathAndQuery}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return { status: res.status, data, headers: res.headers };
}

// ---------------- 1. 拿一个能写接口的会话 ----------------

// 新库首次登录会返回 mustChangePassword，必须先改密，否则所有非 GET 一律 403。
const first = await call("login", "POST", { username: ADMIN, password: OLD_PW });
check("首次登录要求改密（mustChangePassword）", first.data?.mustChangePassword === true,
    `status=${first.status}`);
await call("auth/credentials", "PUT", {
    username: ADMIN,
    password: NEW_PW,
    currentPassword: OLD_PW,
});
// 改密会 bump tokenVersion，**当前令牌当场失效**，必须重新登录
const second = await call("login", "POST", { username: ADMIN, password: NEW_PW });
check("改密后重新登录成功且不再要求改密",
    second.status === 200 && second.data?.mustChangePassword === false, `status=${second.status}`);
check("拿到会话 cookie", cookie.startsWith("navihive_token="));

// ---------------- 2. 造数据：一个分组 + 一个站点 + 一条笔记 ----------------

const group = await call("groups", "POST", { name: "分享验收分组", order_num: 0 });
check("建分组成功", group.status === 200 && typeof group.data?.id === "number", `status=${group.status}`);
const groupId = group.data?.id;

const site = await call("sites", "POST", {
    name: "分享验收站点",
    url: "https://example.com/",
    group_id: groupId,
    order_num: 0,
    // 这两个字段是**脱敏断言**的关键：公开分组页不许把它们带出去
    username: "secret-user",
    password: "secret-pass",
});
check("建站点成功（带 username/password 用于验脱敏）", site.status === 200, `status=${site.status}`);

const NOTE_TITLE = "分享验收笔记";
const NOTE_BODY = "正文里有 E2E-分享标记。";
const note = await call("notes", "POST", { title: NOTE_TITLE, content: NOTE_BODY });
check("建笔记成功", note.status === 200 && typeof note.data?.id === "number", `status=${note.status}`);
const noteId = note.data?.id;

// ---------------- 3. 笔记分享：建 → 口令 → 撤销 ----------------

// 先试一个非法有效期：迁移后这里必须回 400 + code=bad_request
const badDays = await call(`notes/${noteId}/share`, "POST", { days: 3 });
check("非法有效期回 400 + bad_request",
    badDays.status === 400 && badDays.data?.error?.code === "bad_request",
    `status=${badDays.status} code=${badDays.data?.error?.code}`);

// 建一个**带口令**的分享
const created = await call(`notes/${noteId}/share`, "POST", { days: 1, password: SHARE_PW });
check("创建带口令的笔记分享", created.status === 200 && /^[a-f0-9]{64}$/.test(created.data?.token ?? ""),
    `status=${created.status} token=${(created.data?.token ?? "").slice(0, 8)}…`);
const token = created.data?.token;
// ⚠️ hasPassword 过网是 1/0 不是布尔：SQL 里是 (password IS NOT NULL)，SQLite 没有布尔类型。
// 既有真库测试（groupSharesRealSql.test.ts）与前端（NoteShareDialog 用 !!value?.hasPassword）都按真值判。
check("分享标记为有口令", !!created.data?.hasPassword);

// 匿名 GET：必须 401 + 顶层 needPassword，且**不带正文**
const needPw = await anon(`note-shares/${token}`);
check("受口令分享匿名 GET 回 401", needPw.status === 401, `status=${needPw.status}`);
check("401 的 message 是「需要访问口令」",
    needPw.data?.error?.message === "需要访问口令", JSON.stringify(needPw.data?.error));
check("401 带顶层 needPassword（公开页靠它弹框）", needPw.data?.needPassword === true);
check("401 不带正文", typeof needPw.data?.content !== "string");
check("401 带 no-store 与 noindex",
    needPw.headers.get("Cache-Control") === "no-store" &&
    (needPw.headers.get("X-Robots-Tag") ?? "").includes("noindex"));

// 口令错：也要 401，同样不能漏正文
const wrongPw = await anon(`note-shares/${token}`, "POST", { password: "wrong-" + SHARE_PW });
check("口令错也回 401", wrongPw.status === 401, `status=${wrongPw.status}`);
check("口令错不带正文", typeof wrongPw.data?.content !== "string");

// 口令对：拿到正文
const ok = await anon(`note-shares/${token}`, "POST", { password: SHARE_PW });
check("口令正确拿到分享正文",
    ok.status === 200 && ok.data?.title === NOTE_TITLE && ok.data?.content === NOTE_BODY,
    `status=${ok.status} title=${ok.data?.title}`);
check("成功响应打上防刷当日戳 cookie",
    (ok.headers.getSetCookie?.() ?? []).some(c => /nh_noteview_[a-f0-9]+=/.test(c)),
    (ok.headers.getSetCookie?.() ?? []).join(" | "));

// 更新设置：保留 token，只改有效期
const updated = await call(`notes/${noteId}/share`, "PUT", { days: 7 });
check("PUT 更新有效期成功且 token 不变",
    updated.status === 200 && updated.data?.token === token, `status=${updated.status}`);
check("PUT 之后仍是有口令", !!updated.data?.hasPassword);

// 方法不对：PATCH 必须 405 + method_not_allowed（迁移后新增的 code）
const patched = await call(`notes/${noteId}/share`, "PATCH", { days: 7 });
check("PATCH 分享回 405 + method_not_allowed",
    patched.status === 405 && patched.data?.error?.code === "method_not_allowed",
    `status=${patched.status} code=${patched.data?.error?.code}`);

// 撤销 → 同一 token 立刻 404 + not_found
const revoked = await call(`notes/${noteId}/share`, "DELETE");
check("撤销分享成功", revoked.status === 200 && revoked.data?.success === true, `status=${revoked.status}`);
const afterRevoke = await anon(`note-shares/${token}`);
check("撤销后匿名访问回 404 + not_found",
    afterRevoke.status === 404 && afterRevoke.data?.error?.code === "not_found",
    `status=${afterRevoke.status} code=${afterRevoke.data?.error?.code}`);
const afterRevokePw = await anon(`note-shares/${token}`, "POST", { password: SHARE_PW });
check("撤销后带正确口令也是 404", afterRevokePw.status === 404, `status=${afterRevokePw.status}`);

// 撤销后 GET 配置应为空（null）
const shareAfter = await call(`notes/${noteId}/share`, "GET");
check("撤销后 GET 分享配置为空", shareAfter.status === 200 && shareAfter.data === null,
    `status=${shareAfter.status} body=${JSON.stringify(shareAfter.data)}`);

// 不存在的笔记 id：404 + not_found（迁移前是 `share ?? { error: "分享不存在" }`）
const missing = await call("notes/99999999/share", "POST", { days: 1 });
check("给不存在的笔记建分享回 404 + not_found",
    missing.status === 404 && missing.data?.error?.code === "not_found",
    `status=${missing.status} code=${missing.data?.error?.code}`);

// ---------------- 4. 分组分享：公开读必须脱敏 ----------------

const gCreated = await call(`groups/${groupId}/share`, "POST", { days: 1 });
check("创建分组分享", gCreated.status === 200 && /^[a-f0-9]{64}$/.test(gCreated.data?.token ?? ""),
    `status=${gCreated.status}`);
const gToken = gCreated.data?.token;

const pubGroup = await anon(`group-shares/${gToken}`);
check("匿名读分组分享成功", pubGroup.status === 200 && pubGroup.data?.status === "ok",
    `status=${pubGroup.status} body=${JSON.stringify(pubGroup.data).slice(0, 120)}`);
const pubText = JSON.stringify(pubGroup.data ?? {});
check("公开分组页不含 username / password（脱敏）",
    !pubText.includes("secret-user") && !pubText.includes("secret-pass"),
    pubText.slice(0, 160));
check("公开分组页带出了站点名", pubText.includes("分享验收站点"));

// 分组分享也能带口令
const gPwCreated = await call(`groups/${groupId}/share`, "POST", { days: 1, password: SHARE_PW });
check("创建带口令的分组分享", gPwCreated.status === 200 && !!gPwCreated.data?.hasPassword,
    `status=${gPwCreated.status}`);
const gPwToken = gPwCreated.data?.token;
const gNeedPw = await anon(`group-shares/${gPwToken}`);
check("带口令分组分享匿名 GET 回 need-password",
    gNeedPw.status === 200 && gNeedPw.data?.status === "need-password",
    `status=${gNeedPw.status} status=${gNeedPw.data?.status}`);
const gOk = await anon(`group-shares/${gPwToken}`, "POST", { password: SHARE_PW });
check("口令正确拿到分组内容", gOk.status === 200 && gOk.data?.status === "ok", `status=${gOk.status}`);
const gBad = await anon(`group-shares/${gPwToken}`, "POST", { password: "nope-" + SHARE_PW });
check("口令错回 need-password", gBad.data?.status === "need-password", JSON.stringify(gBad.data));

const gRevoked = await call(`groups/${groupId}/share`, "DELETE");
check("撤销分组分享", gRevoked.status === 200, `status=${gRevoked.status}`);
const gAfter = await anon(`group-shares/${gToken}`);
check("撤销后匿名读分组分享回 not-found",
    gAfter.status === 200 && gAfter.data?.status === "not-found",
    `status=${gAfter.status} status=${gAfter.data?.status}`);

// ---------------- 收尾 ----------------

await proc.stopAndWait();
console.log(`\n分享端到端：${state.checks - state.failures} PASS / ${state.failures} FAIL`);
process.exit(state.failures === 0 ? 0 : 1);
