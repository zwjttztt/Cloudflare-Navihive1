// tests/errorCodeMigration.test.ts
// 错误码迁移的收尾守卫：worker/ 下不许再冒出**裸的错误出口**。
//
// 背景：统一错误码（ApiError + errorResponse）是增量迁移的，每次改动顺手改一点。
// 危险在于「改到一半就停」—— 新旧两种形状永远并存，客户端拿不到 code，
// 于是 UI 分流又得回去 includes 匹配字符串，而这个倒退没有任何东西在盯着。
//
// 2026-10-13 把剩下的 30 处（data.ts 25 / public.ts 5 / icon.ts 3，含若干
// `share ?? { error: "..." }` 这种藏在成功响应里的）一次迁完，这里钉住这个结果：
// 谁再写 `Response.json({ error: "..." })`，这条会红。
//
// 卡了很久的那批出口是**带响应头**的（分享与图标端点的 no-store / X-Robots-Tag），
// 所以同批给 errorResponse 加了 `headers` 与 `extra` 两个可选项 ——
// 有能力带头的错误出口，才谈得上「迁移」。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** 往上找到带 package.json 的那一层（单测会被 esbuild 打到 script/tmp-tests/ 下） */
function findRepoRoot(from: string): string {
    let dir = from;
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error("找不到仓库根（一路向上都没有 package.json）");
        dir = up;
    }
}

const ROOT = findRepoRoot(path.resolve(process.argv[1] ?? ".", ".."));
const WORKER = path.join(ROOT, "worker");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, out);
        else if (/\.ts$/.test(name)) out.push(full);
    }
    return out;
}

/**
 * 剥掉注释再扫。
 *
 * 必须剥：`worker/lib/apiError.ts` 的文件头注释里就写着「以前各路由自行
 * `Response.json({ error: "密码强度不足" })`」—— 不剥的话这条守卫会永远红在
 * 它自己要说明的那段文字上（lazyBoundary 那条守卫踩过同一个坑）。
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // 行注释：// 前面不能是引号或冒号，否则 "http://" 会被吃掉
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

const FILES = walk(WORKER).map(f => ({
    rel: path.relative(ROOT, f).replace(/\\/g, "/"),
    text: stripComments(fs.readFileSync(f, "utf8")),
}));

/** 允许保留裸出口的文件：只有统一出口自己（它要造这个形状，不是用它） */
const ALLOWED = new Set(["worker/lib/apiError.ts"]);

test("worker/ 下不许再有裸的错误出口 Response.json({ error: ... })", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
        if (ALLOWED.has(rel)) continue;
        // 所有 `{ error:` 的对象字面量（含跨行），往前看 200 个字符里有没有 Response.json(
        const re = /\{\s*error\s*:/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const before = text.slice(Math.max(0, m.index - 200), m.index);
            if (/Response\.json\(\s*$|Response\.json\([^)]*$/.test(before)) {
                const line = text.slice(0, m.index).split("\n").length;
                bad.push(`${rel}:${line}`);
            }
        }
    }
    assert.deepEqual(
        bad,
        [],
        `${bad.join("、")} 还在写裸的 Response.json({ error: ... })。` +
            `改成 throw ApiError.xxx("...")，或（要带响应头时）` +
            `return errorResponse(ApiError.xxx("..."), { headers }) —— 状态码与文案都不变，` +
            `只是多一个机器可读的 code。`
    );
});

test("迁移没把状态码或文案改掉：These 几条文案必须还在", () => {
    // 反向盯一下：迁移只加 code，不该顺手把用户看得见的文案改掉
    // （改文案等于改契约，客户端有测试依赖原文）。
    const all = FILES.map(f => f.text).join("\n");
    for (const phrase of [
        "有效期仅支持1、7、30天或永久",
        "附件数据已丢失",
        "分享不存在、已过期或已撤销",
        "需要访问口令",
        "图标请求过于频繁，请稍后再试",
        "该版本不存在",
    ]) {
        assert.ok(all.includes(phrase), `「${phrase}」在 worker/ 里找不到了 —— 迁移不该改文案`);
    }
});

test("守卫自身没跑空：worker/ 下确实扫到了文件，且统一出口自己被跳过", () => {
    assert.ok(FILES.length >= 15, `只扫到 ${FILES.length} 个 worker 源文件，口径可能坏了`);
    assert.ok(
        FILES.some(f => f.rel === "worker/lib/apiError.ts"),
        "没扫到 worker/lib/apiError.ts"
    );
    // 反面：统一出口自己必须**存在**（没了说明这条守卫的前提变了）
    const apiError = FILES.find(f => f.rel === "worker/lib/apiError.ts");
    assert.ok(apiError && /export function errorResponse/.test(apiError.text), "errorResponse 不见了");
});
