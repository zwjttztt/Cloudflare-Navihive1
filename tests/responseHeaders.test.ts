// Worker 自己 new 出来的响应默认一个安全头都没有（_headers 只管静态资源），
// 靠逐个 return 处补必漏，所以在 fetch 出口统一加。这条测试钉住的是那个出口。

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index";

const env = {} as never;

test("非 API 路由的 404 也带安全头", async () => {
    const res = await worker.fetch(new Request("https://nav.example.com/nope"), env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
});

test("API 未知路径的 404 同样带安全头", async () => {
    const res = await worker.fetch(new Request("https://nav.example.com/api/does-not-exist"), env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("写操作被拒时，4xx 响应同样带安全头", async () => {
    // 不绑死状态码：跨站会被 isSameOrigin 拦（403），参数不合法则是 400，
    // 这里要守的是「不管走哪条拒绝路径，响应都戴着安全头」。
    const res = await worker.fetch(
        new Request("https://nav.example.com/api/groups", {
            method: "POST",
            headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
            body: JSON.stringify({ name: "x" }),
        }),
        env
    );
    assert.ok(res.status >= 400 && res.status < 500, `期望 4xx，实际 ${res.status}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});
