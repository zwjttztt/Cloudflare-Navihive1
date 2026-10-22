// tests/spaRoutes.test.ts
// SPA 路由表（shared/spaRoutes.ts）的行为钉子 + 三处共用同一张表的静态守卫。
//
// 背景（P2-8）：Cloudflare（worker/index.ts）与自托管（server/static.ts）的 SPA 回退
// 以前是「无扩展名一律回 index.html」，于是 /notes、/.git/config、/wp-login.php
// 这类压根不存在的路径一律 200 吐整页 HTML —— 扫描器眼里「本站什么都存在」，
// 而前端根本没有这些路由。现在回退条件收紧成「命中路由表才回退」。
//
// 收紧之后最大的风险变成反向的：**前端加了 URL 路由而忘了往表里加**，两端一起 404，
// 而本地开发（Vite dev server 无条件回退）完全测不出来。所以这个文件干两件事：
//   1) 逐条断言路由表的判定（表内 200 / 表外 404 的那条线画在哪）；
//   2) 静态守卫：三个消费方必须 import 这张表，谁都不许再内联自己的正则。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import {
    isSpaRoute,
    looksLikeAsset,
    normalizeSpaPath,
    publicGroupTokenFromPath,
    publicNoteTokenFromPath,
    SPA_ROUTES,
} from "../shared/spaRoutes";
import { serveStatic } from "../server/static";

const TOKEN = "a1b2c3d4".repeat(8); // 64 位小写 hex，与真实分享令牌同形
const NO_RULES: never[] = [];

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

function readRepoFile(...segments: string[]): string {
    return readFileSync(path.join(findProjectDir(), ...segments), "utf8");
}

// ============ 路由表判定 ============

test("路由表内的三条路径全部命中：/ 与 /s/<token> 与 /sg/<token>", () => {
    for (const p of ["/", `/s/${TOKEN}`, `/sg/${TOKEN}`]) {
        assert.equal(isSpaRoute(p), true, `${p} 必须在路由表里`);
    }
});

test("路由表外的一律不命中：无扩展名的未知路径不再回退", () => {
    for (const p of [
        "/notes",
        "/settings/account",
        "/.git/config",
        "/admin",
        "/s/not-a-token", // 形似但令牌不是 64 位 hex
        `/s/${TOKEN.toUpperCase()}`, // 大写 hex 不是真令牌（生成端只出小写）
        `/s/${TOKEN}x`, // 多一位
        "/s/", // 缺令牌
    ]) {
        assert.equal(isSpaRoute(p), false, `${p} 不该在路由表里`);
    }
});

test("结尾斜杠归一：/s/<token>/ 与 /s/<token> 同路由（手输 / 某些客户端会补斜杠）", () => {
    assert.equal(isSpaRoute(`/s/${TOKEN}/`), true);
    assert.equal(publicNoteTokenFromPath(`/s/${TOKEN}/`), TOKEN);
    assert.equal(normalizeSpaPath("/"), "/");
    assert.equal(normalizeSpaPath("/a/b///"), "/a/b");
});

test("令牌提取只在真路由上返回，且两条前缀互不串味", () => {
    assert.equal(publicNoteTokenFromPath(`/s/${TOKEN}`), TOKEN);
    assert.equal(publicGroupTokenFromPath(`/sg/${TOKEN}`), TOKEN);
    assert.equal(publicNoteTokenFromPath(`/sg/${TOKEN}`), null, "/sg/ 不能被 /s/ 认领");
    assert.equal(publicGroupTokenFromPath(`/s/${TOKEN}`), null);
    assert.equal(publicNoteTokenFromPath("/notes"), null);
});

test("looksLikeAsset 与路由表互补：带扩展名的永远不是路由", () => {
    for (const p of ["/assets/app.js", "/index.html", "/favicon.ico", "/sw.js", "/a.b.c/d.webp"]) {
        assert.equal(looksLikeAsset(p), true, `${p} 应当算静态资产`);
        assert.equal(isSpaRoute(p), false, `${p} 不该算 SPA 路由`);
    }
    for (const p of ["/", `/s/${TOKEN}`, "/notes"]) {
        assert.equal(looksLikeAsset(p), false, `${p} 不该算静态资产`);
    }
});

test("路由表是个非空常量数组，且每条都有名字（新增路由时一眼看得见）", () => {
    assert.ok(SPA_ROUTES.length >= 3);
    for (const route of SPA_ROUTES) {
        assert.ok(route.name.length > 0);
        assert.ok(route.match instanceof RegExp);
    }
});

// ============ 自托管侧：表内 200 / 表外 404 ============

function fakeRes(): {
    res: ServerResponse;
    status: () => number;
    text: () => string;
    done: Promise<void>;
} {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    const done = new Promise<void>(resolve => sink.on("end", () => resolve()));
    let status = 0;
    const res = sink as unknown as ServerResponse;
    (res as unknown as { writeHead(code: number, h?: unknown): unknown }).writeHead = (code: number) => {
        status = code;
        return res;
    };
    return {
        res,
        status: () => status,
        text: () => Buffer.concat(chunks).toString("utf8"),
        done,
    };
}

test("自托管：路由表内的路径回 200 + index.html，表外的无扩展名路径回 404", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nh-spa-routes-"));
    try {
        mkdirSync(path.join(dir, "assets"), { recursive: true });
        writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>ok</title>");
        writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");

        for (const p of ["/", `/s/${TOKEN}`, `/sg/${TOKEN}`]) {
            const r = fakeRes();
            await serveStatic(dir, NO_RULES, p, "GET", r.res);
            await r.done;
            assert.equal(r.status(), 200, `${p} 应当 200`);
            assert.ok(r.text().includes("<!doctype html>"), `${p} 应当回整页 HTML`);
        }
        // ⚠️ 只列**无扩展名**的（带扩展名走 looksLikeAsset 那条分支）
        for (const p of ["/notes", "/.git/config", "/admin", "/s/nope"]) {
            const r = fakeRes();
            await serveStatic(dir, NO_RULES, p, "GET", r.res);
            await r.done;
            assert.equal(r.status(), 404, `${p} 应当 404`);
            assert.equal(r.text(), "Not Found");
        }
        // 真实资产照旧命中（收紧不能误伤）
        const a = fakeRes();
        await serveStatic(dir, NO_RULES, "/assets/app.js", "GET", a.res);
        await a.done;
        assert.equal(a.status(), 200);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============ 静态守卫：三处共用同一张表 ============

test("静态守卫：worker / 自托管 / 前端入口都从 shared/spaRoutes 取判定，不许再内联", () => {
    const workerSrc = readRepoFile("worker", "index.ts");
    assert.ok(workerSrc.includes("shared/spaRoutes"), "worker/index.ts 必须 import shared/spaRoutes");
    assert.ok(
        !workerSrc.includes("\\.[a-z0-9]{1,8}"),
        "worker/index.ts 不能再内联扩展名正则（与自托管漂移就是 MIME 事故）"
    );

    const staticSrc = readRepoFile("server", "static.ts");
    assert.ok(staticSrc.includes("shared/spaRoutes"), "server/static.ts 必须 import shared/spaRoutes");

    const mainSrc = readRepoFile("src", "main.tsx");
    assert.ok(mainSrc.includes("shared/spaRoutes"), "src/main.tsx 必须 import shared/spaRoutes");
});

test("静态守卫：后端回退必须先判路由表再回 index.html（不能退回「无扩展名一律回退」）", () => {
    // 不看注释（注释里也会提到这两个名字），只看**代码顺序**：守卫必须在回退之前
    const workerSrc = readRepoFile("worker", "index.ts");
    const workerGuard = workerSrc.indexOf("isSpaRoute(url.pathname)");
    const workerFallback = workerSrc.indexOf('new URL("/index.html"');
    assert.ok(workerGuard > -1, "worker/index.ts 要有 isSpaRoute 判定");
    assert.ok(workerFallback > -1, "worker/index.ts 要有取 /index.html 的回退");
    assert.ok(
        workerGuard < workerFallback,
        "取 /index.html 之前必须先过 isSpaRoute（否则未知路径又变 200）"
    );

    const staticSrc = readRepoFile("server", "static.ts");
    const staticGuard = staticSrc.indexOf("isSpaRoute(decoded)");
    const staticFallback = staticSrc.indexOf("// SPA fallback");
    assert.ok(staticGuard > -1, "server/static.ts 要有 isSpaRoute 判定");
    assert.ok(staticFallback > -1, "server/static.ts 里要有 SPA fallback 分支");
    assert.ok(
        staticGuard < staticFallback,
        "serveStatic 回退 index.html 之前必须先过 isSpaRoute"
    );
});
