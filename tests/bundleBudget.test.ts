// tests/bundleBudget.test.ts
// 首屏包（index chunk）的体积预算。
//
// 为什么需要它：把弹窗改成 lazy 那次把首屏从 264 KB 压到 231 KB，再拆出 LoginForm
// 之后是 222.61 KB（gzip 75.65）。但这类成果**没有任何东西在守着** ——
// 下次有人为了省事把一个大组件改回同步 import，包会悄悄涨回去，
// 而且涨的那一刻 CI 是绿的，只有用户觉得首屏变慢了。
//
// 所以这里钉一个上限：超了就红，逼着改动的人要么继续拆，要么明确上调预算并说明理由。
// 没构建过（dist 不存在）时跳过 —— 单测不该要求先跑一次 build。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const BUDGET_KB = 235;
/** 基线：LoginForm 改 lazy 之后测得的 222.61 KB（见 git log） */
const BASELINE_KB = 222.61;

function indexChunk(): { name: string; kb: number } | null {
    const assets = join(findProjectDir(), "dist", "client", "assets");
    let files: string[];
    try {
        files = readdirSync(assets);
    } catch {
        return null;
    }
    const hit = files.find(f => /^index-.*\.js$/.test(f));
    if (!hit) return null;
    const bytes = readFileSync(join(assets, hit)).length;
    return { name: hit, kb: bytes / 1024 };
}

test("首屏包（index chunk）不超过体积预算", t => {
    const chunk = indexChunk();
    if (!chunk) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    assert.ok(
        chunk.kb <= BUDGET_KB,
        `首屏包 ${chunk.name} 现在 ${chunk.kb.toFixed(2)} KB，超过预算 ${BUDGET_KB} KB` +
            `（基线 ${BASELINE_KB} KB）。多半是有组件被改回了同步 import ——` +
            `先确认是不是该走 lazy；确实要上调预算的话，请连同理由一起改这条用例。`
    );
});

test("首屏包体积预算本身要留有余量（基线不能贴着上限）", () => {
    // 预算贴着基线写，等于每次微调构建都会红。留至少 5% 的余量，
    // 红的才是「真的有人在往首屏里塞东西」而不是「MUI 升了个小版本」。
    const headroom = (BUDGET_KB - BASELINE_KB) / BASELINE_KB;
    assert.ok(headroom >= 0.05, `预算余量只有 ${(headroom * 100).toFixed(1)}%，太紧了`);
});
