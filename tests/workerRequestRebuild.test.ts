// tests/workerRequestRebuild.test.ts
//
// 「读限流后的请求重建」的运行时兼容钉子。
//
// worker/index.ts 为了给写请求限流，先把 body 读成定长字节，再构造一个新的 Request
// 往下传。2026-10-15 在自托管端炸出 500：写法是 `new Request(request, { body })`
// （拿旧 Request 当模板），Node 的 undici 在 init.body 为 null 时要从模板继承 body，
// 而模板的 body 流刚被读完 → "Cannot construct a Request with a Request object
// that has already been used"。带 body 的 PUT/POST 反而没事（init.body 非空时
// undici 不碰模板的 body），所以 CRUD 大多正常，唯独「空体删除」炸
// （DELETE /api/configs/webdav.backupPassword，WebDAV 配置保存挂在它上面）。
// Cloudflare 的 runtime 没这条检查，线上从不出错 —— 典型的「只在自托管暴露」。
//
// 本测试钉住：不能用 Request 实例当构造模板，必须用 url + method + headers 重建。
// 真跑请求的端到端覆盖在 script/selfhost-smoke.mjs（无 body 的 DELETE 回 404）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function projectDir(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

const ROOT = projectDir();

/** 扫源码必须剥注释：注释里解释事故时必然引用旧写法，不剥就是假绿 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("限流后的请求重建不得拿 Request 实例当模板（undici 空体删除 500）", () => {
    const src = stripComments(readFileSync(path.join(ROOT, "worker", "index.ts"), "utf8"));
    // 第一参就是 Request 实例本身（后面紧跟逗号或闭括号）的写法一律禁止。
    // ⚠️ 不能用 \b：`new Request(request.url` 里 request 后面也是词边界，会误伤修复形态。
    assert.doesNotMatch(
        src,
        /new Request\(\s*(request|req)\s*[,)]/,
        "又改回 `new Request(request, ...)` 了：undici 下空体写请求会 500（见 worker/index.ts 的事故注释）"
    );
    // 修复形态必须在场：url + method + headers 重建
    assert.match(
        src,
        /new Request\(\s*request\.url\s*,/,
        "没找到按 url 重建的写法 —— 限流后的请求还在用旧模板吗？"
    );
    // 重建时必须显式带 method：new Request(url, init) 的默认是 GET，
    // 漏了 method 会把所有写请求悄悄变成 GET（读限流分支放行、路由直接 404）
    const rebuild = /new Request\(\s*request\.url\s*,\s*\{([\s\S]*?)\}\s*\)/.exec(src);
    assert.ok(rebuild, "找不到重建请求的 init 块");
    assert.match(rebuild[1], /method:\s*request\.method/, "重建请求时漏了 method");
});

test("桥接层（server/entry.ts）给非 GET/HEAD 挂 body 流的约定还在", () => {
    const src = stripComments(readFileSync(path.join(ROOT, "server", "entry.ts"), "utf8"));
    // hasBody 的定义不能被改成「只有 POST/PUT」：DELETE 一样可能带 body，
    // 改了之后 index.ts 的读限流就会错过 DELETE 的 body（限流失效）
    assert.match(src, /method !== "GET" && method !== "HEAD"/, "hasBody 判据被改了");
});
