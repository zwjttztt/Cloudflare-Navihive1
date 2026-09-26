// tests/importDiff.test.ts
// 导入前差异计算 + 勾选裁剪的单测。
// 这块逻辑的特点：一旦算错，用户会以为「备份把数据弄丢了」，而且没法当场发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyImportSelection,
    computeImportDiff,
    defaultSelection,
} from "../src/utils/importDiff";
import type { ExportData, Site } from "../src/API/http";
import type { GroupWithSites } from "../src/types";

const site = (over: Partial<Site> = {}): Site => ({
    id: 1,
    group_id: 1,
    name: "",
    url: "",
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: 0,
    ...over,
});

const current: GroupWithSites[] = [
    {
        id: 1,
        name: "常用工具",
        order_num: 0,
        sites: [
            site({ id: 11, group_id: 1, name: "云设", url: "https://yunso.net" }),
            site({ id: 12, group_id: 1, name: "示例二", url: "https://example.com" }),
        ],
    },
    {
        id: 2,
        name: "开发",
        order_num: 1,
        sites: [site({ id: 21, group_id: 2, name: "示例三", url: "https://example.org" })],
    },
];

const incoming: ExportData = {
    groups: [
        { id: 1, name: "常用工具", order_num: 0 },
        { id: 3, name: "新增分组", order_num: 2 },
    ],
    sites: [
        // 内容与现有的一模一样 -> 无变化
        site({ id: 11, group_id: 1, name: "云设", url: "https://yunso.net" }),
        // 改了名字 -> 更新
        site({ id: 12, group_id: 1, name: "示例二（改过）", url: "https://example.com" }),
        // 新链接 -> 新增
        site({ id: 31, group_id: 3, name: "新卡片", url: "https://new.example.com" }),
    ],
    configs: {},
    version: "1.2",
    exportDate: "2026-09-26T00:00:00.000Z",
};

test("按 id 认得出「无变化 / 更新 / 新增」", () => {
    const diff = computeImportDiff(current, incoming, false);
    assert.equal(diff.groupEntries[0].status, "unchanged");
    assert.equal(diff.groupEntries[1].status, "added");
    assert.equal(diff.siteEntries[0].status, "unchanged");
    assert.equal(diff.siteEntries[1].status, "updated");
    assert.equal(diff.siteEntries[2].status, "added");
});

test("非覆盖模式下不算「将删除」", () => {
    const diff = computeImportDiff(current, incoming, false);
    assert.equal(diff.counts.removed, 0);
    assert.equal(diff.removedSites.length, 0);
});

test("覆盖模式下：现有数据里备份没有的，都列进「将删除」", () => {
    const diff = computeImportDiff(current, incoming, true);
    // 现有 3 张卡里，只有 id 11/12 出现在备份里，21 会被清掉
    assert.equal(diff.removedSites.length, 1);
    // 分组 2 也不在备份里
    assert.equal(diff.removedGroups.length, 1);
    assert.equal(diff.counts.removed, 2);
});

test("合并导入：默认勾选跳过「无变化」，但不是全空", () => {
    const diff = computeImportDiff(current, incoming, false);
    const selected = defaultSelection(diff, false);
    assert.ok(selected.size > 0, "默认不应一个都不勾");
    assert.equal(selected.has(diff.siteEntries[0].key), false, "无变化的条目默认不勾");
    assert.equal(selected.has(diff.siteEntries[2].key), true);
});

test("覆盖恢复：默认必须全选（没勾的会被当成「不在备份里」删掉）", () => {
    const diff = computeImportDiff(current, incoming, true);
    const selected = defaultSelection(diff, true);
    assert.equal(
        selected.size,
        diff.groupEntries.length + diff.siteEntries.length,
        "覆盖恢复默认全选，否则用户什么都没动就会丢掉所有没变过的分组和卡片"
    );
});

test("合并导入：老分组下内容有改动的卡片不会被连带丢掉", () => {
    // 「示例二（改过）」挂在已有的「常用工具」下，而那个分组本身没变化、默认不勾。
    // 它必须照样能导进来 —— 之前会被「分组没勾」这条规则连带过滤掉。
    const diff = computeImportDiff(current, incoming, false);
    const selected = defaultSelection(diff, false);
    const trimmed = applyImportSelection(incoming, diff, selected);
    assert.deepEqual(trimmed.sites.map(s => s.name).sort(), ["新卡片", "示例二（改过）"].sort());
});

test("全都没变化时默认全选（否则用户会以为出错了）", () => {
    const sameData: ExportData = {
        ...incoming,
        groups: [{ id: 1, name: "常用工具", order_num: 0 }],
        sites: [site({ id: 11, group_id: 1, name: "云设", url: "https://yunso.net" })],
    };
    const diff = computeImportDiff(current, sameData, false);
    const selected = defaultSelection(diff);
    assert.equal(selected.size, diff.groupEntries.length + diff.siteEntries.length);
});

test("取消勾选分组时，它下面的卡片一起不导入", () => {
    const diff = computeImportDiff(current, incoming, false);
    const groupKey = diff.groupEntries[1].key; // 新增的那个分组
    const siteKey = diff.siteEntries[2].key; // 挂在它下面的新卡片
    const selected = new Set([siteKey]); // 只勾卡片、不勾分组

    const trimmed = applyImportSelection(incoming, diff, selected);
    assert.equal(trimmed.sites.length, 0, "分组没勾，卡片不该进来");
    assert.equal(trimmed.groups.length, 0);
});

test("勾选结果与输出一一对应（顺序不被打乱）", () => {
    const diff = computeImportDiff(current, incoming, false);
    const selected = defaultSelection(diff);
    const trimmed = applyImportSelection(incoming, diff, selected);

    // 备份里有 3 张卡，其中 1 张无变化被跳过
    assert.equal(trimmed.sites.length, 2);
    assert.deepEqual(
        trimmed.sites.map(s => s.name),
        ["示例二（改过）", "新卡片"]
    );
    // 分组只带「新增」的那一个：「常用工具」本身没变化，合并导入时不用重复提交
    // （它下面的卡片照常导入，靠 group_id 落到已有的分组上）
    assert.deepEqual(trimmed.groups.map(g => g.name), ["新增分组"]);
});
