// tests/collapse.dom.test.tsx
// 收起状态的 localStorage 读写与广播。需要 window.dispatchEvent，所以走 DOM 模式。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    COLLAPSED_EVENT,
    COLLAPSED_GROUPS_KEY,
    readCollapsedGroupIds,
    setAllCollapsed,
    writeCollapsedGroupIds,
} from "../src/utils/collapse";

beforeEach(() => {
    localStorage.removeItem(COLLAPSED_GROUPS_KEY);
});

test("写进去的 id 一律存成字符串，读回来也是字符串", () => {
    writeCollapsedGroupIds([1 as unknown as string, "2"]);
    assert.deepEqual(readCollapsedGroupIds(), ["1", "2"]);
});

test("写入后要广播事件：同页面的 GroupCard 收不到 storage 事件", () => {
    let fired = 0;
    const listener = () => {
        fired += 1;
    };
    window.addEventListener(COLLAPSED_EVENT, listener);
    try {
        writeCollapsedGroupIds(["1"]);
        assert.equal(fired, 1);
    } finally {
        window.removeEventListener(COLLAPSED_EVENT, listener);
    }
});

test("存了脏数据（非数组 / 坏 JSON / 带非字符串项）不会抛，且被规整", () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify({ a: 1 }));
    assert.deepEqual(readCollapsedGroupIds(), []);

    localStorage.setItem(COLLAPSED_GROUPS_KEY, "not json{");
    assert.deepEqual(readCollapsedGroupIds(), []);

    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([1, "2", null]));
    assert.deepEqual(readCollapsedGroupIds(), ["1", "2", "null"]);
});

test("全部折叠写全部 id，全部展开写空数组", () => {
    setAllCollapsed([1, 2], true);
    assert.deepEqual(readCollapsedGroupIds(), ["1", "2"]);
    setAllCollapsed([1, 2], false);
    assert.deepEqual(readCollapsedGroupIds(), []);
});
