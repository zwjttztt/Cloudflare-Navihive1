// tests/prodSmokeGuard.test.ts
// 线上只读冒烟（script/prod-smoke.mjs）的守卫。
//
// 这个脚本的**唯一立身之本**是「只读」：它每天定时打向一个真实的、可能正在被使用的
// 线上实例。一旦有人为了「顺便验一下登录」往里加一个 POST，或者把口令塞进 env，
// 它就从健康检查变成了定时写入 —— 而这类改动在代码评审里很容易被放过（只是几行）。
//
// 所以这里钉三条：
//   1) 不许出现任何写方法（POST/PUT/PATCH/DELETE）；
//   2) 不许出现任何凭据（Authorization / Cookie / 口令环境变量）；
//   3) 每次请求都必须带超时 —— 线上卡住时定时任务不能挂到 runner 超时。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

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

const src = readFileSync(path.join(findProjectDir(), "script", "prod-smoke.mjs"), "utf8");
// 注释里会提到这些词（本文件开头就在解释为什么不能有 POST），只扫代码部分
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => {
        const at = line.indexOf("//");
        return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

test("只读：脚本里不许出现任何写方法", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        // fetch 的 method 只可能是 "GET" / "HEAD" 这两个字符串字面量
        assert.ok(
            !new RegExp(`method:\\s*"${method}"`).test(code),
            `prod-smoke 是只读探针，不能有 method: "${method}"`
        );
        assert.ok(
            !new RegExp(`method:\\s*'${method}'`).test(code),
            `prod-smoke 是只读探针，不能有 method: '${method}'`
        );
    }
});

test("无凭据：不许出现 Authorization / Cookie / 口令类环境变量", () => {
    for (const needle of [
        "Authorization",
        "authorization",
        "Cookie",
        "cookie:",
        "AUTH_PASSWORD",
        "AUTH_SECRET",
        "Bearer",
        "secrets.",
    ]) {
        assert.ok(
            !code.includes(needle),
            `prod-smoke 不该碰任何凭据（命中 "${needle}"）—— 它打的是别人的线上实例，且设计为不需要登录`
        );
    }
});

test("每次请求都带超时：线上卡住时定时任务不能挂死", () => {
    assert.ok(
        code.includes("AbortSignal.timeout"),
        "fetch 必须带 AbortSignal.timeout，否则线上不响应会把 runner 挂到超时"
    );
});

test("退出码语义：不可达与断言失败要分开（--tolerate-down 只影响前者）", () => {
    assert.ok(code.includes("TOLERATE_DOWN"), "必须支持 --tolerate-down（定时任务要能容忍机房断网）");
    // 断言失败那条路径必须是硬退出 1，不能被 tolerate-down 一并吞掉
    const tail = code.slice(code.indexOf("const failed ="));
    assert.ok(
        /process\.exit\(failed\.length \? 1 : 0\)/.test(tail),
        "汇总后必须按失败数退出 1（--tolerate-down 只赦免「连不上」，不赦免断言失败）"
    );
});
