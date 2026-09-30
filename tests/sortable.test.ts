// tests/sortable.test.ts
// 拖拽排序的纯计算单测。这段逻辑原先埋在 App.tsx 里（约 200 行），
// 是「改坏了不报错、但拖起来会卡 / 会丢卡片」的那类：
//   - dragOver 每秒触发几十次，位置没变时必须返回**原数组引用**，否则全页卡片重渲染；
//   - 跨组移动要同步改写 group_id，不然刷新后卡片会跳回原分组；
//   - 提交给后端的顺序里，只有真跨组了才带 group_id。
// 这三条都有用例钉着，并做过变异验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
import {
    buildSiteOrderPayload,
    moveGroupByDrag,
    moveSiteAcrossGroups,
} from "../src/utils/sortable";

const site = (id: number, groupId: number, extra: Partial<Site> = {}): Site =>
    ({ id, name: `s${id}`, url: `https://s${id}.com`, group_id: groupId, order_num: id, ...extra } as Site);

const group = (id: number, siteIds: number[]): GroupWithSites => ({
    id,
    name: `g${id}`,
    order_num: id,
    sites: siteIds.map(sid => site(sid, id)),
});

const ids = (gs: GroupWithSites[]) => gs.map(g => g.id);
const siteIds = (gs: GroupWithSites[], groupId: number) =>
    gs.find(g => g.id === groupId)!.sites.map(s => s.id);

// ---------- 分组整体重排 ----------

test("分组拖拽：按上/下位置重排", () => {
    const gs = [group(1, []), group(2, []), group(3, [])];
    const next = moveGroupByDrag(gs, "1", "3");
    assert.deepEqual(ids(next), [2, 3, 1]);
});

test("分组拖拽：拖到自己身上、id 对不上时返回原引用（跳过重渲染）", () => {
    const gs = [group(1, []), group(2, [])];
    assert.equal(moveGroupByDrag(gs, "1", "1"), gs);
    assert.equal(moveGroupByDrag(gs, "1", "9"), gs);
    assert.equal(moveGroupByDrag(gs, "9", "1"), gs);
    assert.equal(moveGroupByDrag(gs, "1", ""), gs);
});

// ---------- 站点：同组重排 ----------

test("站点同组重排：从首位拖到末位", () => {
    const gs = [group(1, [10, 11, 12]), group(2, [20])];
    const next = moveSiteAcrossGroups(gs, "site-10", "site-12");
    assert.deepEqual(siteIds(next, 1), [11, 12, 10]);
    // 没被碰的分组保持原引用
    assert.equal(next[1], gs[1]);
});

test("站点同组重排：拖到自己身上返回原引用（dragOver 高频触发的兜底）", () => {
    const gs = [group(1, [10, 11, 12])];
    assert.equal(moveSiteAcrossGroups(gs, "site-11", "site-11"), gs);
});

test("站点同组重排：已在末位又悬停到分组容器（末尾）→ 返回原引用", () => {
    // 悬停到分组容器上得到的 overIndex 是 sites.length（末尾语义），
    // 夹取后正好等于被拖卡片自己的下标 —— 这时必须原样退回，
    // 否则每帧都会重建一个内容完全相同的分组对象，拖动时整页卡片跟着重渲染。
    const gs = [group(1, [10, 11])];
    assert.equal(moveSiteAcrossGroups(gs, "site-11", "group-1"), gs);
});

// ---------- 站点：跨组移动 ----------

test("站点跨组：插到目标卡片前面，并改写 group_id", () => {
    const gs = [group(1, [10, 11]), group(2, [20, 21])];
    const next = moveSiteAcrossGroups(gs, "site-10", "site-21");
    assert.deepEqual(siteIds(next, 1), [11]);
    assert.deepEqual(siteIds(next, 2), [20, 10, 21]);
    assert.equal(next[1].sites[1].group_id, 2);
});

test("站点跨组：悬停在分组容器上时追加到末尾", () => {
    const gs = [group(1, [10]), group(2, [20, 21])];
    const next = moveSiteAcrossGroups(gs, "site-10", "group-2");
    assert.deepEqual(siteIds(next, 1), []);
    assert.deepEqual(siteIds(next, 2), [20, 21, 10]);
    assert.equal(next[1].sites[2].group_id, 2);
});

test("站点跨组：拖到空分组也能落进去", () => {
    const gs = [group(1, [10]), group(2, [])];
    const next = moveSiteAcrossGroups(gs, "site-10", "group-2");
    assert.deepEqual(siteIds(next, 2), [10]);
});

test("站点跨组：只有来源与目标两个分组被重建，其它保持原引用", () => {
    const gs = [group(1, [10]), group(2, [20]), group(3, [30]), group(4, [40])];
    const next = moveSiteAcrossGroups(gs, "site-10", "group-2");
    assert.notEqual(next[0], gs[0]);
    assert.notEqual(next[1], gs[1]);
    assert.equal(next[2], gs[2]);
    assert.equal(next[3], gs[3]);
});

test("站点拖拽：非法 / 找不到的 id 一律返回原引用", () => {
    const gs = [group(1, [10, 11])];
    assert.equal(moveSiteAcrossGroups(gs, "group-1", "site-11"), gs); // active 不是站点
    assert.equal(moveSiteAcrossGroups(gs, "site-99", "site-11"), gs); // 找不到被拖的卡片
    assert.equal(moveSiteAcrossGroups(gs, "site-10", "site-99"), gs); // 找不到目标卡片
    assert.equal(moveSiteAcrossGroups(gs, "site-10", "group-9"), gs); // 找不到目标分组
    assert.equal(moveSiteAcrossGroups(gs, "site-10", "unknown-1"), gs); // 前缀不认识
    assert.equal(moveSiteAcrossGroups(gs, "site-10", ""), gs);
});

// ---------- 提交给后端的顺序 ----------

test("顺序提交：没跨组的只带 order_num，跨组的额外带 group_id", () => {
    // 进入排序模式时的快照：10 原在 1 组
    const original = new Map<number, number>([
        [10, 1],
        [20, 2],
    ]);
    const gs = [group(1, [20]), group(2, [10])];
    const orders = buildSiteOrderPayload(gs, original);
    assert.deepEqual(orders, [
        { id: 20, order_num: 0, group_id: 1 },
        { id: 10, order_num: 0, group_id: 2 },
    ]);
});

test("顺序提交：原位不动的卡片不带 group_id（后端只改顺序）", () => {
    const original = new Map<number, number>([
        [10, 1],
        [11, 1],
    ]);
    const gs = [group(1, [11, 10])];
    const orders = buildSiteOrderPayload(gs, original);
    assert.deepEqual(orders, [
        { id: 11, order_num: 0 },
        { id: 10, order_num: 1 },
    ]);
});

test("顺序提交：快照里没有的卡片（排序期间新建的）不带 group_id", () => {
    const gs = [group(1, [10, 99])];
    const orders = buildSiteOrderPayload(gs, new Map([[10, 1]]));
    assert.deepEqual(orders, [
        { id: 10, order_num: 0 },
        { id: 99, order_num: 1 },
    ]);
});

test("顺序提交：order_num 是组内下标，空分组不产生记录", () => {
    const gs = [group(1, []), group(2, [20, 21, 22])];
    const orders = buildSiteOrderPayload(gs, new Map());
    assert.deepEqual(orders, [
        { id: 20, order_num: 0 },
        { id: 21, order_num: 1 },
        { id: 22, order_num: 2 },
    ]);
});
