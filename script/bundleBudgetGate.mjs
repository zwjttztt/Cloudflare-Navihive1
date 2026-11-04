// script/bundleBudgetGate.mjs
// 体积门禁的**判据**与**测量**：只回答事实与「该不该红」，不打印、不 t.skip。
//
// 为什么抽出来（2026-11-04，审查项 R15）：
//   原来的 tests/bundleBudget.test.ts 里 `firstScreen()` 有两处静默降级 ——
//     · dist/client/index.html 读不到 → `return null`，后面所有断言直接跳过；
//     · index.html 里引用的资产读不到 → `catch { continue; }`，少算几个文件照样算总和。
//   于是 dist 根本没构建、或者构建产物断了一半的时候，门禁**报绿**。
//   这不是「单测不该要求先 build」的问题，而是「门禁在最该红的时候是绿的」。
//
// 现在把判据写成纯函数放在这里，由 tests/bundleBudgetGate.test.ts 用注入的假 fs 钉住；
// tests/bundleBudget.test.ts 只负责把真 fs 注进来，并按 strict / 非 strict 决定
// 「跳过还是失败」。
//
// strict 的判定（见 isStrictMode）：
//   · `NAVIHIVE_BUDGET_STRICT=1`  —— 显式打开，CI 或本地手动都能用；
//   · `npm_lifecycle_event=check:budget` —— `npm run check:budget` 时 npm 自己会设。
//     script/unit-tests.mjs 用 spawn 起 node:test 子进程时**没有传 env**，
//     子进程直接继承父进程的环境，所以这条能传到用例里。
//   两者都没有（普通 `npm test`）时保持原来的可跳过行为 —— 单测不该强迫先 build 一遍，
//   但跳过必须打印原因，不能静默。

import { gzipSync } from "node:zlib";

/** 显式打开 strict 的环境变量名 */
export const STRICT_ENV_FLAG = "NAVIHIVE_BUDGET_STRICT";
/** npm 跑 `check:budget` 这个 script 时自动注入的 lifecycle 名 */
export const STRICT_LIFECYCLE_EVENT = "check:budget";

/**
 * 问「strict 是被谁打开的」，好把原因写进失败信息里。
 *
 * 返回 `null` 表示非 strict。返回字符串是有意为之：门禁红了的时候，
 * 第一件事就是确认「这个红该不该当真」，而那句话必须自己说清是谁打开的 strict。
 *
 * @param {Record<string, string | undefined> | undefined | null} env
 * @returns {string | null}
 */
export function strictModeSource(env) {
    const e = env ?? {};
    if (String(e[STRICT_ENV_FLAG] ?? "") === "1") return `${STRICT_ENV_FLAG}=1`;
    if (String(e.npm_lifecycle_event ?? "") === STRICT_LIFECYCLE_EVENT) {
        return `npm_lifecycle_event=${STRICT_LIFECYCLE_EVENT}`;
    }
    return null;
}

/**
 * 当前是否 strict 模式。
 *
 * @param {Record<string, string | undefined> | undefined | null} env
 * @returns {boolean}
 */
export function isStrictMode(env) {
    return strictModeSource(env) !== null;
}

/** index.html 里 src / href 指向 /assets/ 的引用（script、modulepreload、stylesheet 共用同一形状） */
const ASSET_REF_RE = /(?:src|href)="\/assets\/([^"]+)"/g;

/**
 * 从 index.html 文本里取出首屏必下的资产名（去重，保持出现顺序）。
 *
 * @param {string | null | undefined} html
 * @returns {string[]}
 */
export function assetRefsFromHtml(html) {
    if (typeof html !== "string") return [];
    const names = [...html.matchAll(ASSET_REF_RE)].map(match => match[1]);
    return [...new Set(names)];
}

/**
 * 量一次首屏。
 *
 * 所有 IO 都由调用方注入（`html` 是读到的文本或 null，`readAsset` 按名字返回字节或 null），
 * 于是 strict 的失败路径可以在**不真删 dist** 的前提下被用例走到。
 *
 * 这里刻意**不**吞掉缺资产：读不到的引用全部收进 `missingAssets`，由 firstScreenProblem
 * 决定「这是不能量」还是「只是少一个文件」。以前是 `catch { continue; }`，
 * 少算一个 400 KB 的块和少算一个 2 KB 的块长得一模一样。
 *
 * @param {{
 *   html: string | null | undefined,
 *   readAsset: (name: string) => Buffer | Uint8Array | null | undefined,
 *   gzip?: (buf: Buffer) => number,
 * }} io
 * @returns {{
 *   htmlMissing: boolean,
 *   refs: string[],
 *   files: { name: string, rawKb: number, gzipKb: number }[],
 *   missingAssets: string[],
 *   rawKb: number,
 *   gzipKb: number,
 * }}
 */
export function measureFirstScreen(io) {
    const html = io?.html ?? null;
    const readAsset = typeof io?.readAsset === "function" ? io.readAsset : () => null;
    // gzip 默认用 zlib 的真实压缩；用例里可以换成一个固定倍率，免得为了断言去压几 MB
    const gz = typeof io?.gzip === "function" ? io.gzip : buf => gzipSync(buf, { level: 9 }).length;

    const htmlMissing = typeof html !== "string";
    const refs = assetRefsFromHtml(htmlMissing ? "" : html);
    const files = [];
    const missingAssets = [];
    let raw = 0;
    let gzip = 0;

    for (const name of refs) {
        let bytes;
        try {
            bytes = readAsset(name);
        } catch {
            bytes = null;
        }
        if (!bytes || typeof bytes.length !== "number") {
            missingAssets.push(name);
            continue;
        }
        const gzBytes = gz(bytes);
        files.push({ name, rawKb: bytes.length / 1024, gzipKb: gzBytes / 1024 });
        raw += bytes.length;
        gzip += gzBytes;
    }

    return { htmlMissing, refs, files, missingAssets, rawKb: raw / 1024, gzipKb: gzip / 1024 };
}

/**
 * 把一次测量翻译成「量不了，为什么」，量得全就返回 null。
 *
 * 返回的每一句都要能直接放进入口人的下一步动作里 —— 尤其是「先 npm run build」，
 * 因为 dist 不存在时看到「体积门禁失败」的人第一反应会是「我改代码改坏了」。
 *
 * @param {ReturnType<typeof measureFirstScreen>} measure
 * @returns {string | null}
 */
export function firstScreenProblem(measure) {
    // 先校验形状再取字段：这个函数的调用方在 strict 下会把返回值直接当失败原因用，
    // 它自己要是在这儿抛 TypeError，人看到的就是一句「Cannot read properties of undefined」，
    // 而不是「该去 build 了」。
    if (!measure || typeof measure !== "object") {
        return "量不出首屏（measureFirstScreen 返回值为空或不是对象）";
    }
    const { htmlMissing, refs, files, missingAssets } = measure;
    if (typeof htmlMissing !== "boolean" || !Array.isArray(refs) || !Array.isArray(files) ||
        !Array.isArray(missingAssets)) {
        return "量不出首屏（measureFirstScreen 返回的字段形状不对，判据无法使用）";
    }
    if (htmlMissing) {
        return "dist/client/index.html 不存在 —— 先 npm run build（体积门禁要有构建产物才能量）";
    }
    if (refs.length === 0) {
        return (
            "dist/client/index.html 里没解析到任何 /assets/ 引用 —— 统计口径坏了：" +
            "先确认构建产物结构没变（vite.config.ts 的 build.assetsDir / base）"
        );
    }
    if (missingAssets.length > 0) {
        return (
            `index.html 引用的 ${missingAssets.length} 个资产在 dist/client/assets 下读不到：` +
            `${missingAssets.join("、")} —— dist 不完整，先 npm run build 重建一份完整产物`
        );
    }
    if (files.length === 0) {
        return "首屏文件清单为空 —— 一个字节都没量到，先 npm run build";
    }
    return null;
}

/**
 * 体积门禁的唯一判定入口：这次该「用量出来的数字断言」、「跳过」还是「直接失败」。
 *
 * 三种 action：
 *   · `"measure"` —— 量全了，调用方拿数字去比预算；
 *   · `"fail"`    —— strict 下量不到：**不许跳过**，直接判红；
 *   · `"skip"`    —— 非 strict 下量不到：可以跳过，但调用方必须把 reason 打出来。
 *
 * 只有 strict 这一条判据决定 fail / skip，measure 只决定「量没量到」——
 * 两者刻意分开，免得以后有人为了「让本地跑得顺」去改测量代码把失败路径也弄没了。
 *
 * @param {FirstScreenMeasure} measure
 * @param {Record<string, string | undefined> | undefined | null} env
 * @returns {{
 *   action: "measure" | "fail" | "skip",
 *   reason: string | null,
 *   strict: boolean,
 *   strictSource: string | null,
 * }}
 */
export function decideBudgetGate(measure, env) {
    const strictSource = strictModeSource(env);
    const strict = strictSource !== null;
    const problem = firstScreenProblem(measure);
    if (problem === null) return { action: "measure", reason: null, strict, strictSource };
    return { action: strict ? "fail" : "skip", reason: problem, strict, strictSource };
}
