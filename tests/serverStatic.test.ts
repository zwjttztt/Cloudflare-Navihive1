// tests/serverStatic.test.ts
//
// server/static.ts 的行为钉子：_headers 规则解析、路径穿越防护、静态资源与 SPA fallback。
// 这段逻辑在 Cloudflare 上是平台白干的活，自托管必须自己长出来 —— 而它**没有报错通道**：
// CSP 少一条表现为 Service Worker 注册静默失败、缓存头写错表现为发版后用户拿到旧壳子，
// 都不是「跑一下就能发现」的那类问题，只能把行为钉在这里。
//
// 两条最重要的断言：
//   1) 真 dist/client/_headers 解析出来的 CSP 必须仍带 require-trusted-types-for 'script'
//      与 trusted-types navihive-sw —— 前者是 DOM XSS sink 的总闸，后者是 SW 注册的通行证，
//      少任何一条都没有任何东西会报错（见 tests/selfhost-smoke 的同名检查）。
//   2) 规则按**请求路径**匹配，不是按落盘文件：/s/<token> 落盘的是 index.html，
//      但响应头必须来自 /s/* 规则（分享短链要 no-referrer）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { applyHeaderRules, isInside, parseHeaderRules, serveStatic } from "../server/static";

/** 64 位小写 hex，与真实分享令牌同形（路由表只认这个形状） */
const TOKEN = "a1b2c3d4".repeat(8);

// ============ 测试替身 ============

/** 收集 writeHead / 响应体的假 ServerResponse（serveStatic 只用到 writeHead/end/pipe/destroy） */
function fakeRes(): {
    res: ServerResponse;
    status: () => number;
    headers: () => Record<string, string | string[]>;
    text: () => string;
    raw: () => Buffer;
    done: Promise<void>;
} {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    const done = new Promise<void>(resolve => {
        sink.on("end", () => resolve());
    });
    let status = 0;
    let sent: Record<string, string | string[]> = {};
    const res = sink as unknown as ServerResponse;
    // ⚠️ writeHead 必须 return res：serveStatic 里写的是 res.writeHead(...).end(...)
    (res as unknown as { writeHead(code: number, headers: Record<string, string | string[]>): void }).writeHead = (
        code,
        headers
    ) => {
        status = code;
        sent = headers;
        return res;
    };
    return {
        res,
        status: () => status,
        headers: () => sent,
        text: () => Buffer.concat(chunks).toString("utf8"),
        raw: () => Buffer.concat(chunks),
        done,
    };
}

/** 等响应结束，带超时：pipe 卡住时让用例失败，而不是把整个测试集挂死 */
async function finish(label: string, done: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            done,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`等待响应超时：${label}`)), 5000);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 带 index.html / assets / 子目录 / 二进制 / 空目录的静态目录替身 */
function fixture(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "nh-static-"));
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>fixture</title>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    writeFileSync(path.join(dir, "sub", "index.html"), "<h1>sub</h1>");
    writeFileSync(path.join(dir, "data.bin"), new Uint8Array([1, 2, 3]));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 形状照真 _headers 缩小：全站兜底 + 一条带 drop 的覆盖规则 + 一条分享短链规则 */
const RULES = parseHeaderRules(
    [
        "# 全站安全头",
        "/*",
        "  X-Frame-Options: DENY",
        "  Cache-Control: max-age=60",
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "  ! X-Frame-Options",
        "/s/*",
        "  Referrer-Policy: no-referrer",
    ].join("\n")
);

// ============ parseHeaderRules ============

test("parseHeaderRules：* 通配、drop、缩进注释、顶格之前的缩进行全部按 CF 语义处理", () => {
    const rules = parseHeaderRules(
        [
            "  X-Before-Any-Rule: ignored", // 还没有顶格规则，无处安放
            "# 整行注释",
            "/a/*",
            "  # 缩进注释也要跳过（真文件里 /* 规则底下全是这种）",
            "  X-One: 1",
            "  ! X-Dropped",
            "/b",
            "  X-One: 2",
        ].join("\n")
    );
    assert.equal(rules.length, 2);

    assert.ok(rules[0]!.match.test("/a/x"), "* 要能匹配多段路径");
    assert.ok(rules[0]!.match.test("/a/deep/nested.js"));
    assert.ok(!rules[0]!.match.test("/b"));
    assert.deepEqual(rules[0]!.set, [["X-One", "1"]]);
    assert.deepEqual(rules[0]!.drop, ["X-Dropped"]);

    assert.ok(rules[1]!.match.test("/b"), "没有 * 的按精确匹配");
    assert.ok(!rules[1]!.match.test("/b/c"));
});

test("parseHeaderRules：路径里的正则元字符被转义，不会被当成模式", () => {
    const rules = parseHeaderRules("/a+b.c\n  X: 1");
    assert.equal(rules.length, 1);
    assert.ok(rules[0]!.match.test("/a+b.c"));
    assert.ok(!rules[0]!.match.test("/aab-c"), "加号不该被解释成「一个或多个」");
});

// ============ applyHeaderRules ============

test("applyHeaderRules：后面的规则覆盖前面，! 前缀删除，不匹配的规则不动", () => {
    const headers: Record<string, string> = { "Content-Type": "text/html", "X-Frame-Options": "DENY" };
    applyHeaderRules(RULES, "/assets/app.js", headers);
    assert.equal(headers["X-Frame-Options"], undefined, "/assets/* 里的 ! X-Frame-Options 要删掉全站那条");
    assert.equal(headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(headers["Content-Type"], "text/html", "规则没提的头保持原样");

    applyHeaderRules(RULES, "/", headers);
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(headers["Cache-Control"], "max-age=60", "同名头后面覆盖前面");
});

// ============ isInside ============

test("isInside：目录内与根本身为真，.. 逃逸与外部绝对路径为假", () => {
    const root = path.resolve("/a/b");
    assert.equal(isInside(root, path.join(root, "index.html")), true);
    assert.equal(isInside(root, root), true, "根目录本身为真，交给后面的 index.html 逻辑");
    assert.equal(isInside(root, path.join(root, "..", "c")), false);
    assert.equal(isInside(root, path.resolve("/somewhere/else")), false);
});

test("isInside：Windows 跨盘符路径为假", {
    skip: process.platform !== "win32" ? "跨盘符只在 Windows 上存在" : false,
}, () => {
    assert.equal(isInside("C:\\base", "D:\\evil\\x"), false, "跨盘符时 relative 回绝对路径，必须拦下");
});

// ============ serveStatic ============

test("serveStatic：GET / 回 index.html，带上全站规则的头", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        const handled = await serveStatic(dir, RULES, "/", "GET", r.res);
        assert.equal(handled, true);
        await finish("GET /", r.done);
        assert.equal(r.status(), 200);
        assert.equal(r.headers()["Content-Type"], "text/html; charset=utf-8");
        assert.equal(r.headers()["X-Frame-Options"], "DENY");
        assert.equal(r.headers()["Cache-Control"], "max-age=60");
        assert.equal(r.headers()["Content-Length"], String(Buffer.byteLength("<!doctype html><title>fixture</title>")));
        assert.equal(r.text(), "<!doctype html><title>fixture</title>");
    } finally {
        cleanup();
    }
});

test("serveStatic：/assets/* 命中覆盖规则（强缓存 + 删掉全站的 X-Frame-Options）", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/assets/app.js", "GET", r.res);
        await finish("assets", r.done);
        assert.equal(r.status(), 200);
        assert.equal(r.headers()["Content-Type"], "text/javascript; charset=utf-8");
        assert.equal(r.headers()["Cache-Control"], "public, max-age=31536000, immutable");
        assert.equal(r.headers()["X-Frame-Options"], undefined);
        assert.equal(r.text(), "console.log(1)");
    } finally {
        cleanup();
    }
});

test("serveStatic：SPA fallback —— 没命中的路径回 index.html（分享短链 /s/<token> 靠这个）", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, `/s/${TOKEN}`, "GET", r.res);
        await finish("spa", r.done);
        assert.equal(r.status(), 200);
        assert.equal(r.text(), "<!doctype html><title>fixture</title>");
        // 规则按请求路径匹配，不是按落盘文件：/s/* 的 no-referrer 必须生效
        assert.equal(r.headers()["Referrer-Policy"], "no-referrer");
        assert.equal(r.headers()["Cache-Control"], "max-age=60");
    } finally {
        cleanup();
    }
});

test("serveStatic：缺失的静态资源回 404，绝不拿 index.html 顶替（MIME 事故）", async () => {
    const { dir, cleanup } = fixture();
    try {
        // 发版后被删掉的旧 chunk：缓存里的 index.html 还在指着它
        for (const p of ["/assets/index-OLD.js", "/favicon.ico", "/assets/app.css", "/icons/x.webp"]) {
            const r = fakeRes();
            await serveStatic(dir, RULES, p, "GET", r.res);
            await finish(`miss ${p}`, r.done);
            assert.equal(r.status(), 404, `${p} 应当 404`);
            assert.ok(!r.text().includes("<!doctype html>"), `${p} 不能回 HTML`);
            // 404 也走一遍规则（与 CF 上 assets 的响应一致）：/assets/* 那条
            // 把 X-Frame-Options 删掉了，说明规则确实按请求路径套过
            assert.equal(r.headers()["Cache-Control"], p.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "max-age=60");
            assert.equal(r.headers()["X-Frame-Options"], p.startsWith("/assets/") ? undefined : "DENY");
        }
    } finally {
        cleanup();
    }
});

test("serveStatic：带扩展名的未命中请求，HEAD 也 404 且不带正文", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/assets/gone.js", "HEAD", r.res);
        await finish("head-miss", r.done);
        assert.equal(r.status(), 404);
        assert.equal(r.text(), "");
    } finally {
        cleanup();
    }
});

test("serveStatic：路由表内的路径走 SPA fallback（分享页 / 分组分享页靠这个）", async () => {
    const { dir, cleanup } = fixture();
    try {
        for (const p of ["/", `/s/${TOKEN}`, `/sg/${TOKEN}`]) {
            const r = fakeRes();
            await serveStatic(dir, RULES, p, "GET", r.res);
            await finish(`spa ${p}`, r.done);
            assert.equal(r.status(), 200, `${p} 应当走 SPA fallback`);
            assert.equal(r.text(), "<!doctype html><title>fixture</title>");
        }
    } finally {
        cleanup();
    }
});

test("serveStatic：无扩展名但不在路由表里的未知路径回 404（P2-8，不再一律回整页 HTML）", async () => {
    const { dir, cleanup } = fixture();
    try {
        // 前端没有 react-router，URL 上根本不存在这些路径 —— 以前它们一律 200 吐整页 HTML
        // ⚠️ 只列**无扩展名**的：带扩展名走的是下面那条「像静态资源」分支（早就有 404）
        for (const p of ["/notes", "/settings/account", "/.git/config", "/admin", `/s/not-a-token`]) {
            const r = fakeRes();
            const handled = await serveStatic(dir, RULES, p, "GET", r.res);
            await finish(`404 ${p}`, r.done);
            assert.equal(handled, true, `${p} 应由静态层自己收掉`);
            assert.equal(r.status(), 404, `${p} 应当 404`);
            assert.ok(!r.text().includes("<!doctype html>"), `${p} 不能回 HTML`);
            // 404 也走规则：与 CF 上 assets 的响应一致（/assets/* 那条会删掉 X-Frame-Options）
            assert.equal(r.headers()["Content-Type"], "text/plain; charset=utf-8");
        }
    } finally {
        cleanup();
    }
});

test("serveStatic：未知无扩展名路径的 HEAD 请求也 404 且不带正文", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/notes", "HEAD", r.res);
        await finish("head-404", r.done);
        assert.equal(r.status(), 404);
        assert.equal(r.text(), "");
    } finally {
        cleanup();
    }
});

test("serveStatic：目录回自己的 index.html", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/sub/", "GET", r.res);
        await finish("dir", r.done);
        assert.equal(r.status(), 200);
        assert.equal(r.text(), "<h1>sub</h1>");
    } finally {
        cleanup();
    }
});

test("serveStatic：HEAD 只回头部，正文为空", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/", "HEAD", r.res);
        await finish("head", r.done);
        assert.equal(r.status(), 200);
        assert.equal(r.headers()["Content-Type"], "text/html; charset=utf-8");
        assert.equal(r.text(), "");
    } finally {
        cleanup();
    }
});

test("serveStatic：../ 穿越回 403，坏百分号编码回 400", async () => {
    const { dir, cleanup } = fixture();
    try {
        const evil = fakeRes();
        assert.equal(await serveStatic(dir, RULES, "/%2e%2e/package.json", "GET", evil.res), true);
        await finish("403", evil.done);
        assert.equal(evil.status(), 403);
        assert.equal(evil.text(), "Forbidden");

        const bad = fakeRes();
        assert.equal(await serveStatic(dir, RULES, "/%ZZ", "GET", bad.res), true);
        await finish("400", bad.done);
        assert.equal(bad.status(), 400);
        assert.equal(bad.text(), "Bad Request");
    } finally {
        cleanup();
    }
});

test("serveStatic：未知扩展名回 application/octet-stream，二进制按字节给", async () => {
    const { dir, cleanup } = fixture();
    try {
        const r = fakeRes();
        await serveStatic(dir, RULES, "/data.bin", "GET", r.res);
        await finish("bin", r.done);
        assert.equal(r.headers()["Content-Type"], "application/octet-stream");
        assert.equal(r.headers()["Content-Length"], "3");
        assert.deepEqual([...r.raw()], [1, 2, 3]);
    } finally {
        cleanup();
    }
});

test("serveStatic：静态目录里没有 index.html 时返回 false（交给 worker 回它的 404）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nh-static-empty-"));
    try {
        writeFileSync(path.join(dir, "only.txt"), "x");
        const r = fakeRes();
        // 用 /（路由表内的路径）：未知路径现在直接 404，只有「路由命中但 index.html 不在」
        // 才轮到「交回 worker」这条兜底
        assert.equal(await serveStatic(dir, RULES, "/", "GET", r.res), false);
        assert.equal(r.status(), 0, "没写过任何状态码");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============ 真 _headers 漂移守卫 ============

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = process.cwd(), i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

test("真 _headers：CSP 的总闸与 SW 通行证都还在（少一条都不报错的那类）", t => {
    const file = path.join(findProjectDir(), "dist", "client", "_headers");
    if (!existsSync(file)) {
        t.skip("dist/client/_headers 不存在（先 npm run build），跳过");
        return;
    }
    const rules = parseHeaderRules(readFileSync(file, "utf8"));
    assert.ok(rules.length >= 10, `只解析出 ${rules.length} 条规则，_headers 可能被截断了`);

    // 第一条是全站兜底（/*）
    const global = rules[0]!;
    assert.ok(global.match.test("/"), "第一条规则应匹配全站");
    assert.ok(global.match.test("/api/bootstrap"));

    const csp = global.set.find(([name]) => name === "Content-Security-Policy")?.[1] ?? "";
    assert.ok(csp.includes("require-trusted-types-for 'script'"), "CSP 少了 require-trusted-types-for：DOM XSS sink 总闸没了");
    assert.ok(csp.includes("trusted-types navihive-sw"), "CSP 少了 trusted-types navihive-sw：Service Worker 注册会静默失败");
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("report-uri /api/csp-report"));

    // 入口 HTML 的 60 秒短缓存（发版窗口的既定取舍，见文件里的长注释）。
    // ⚠️ 要取**最后一条**匹配的规则：/* 兜底也匹配 "/"，规则按顺序生效、后者覆盖前者，
    // 直接 find 会拿到兜底那条（沙箱页的用例就是被这个坑红的）。
    const entry = rules
        .filter(rule => rule.match.test("/"))
        .at(-1);
    assert.ok(entry, "没有任何规则匹配 /");
    assert.ok(
        entry!.set.some(([n, v]) => n === "Cache-Control" && v.includes("max-age=60")),
        "入口 HTML 的 max-age=60 规则不见了"
    );

    // mermaid 沙箱页：先删全站 CSP 再换一条收紧的
    const sandbox = rules.filter(rule => rule.match.test("/mermaid-sandbox")).at(-1);
    assert.ok(sandbox, "/mermaid-sandbox* 规则不见了");
    assert.ok(sandbox!.drop.includes("Content-Security-Policy"), "沙箱页要先删掉全站 CSP 再换自己的");
    assert.ok(sandbox!.set.some(([n]) => n === "Content-Security-Policy"));

    // Service Worker 不能长效缓存
    const sw = rules.filter(rule => rule.match.test("/sw.js")).at(-1);
    assert.ok(sw, "/sw.js 规则不见了");
    assert.ok(
        sw!.set.some(([n, v]) => n === "Cache-Control" && v.includes("must-revalidate")),
        "sw.js 必须 must-revalidate，否则发新版后老客户端拿不到新壳子"
    );
});
