// tests/siteMutations.test.ts
// 分组数组纯变换的单测。这段逻辑原来内联在 App.tsx 的 setGroups(prev => ...) 回调里，
// 是写操作路径上最容易被改坏的部分（乐观更新、跨分组移动、快照回滚都经过它），
// 但因为写在组件里一直没法直接测。抽出来之后在这里钉死三类行为：
//   ① 跨分组移动要排到末尾、并从原分组摘掉
//   ② 没有实际变化时必须原样返回入参（引用稳定是 memo 生效的前提，返回新数组会让整片重渲染）
//   ③ 批量删除只重建命中的分组
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
import { findSite, removeSite, removeSites, upsertSite } from "../src/utils/siteMutations";

const site = (id: number, groupId: number, order: number, extra: Partial<Site> = {}): Site =>
    ({
        id,
        name: `s${id}`,
        url: `https://s${id}.com`,
        group_id: groupId,
        order_num: order,
        ...extra,
    } as Site);

const group = (id: number, sites: Site[]): GroupWithSites => ({
    id,
    name: `g${id}`,
    order_num: id,
    sites,
});

test("upsertSite：改已有卡片只换那一条，其它卡片引用不动", () => {
    const a = site(1, 1, 0);
    const b = site(2, 1, 1);
    const groups = [group(1, [a, b])];

    const next = upsertSite(groups, site(1, 1, 0, { name: "改过的" }));

    assert.equal(next[0].sites.length, 2);
    assert.equal(next[0].sites[0].name, "改过的");
    // 没被改的那条要保持同一个对象引用
    assert.equal(next[0].sites[1], b);
});

test("upsertSite：往分组里塞不存在的卡片时追加并按 order_num 排好", () => {
    const groups = [group(1, [site(1, 1, 5), site(2, 1, 10)])];

    const next = upsertSite(groups, site(3, 1, 7));

    assert.deepEqual(next[0].sites.map(s => s.id), [1, 3, 2]);
});

test("upsertSite：跨分组移动排到目标分组末尾，并从原分组摘掉", () => {
    const groups = [group(1, [site(1, 1, 0), site(2, 1, 1)]), group(2, [site(9, 2, 3)])];

    // 2 号卡片从分组 1 挪到分组 2；它原本 order_num=1，目标分组最大是 3
    const next = upsertSite(groups, site(2, 2, 1));

    assert.deepEqual(next[0].sites.map(s => s.id), [1], "原分组里不该再留着它");
    assert.deepEqual(next[1].sites.map(s => s.id), [9, 2], "应该排在目标分组末尾");
    // 落在末尾靠的是 order_num 被改成 max+1，而不是靠插入位置
    assert.equal(next[1].sites[1].order_num, 4);
});

test("upsertSite：目标分组不存在时原样返回入参", () => {
    const groups = [group(1, [site(1, 1, 0)])];
    assert.equal(upsertSite(groups, site(2, 999, 0)), groups);
});

test("removeSite：命中时只重建那一个分组，未命中的分组引用不动", () => {
    const a = site(1, 1, 0);
    const b = site(2, 1, 1);
    const other = group(2, [site(9, 2, 0)]);
    const groups = [group(1, [a, b]), other];

    const next = removeSite(groups, 1);

    assert.deepEqual(next[0].sites.map(s => s.id), [2]);
    assert.equal(next[1], other, "没被删的分组必须保持原引用");
});

test("removeSite：id 不存在时原样返回入参（引用不变）", () => {
    const groups = [group(1, [site(1, 1, 0)])];
    assert.equal(removeSite(groups, 999), groups);
});

test("removeSites：一次删多张，跨分组一起处理", () => {
    const groups = [
        group(1, [site(1, 1, 0), site(2, 1, 1), site(3, 1, 2)]),
        group(2, [site(4, 2, 0), site(5, 2, 1)]),
    ];

    const next = removeSites(groups, [2, 4]);

    assert.deepEqual(next[0].sites.map(s => s.id), [1, 3]);
    assert.deepEqual(next[1].sites.map(s => s.id), [5]);
});

test("removeSites：空数组和全不命中都不改动引用", () => {
    const groups = [group(1, [site(1, 1, 0)])];
    assert.equal(removeSites(groups, []), groups);
    assert.equal(removeSites(groups, [999, 1000]), groups);
});

test("findSite：跨分组找得到，找不到返回 null", () => {
    const groups = [group(1, [site(1, 1, 0)]), group(2, [site(9, 2, 0)])];
    assert.equal(findSite(groups, 9)?.id, 9);
    assert.equal(findSite(groups, 404), null);
});
