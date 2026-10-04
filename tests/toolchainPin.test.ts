// tests/toolchainPin.test.ts
// 工具链版本的两条约束。都不是「为了新而新」，而是防止**悄悄跑偏**：
//
// 1. @types/node 的主版本必须等于 CI / 运行时那个 Node 的主版本。
//    试过 @types/node@26（2026-10-04）：类型检查只冒出 4 条错误，全在
//    `assert.equal(a, b, obj.message)` 上 —— 因为 26 的 overload 不再接受
//    `string | undefined` 作为 message。修起来是 4 个 `?? ""`，成本很小；
//    但真正的代价是：类型会开始描述 Node 26 才有的 API，而我们跑在 Node 22 上，
//    于是「能编译通过、运行才炸」的口子被打开了。等 CI 换 Node 再一起升。
//
// 2. 装上的 typescript 必须落在 typescript-eslint 声明的 peer 区间内。
//    现在这个区间是 `>=4.8.4 <6.1.0`，也就是说 **TypeScript 7 还进不来**：
//      - typescript-eslint 8.71.0 **以及** canary 8.71.1-alpha.8 都还是 <6.1.0；
//      - 而且 TS 7.0 本身不带 compiler API（types-eslint 的依赖），要等 7.1。
//    两条都解除之前别升；升的时候用 --legacy-peer-deps 绕过只是把红灯藏起来，
//    type-aware 的 lint 规则会静默失效 —— 所以这里钉一道，硬装也能被抓住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
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

/** 实际装上（不是 package.json 里写的范围）的版本 */
function installedVersion(pkg: string): string {
    return JSON.parse(readProjectFile(`node_modules/${pkg}/package.json`)).version as string;
}

const cmp = (a: string, b: string): number => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 3; i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
};

/**
 * 判一个版本是否满足 npm 的 semver 区间。
 * 只处理本项目会遇到的形态：`>=x.y.z <a.b.c`、`^x.y.z`、以及 `||` 分隔的或。
 * 不引 semver 依赖 —— 为了两行判断拉一个包不划算。
 */
function satisfies(version: string, range: string): boolean {
    return range.split("||").some(part =>
        part
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .every(token => {
                const m = token.match(/^(>=|<=|>|<|=|\^|~)?([\d.]+)$/);
                if (!m) return true; // 认不出来的算子就放过，别让守卫自己变成红灯
                const [, op = "=", bound] = m;
                const d = cmp(version, bound);
                switch (op) {
                    case ">=":
                        return d >= 0;
                    case ">":
                        return d > 0;
                    case "<=":
                        return d <= 0;
                    case "<":
                        return d < 0;
                    case "^":
                        return d >= 0 && version.split(".")[0] === bound.split(".")[0];
                    case "~":
                        return (
                            d >= 0 &&
                            version.split(".").slice(0, 2).join(".") ===
                                bound.split(".").slice(0, 2).join(".")
                        );
                    default:
                        return d === 0;
                }
            })
    );
}

test("@types/node 的主版本要跟 CI 上跑的 Node 主版本一致", () => {
    const ci = readProjectFile(".github/workflows/ci.yml");
    const declared = ci.match(/node-version:\s*["']?(\d+)/)?.[1];
    assert.ok(declared, "CI 里应写明 node-version");

    const types = installedVersion("@types/node").split(".")[0];
    assert.equal(
        types,
        declared,
        `@types/node 装的是 ${installedVersion("@types/node")}，CI 跑的是 Node ${declared} —— ` +
            "类型比运行时新，就意味着「能编译通过但运行才炸」的口子被打开了"
    );
});

test("装上的 typescript 必须落在 typescript-eslint 的 peer 区间内（TS 7 还进不来）", () => {
    const peer = JSON.parse(readProjectFile("node_modules/typescript-eslint/package.json"))
        .peerDependencies?.typescript as string | undefined;
    assert.ok(peer, "typescript-eslint 应声明对 typescript 的 peer 范围");

    const ts = installedVersion("typescript");
    assert.ok(
        satisfies(ts, peer),
        `typescript ${ts} 不在 typescript-eslint 要求的 ${peer} 内 —— ` +
            "若是用 --legacy-peer-deps 硬装的，type-aware 的 lint 规则会静默失效"
    );

    // 顺便钉住这条判据本身：TS 7 现在的确落在区间外。
    // 少了这一句，「TS 7 还进不来」就只是注释里的一句话 —— 而它恰恰是最容易
    // 悄悄变成「其实已经能升了」的那类结论，没人会回头验证。
    assert.equal(
        satisfies("7.0.2", peer),
        false,
        `TS 7 应当还在 ${peer} 之外；若这条挂了，说明阻塞已解除，可以安排升级了`
    );
});
