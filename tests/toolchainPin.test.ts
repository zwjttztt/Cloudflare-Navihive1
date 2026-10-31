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
//    2026-10-31 再补一刀：原来这里是 `ci.match(/node-version:.../)`，只取**第一个**
//    命中。CI 拆成四个并行 job 之后 ci.yml 里有四处 node-version —— 现在四处都是 22，
//    结论仍然对；但哪天有人给某一个 job 单独降/升版本，这条守卫会**静默通过**：
//    它比的是第一个，剩下三个跑在别的 Node 上它根本看不见。守卫一旦会静默通过，
//    就等于没有 —— 所以改成「全部取出来，去重后必须只剩一个主版本」。
//    ⚠️ 判据是「彼此一致」，不是「都等于 22」：把当前值写死，将来真升版本时这条守卫
//    就从护栏变成绊脚石，而那时最省事的处理是把它删掉 —— 那才是最坏的结果。
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

/** 一次核对的全部结论：既能断言 ok，也能在失败时把原始值摊开给人看 */
export interface NodeVersionPin {
    /** CI 里收集到的全部值（按出现顺序，含重复）—— 失败时原样打印，一眼看出是哪个 job 走偏 */
    versions: string[];
    /** 去重后的原始值（`22` 与 `22.x` 会各占一项，保留它们本来的写法） */
    distinct: string[];
    /** 去重后的主版本（真正参与比对的东西） */
    majors: string[];
    /** 是否通过 */
    ok: boolean;
    /** 不通过时给人看的一段话（含收集到的值列表）；通过时是空串 */
    message: string;
}

/**
 * 取出 CI 配置里**全部** `node-version:` 的值（按出现顺序保留重复）。
 *
 * 只认「冒号后面紧跟一个值」的写法：注释里提到 node-version 但后面没跟值的不算。
 * 值一律按**原始字符串**留下（`22` / `22.x` / `lts/*` 都照抄），主版本由调用方再解析 ——
 * 在这里就归一化会把「有个 job 写成了 lts/*」这种走偏洗成看不见。
 */
export function nodeVersionsIn(ci: string): string[] {
    return [...ci.matchAll(/node-version:\s*["']?([^\s"'#]+)/g)].map(m => m[1] ?? "");
}

/**
 * 核对「CI 上跑的 Node 主版本」这件事本身。
 *
 * 三条都要成立，缺一条就算没通过：
 *   ① 至少声明了一处 —— 一处都取不到（写成 `lts/*`、或者键名改了）说明这条守卫
 *      根本够不着版本号，那它凭什么绿；
 *   ② 去重后的**主版本**只有一个 —— 四个 job 各有各的 node-version，不一致就意味着
 *      「有的检查跑在 20 上、有的跑在 22 上」，而 CI 只会告诉你整体绿了；
 *   ③ 这个主版本等于 @types/node 的主版本 —— 类型比运行时新，就打开了「能编译通过、
 *      运行才炸」的口子（见文件头）。
 *
 * 抽成纯函数（而不是把断言写在用例里）：上面两条用例要能直接喂**假文本**验证
 * 「全一致」与「有一处不一致」两个方向。判据本身若只被真 CI 文件验证过，那它跟
 * 「一句没人验证过的注释」没有区别。
 */
export function checkNodeVersionPin(ci: string, expectedMajor: string): NodeVersionPin {
    const versions = nodeVersionsIn(ci);
    const distinct = [...new Set(versions)];

    // 失败信息统一带上「收全了哪些值」：只报「不一致」的话，人还得回去自己数一遍。
    // majors 由调用方传（默认空）：解析都失败的那几条路径没有主版本可给，
    // 给个空数组比给半份更好 —— 免得看日志的人以为「只有这几个值」。
    const fail = (reason: string, majors: string[] = []): NodeVersionPin => ({
        versions,
        distinct,
        majors,
        ok: false,
        message:
            `${reason}\n` +
            `  CI 里收集到的 node-version：${versions.length > 0 ? versions.join(" / ") : "（一处都没有）"}` +
            `｜去重后：${distinct.length > 0 ? distinct.join(" / ") : "（无）"}\n` +
            `  @types/node 的主版本：${expectedMajor}`,
    });

    if (versions.length === 0) {
        return fail("CI 里一处 node-version 都没有 —— 取不到就没得比，不能当成通过");
    }

    const unparsable = distinct.filter(v => !/^\d+/.test(v));
    if (unparsable.length > 0) {
        return fail(`有 node-version 不是以数字开头（${unparsable.join(" / ")}），算不出主版本`);
    }

    const majorOf = (value: string): string => value.match(/^\d+/)?.[0] ?? "";
    const majors = [...new Set(distinct.map(majorOf))];
    const [onlyMajor, ...others] = majors;
    if (onlyMajor === undefined || onlyMajor === "") {
        return fail("一个主版本都没解析出来");
    }
    if (others.length > 0) {
        return fail(
            `CI 里的 node-version 不一致：主版本有 ${majors.join(" / ")}，各 job 跑的不是同一个 Node`,
            majors
        );
    }
    if (onlyMajor !== expectedMajor) {
        return fail(`CI 跑的是 Node ${onlyMajor}，@types/node 装的却是主版本 ${expectedMajor}`, majors);
    }

    return { versions, distinct, majors, ok: true, message: "" };
}

/** 拼一段和真 ci.yml 同形的片段：n 个 job、各自一份 node-version */
function ciWithVersions(...values: string[]): string {
    return values
        .map(
            (v, i) =>
                `  job_${i}:\n` +
                `    steps:\n` +
                `      - uses: actions/setup-node@v4\n` +
                `        with:\n` +
                `          node-version: ${v}\n`
        )
        .join("");
}

test("判据本身：四处一致算通过，有一处不一致要红并指出是哪个值", () => {
    // 方向一：四个 job 全是 22（就是现在 ci.yml 的形状）→ 通过
    const allSame = checkNodeVersionPin(ciWithVersions("22", "22", "22", "22"), "22");
    assert.equal(allSame.ok, true, `四个 22 应当通过，实际：${allSame.message}`);
    assert.deepEqual(allSame.versions, ["22", "22", "22", "22"], "四处都要被收集到（别又只留了第一个）");
    assert.deepEqual(allSame.majors, ["22"]);

    // 方向二：三处 22 + 一处 20 → 红，且失败信息里必须能读到那个 20
    const oneOff = checkNodeVersionPin(ciWithVersions("22", "22", "22", "20"), "22");
    assert.equal(oneOff.ok, false, "有一个 job 跑在 20 上，这条守卫必须红 —— 静默通过就等于没写");
    assert.deepEqual(oneOff.majors, ["22", "20"], "两个主版本都要被认出来");
    assert.match(oneOff.message, /20/, `失败信息要点出那个走偏的 20，实际：${oneOff.message}`);
    assert.match(oneOff.message, /22 \/ 22 \/ 22 \/ 20/, "失败信息要把收全了的原始值摊开");

    // 方向三（反向确认）：主版本对不上也要红，别只盯着「彼此一致」
    const wrongMajor = checkNodeVersionPin(ciWithVersions("20", "20"), "22");
    assert.equal(wrongMajor.ok, false, "全部一致但是和 @types/node 对不上，同样不能放过");

    // 方向四：一处都取不到时不能绿（写死成 lts/* 或改了键名就会走到这里）
    assert.equal(checkNodeVersionPin("# 只有注释提到 node-version\n", "22").ok, false, "取不到值必须红");
    assert.equal(checkNodeVersionPin(ciWithVersions("lts/*"), "22").ok, false, "算不出主版本的值必须红");
});

test("@types/node 的主版本要跟 CI 上跑的 Node 主版本一致", () => {
    const ci = readProjectFile(".github/workflows/ci.yml");
    const result = checkNodeVersionPin(ci, installedVersion("@types/node").split(".")[0]);

    assert.ok(result.versions.length > 0, "CI 里应写明 node-version");
    assert.ok(
        result.ok,
        `${result.message}\n` +
            "—— 类型比运行时新，就意味着「能编译通过但运行才炸」的口子被打开了"
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
