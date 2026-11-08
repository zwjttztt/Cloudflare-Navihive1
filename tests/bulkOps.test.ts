// tests/bulkOps.test.ts
// 批量移动 / 批量删标签的纯计算用例。
//
// 批量移动是唯一一处「同时改服务端与本地快照」的操作，写歪了的表现很隐蔽：
// 界面上卡片已经搬走了，刷新一看还在原处 —— 用户以为操作成功，其实是本地
// 快照骗了他。所以这里的断言都对准「哪些卡片真的动了」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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

// ==================== 需求 2 / 需求 3 的结构性守卫 ====================
//
// 运行时的「证明行为」用例放在 tests/*.dom.test.tsx（要渲染 hook / 组件，
// 只有 DOM bundle 才挂 jsdom）。这里补的是**纯文本第二层**：钉住那几处
// 「写歪了不报错、只是界面不对」的调用点。运行时用例没法单独隔离它们 ——
// 例如 X 按钮本来就直接调了 exitMultiSelect，集中式 effect 被删掉也照样过，
// 而那条 effect 恰恰是给「折叠 / 选中文件夹」这些别的隐藏路径兜底的。
// 所以这一层专门盯「入口和兜底都还在」，运行时那层盯「状态真的被清干净」。

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** 剥掉块注释与整行行注释：仓库注释里常写「正确写法」，不剥会被守卫蒙混 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

function readSrc(rel: string): string {
    return stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));
}

test("批量删除（useNotes.deleteNotes）：一次批量端点 + 一次乐观 setNotes + 老部署降级 + 失败回滚", () => {
    const src = readSrc("src/hooks/useNotes.ts");
    const at = src.indexOf("const deleteNotes = useCallback(");
    assert.ok(at > 0, "找不到 deleteNotes 实现");
    // 用下一个 callback 当边界，避免窗口太短把 catch 那段回滚切掉
    const end = src.indexOf("const saveOrder = useCallback(", at);
    const body = end > at ? src.slice(at, end) : src.slice(at, at + 6000);
    // 一次批量端点，而不是 N 次单删
    assert.ok(/api\.deleteNotes\(ids\)/.test(body), "deleteNotes 要走一次批量端点");
    assert.ok(!/api\.deleteNotes\(id\)/.test(body), "别把批量端点退化成逐条调用");
    // 老部署没有批量端点时逐条降级
    assert.ok(
        /Promise\.all\([\s\S]*?api\.deleteNote\(id\)/.test(body),
        "没有批量端点时要退化成 N 次 deleteNote"
    );
    // 乐观移除只做一次（卡片不能一条条消失）
    assert.equal(
        (body.match(/setNotes\(prev\s*=>\s*prev\.filter\(/g) ?? []).length,
        1,
        "整批只该有一次乐观 setNotes"
    );
    // 异常整体回滚 + 提示
    assert.ok(/setNotes\(before\)/.test(body), "抛异常要整体回滚到 before 快照");
    assert.ok(/onError\("批量删除笔记失败/.test(body), "异常要触发 onError");
});

test("useNotesBulkOps：优先一次 onDeleteMany、failed 留勾选、归档并发上限 6", () => {
    const src = readSrc("src/components/notes/useNotesBulkOps.ts");
    const del = src.indexOf("const bulkDelete = useCallback(");
    assert.ok(del > 0, "找不到 bulkDelete 实现");
    const delEnd = src.indexOf("return { checkedNotes", del);
    const delBody = delEnd > del ? src.slice(del, delEnd) : src.slice(del, del + 3000);
    assert.ok(/await\s+onDeleteMany\(checkedNotes\)/.test(delBody), "bulkDelete 要优先一次 onDeleteMany");
    assert.ok(/setChecked\(new Set\(failed\)\)/.test(delBody), "failed 要保留在勾选里");
    const arc = src.indexOf("const bulkArchive = useCallback(");
    assert.ok(arc > 0, "找不到 bulkArchive 实现");
    const arcEnd = src.indexOf("const bulkDelete = useCallback(", arc);
    const arcBody = arcEnd > arc ? src.slice(arc, arcEnd) : src.slice(arc, arc + 3000);
    assert.ok(
        /mapWithConcurrency\(checkedNotes,\s*6\s*,/.test(arcBody),
        "批量归档并发上限必须是 6（不是串行 for...await）"
    );
});

test("exitMultiSelect 一次收掉 multiSelect / 勾选 / 批量删除确认框", () => {
    const src = readSrc("src/components/notes/useNotesRowActions.ts");
    const at = src.indexOf("const exitMultiSelect = useCallback(");
    assert.ok(at > 0, "找不到 exitMultiSelect 实现");
    const body = src.slice(at, at + 400);
    assert.ok(/setMultiSelect\(false\)/.test(body), "要关掉多选");
    assert.ok(/setChecked\(new Set\(\)\)/.test(body), "要清空勾选");
    assert.ok(/setBulkDeleteOpen\(false\)/.test(body), "要关掉批量删除确认框");
});

test("隐藏列表 / 折叠 / 退出多选：三个入口都接到 exitMultiSelect", () => {
    const model = readSrc("src/components/notes/useNotesPageModel.tsx");
    assert.ok(
        /if\s*\(listHidden\s*\|\|\s*listCollapsed\)\s*exitMultiSelect\(\)/.test(model),
        "集中 effect 要在 listHidden / listCollapsed 为真时退出多选"
    );
    const pane = readSrc("src/components/notes/NotesListPane.tsx");
    assert.ok(
        /setMiddleHidden\(true\);\s*exitMultiSelect\(\)/.test(pane),
        "X 收起要顺手 exitMultiSelect（需求 3 的直接入口）"
    );
    assert.ok(
        /if\s*\(multiSelect\)\s*exitMultiSelect\(\)/.test(pane),
        "再点多选按钮切出要 exitMultiSelect"
    );
});
