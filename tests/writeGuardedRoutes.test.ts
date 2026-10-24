// tests/writeGuardedRoutes.test.ts
// 守住「改了状态的路由必须有限速闸门」。
//
// 为什么需要：写限速（enforceWriteGuard）一直是**手工逐个路由接**的，
// 于是它总是落后于新路由的诞生：
//   · data.ts 的 37 个写分支有闸门（2026-10 补的）；
//   · 但 account.ts 的 9 条、ops.ts 的 5 条**一直是裸的** ——
//     而这两组恰恰是最危险的：改账号凭据是攻击者最省事的持久化手段，
//     回收站的 purge / 清空一条请求就能抹掉几千行且不可逆。
// 2026-10-24 把这两组补齐，并加了这条守卫，让「新加一条写路由忘了接闸门」直接红。
//
// 判据（两条，互补）：
//   A. **文件级**：任何含写方法分支的路由文件，必须至少有一处闸门调用。
//      「至少一处」而不是「每个分支一处」是刻意的 —— 两种收口模式都合法：
//        · 逐分支：`if (…) { const limited = await writeGate(); … }`（account / ops）
//        · 顶部统一：`if (WRITE_METHODS.has(method)) { … enforceConfigGuard(…) }`（config）
//      只认「每个分支都有」会把 config 那种更干净的模式误判成违规。
//   B. **精确计数**：account.ts 与 ops.ts 必须做到「写分支数 == writeGate() 调用次数」。
//      这两个文件选择了逐分支收口，所以数量对不上就是有人漏接。
//
// 豁免必须写 reason —— 没写清「为什么这类端点不该走写限速」的豁免不许存在。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

const ROOT = findProjectDir();
const ROUTES_DIR = path.join(ROOT, "worker", "routes");

/** 剥注释：注释里写的 `method === "POST"` 是说明文字，不是分支 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            let out = "";
            let quote: string | null = null;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (quote) {
                    out += c;
                    if (c === "\\") {
                        out += line[i + 1] ?? "";
                        i++;
                        continue;
                    }
                    if (c === quote) quote = null;
                    continue;
                }
                if (c === '"' || c === "'" || c === "`") {
                    quote = c;
                    out += c;
                    continue;
                }
                if (c === "/" && line[i + 1] === "/") break;
                out += c;
            }
            return out;
        })
        .join("\n");
}

const WRITE_METHOD = /method === "(POST|PUT|DELETE|PATCH)"/g;

/** 所有算作「已接闸门」的调用形态 */
const GATE_CALLS = [
    /await writeGate\(\)/,
    /await enforceWriteGuard\(/,
    /await enforceConfigGuard\(/,
    /await enforceDavGuard\(/,
    // 分享口令那一路：公开端点没法按 uid 分桶，但同样在校验前拦了一次
    /await shareGuardLocked\(/,
    /await bumpShareGuardFailure\(/,
];

function countMatches(src: string, re: RegExp): number {
    // 每次重新 new 一个正则，避免 lastIndex 污染
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    return (src.match(g) ?? []).length;
}

/**
 * 豁免清单：key 是路由文件名。
 * 只有「这类端点**结构上**不该走写限速」才允许豁免，不是「暂时还没接」。
 */
const EXEMPT: Record<string, { reason: string }> = {
    "public.ts": {
        reason:
            "全是未鉴权入口：login / register / recover 各有自己那把锁（clientBucket 分桶），" +
            "分享口令有 shareGuard（IP+token 分桶），csp-report 与 report-error 是浏览器上报，" +
            "写限速要求「账号 + IP」分桶，这里根本没有账号 —— 硬套会给全站访客共用一把锁",
    },
    "ai.ts": {
        reason:
            "⚠️ 已知缺口，不是设计如此：AI 五个端点每个都出网调大模型，比任何写操作都贵，" +
            "确实该有限速。但它需要独立一把锁 + 更宽松的阈值（重建索引会循环调 embed，" +
            "套 120 次/分钟会把正常功能截断），需要先量真实调用频率再定阈值。" +
            "已记入后续行动项，**别把这条豁免当成『AI 端点不需要限速』**",
    },
};

const routeFiles = readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith(".ts"))
    .filter(f => statSync(path.join(ROUTES_DIR, f)).isFile());

test("含写方法分支的路由文件必须有闸门（或在豁免清单里带 reason）", () => {
    const offenses: string[] = [];
    const report: string[] = [];

    for (const file of routeFiles) {
        const src = stripComments(readFileSync(path.join(ROUTES_DIR, file), "utf8"));
        const writes = countMatches(src, WRITE_METHOD);
        if (writes === 0) continue;

        const gates = GATE_CALLS.reduce((n, re) => n + countMatches(src, re), 0);
        report.push(`${file}: 写分支 ${writes} / 闸门调用 ${gates}`);

        if (gates > 0) continue;

        const exempt = EXEMPT[file];
        if (!exempt) {
            offenses.push(
                `${file}：有 ${writes} 条写方法分支，但**一处闸门都没有** —— ` +
                    `要么接 enforceWriteGuard / writeGate，要么在这个用例的 EXEMPT 里写清为什么不该有`
            );
            continue;
        }
        assert.ok(exempt.reason.length > 20, `${file} 的豁免必须写清原因（现在是 ${exempt.reason.length} 字）`);
    }

    assert.deepEqual(offenses, [], `\n${offenses.join("\n")}`);
});

test("account.ts：九条写路由逐条接闸（数量必须对上）", () => {
    // 这个文件选的是「逐分支收口」，所以数量对不上就是有人新加了路由却没接闸门。
    // 用固定数字而不是只比大小：写路由变少时也该有人来看一眼（是不是误删了）。
    const src = stripComments(readFileSync(path.join(ROUTES_DIR, "account.ts"), "utf8"));
    const writes = countMatches(src, WRITE_METHOD);
    const gates = countMatches(src, /await writeGate\(\)/);
    assert.equal(
        gates,
        writes,
        `account.ts 有 ${writes} 条写分支但只有 ${gates} 处 writeGate() —— 每条写路由都要在开头过闸`
    );
    assert.equal(writes, 9, `account.ts 的写路由数变了（现在是 ${writes}，之前是 9）：新增的话记得同步这个数字`);
});

test("ops.ts：五条回收站写路由逐条接闸（数量必须对上）", () => {
    const src = stripComments(readFileSync(path.join(ROUTES_DIR, "ops.ts"), "utf8"));
    const writes = countMatches(src, WRITE_METHOD);
    const gates = countMatches(src, /await writeGate\(\)/);
    assert.equal(
        gates,
        writes,
        `ops.ts 有 ${writes} 条写分支但只有 ${gates} 处 writeGate() —— 每条写路由都要在开头过闸`
    );
    assert.equal(writes, 5, `ops.ts 的写路由数变了（现在是 ${writes}，之前是 5）：新增的话记得同步这个数字`);
});

/**
 * 取出所有 `writeBucket(...)` 调用的完整实参文本。
 *
 * ⚠️ 不能用 `writeBucket\([^)]*\)`：实参里还有 `api.getCurrentUserId()`
 * 自己的括号，那个正则会在第一个 `)` 就断掉，把「传了 trustXFF」误判成「没传」
 * （本用例第一版就是这么假红的）。
 */
function writeBucketCalls(src: string): string[] {
    const out: string[] = [];
    const needle = "writeBucket(";
    let idx = src.indexOf(needle);
    while (idx >= 0) {
        const open = idx + needle.length - 1;
        let depth = 0;
        let close = -1;
        for (let i = open; i < src.length; i++) {
            if (src[i] === "(") depth++;
            else if (src[i] === ")") {
                depth--;
                if (depth === 0) {
                    close = i;
                    break;
                }
            }
        }
        out.push(src.slice(open, close < 0 ? src.length : close + 1));
        idx = src.indexOf(needle, close < 0 ? src.length : close + 1);
    }
    return out;
}

test("写闸门必须拿到 trustXFF（否则反代后面所有人共用一个桶）", () => {
    // writeBucket(request, uid, trustXFF) 的第三参默认 false。
    // 自托管部署（VPS + 反代）下不传它 → 所有用户都落进 `unknown` 桶 →
    // 一个人刷满额度，全站被 429。这是最难发现的误伤，必须钉死。
    for (const file of ["account.ts", "ops.ts", "data.ts"]) {
        const src = stripComments(readFileSync(path.join(ROUTES_DIR, file), "utf8"));
        const buckets = writeBucketCalls(src);
        assert.ok(buckets.length > 0, `${file} 里没找到 writeBucket 调用`);
        for (const call of buckets) {
            assert.ok(
                /trustXFF/.test(call),
                `${file} 的 ${call} 没传 trustXFF —— 反代后面所有用户会共用一个限速桶`
            );
        }
        // 解构里也得有，否则变量根本取不到（tsc 会报，但报错信息不直观）
        assert.ok(
            /^\s*trustXFF,\s*$/m.test(src),
            `${file} 的 ctx 解构里没有 trustXFF —— writeBucket 拿不到真实来源 IP`
        );
    }
});
