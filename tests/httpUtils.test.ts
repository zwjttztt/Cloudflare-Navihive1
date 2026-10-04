// worker/httpUtils.ts 的直测。
//
// 这个文件是「每个请求都要过一遍」的那一层，但它自己一条用例都没有 ——
// requestIsSecure 另由 cookieSecure.test.ts 盯着，剩下 6 个函数是裸奔的。
//
// 为什么值得单独钉：这里的错法**不会报错**。
//   - 令牌 cookie 少了 HttpOnly → 一切正常，只是 XSS 能顺手偷走令牌；
//   - 登录标记 cookie 多了 HttpOnly → 前端读不到，表现为「登录了但界面不知道」；
//   - SameSite 掉了 → 一切正常，只是 CSRF 敞开；
//   - isSameOrigin 写反 → 跨站请求要么全被拒、要么全放行，两种都不报错。
// 这些只有把属性逐条断言出来才看得见。

import assert from "node:assert/strict";
import test from "node:test";
import {
    TOKEN_COOKIE,
    SESSION_COOKIE,
    clientIp,
    isSameOrigin,
    readBearerToken,
    readCookie,
    expiredCookieHeaders,
    sessionCookieHeaders,
    withSecurityHeaders,
} from "../worker/httpUtils";

/** 把一条 Set-Cookie 串拆成「属性 → 是否存在」方便断言 */
const attrsOf = (cookie: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of cookie.split(";")) {
        const idx = part.indexOf("=");
        const key = (idx < 0 ? part : part.slice(0, idx)).trim().toLowerCase();
        out[key] = idx < 0 ? "" : part.slice(idx + 1).trim();
    }
    return out;
};

// ---------------- 登录下发的 cookie ----------------

test("令牌 cookie 带 HttpOnly，登录标记 cookie 不带", () => {
    const [token, session] = sessionCookieHeaders("tok-123", 3600, true);
    const t = attrsOf(token);
    const s = attrsOf(session);

    // XSS 读不到令牌：这是把令牌从 localStorage 挪到 cookie 的全部理由
    assert.ok("httponly" in t, `令牌 cookie 缺 HttpOnly：${token}`);
    // 前端要靠它判断「是否已登录」，加了 HttpOnly 就永远读不到，
    // 表现为刷新后明明有令牌、界面却一直认为没登录
    assert.ok(!("httponly" in s), `登录标记不该 HttpOnly：${session}`);
});

test("两条 cookie 都带 Path=/ 与 SameSite=Strict", () => {
    for (const cookie of sessionCookieHeaders("tok", 3600, true)) {
        const a = attrsOf(cookie);
        assert.equal(a["path"], "/");
        assert.equal(a["samesite"], "Strict");
    }
});

test("Max-Age 就是传入的 TTL；Secure 只在安全通道加", () => {
    const [secureToken] = sessionCookieHeaders("tok", 7200, true);
    assert.equal(attrsOf(secureToken)["max-age"], "7200");
    assert.ok("secure" in attrsOf(secureToken));

    const [plainToken, plainSession] = sessionCookieHeaders("tok", 7200, false);
    assert.ok(!("secure" in attrsOf(plainToken)), "http 下带 Secure 会被浏览器直接丢弃");
    assert.ok(!("secure" in attrsOf(plainSession)));
});

test("两条 cookie 的名字就是常量里那两个（改名会同时改坏写入与读取）", () => {
    const [token, session] = sessionCookieHeaders("tok", 60, true);
    assert.ok(token.startsWith(`${TOKEN_COOKIE}=tok;`), token);
    assert.ok(session.startsWith(`${SESSION_COOKIE}=1;`), session);
});

test("退出登录：值为空且 Max-Age=0，两条都过期", () => {
    for (const cookie of expiredCookieHeaders(false)) {
        const a = attrsOf(cookie);
        assert.equal(a["max-age"], "0");
        const [pair] = cookie.split(";");
        assert.equal(pair.split("=")[1], "", `值没清空：${cookie}`);
    }
    const [token] = expiredCookieHeaders(true);
    assert.ok("httponly" in attrsOf(token), "过期 cookie 同样得带 HttpOnly，否则删不掉 httpOnly 那条");
});

// ---------------- 读取 cookie / Bearer ----------------

test("readCookie 能从多个 cookie 里取到指定的那个", () => {
    const req = new Request("https://nav.example.com/api/groups", {
        headers: { Cookie: `a=1; ${TOKEN_COOKIE}=tok-9; b=2` },
    });
    assert.equal(readCookie(req, TOKEN_COOKIE), "tok-9");
});

test("readCookie 会把 URL 编码的值解回来", () => {
    const req = new Request("https://nav.example.com/", {
        headers: { Cookie: "nav=hello%20world%2F1" },
    });
    assert.equal(readCookie(req, "nav"), "hello world/1");
});

test("readCookie 不会被名字前缀相同的 cookie 骗到（只认全名）", () => {
    const req = new Request("https://nav.example.com/", {
        headers: { Cookie: `${TOKEN_COOKIE}x=wrong; ${TOKEN_COOKIE}=right` },
    });
    assert.equal(readCookie(req, TOKEN_COOKIE), "right");
});

test("readCookie 没有 Cookie 头时返回 null", () => {
    assert.equal(readCookie(new Request("https://nav.example.com/"), TOKEN_COOKIE), null);
});

test("readBearerToken 只认 Bearer，其它类型一律当没有", () => {
    const get = (authorization: string) =>
        readBearerToken(new Request("https://nav.example.com/", { headers: { Authorization: authorization } }));

    assert.equal(get("Bearer tok-1"), "tok-1");
    assert.equal(get("Basic dXNlcjpwYXNz"), null, "Basic 凭据不能当 Bearer 喂给验签");
    assert.equal(get("Bearer"), null, "只有类型没有令牌");
    assert.equal(get("Bearer   "), null);
    assert.equal(
        readBearerToken(new Request("https://nav.example.com/")),
        null,
        "没有 Authorization 头"
    );
});

// ---------------- 客户端 IP（审计日志） ----------------

test("clientIp 优先取 CF-Connecting-IP，其次是 XFF，都没有记 unknown", () => {
    const req = (headers: Record<string, string>) => new Request("https://nav.example.com/", { headers });
    assert.equal(clientIp(req({ "CF-Connecting-IP": "1.2.3.4" })), "1.2.3.4");
    assert.equal(clientIp(req({ "X-Forwarded-For": "5.6.7.8" })), "5.6.7.8");
    // XFF 是客户端能伪造的，边缘注入的那条必须赢
    assert.equal(
        clientIp(req({ "CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9" })),
        "1.2.3.4"
    );
    assert.equal(clientIp(req({})), "unknown");
});

// ---------------- 同源校验（CSRF 闸门） ----------------

const post = (headers: Record<string, string>) =>
    new Request("https://nav.example.com/api/groups", { method: "POST", headers });

test("isSameOrigin：跨站 Origin 一律拒绝（这是 CSRF 的主闸门）", () => {
    assert.equal(isSameOrigin(post({ Origin: "https://evil.example.com" })), false);
    assert.equal(isSameOrigin(post({ Origin: "https://nav.example.com.evil.com" })), false, "后缀伪装不算同源");
    // host 含端口，所以换端口也算跨站
    assert.equal(isSameOrigin(post({ Origin: "https://nav.example.com:8443" })), false);
});

// 刻意**不**比协议：host 相同、只有 scheme 不同（http://本站 vs https://本站）
// 不构成 CSRF —— 能拿本站 host 发请求的攻击者已经控制了这台主机，那时候有没有
// 这道校验都不重要。反过来说，把 scheme 也加进比较是纯风险：
// 反代场景下 Origin（浏览器看到的）与 request.url（Worker 看到的）协议不一致时，
// 会把所有本站写操作一律打成 403，而且这种故障只在特定部署形态下出现。
// 真要防「http 上的会话被劫持」，靠的是 cookie 的 Secure，不是同源校验。
test("isSameOrigin：只比 host（含端口），协议差异不算跨站——记下这个取舍", () => {
    assert.equal(isSameOrigin(post({ Origin: "http://nav.example.com" })), true);
});

test("isSameOrigin：本站 Origin 放行", () => {
    assert.equal(isSameOrigin(post({ Origin: "https://nav.example.com" })), true);
});

test("isSameOrigin：Origin 解析不了就当跨站（畸形值不放行）", () => {
    assert.equal(isSameOrigin(post({ Origin: "not-a-url" })), false);
});

test("isSameOrigin：没有 Origin 时看 Sec-Fetch-Site", () => {
    assert.equal(isSameOrigin(post({ "Sec-Fetch-Site": "same-origin" })), true);
    assert.equal(isSameOrigin(post({ "Sec-Fetch-Site": "none" })), true, "浏览器导航发起的请求");
    assert.equal(isSameOrigin(post({ "Sec-Fetch-Site": "same-site" })), false);
    assert.equal(isSameOrigin(post({ "Sec-Fetch-Site": "cross-site" })), false);
});

test("isSameOrigin：两个头都没有时放行，交给 SameSite=Strict 兜底", () => {
    // curl / 老客户端发不出这两个头，全拒会让脚本用不了。
    // 这里放行不是漏洞 —— cookie 上的 SameSite=Strict 会拦住浏览器发起的跨站请求。
    assert.equal(isSameOrigin(post({})), true);
});

// ---------------- 响应安全头 ----------------

test("withSecurityHeaders 补齐三个安全头", () => {
    const res = withSecurityHeaders(new Response("ok"));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
});

test("withSecurityHeaders 不覆盖已经设过的头（图标代理那条 CSP sandbox 更严）", () => {
    const res = new Response("ok", {
        headers: { "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin" },
    });
    const out = withSecurityHeaders(res);
    assert.equal(out.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.equal(out.headers.get("Referrer-Policy"), "strict-origin");
});
