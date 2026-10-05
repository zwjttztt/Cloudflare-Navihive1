// tests/bundleBudget.test.ts
// 首屏体积预算。**两个口径**（2026-10-05 起）：
//
//   1. 真实首屏总量 —— index.html 里 script + modulepreload + css 的**全部**兄弟文件
//      （914.1 KB / gzip 295.2 KB）。这才是用户实际下载的字节。
//   2. index chunk 单文件（历史口径，221.18 KB）—— 保留，因为它是有用的**子指标**：
//      业务代码进首屏时它会涨，而 MUI 升版本不会。
//
// 为什么要有第 1 个口径：原来只有第 2 个，而 Vite 会在 index.html 里给首屏静态依赖发
// `modulepreload` —— 那些是浏览器**必定要下**的。实测 index chunk 只占真实首屏的 23.7%，
// 另外 76.3%（约 697 KB）完全不受约束：谁把 MUI 涨一涨，CI 全绿，只有用户感觉首屏变慢。
// 更要紧的是，之前几次「首屏 264 → 221 KB」的成绩单其实只动了真实首屏的四分之一。
//
// 为什么需要这个守卫：把弹窗改成 lazy 那次把首屏从 264 KB 压到 231 KB，再拆出 LoginForm
// 之后是 222.61 KB（gzip 75.65）。但这类成果**没有任何东西在守着** ——
// 下次有人为了省事把一个大组件改回同步 import，包会悄悄涨回去，
// 而且涨的那一刻 CI 是绿的，只有用户觉得首屏变慢了。
//
// 所以这里钉上限：超了就红，逼着改动的人要么继续拆，要么明确上调预算并说明理由。
// 没构建过（dist 不存在）时跳过 —— 单测不该要求先跑一次 build。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

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
/**
 * 基线：每次真的把首屏压下来之后都要跟着更新，否则这条用例会一路放任包变大。
 * 222.61 KB —— LoginForm 改 lazy 之后（见 git log）
 * 221.18 KB —— 底部批量条 BulkActionBar 改 lazy 之后：它只有进入多选才出现，
 *              却一直躺在首屏里（6.46 KB）。首屏预算当时只剩 7 KB 余量，
 *              这是当时最干净的一刀（其余大块都是首屏真要用到的：
 *              App 26 KB、SiteCard 12 KB、client 10 KB、GroupCard 10 KB）。
 */
const BASELINE_KB = 221.18;

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

// ---------------------------------------------------------------------------
// 真实首屏：index.html 里 script + modulepreload + css 的**全部**兄弟文件
// ---------------------------------------------------------------------------
//
// 为什么必须加总（2026-10-05 修）：上面那条只盯 index chunk，而 Vite 会在 index.html 里
// 给首屏的静态依赖发 `modulepreload` —— 那些是浏览器**必定要下**的。
// 实测（main @ affaf2b）：
//   index 216.6 + mui 402.6 + react 202.0 + vendor 75.3 + runtime/css 17.6 = 914.1 KB
// 也就是说 index chunk 只占真实首屏的 23.7%，另外 76.3%（约 697 KB）当时完全不受约束 ——
// 谁把 MUI 涨一涨，CI 全绿，只有用户感觉首屏变慢。
// 更要紧的是：之前几次「首屏 264 → 221 KB」的成绩单，其实只动了真实首屏的四分之一。
//
// gzip 也要断言：用户实际下载的是压缩后的字节，那才是体感。
const FIRST_SCREEN_BUDGET_RAW_KB = 950;
const FIRST_SCREEN_BUDGET_GZIP_KB = 305;
/** 实测基线（main @ affaf2b，2026-10-05）：914.1 KB 原始 / 295.2 KB gzip */
const FIRST_SCREEN_BASELINE_RAW_KB = 914.1;
const FIRST_SCREEN_BASELINE_GZIP_KB = 295.2;

interface FirstScreen {
    files: { name: string; rawKb: number; gzipKb: number }[];
    rawKb: number;
    gzipKb: number;
}

function firstScreen(): FirstScreen | null {
    const dir = findProjectDir();
    let html: string;
    try {
        html = readFileSync(join(dir, "dist", "client", "index.html"), "utf-8");
    } catch {
        return null;
    }
    // script 的 src 与 modulepreload / stylesheet 的 href 都是首屏必下文件
    const names = [
        ...new Set(
            [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(m => m[1])
        ),
    ];
    const files: FirstScreen["files"] = [];
    let raw = 0;
    let gzip = 0;
    for (const name of names) {
        let bytes: Buffer;
        try {
            bytes = readFileSync(join(dir, "dist", "client", "assets", name));
        } catch {
            continue;
        }
        const gz = gzipSync(bytes, { level: 9 }).length;
        files.push({ name, rawKb: bytes.length / 1024, gzipKb: gz / 1024 });
        raw += bytes.length;
        gzip += gz;
    }
    return { files, rawKb: raw / 1024, gzipKb: gzip / 1024 };
}

test("真实首屏（index.html 的 script + modulepreload + css 合计）不超预算", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const detail = fs.files.map(f => `${f.name} ${f.rawKb.toFixed(1)}KB`).join("、");
    assert.ok(
        fs.rawKb <= FIRST_SCREEN_BUDGET_RAW_KB,
        `真实首屏 ${fs.rawKb.toFixed(1)} KB（gzip ${fs.gzipKb.toFixed(1)} KB），` +
            `超过预算 ${FIRST_SCREEN_BUDGET_RAW_KB} KB。构成：${detail}。` +
            `多半是某个只在触发后才出现的组件被改回了同步 import —— 先看它该不该走 lazy。`
    );
    assert.ok(
        fs.gzipKb <= FIRST_SCREEN_BUDGET_GZIP_KB,
        `真实首屏 gzip ${fs.gzipKb.toFixed(1)} KB，超过预算 ${FIRST_SCREEN_BUDGET_GZIP_KB} KB。` +
            `构成：${fs.files.map(f => `${f.name} ${f.gzipKb.toFixed(1)}KB`).join("、")}。` +
            `gzip 才是用户实际下载的字节，它比原始体积更能反映体感。`
    );
});

test("**当前**真实首屏也要留 5% 余量，不只是基线留", t => {
    // 和上面那条 index chunk 的余量用例同一个道理：基线只在真把首屏压下来时才更新，
    // 中间加进去的几 KB 它看不见。真正该红的是「现在离上限还有多远」。
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const rawHeadroom = (FIRST_SCREEN_BUDGET_RAW_KB - fs.rawKb) / fs.rawKb;
    const gzipHeadroom = (FIRST_SCREEN_BUDGET_GZIP_KB - fs.gzipKb) / fs.gzipKb;
    assert.ok(
        rawHeadroom >= 0.03 && gzipHeadroom >= 0.03,
        `当前真实首屏 ${fs.rawKb.toFixed(1)} KB / gzip ${fs.gzipKb.toFixed(1)} KB，` +
            `离预算只剩 ${(rawHeadroom * 100).toFixed(1)}% / ${(gzipHeadroom * 100).toFixed(1)}%` +
            `（各留至少 3%）。`
    );
});

test("首屏预算的基线常量要与实测相符（别让基线悄悄过期）", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    // 基线是「上次实测值」。它与真实值差太远，说明中间发生了大改动 ——
    // 确认是有意为之的话，连同理由一起更新这两个常量。
    const rawDrift = Math.abs(fs.rawKb - FIRST_SCREEN_BASELINE_RAW_KB) / FIRST_SCREEN_BASELINE_RAW_KB;
    const gzipDrift = Math.abs(fs.gzipKb - FIRST_SCREEN_BASELINE_GZIP_KB) / FIRST_SCREEN_BASELINE_GZIP_KB;
    assert.ok(
        rawDrift <= 0.05 && gzipDrift <= 0.05,
        `实测 ${fs.rawKb.toFixed(1)} KB / gzip ${fs.gzipKb.toFixed(1)} KB 与基线 ` +
            `${FIRST_SCREEN_BASELINE_RAW_KB} KB / ${FIRST_SCREEN_BASELINE_GZIP_KB} KB 分别差 ` +
            `${(rawDrift * 100).toFixed(1)}% / ${(gzipDrift * 100).toFixed(1)}%。` +
            `若是有意压下去的，把基线更新掉；若是涨上来的，先查是什么进了首屏。`
    );
});

test("首屏文件清单要能看出少了谁（防止统计口径悄悄失效）", t => {
    const fs = firstScreen();
    if (!fs || fs.files.length === 0) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const names = fs.files.map(f => f.name);
    const has = (re: RegExp) => names.some(n => re.test(n));
    // 这四条是当前首屏的固定组成（入口 / 三个 vendor 块 / 样式）。
    // 少任何一条都说明统计口径坏了 —— 而不是「优化掉了」，
    // 因为入口 HTML 必然引用它们。真要减首屏请先改这里的前提。
    assert.ok(has(/^index-.*\.js$/), "没统计到入口 chunk");
    assert.ok(has(/^react-.*\.js$/), "没统计到 react 块");
    assert.ok(has(/^mui-.*\.js$/), "没统计到 mui 块");
    assert.ok(has(/^vendor-.*\.js$/), "没统计到 vendor 块");
    assert.ok(has(/\.css$/), "没统计到样式文件");
});

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

test("**当前**首屏包也要留 5% 余量，不只是基线留", t => {
    // 上面那条是按基线算的。基线只在「真的把首屏压下来」时才更新，
    // 于是中间陆续加进去的几 KB 它一概看不见 —— 实测出现过基线余量 6.25%、
    // 实际余量只剩 4.24% 的情况，用例却是绿的。
    // 真正会红的应该是「现在这个包离上限还有多远」，所以这里按当前体积再算一遍。
    const chunk = indexChunk();
    if (!chunk) {
        t.skip("没有构建产物，跳过（先跑 npm run build 再跑单测）");
        return;
    }
    const actual = (BUDGET_KB - chunk.kb) / chunk.kb;
    assert.ok(
        actual >= 0.05,
        `当前首屏包 ${chunk.name} 是 ${chunk.kb.toFixed(2)} KB，离预算只剩 ` +
            `${(actual * 100).toFixed(1)}%（至少要 5%）。` +
            `要么继续把只在触发后才出现的组件改成 lazy，要么连同理由一起上调预算。`
    );
});
