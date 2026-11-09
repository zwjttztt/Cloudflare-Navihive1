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

test("public/_headers：precache-manifest.json 是 60 秒短缓存、不是 immutable", async () => {
    // manifest 不被 SW 的 fetch 拦截，每次起生命周期都要回源取一次（线上曾 30 秒超时）；
    // 它会随构建变，所以只给短缓存、且绝不能 immutable（否则 SW 拿到旧 version
    // 会去用已被清掉的缓存名）。动态 import 保持这条用例自包含、不碰上面的现有内容。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    let dir = path.dirname(fileURLToPath(import.meta.url));
    let text = "";
    for (let i = 0; i < 6; i++) {
        try {
            text = fs.readFileSync(path.resolve(dir, "public/_headers"), "utf8");
            break;
        } catch {
            dir = path.dirname(dir);
        }
    }
    assert.ok(text, "读不到 public/_headers");

    const lines = text.split(/\r?\n/);
    const at = lines.findIndex(l => l.trim() === "/precache-manifest.json");
    assert.ok(at >= 0, "public/_headers 里必须有 /precache-manifest.json 规则块");
    const block: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^\/\S/.test(l)) break; // 下一个路径块
        if (/^ {2}\S/.test(l)) block.push(l.trim());
    }
    const cc = block.find(l => /^cache-control:/i.test(l)) ?? "";
    assert.match(cc, /max-age=60/, "manifest 要 60 秒短缓存，避免每次 SW 生命周期都跨境回源");
    assert.ok(!/immutable/i.test(cc), "manifest 会随构建变，不能 immutable");
    assert.ok(!/no-store/i.test(cc), "manifest 必须允许缓存，不能是 no-store");
});
