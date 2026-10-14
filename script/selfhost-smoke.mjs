// 自托管链路冒烟：登录 → 改密 → 重登 → CRUD → 静态资源 → SPA → 附件 → 定时任务口
// 用法：node script/selfhost-smoke.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://127.0.0.1:8791";
const ADMIN = "root";
const OLD_PW = "seed-password";
const NEW_PW = "smoke-new-password-2";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
    if (ok) {
        pass += 1;
        console.log(`  PASS ${label}${detail ? `  ${detail}` : ""}`);
    } else {
        fail += 1;
        console.log(`  FAIL ${label}${detail ? `  ${detail}` : ""}`);
    }
};

/** 手动管 cookie：Node 的 fetch 不持久化 cookie，而登录态是全链路的前提 */
let cookieHeader = "";
const api = async (method, path, body, headers = {}) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
        cookieHeader = setCookies.map(c => c.split(";")[0]).join("; ");
    }
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON 响应（静态资源 / 纯文本） */
    }
    return { status: res.status, json, text, headers: res.headers };
};

console.log(`冒烟目标：${BASE}\n`);

// ---- 1. 公开路由 ----
const init = await api("GET", "/api/init");
check("GET /api/init 返回 200", init.status === 200, JSON.stringify(init.json));

// ---- 2. 登录：首次必须提示改密；重复跑（密码已改过）时自动退回新密码 ----
let login1 = await api("POST", "/api/login", { username: ADMIN, password: OLD_PW });
if (login1.status === 401) {
    // 上一轮冒烟已经把密码改掉了（重复跑同一个库）：用新密码再登一次
    login1 = await api("POST", "/api/login", { username: ADMIN, password: NEW_PW });
}
check("登录 200", login1.status === 200, `status=${login1.status}`);
check("登录提示 mustChangePassword", login1.json?.mustChangePassword === true);
// ⚠️ 详情里不要打印 cookie 值：那是带 JWT 的会话凭据
check("登录下发两条 Set-Cookie", (login1.headers.getSetCookie?.() ?? []).length === 2,
    `条数=${(login1.headers.getSetCookie?.() ?? []).length}`);

// ---- 3. 未登录读写要被拦 ----
const anon = await fetch(`${BASE}/api/groups`).then(r => r.status);
check("未登录 GET /api/groups 返回 401", anon === 401, `status=${anon}`);

// ---- 4. 改密（tokenVersion 会变，旧令牌当场失效） ----
const currentPw = login1.json?.mustChangePassword ? OLD_PW : NEW_PW;
const changePw = await api("PUT", "/api/auth/credentials", {
    username: ADMIN,
    currentPassword: currentPw,
    password: NEW_PW,
});
check("PUT /api/auth/credentials 改密成功", changePw.status === 200, JSON.stringify(changePw.json));

// ---- 5. 重新登录 ----
const login2 = await api("POST", "/api/login", { username: ADMIN, password: NEW_PW });
check("改密后重新登录 200", login2.status === 200, `status=${login2.status}`);
check("改密后不再要求改密", login2.json?.mustChangePassword !== true);

// ---- 6. bootstrap + CRUD ----
const boot = await api("GET", "/api/bootstrap");
check("GET /api/bootstrap 200", boot.status === 200);

const group = await api("POST", "/api/groups", { name: "自托管冒烟分组", order_num: 0 });
check("POST /api/groups 建分组", group.status === 200 || group.status === 201, JSON.stringify(group.json));
const groupId = group.json?.id ?? group.json?.group?.id;

const site = await api("POST", "/api/sites", {
    group_id: groupId,
    name: "自托管冒烟站点",
    url: "https://example.com",
    description: "冒烟",
    order_num: 0,
});
check("POST /api/sites 建站点", site.status === 200 || site.status === 201, JSON.stringify(site.json));
const siteId = site.json?.id ?? site.json?.site?.id;

// 这一步正是线上 403 事故的同款请求：带 cookie 的写操作
const updated = await api("PUT", `/api/sites/${siteId}`, {
    name: "自托管冒烟站点（改）",
    description: "改过了",
});
check("PUT /api/sites/{id} 更新站点 200（403 事故同款请求）", updated.status === 200, JSON.stringify(updated.json));

const list = await api("GET", `/api/sites?group_id=${groupId}`);
check("GET /api/sites 能读回更新后的值",
    list.status === 200 && JSON.stringify(list.json).includes("改"), "");

// ---- 7. 静态资源（顶掉 assets 绑定） ----
const html = await fetch(`${BASE}/`);
const htmlText = await html.text();
check("GET / 返回 index.html", html.status === 200 && htmlText.includes("<div id="), `status=${html.status}`);
const csp = html.headers.get("content-security-policy") ?? "";
check("index.html 带 CSP（_headers 规则生效）", csp.includes("require-trusted-types-for") && csp.includes("trusted-types navihive-sw"));
check("index.html 带 X-Frame-Options", html.headers.get("x-frame-options") === "DENY");
check("index.html 缓存 60 秒", (html.headers.get("cache-control") ?? "").includes("max-age=60"));

const assetMatch = htmlText.match(/\/assets\/[^"]+\.js/);
if (assetMatch) {
    const asset = await fetch(`${BASE}${assetMatch[0]}`);
    check("GET /assets/*.js 200", asset.status === 200, assetMatch[0]);
    check("assets 强缓存 immutable", (asset.headers.get("cache-control") ?? "").includes("immutable"));
} else {
    check("index.html 里找到 /assets/*.js 引用", false);
}

const sw = await fetch(`${BASE}/sw.js`);
check("GET /sw.js 200 且不长效缓存", sw.status === 200 && (sw.headers.get("cache-control") ?? "").includes("must-revalidate"));

// SPA fallback：分享短链这类前端路由必须回 index.html
const spa = await fetch(`${BASE}/s/${"0".repeat(64)}`);
const spaText = await spa.text();
check("GET /s/<token> SPA fallback 回 index.html", spa.status === 200 && spaText.includes("<div id="), `status=${spa.status}`);

// 路径穿越的防护由单测覆盖（server/static-guard 用例），这里不发真实的越界请求

// 非 GET 的非 API 路径进 worker → 纯文本 404（与 CF 上一致）
const postRoot = await fetch(`${BASE}/`, { method: "POST" });
check("POST / 由 worker 回 404 文本", postRoot.status === 404, `status=${postRoot.status}`);

// ---- 8. 附件上传（走文件 KV + D1 元数据） ----
// 1x1 透明 PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = await fetch(`${BASE}/api/notes/attachments`, {
    method: "POST",
    headers: { "Content-Type": "image/png", Cookie: cookieHeader },
    body: png,
});
const uploadJson = await upload.json().catch(() => null);
check("POST /api/notes/attachments 上传图片", upload.status === 200 || upload.status === 201, JSON.stringify(uploadJson));
// 响应里刻意不含 object_key（暴露它等于泄漏存储布局），按 id 读
const attachmentId = uploadJson?.id;
if (attachmentId) {
    const read = await fetch(`${BASE}/api/notes/attachments/${attachmentId}`, { headers: { Cookie: cookieHeader } });
    check("按 id 读回图片字节", read.status === 200 && (await read.arrayBuffer()).byteLength === png.byteLength, `status=${read.status}`);
}

// ---- 9. 定时任务触发口 ----
const cronNoToken = await fetch(`${BASE}/__cron`, { method: "POST" });
check("POST /__cron 无 token → 404（端点关闭）", cronNoToken.status === 404, `status=${cronNoToken.status}`);

// ---- 10. 错误出口形状 ----
const missing = await api("GET", "/api/sites/99999999");
check("不存在的站点 404 且带结构化错误码", missing.status === 404 && typeof missing.json?.error?.code === "string",
    JSON.stringify(missing.json));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
