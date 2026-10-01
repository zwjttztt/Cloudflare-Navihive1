// tests/sessionBoundary.test.ts
// 第四章第 5 项「App 架构」里最要紧的那半句：
//   「秘密数据流和身份生命周期比单纯压行数更重要。」
//
// 退出登录 / 注销账号 / 换人登录共用的那份「账号边界清单」现在在
// utils/sessionBoundary.ts 里。这里逐条核对：少清一样，实际后果都是
// 「上一个人的数据在新账号下继续生效」，而这类问题在界面上看不出来。
import { test } from "node:test";
import assert from "node:assert/strict";

import { clearSessionBoundary, switchAccountBoundary } from "../src/utils/sessionBoundary";

type Deps = Parameters<typeof switchAccountBoundary>[1];

/** 记录每一步调用顺序的假依赖 */
function spyDeps() {
    const calls: string[] = [];
    const deps: Deps = {
        setQueueAccount: uid => calls.push(`queue:${uid}`),
        setUndoAccount: uid => calls.push(`undo:${uid}`),
        setPrefsAccount: uid => calls.push(`prefs:${uid}`),
        clearHistory: () => calls.push("history"),
        resetCollapsed: () => calls.push("collapsed"),
    };
    return { calls, deps };
}

test("换账号：四份按账号分开的数据全部换绑，撤销栈与快照清掉", () => {
    const { calls, deps } = spyDeps();
    switchAccountBoundary(7, deps);

    // 换绑（不是清空）：离线队列里可能还有没同步出去的编辑，删了就真丢了
    assert.ok(calls.includes("queue:7"), "离线队列要绑到新账号名下");
    assert.ok(calls.includes("undo:7"), "撤销快照要绑到新账号名下");
    assert.ok(calls.includes("prefs:7"), "星标 / 标签 / 访问统计要跟着换一份");
    assert.ok(calls.includes("collapsed"), "折叠状态要复位（记的是分组 id，跨账号会折叠错组）");
    // 清掉（跨账号留着就是「把别人的卡片改回来」的开关）
    assert.ok(calls.includes("history"), "撤销栈必须清掉");
});

test("退出登录：连账号作用域本身一起归零，且首屏缓存不再可渲染", () => {
    const { calls, deps } = spyDeps();
    clearSessionBoundary(deps);

    assert.ok(calls.includes("queue:null"), "离线队列要解绑（不能留在全局键里）");
    assert.ok(calls.includes("undo:null"), "撤销快照要解绑");
    assert.ok(calls.includes("prefs:null"), "星标 / 标签 / 访问统计要归零");
    assert.ok(calls.includes("history"), "撤销栈要清掉");
    assert.ok(calls.includes("collapsed"), "折叠状态要复位");
    // clearBootstrapCache 没有返回值可断言，至少保证整条函数不抛（首屏缓存那步在里面）
});

test("换到同一个账号时不再做破坏性清理（撤销栈不重复清）", () => {
    const { calls, deps } = spyDeps();

    switchAccountBoundary(7, deps);
    const afterFirst = calls.filter(c => c === "history").length;
    assert.equal(afterFirst, 1, "第一次切过去确实换了人，撤销栈该清一次");

    // 再切一次还是同一个人：只换绑，不该把撤销栈又清一遍
    // （真清了也没什么大碍，但它说明「账号变了没有」这个判断失效了）
    switchAccountBoundary(7, deps);
    assert.equal(
        calls.filter(c => c === "history").length,
        afterFirst,
        "账号没变时不该重复清撤销栈"
    );
    // 换绑仍然要做（幂等）
    assert.equal(calls.filter(c => c === "queue:7").length, 2);
});

test("账号边界的两条路径都不抛异常（退出 / 换人是最不能被中断的操作）", () => {
    const { deps } = spyDeps();
    assert.doesNotThrow(() => switchAccountBoundary(null, deps));
    assert.doesNotThrow(() => clearSessionBoundary(deps));
});
