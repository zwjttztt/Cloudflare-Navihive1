// tests/eslintReactHooks.test.ts
// 档 1 升到 eslint 10 / react-hooks 7 时定下的一条配置决策，值得钉住。
//
// react-hooks v7 的 `configs.recommended.rules` 里塞进了整套「面向 React Compiler」的
// 规则（set-state-in-effect / refs / immutability / globals …）。本项目没开 compiler，
// 全开会一次性冒出 60+ 条既改不动、改了也不改变运行行为的报错，所以 eslint.config.js
// 写成了「白名单以外的全关」。
//
// 风险在反方向：哪天有人图省事把 `...reactHooks.configs.recommended.rules` 直接展开
// 回 rules 里，上面这套说明就白写了，而且 CI 会一次红 60 条、看着像「升级踩雷」而不是
// 「配置被改回去」。这里把白名单和「不许直接展开」两件事钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const config = readProjectFile("eslint.config.js");

test("react-hooks 只留白名单里的两条，其余一律 off", () => {
    const kept = config.match(/KEPT_REACT_HOOKS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(kept, "eslint.config.js 里找不到 KEPT_REACT_HOOKS 白名单");
    const rules = [...kept[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(
        rules.sort(),
        ["react-hooks/exhaustive-deps", "react-hooks/rules-of-hooks"],
        "白名单变了就说明 lint 契约变了，先看清楚再改这条用例"
    );
    // 白名单以外的必须被置成 off，而不是漏掉（漏掉 = 沿用插件默认的 error）
    assert.match(
        config,
        /KEPT_REACT_HOOKS\.has\(name\)\s*\?\s*value\s*:\s*'off'/,
        "白名单以外的规则必须显式置为 'off'"
    );
});

test("不要把 reactHooks.configs.recommended.rules 直接展开进 rules", () => {
    assert.doesNotMatch(
        config,
        /\.\.\.reactHooks\.configs\.recommended\.rules/,
        "直接展开会把整套 React Compiler 规则一起打开（60+ 条），见本文件顶部说明"
    );
});
