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
import test from "node:test";
import { createAPI } from "../src/API/http";
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
