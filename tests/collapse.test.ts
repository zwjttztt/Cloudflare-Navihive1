// tests/collapse.test.ts
// isAllCollapsed：全部折叠开关该显示「折叠」还是「展开」。
//
// 坑在 id 的类型：localStorage 里存的必然是字符串，拿数字 id 去 includes
// 永远匹配不上，开关会一直显示「折叠全部」却按不动。
// 这里只测纯计算；localStorage 读写在 collapse.dom.test.tsx。

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllCollapsed } from "../src/utils/collapse";

const groups = (...ids: number[]) => ids.map(id => ({ id }));

test("全部收起时才是已折叠；少一个都不算", () => {
    assert.equal(isAllCollapsed(groups(1, 2), ["1", "2"]), true);
    assert.equal(isAllCollapsed(groups(1, 2), ["1"]), false);
    assert.equal(isAllCollapsed(groups(1, 2), []), false);
});

test("id 按字符串比：传数字数组也能匹配上", () => {
    assert.equal(isAllCollapsed(groups(7), [7 as unknown as string]), true);
});

test("没有分组时不算已折叠 —— 否则开关按下去什么都不会发生", () => {
    assert.equal(isAllCollapsed([], []), false);
    assert.equal(isAllCollapsed(null, []), false);
    assert.equal(isAllCollapsed(groups(1), ["1"]), true);
});

test("临时分组（id 为 0 或缺失）不参与判定", () => {
    assert.equal(isAllCollapsed([{ id: 0 }, { id: 3 }], ["3"]), true);
});

test("collapsedIds 为 null/undefined 时安全返回 false", () => {
    assert.equal(isAllCollapsed(groups(1), null), false);
    assert.equal(isAllCollapsed(groups(1), undefined), false);
});
