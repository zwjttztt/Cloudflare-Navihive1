// script/bump-version-lib.d.mts
// bump-version-lib.mjs 的类型声明。
//
// 为什么需要它：lib 本身是 .mjs（node 直接跑、esbuild 按纯 JS 打包，里面不能写 TS
// 标注），但 tests/bumpVersion.test.ts 要 import 它的纯函数 —— 没有这份声明，
// strict 模式下测试会报 TS7016（implicit any）。逻辑与注释以 .mjs 为准。
export declare const THRESHOLDS: {
    patch: { files: number; lines: number };
    minor: { files: number; lines: number };
};

/** 改动规模 → 档位（patch=末位 / minor=中位 / major=首位） */
export declare function levelOf(files: number, lines: number): "patch" | "minor" | "major";

/** 按档位跳变语义版本；跳中位/首位时低位归零。格式不认识就抛 */
export declare function bumpSemver(version: string, level: "patch" | "minor" | "major"): string;

/** 只替换 package.json 文本里 version 一行的值，其余字节不动；没有 version 字段就抛 */
export declare function applyVersionToPackageJson(raw: string, next: string): string;
