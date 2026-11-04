// tests/bundleBudgetGate.test.ts
// R15 的守卫：体积门禁不许在「量不到」的时候报绿。
//
// 背景（2026-11-04 审查发现）：tests/bundleBudget.test.ts 里原来有两处静默降级 ——
//   · dist/client/index.html 读不到 → `return null`，后面所有断言全跳过；
//   · index.html 里引用的资产读不到 → `catch { continue; }`，少算几个文件照样算总和。
// 于是「dist 根本没构建」和「dist 构建断了一半」都被报成绿。
//
// 修法是把判据抽成纯函数（script/bundleBudgetGate.mjs），IO 由调用方注入。
// 这样 strict 的失败路径可以在**不真删 dist** 的前提下被用例走一遍 ——
// 「删掉 dist 再跑一遍看红不红」这种验证方式在 CI / 别人机器上都做不了，
// 而做不了的守卫等于没写。
//
// 逻辑与注释以 script/bundleBudgetGate.mjs 为准。

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    isStrictMode,
    strictModeSource,
    assetRefsFromHtml,
    measureFirstScreen,
    firstScreenProblem,
    decideBudgetGate,
    STRICT_ENV_FLAG,
    STRICT_LIFECYCLE_EVENT,
    type FirstScreenMeasure,
    type MeasureFirstScreenIo,
} from "../script/bundleBudgetGate.mjs";

// ---------------- 假产物：形状对齐真实的 vite 输出 ----------------
//
// 真产物长这样（本轮实测 6 个文件 / 858.5 KB）：
//   <script type="module" crossorigin src="/assets/index-xxxx.js">
//   <link rel="modulepreload" href="/assets/vendor-xxxx.js">
//   <link rel="stylesheet" href="/assets/index-xxxx.css">
// 三种引用共用 `src=|href=".../assets/NAME"` 这同一个形状，所以解析器只认一种形状。
const HTML_OK = [
    "<!doctype html>",
    "<html><head>",
    '<link rel="stylesheet" href="/assets/index-aaaa.css">',
    '<link rel="modulepreload" href="/assets/vendor-bbbb.js">',
    '<link rel="modulepreload" href="/assets/react-cccc.js">',
    '<script type="module" crossorigin src="/assets/index-aaaa.js"></script>',
    "</head><body><div id=\"root\"></div></body></html>",
].join("\n");

const SIZES: Record<string, number> = {
    "index-aaaa.js": 200 * 1024,
    "index-aaaa.css": 20 * 1024,
    "vendor-bbbb.js": 300 * 1024,
    "react-cccc.js": 150 * 1024,
};

/**
 * 造一个假 fs。
 *
 * gzip 固定返回 0：这些用例断言的是「有没有量到」「该不该红」，不是压缩比 ——
 * 真去压 670 KB 只会让用例变慢，还引入一个与判据无关的变量。
 */
function fakeIo(html: string | null, present: Record<string, number> = SIZES): MeasureFirstScreenIo {
    return {
        html,
        readAsset: (name: string) => (name in present ? Buffer.alloc(present[name]) : null),
        gzip: () => 0,
    };
}

// ---------------- isStrictMode：四种组合 ----------------

test("isStrictMode：（1）只有 NAVIHIVE_BUDGET_STRICT=1 → strict", () => {
    const env = { [STRICT_ENV_FLAG]: "1" };
    assert.equal(isStrictMode(env), true);
    assert.equal(strictModeSource(env), `${STRICT_ENV_FLAG}=1`);
});

test("isStrictMode：（2）只有 npm_lifecycle_event=check:budget → strict", () => {
    // npm run check:budget 时 npm 会自己设这一条；unit-tests.mjs spawn node:test
    // 时没有传 env，子进程继承父进程环境，所以能传到用例里。
    const env = { npm_lifecycle_event: STRICT_LIFECYCLE_EVENT };
    assert.equal(isStrictMode(env), true);
    assert.equal(strictModeSource(env), `npm_lifecycle_event=${STRICT_LIFECYCLE_EVENT}`);
});

test("isStrictMode：（3）两者都有 → strict（且优先报告显式那条）", () => {
    const env = { [STRICT_ENV_FLAG]: "1", npm_lifecycle_event: STRICT_LIFECYCLE_EVENT };
    assert.equal(isStrictMode(env), true);
    assert.equal(
        strictModeSource(env),
        `${STRICT_ENV_FLAG}=1`,
        "显式置位比 lifecycle 更该被报告 —— 它是人主动选的"
    );
});

test("isStrictMode：（4）两者都没有 → 非 strict（保持原有可跳过行为）", () => {
    assert.equal(isStrictMode({}), false);
    assert.equal(strictModeSource({}), null);
    assert.equal(isStrictMode({ npm_lifecycle_event: "test" }), false);
    assert.equal(isStrictMode(undefined), false);
    assert.equal(isStrictMode(null), false);
});

test("isStrictMode：只有字面量 \"1\" 才算打开（0 / true / 空串都不算）", () => {
    // 「随便写点东西就打开」会让 CI 与本地跑的不是同一套判据，
    // 而这两套的差别恰恰是「红 / 绿」。
    for (const value of ["0", "", "true", "yes", " 1"]) {
        assert.equal(
            isStrictMode({ [STRICT_ENV_FLAG]: value }),
            false,
            `${STRICT_ENV_FLAG}=${JSON.stringify(value)} 不该算 strict`
        );
    }
});

// ---------------- 解析 index.html 的资产引用 ----------------

test("assetRefsFromHtml：src 与 href 都认，且去重保序", () => {
    const refs = assetRefsFromHtml(HTML_OK);
    assert.deepEqual(refs, [
        "index-aaaa.css",
        "vendor-bbbb.js",
        "react-cccc.js",
        "index-aaaa.js",
    ]);
});

test("assetRefsFromHtml：重复引用只算一次（两次引用不等于两个文件）", () => {
    const html = '<script src="/assets/a.js"></script><link rel="modulepreload" href="/assets/a.js">';
    assert.deepEqual(assetRefsFromHtml(html), ["a.js"]);
});

test("assetRefsFromHtml：非 /assets/ 的绝对路径与相对路径不参与首屏统计", () => {
    const html = '<script src="/other/a.js"></script><script src="./b.js"></script>';
    assert.deepEqual(assetRefsFromHtml(html), []);
});

test("assetRefsFromHtml：null / undefined 返回空数组，不抛", () => {
    assert.deepEqual(assetRefsFromHtml(null), []);
    assert.deepEqual(assetRefsFromHtml(undefined), []);
});

// ---------------- measureFirstScreen：注入假 fs ----------------

test("measureFirstScreen：产物完整时把 4 个文件全部加起来", () => {
    const measure = measureFirstScreen(fakeIo(HTML_OK));
    assert.equal(measure.htmlMissing, false);
    assert.equal(measure.refs.length, 4);
    assert.equal(measure.files.length, 4);
    assert.deepEqual(measure.missingAssets, []);
    assert.ok(
        Math.abs(measure.rawKb - 670) < 0.001,
        `rawKb = ${measure.rawKb}，应为 (200+20+300+150) KB = 670`
    );
});

test("measureFirstScreen：HTML 缺失 → htmlMissing=true，且不编造数字", () => {
    const measure = measureFirstScreen(fakeIo(null));
    assert.equal(measure.htmlMissing, true);
    assert.deepEqual(measure.refs, []);
    assert.deepEqual(measure.files, []);
    assert.equal(measure.rawKb, 0);
    assert.equal(measure.gzipKb, 0);
});

test("measureFirstScreen：引用的资产读不到时记进 missingAssets，**不是** continue 掉", () => {
    // 这就是原来的 `catch { continue; }`：少算一个 300 KB 的 vendor 块，
    // 总和自然变小，门禁反而更容易绿。
    const broken = { ...SIZES };
    delete broken["vendor-bbbb.js"];
    const measure = measureFirstScreen(fakeIo(HTML_OK, broken));
    assert.deepEqual(measure.missingAssets, ["vendor-bbbb.js"]);
    assert.equal(measure.files.length, 3);
    assert.ok(Math.abs(measure.rawKb - 370) < 0.001, `rawKb = ${measure.rawKb}，应为 370`);
});

test("measureFirstScreen：readAsset 抛错也算缺失（读不了 ≠ 零字节）", () => {
    const measure = measureFirstScreen({
        html: HTML_OK,
        readAsset: () => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        gzip: () => 0,
    });
    assert.deepEqual(measure.missingAssets, measure.refs);
    assert.equal(measure.files.length, 0);
    assert.equal(measure.rawKb, 0);
});

test("measureFirstScreen：注入的 gzip 决定 gzipKb（真 zlib 只在默认分支用）", () => {
    const measure = measureFirstScreen({
        html: HTML_OK,
        readAsset: name => (name in SIZES ? Buffer.alloc(SIZES[name]) : null),
        gzip: buf => Math.floor(buf.length / 4),
    });
    assert.ok(Math.abs(measure.gzipKb - 670 / 4) < 0.001, `gzipKb = ${measure.gzipKb}`);
});

test("measureFirstScreen：不注入 gzip 时用真 zlib（不会崩、且小于原始体积）", () => {
    const html = '<script src="/assets/a.js"></script>';
    // 可压缩的一大段重复字节
    const payload = Buffer.from("0".repeat(64 * 1024));
    const measure = measureFirstScreen({ html, readAsset: () => payload });
    assert.equal(measure.files.length, 1);
    assert.ok(measure.gzipKb > 0 && measure.gzipKb < measure.rawKb, `gzipKb = ${measure.gzipKb}`);
    // 顺带证明默认压缩确实走 zlib（与这里手算的一致）
    assert.equal(
        Math.round(measure.gzipKb * 1024),
        gzipSync(payload, { level: 9 }).length,
        "默认 gzip 必须与 zlib level 9 一致"
    );
});

// ---------------- firstScreenProblem：把「量不到」说清楚 ----------------

test("firstScreenProblem：产物完整 → null（没什么可抱怨的）", () => {
    assert.equal(firstScreenProblem(measureFirstScreen(fakeIo(HTML_OK))), null);
});

test("firstScreenProblem：HTML 缺失的话必须点名「先 npm run build」", () => {
    const problem = firstScreenProblem(measureFirstScreen(fakeIo(null)));
    assert.ok(problem, "缺 HTML 时不能返回 null");
    assert.match(problem, /npm run build/, `提示里必须给下一步动作：${problem}`);
});

test("firstScreenProblem：分析出 0 个 asset 引用 = 统计口径坏了", () => {
    const problem = firstScreenProblem(measureFirstScreen(fakeIo("<html><body></body></html>")));
    assert.ok(problem);
    assert.match(problem, /统计口径|没解析到/, `提示里必须说清是口径问题：${problem}`);
});

test("firstScreenProblem：资产读不到时列出全部缺失路径 + 下一步动作", () => {
    const problem = firstScreenProblem(measureFirstScreen(fakeIo(HTML_OK, {})));
    assert.ok(problem);
    for (const name of Object.keys(SIZES)) {
        assert.ok(problem.includes(name), `缺失清单里必须有 ${name}：${problem}`);
    }
    assert.match(problem, /npm run build/);
});

test("firstScreenProblem：测量对象异常时也要给出一句话，而不是抛", () => {
    for (const bad of [null, undefined, {} as unknown as FirstScreenMeasure]) {
        const problem = firstScreenProblem(bad as FirstScreenMeasure);
        assert.ok(typeof problem === "string" && problem.length > 0, `bad=${String(bad)} 应给出原因`);
    }
});

// ---------------- decideBudgetGate：strict 分支的失败路径确实存在 ----------------
//
// 这一组是本文件的重点：证明「strict 下量不到 → fail」这条路径真的能被走到，
// 而且**不依赖真的删掉 dist**。

test("decideBudgetGate：产物完整时无论 strict 与否都是 measure", () => {
    const measure = measureFirstScreen(fakeIo(HTML_OK));
    for (const env of [
        {},
        { [STRICT_ENV_FLAG]: "1" },
        { npm_lifecycle_event: STRICT_LIFECYCLE_EVENT },
    ]) {
        const verdict = decideBudgetGate(measure, env);
        assert.equal(verdict.action, "measure", `env=${JSON.stringify(env)}`);
        assert.equal(verdict.reason, null);
    }
});

test("decideBudgetGate：非 strict 下量不到 → skip（保留原有可跳过行为，但要带原因）", () => {
    const verdict = decideBudgetGate(measureFirstScreen(fakeIo(null)), {});
    assert.equal(verdict.action, "skip");
    assert.equal(verdict.strict, false);
    assert.ok(verdict.reason && verdict.reason.length > 0, "跳过必须带原因，不许静默");
});

test("decideBudgetGate：NAVIHIVE_BUDGET_STRICT=1 + 缺 HTML → fail", () => {
    const verdict = decideBudgetGate(measureFirstScreen(fakeIo(null)), { [STRICT_ENV_FLAG]: "1" });
    assert.equal(verdict.action, "fail");
    assert.equal(verdict.strictSource, `${STRICT_ENV_FLAG}=1`);
    assert.match(verdict.reason ?? "", /npm run build/);
});

test("decideBudgetGate：npm_lifecycle_event=check:budget + 缺 HTML → fail", () => {
    // 这一条就是 `npm run check:budget` 的真实路径：npm 设 lifecycle，
    // 运行器 spawn node:test 时继承环境，用例里 isStrictMode 读到它。
    const verdict = decideBudgetGate(measureFirstScreen(fakeIo(null)), {
        npm_lifecycle_event: STRICT_LIFECYCLE_EVENT,
    });
    assert.equal(verdict.action, "fail");
    assert.match(verdict.reason ?? "", /npm run build/);
});

test("decideBudgetGate：strict + 资产断裂 → fail，且缺失路径全部列出", () => {
    const broken = { ...SIZES };
    delete broken["index-aaaa.js"];
    delete broken["react-cccc.js"];
    const verdict = decideBudgetGate(measureFirstScreen(fakeIo(HTML_OK, broken)), {
        [STRICT_ENV_FLAG]: "1",
    });
    assert.equal(verdict.action, "fail");
    assert.ok((verdict.reason ?? "").includes("index-aaaa.js"), verdict.reason ?? "");
    assert.ok((verdict.reason ?? "").includes("react-cccc.js"), verdict.reason ?? "");
});

test("decideBudgetGate：每一种「量不到」在 strict 下都必须 fail（不许有漏网的分支）", () => {
    // 逐个构造：只要 firstScreenProblem 认为有问题，strict 就必须红。
    // 这条用例的价值在于它是**穷举式**的 —— 以后往 firstScreenProblem 里加一条新判据，
    // 忘了处理 strict 的分支会自动在这里露出来。
    const brokenInputs: { label: string; io: MeasureFirstScreenIo }[] = [
        { label: "缺 HTML", io: fakeIo(null) },
        { label: "零 asset 引用", io: fakeIo("<html><body></body></html>") },
        { label: "全部资产缺失", io: fakeIo(HTML_OK, {}) },
        { label: "部分资产缺失", io: fakeIo(HTML_OK, { "index-aaaa.js": 1024 }) },
    ];
    for (const { label, io } of brokenInputs) {
        const measure = measureFirstScreen(io);
        assert.notEqual(firstScreenProblem(measure), null, `${label}：应当被认定为「量不到」`);
        assert.equal(decideBudgetGate(measure, {}).action, "skip", `${label}：非 strict 应跳过`);
        assert.equal(
            decideBudgetGate(measure, { [STRICT_ENV_FLAG]: "1" }).action,
            "fail",
            `${label}：strict 必须失败`
        );
    }
});

// ---------------- 和真实 dist 的一致性（用真 fs，不注入假数据） ----------------
//
// 这几条不判断「体积合不合预算」（那是 tests/bundleBudget.test.ts 的事），只确认
// 「假 io 造出来的形状」与真实产物是一致的 —— 否则上面所有注入式断言都会变成
// 「测了一个不存在的形状」。

test("真产物（如果存在）解析出的引用全部能读到文件", () => {
    // 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
    let dir = dirname(fileURLToPath(import.meta.url));
    let found: string | null = null;
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            found = dir;
            break;
        } catch {
            dir = dirname(dir);
        }
    }
    assert.ok(found, "找不到项目根目录");
    const root: string = found;

    const htmlPath = join(root, "dist", "client", "index.html");
    if (!existsSync(htmlPath)) {
        // 这里**允许**在没有产物时跳过：本文件守的是「判据函数」，不是「必须构建过」。
        // 「必须构建过」那条由 tests/bundleBudget.test.ts 在 strict 下守。
        // 但跳过也要留一句话，不能静默。
        console.log("  ⏭  跳过：没有 dist/client/index.html（本用例只是形状一致性核对）");
        return;
    }
    const measure = measureFirstScreen({
        html: readFileSync(htmlPath, "utf-8"),
        readAsset: name => {
            const target = join(root, "dist", "client", "assets", name);
            return existsSync(target) ? readFileSync(target) : null;
        },
    });
    assert.equal(firstScreenProblem(measure), null, "真实产物不该被判成「量不到」");
    assert.ok(measure.files.length >= 4, `真实首屏文件数异常偏少：${measure.files.length}`);
});
