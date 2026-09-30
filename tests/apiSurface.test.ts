// API 表面覆盖：src/API/http.ts 原本是一个 3739 行 / 130+ 方法的巨型类，
// 现在按域拆到 src/API/methods/*.ts，再由 http.ts 末尾的 Object.assign 混回原型。
//
// 拆分留下两个只有跑起来才会暴露的坑，而且**类型检查抓不到**：
//
//   1. 某个域忘了加进混回列表。类的类型是靠 interface 声明合并补出来的，
//      TS 只信这个声明、不会去核实原型上真有这些方法 —— 少混一个域编译照样过，
//      上线后那个域的方法全是 undefined，调用时才 TypeError。
//   2. 两个域定义了同名方法。后混入的静默覆盖先混入的，没有任何提示。
//
// 所以这里在运行时把清单核一遍：每个域导出的实现对象里有哪些方法，
// 原型上就必须一一有同名函数；顺手钉住留在类里的几个核心方法没被搬丢。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAPI } from "../src/API/navigationApi";
import { migrationImpl } from "../src/API/methods/migration";
import { authImpl } from "../src/API/methods/auth";
import { recoveryImpl } from "../src/API/methods/recovery";
import { accountsImpl } from "../src/API/methods/accounts";
import { auditImpl } from "../src/API/methods/audit";
import { dataImpl } from "../src/API/methods/data";
import { recycleImpl } from "../src/API/methods/recycle";
import { configImpl } from "../src/API/methods/config";
import { transferImpl } from "../src/API/methods/transfer";

/** 域实现清单。新增域时**必须**在这里加一行，否则这个测试会漏掉它。 */
const IMPLS: Array<[string, object]> = [
    ["migration", migrationImpl],
    ["auth", authImpl],
    ["recovery", recoveryImpl],
    ["accounts", accountsImpl],
    ["audit", auditImpl],
    ["data", dataImpl],
    ["recycle", recycleImpl],
    ["config", configImpl],
    ["transfer", transferImpl],
];

/** 留在 http.ts 类里没搬的方法（账号作用域三件套 + 构造器） */
const CORE_METHODS = ["setCurrentUser", "getCurrentUserId", "scopeSql", "scopeParams"];

/** 拆分时搬走的方法数，用来兜底「整批没混进去」这种大面积回退 */
const MOVED_METHOD_COUNT = 126;

test("每个域的方法都真的混进了 NavigationAPI 原型", () => {
    const proto = Object.getPrototypeOf(createAPI({} as never)) as Record<string, unknown>;
    for (const [domain, impl] of IMPLS) {
        const names = Object.keys(impl);
        assert.ok(names.length > 0, `${domain} 域的实现是空的（导出错了？）`);
        for (const name of names) {
            assert.equal(
                typeof proto[name],
                "function",
                `${domain}.${name} 没混进原型 —— 检查 http.ts 末尾的 mixin 列表`,
            );
        }
    }
});

test("留在类里的核心方法没有被搬丢", () => {
    const api = createAPI({} as never) as unknown as Record<string, unknown>;
    for (const name of CORE_METHODS) {
        assert.equal(typeof api[name], "function", `${name} 应该留在 http.ts 的类里`);
    }
    // 构造器读过 env，这里只确认字段建起来了、没抛错
    assert.equal(api.currentUserId, null);
});

test("没有两个域定义同名方法（后者会静默覆盖前者）", () => {
    const owner = new Map<string, string>();
    for (const [domain, impl] of IMPLS) {
        for (const name of Object.keys(impl)) {
            assert.ok(!owner.has(name), `${name} 同时出现在 ${owner.get(name)} 和 ${domain}`);
            owner.set(name, domain);
        }
    }
});

test("搬走的方法总数没有缩水", () => {
    const total = IMPLS.reduce((sum, [, impl]) => sum + Object.keys(impl).length, 0);
    assert.ok(
        total >= MOVED_METHOD_COUNT,
        `原型上只有 ${total} 个搬来的方法，拆分时是 ${MOVED_METHOD_COUNT} 个 —— 有方法在搬运中丢了`,
    );
});

// ---------------- 打包边界：别把服务端代码摇进浏览器包 ----------------
//
// 浏览器包里出现 D1 的 SQL 是纯浪费：那 126 个方法体只有 Worker 会跑。
// 出过一次：类和那句 Object.assign 都放在 http.ts 里，而前端 30 多处从 http.ts 引
// 类型和常量 —— 顶层副作用让 Rollup 摇不掉，index chunk 从 199.77 KB 涨到 262.81 KB
// （gzip 66.34 → 81.86），多出来的全是浏览器永不执行的死代码。
// 拆出 navigationApi.ts 之后回来了。下面两条把这个边界钉住。

const HTTP_TS = path.join(process.cwd(), "src", "API", "http.ts");

test("http.ts 不能在运行时依赖 navigationApi（只允许 export type）", () => {
    const src = fs.readFileSync(HTTP_TS, "utf8");
    const offenders = src
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => line.includes('"./navigationApi"') && !/^\s*export type\b/.test(line));
    assert.deepEqual(
        offenders.map(([n, line]) => `${n}: ${line.trim()}`),
        [],
        "http.ts 一旦运行时 import 了 navigationApi，126 个方法体就会被拖进浏览器包 —— 只能 export type",
    );
});

test("浏览器包里不该出现 D1 的建表 / 回收站 SQL", (t) => {
    const assets = path.join(process.cwd(), "dist", "client", "assets");
    if (!fs.existsSync(assets)) {
        t.diagnostic("没有 dist/client/assets，跳过（先跑 npm run build 才会检查）");
        return;
    }
    const bundles = fs.readdirSync(assets).filter(f => f.startsWith("index-") && f.endsWith(".js"));
    assert.ok(bundles.length > 0, "dist 里找不到 index chunk");
    for (const f of bundles) {
        const code = fs.readFileSync(path.join(assets, f), "utf8");
        for (const needle of ["CREATE TABLE IF NOT EXISTS", "INSERT INTO recycle_bin"]) {
            assert.ok(
                !code.includes(needle),
                `${f} 里出现了 ${needle} —— 服务端代码漏进浏览器包了，检查 http.ts 的顶层副作用`,
            );
        }
    }
});
