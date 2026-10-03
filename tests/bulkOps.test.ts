// tests/bulkOps.test.ts
// 批量移动 / 批量删标签的纯计算用例。
//
// 批量移动是唯一一处「同时改服务端与本地快照」的操作，写歪了的表现很隐蔽：
// 界面上卡片已经搬走了，刷新一看还在原处 —— 用户以为操作成功，其实是本地
// 快照骗了他。所以这里的断言都对准「哪些卡片真的动了」。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyBulkMoveToGroups,
    maxOrderNum,
    pickSitesWithTag,
    planBulkMoveOrders,
    renumberMoved,
} from "../src/utils/bulkOps";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";

const site = (id: number, group_id: number, order_num: number): Site =>
    ({ id, group_id, order_num, name: `s${id}`, url: `https://${id}.example.com` }) as Site;

// ==================== 目标排序号 ====================

test("空分组的最大排序号是 -1（第一张搬进来落到 0）", () => {
    assert.equal(maxOrderNum([]), -1);
});

test("搬进空分组：从 0 开始编号", () => {
    const orders = planBulkMoveOrders([7, 8], [], 2);
    assert.deepEqual(orders, [
        { id: 7, order_num: 0, group_id: 2 },
        { id: 8, order_num: 1, group_id: 2 },
    ]);
});

test("搬进非空分组：追加到末尾，不覆盖已有卡片", () => {
    const target = [site(1, 2, 0), site(2, 2, 1), site(3, 2, 5)];
    const orders = planBulkMoveOrders([7, 8], target, 2);
    assert.deepEqual(
        orders.map(o => o.order_num),
        [6, 7],
        "要接在最大号 5 之后，不能从 0 起（会撞号）"
    );
    assert.deepEqual(
        orders.map(o => o.group_id),
        [2, 2]
    );
});

test("排序号可能不连续，仍按最大值往后排", () => {
    const target = [site(1, 2, 0), site(2, 2, 99)];
    assert.deepEqual(
        planBulkMoveOrders([5], target, 2).map(o => o.order_num),
        [100]
    );
});

// ==================== 只给成功的那些编号 ====================

test("重排号：跳过没写进去的，且不留空洞", () => {
    const orders = [
        { id: 1, order_num: 5, group_id: 2 },
        { id: 2, order_num: 6, group_id: 2 },
        { id: 3, order_num: 7, group_id: 2 },
    ];
    // 中间那条没成功：剩下两条要压成 5、6，不能留成 5、7
    const map = renumberMoved(orders, [1, 3]);
    assert.deepEqual([...map.entries()], [
        [1, 5],
        [3, 6],
    ]);
});

test("重排号：一条都没成功就得到空表（界面一个都不该动）", () => {
    const map = renumberMoved([{ id: 1, order_num: 0, group_id: 2 }], []);
    assert.equal(map.size, 0);
});

// ==================== 本地快照搬家 ====================

const twoGroups = (): GroupWithSites[] => [
    { id: 1, name: "A", order_num: 0, sites: [site(1, 1, 0), site(2, 1, 1)] } as GroupWithSites,
    { id: 2, name: "B", order_num: 1, sites: [site(3, 2, 0)] } as GroupWithSites,
];

test("搬家：卡片从原分组消失、出现在目标分组末尾", () => {
    const next = applyBulkMoveToGroups(twoGroups(), new Map([[1, 1]]), 2);
    assert.deepEqual(
        next[0].sites.map(s => s.id),
        [2],
        "原分组要少一张"
    );
    assert.deepEqual(
        next[1].sites.map(s => s.id),
        [3, 1],
        "目标分组要按排序号插到末尾"
    );
});

test("搬家：只搬真正成功的那批 —— 界面不能比库里多动", () => {
    // 勾了 1、2 两张，服务端只认下 1
    const next = applyBulkMoveToGroups(twoGroups(), new Map([[1, 1]]), 2);
    assert.deepEqual(next[0].sites.map(s => s.id), [2], "没成功的 2 必须留在原处");
    assert.deepEqual(next[1].sites.map(s => s.id), [3, 1]);
});

test("搬家：目标分组内的顺序按排序号重排（搬进来的不一定在最后）", () => {
    const groups = [
        { id: 1, name: "A", order_num: 0, sites: [site(1, 1, 0)] },
        { id: 2, name: "B", order_num: 1, sites: [site(3, 2, 0), site(4, 2, 9)] },
    ] as GroupWithSites[];
    // 排序号 5 落在 0 与 9 之间
    const next = applyBulkMoveToGroups(groups, new Map([[1, 5]]), 2);
    assert.deepEqual(next[1].sites.map(s => s.id), [3, 1, 4]);
});

test("搬家：一个都没成功时原分组原样返回（同一份引用，不触发无谓重渲染）", () => {
    const before = twoGroups();
    const next = applyBulkMoveToGroups(before, new Map(), 2);
    assert.equal(next[0], before[0], "没动的分组要返回同一个对象");
    assert.equal(next[1], before[1]);
});

test("搬家：往自己所在的组搬也不会把卡片弄丢", () => {
    const next = applyBulkMoveToGroups(twoGroups(), new Map([[1, 5]]), 1);
    assert.deepEqual(next[0].sites.map(s => s.id), [2, 1]);
    assert.deepEqual(next[1].sites.map(s => s.id), [3], "另一个组不受影响");
});

// ==================== 删标签影响哪些卡片 ====================

test("删标签：找出所有带这个标签的卡片（键是字符串，要转成数字）", () => {
    const affected = pickSitesWithTag({ "1": ["常用", "工具"], "2": ["工具"], "3": ["AI"] }, "工具");
    assert.deepEqual(affected, [1, 2]);
});

test("删标签：没人用这个标签就返回空（不该给一次没意义的撤销）", () => {
    assert.deepEqual(pickSitesWithTag({ "1": ["常用"] }, "没有的标签"), []);
});

test("删标签：标签表的键是 JSON 键 —— 直接拿数字 id 比会一个都匹配不上", () => {
    // 这是把标签存进 localStorage 之后的必然形状：Object.entries 出来是字符串
    const affected = pickSitesWithTag({ "7": ["常用"] }, "常用");
    assert.deepEqual(affected, [7], "要是数字，就真的是数字");
    assert.equal(typeof affected[0], "number");
});

test("删标签：键不是数字就跳过（脏数据不该让整个操作崩掉）", () => {
    const affected = pickSitesWithTag({ abc: ["常用"], "2": ["常用"] }, "常用");
    assert.deepEqual(affected, [2]);
});
