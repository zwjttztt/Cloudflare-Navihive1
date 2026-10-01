// tests/importDiff.test.ts
// 导入前差异计算 + 勾选裁剪的单测。
// 这块逻辑的特点：一旦算错，用户会以为「备份把数据弄丢了」，而且没法当场发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyImportSelection,
    computeImportDiff,
    defaultSelection,
    diffSiteFields,
    summarizeFieldDiff,
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
    // 分组（第二个分组是新增的，本例刻意不选它）：只勾它下面的卡片、不勾分组本身
    const siteKey = diff.siteEntries[2].key;
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

// —— 字段级差异 ——
// 只看「新增 / 更新」两个字，用户还是不知道备份会把自己的卡片改成什么样；
// 更新项必须能说出「名称、链接已改」，展开还能看到具体从什么改成什么。
// 唯一例外是账号与密码：预览是要摆在屏幕上的，凭据原文不能出现。

test("更新项给出字段级差异：改了哪些字段、从什么改成什么", () => {
    const incoming: ExportData = {
        version: "1",
        exportDate: "",
        configs: {},
        groups: [{ id: 1, name: "常用工具", order_num: 0 }],
        sites: [
            site({
                id: 12,
                group_id: 1,
                name: "示例二改名",
                url: "https://example.com/changed",
                description: "顺手改了描述",
            }),
        ],
    };
    const diff = computeImportDiff(current, incoming, false);
    const entry = diff.siteEntries[0];
    assert.equal(entry.status, "updated");
    assert.ok(entry.fields, "更新项应带字段差异");
    const labels = entry.fields!.map(f => f.label);
    assert.ok(labels.includes("名称"), `应标出名称变了，实际 ${labels}`);
    assert.ok(labels.includes("链接"), `应标出链接变了，实际 ${labels}`);
    const nameField = entry.fields!.find(f => f.field === "name");
    assert.equal(nameField?.before, "示例二");
    assert.equal(nameField?.after, "示例二改名");
});

test("账号与密码只说「有变化」，取值不进预览", () => {
    const incoming: ExportData = {
        version: "1",
        exportDate: "",
        configs: {},
        groups: [{ id: 1, name: "常用工具", order_num: 0 }],
        sites: [
            site({
                id: 11,
                group_id: 1,
                name: "云设",
                url: "https://yunso.net",
                password: "new-secret",
                username: "new-user",
            }),
        ],
    };
    const diff = computeImportDiff(current, incoming, false);
    const entry = diff.siteEntries.find(e => e.key === "site:11");
    assert.equal(entry?.status, "updated");
    const dumped = JSON.stringify(entry?.fields ?? []);
    for (const secret of ["old-secret", "new-secret", "old-user", "new-user"]) {
        assert.ok(!dumped.includes(secret), `差异里不该出现凭据原文：${secret}`);
    }
    const pwd = entry?.fields?.find(f => f.field === "password");
    assert.equal(pwd?.sensitive, true);
    assert.equal(pwd?.before, null);
    assert.equal(pwd?.after, null);
});

test("changeSummary：三处以内列全，超过三项只点前三并给出总数", () => {
    const many = diffSiteFields(
        site({ id: 1, name: "a", url: "https://a.com", description: "d", notes: "n", username: "u" }),
        site({ id: 1, name: "b", url: "https://b.com", description: "D", notes: "N", username: "U" })
    );
    assert.ok(many.length > 3, "这个用例需要超过三项变化");
    const summary = summarizeFieldDiff(many);
    assert.match(summary, /等 \d+ 项已改/);
    const two = diffSiteFields(site({ id: 1, name: "a" }), site({ id: 1, name: "b", url: "https://b.com" }));
    assert.equal(summarizeFieldDiff(two), "名称、链接已改");
});

test("无变化的条目不带字段差异，新增条目也不带（没有可比的对象）", () => {
    const same: ExportData = {
        version: "1",
        exportDate: "",
        configs: {},
        groups: [{ id: 1, name: "常用工具", order_num: 0 }],
        sites: [site({ id: 11, group_id: 1, name: "云设", url: "https://yunso.net" })],
    };
    const diff = computeImportDiff(current, same, false);
    assert.equal(diff.siteEntries[0].status, "unchanged");
    assert.equal(diff.siteEntries[0].fields, undefined);

    const brandNew: ExportData = {
        version: "1",
        exportDate: "",
        configs: {},
        groups: [{ id: 1, name: "常用工具", order_num: 0 }],
        sites: [site({ id: 99, group_id: 1, name: "新站", url: "https://new.com" })],
    };
    const diff2 = computeImportDiff(current, brandNew, false);
    assert.equal(diff2.siteEntries[0].status, "added");
    assert.equal(diff2.siteEntries[0].fields, undefined);
});

test("分组改名 / 改排序也算更新，并给出字段差异", () => {
    const incoming: ExportData = {
        version: "1",
        exportDate: "",
        configs: {},
        groups: [{ id: 1, name: "常用工具（改名）", order_num: 3 }],
        sites: [],
    };
    const diff = computeImportDiff(current, incoming, false);
    const entry = diff.groupEntries[0];
    assert.equal(entry.status, "updated");
    const labels = entry.fields?.map(f => f.label) ?? [];
    assert.deepEqual(labels, ["名称", "排序"], `实际 ${labels}`);
    assert.equal(entry.fields?.[0].before, "常用工具");
    assert.equal(entry.fields?.[0].after, "常用工具（改名）");
});
