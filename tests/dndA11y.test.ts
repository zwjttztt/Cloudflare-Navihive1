import test from "node:test";
import assert from "node:assert/strict";
import type { Active, Over } from "@dnd-kit/core";
import { dndAccessibility, labelOf } from "../src/components/dndA11y";

const items = [
    { id: "site-7", label: "示例网站" },
    { id: "group-9", label: "工作分组" },
    { id: "9", label: "分组排序名称" },
];
const active = { id: "site-7" } as Active;
const over = { id: "group-9" } as Over;
const event = {
    active, over, activatorEvent: {} as Event,
    collisions: null, delta: { x: 0, y: 0 },
};

test("label resolution preserves site/group prefixes and identifier types", () => {
    assert.equal(labelOf(items, "site-7"), "示例网站");
    assert.equal(labelOf(items, "group-9"), "工作分组");
    assert.equal(labelOf(items, "9"), "分组排序名称");
    assert.equal(labelOf(items, 9), "9");
    assert.equal(labelOf(items, null), "项目");
    assert.equal(labelOf(items, undefined), "项目");
    assert.equal(labelOf(items, "site-missing"), "site-missing");
});

test("drag start and hover announce Chinese names", () => {
    const { announcements } = dndAccessibility(items);
    assert.match(announcements.onDragStart(event) ?? "", /已拾起 示例网站/);
    assert.equal(announcements.onDragOver?.(event), "示例网站 正移动到 工作分组 的位置。");
    assert.equal(announcements.onDragOver?.({ ...event, over: null }), "示例网站 正在被拖动。");
});

test("drag completion and cancellation use Chinese labels", () => {
    const { announcements } = dndAccessibility(items);
    assert.equal(announcements.onDragEnd(event), "示例网站 已放置到 工作分组 的位置。");
    assert.equal(announcements.onDragEnd({ ...event, over: null }), "示例网站 已放下。");
    assert.equal(announcements.onDragCancel(event), "已取消拖动 示例网站。");
});

test("screen reader instructions explain keyboard pickup/drop/cancel", () => {
    const { screenReaderInstructions } = dndAccessibility(items);
    assert.match(screenReaderInstructions.draggable, /空格.*回车/);
    assert.match(screenReaderInstructions.draggable, /方向键/);
    assert.match(screenReaderInstructions.draggable, /Esc.*取消/);
});
