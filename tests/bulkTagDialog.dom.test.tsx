// tests/bulkTagDialog.dom.test.tsx
// 批量打标签弹窗：常用 / 推荐两排候选。
//
// 这个弹窗此前只给一排「全站标签」，标签一多就变成一堵墙，而且新库（一个标签都没有）
// 点开是一片空白 —— 和「网站设置」里那两排对不上。
//
// 两条容易写歪的规则：
// - 勾上的标签必须**留在原处**显示选中态（不按已选过滤），点了就消失会数不出勾了哪些
// - 常用排只露前 12 个，但**必须留入口**够到后面的，不能让人够不着

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BulkActionBar from "../src/components/BulkActionBar";
import { RECOMMENDED_TAGS } from "../src/utils/tagSuggest";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
});

interface HarnessOptions {
    allTags?: string[];
    count?: number;
}

function mount(o: HarnessOptions = {}) {
    const tagged: string[][] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <BulkActionBar
                count={o.count ?? 3}
                groups={[{ id: 1, name: "分组一" }]}
                allTags={o.allTags ?? ["AI", "工具"]}
                onStar={() => {}}
                onTag={tags => tagged.push(tags)}
                onMove={() => {}}
                onDelete={() => {}}
                onFinish={() => {}}
                onExit={() => {}}
            />
        );
    });
    return { tagged };
}

async function flush() {
    await act(async () => {
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
    });
}

/** 点开「打标签」弹窗 */
async function openDialog() {
    const btn = document.querySelector<HTMLButtonElement>(".nav-bulk-tag");
    assert.ok(btn, "底栏上要有「打标签」按钮");
    await act(async () => {
        btn!.click();
    });
    await flush();
}

/** 按 aria-label 找弹窗里的候选芯片（弹窗挂在 body 的 portal 上，不能只在 host 里找） */
function chip(label: string) {
    const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    assert.ok(el, `弹窗里要有「${label}」这个候选`);
    return el!;
}

async function click(el: HTMLElement) {
    await act(async () => {
        el.click();
    });
    await flush();
}

function groupChips(kind: string) {
    const group = document.querySelector<HTMLElement>(`.nav-tag-suggest-group[data-kind="${kind}"]`);
    if (!group) return [];
    return Array.from(group.querySelectorAll<HTMLElement>(".MuiChip-root"));
}

test("弹窗里给出「常用」与「推荐」两排候选", async () => {
    mount();
    await openDialog();
    const common = groupChips("common").map(c => c.textContent);
    assert.deepEqual(common, ["AI", "工具"], "常用排按传入顺序（调用方已按使用次数排好）");

    const recommend = groupChips("recommend").map(c => c.textContent);
    assert.ok(recommend.length > 0, "推荐排不能是空的");
    for (const tag of recommend) assert.ok(RECOMMENDED_TAGS.includes(tag!));
});

test("空库（一个标签都没有）也要有推荐排，不能是一片空白", async () => {
    mount({ allTags: [] });
    await openDialog();
    assert.deepEqual(groupChips("common"), [], "没有常用标签就不渲染这一排");
    assert.equal(groupChips("recommend").length, 6);
});

test("勾上的标签留在原处并变成选中态 —— 点了就消失会数不出勾了哪些", async () => {
    mount();
    await openDialog();
    const target = chip("添加标签 AI");
    await click(target);

    assert.equal(chip("添加标签 AI").getAttribute("aria-pressed"), "true", "要显示成已选");
    assert.deepEqual(
        groupChips("common").map(c => c.textContent),
        ["AI", "工具"],
        "勾上的不能从候选里消失"
    );
});

test("再点一次取消勾选", async () => {
    const { tagged } = mount();
    await openDialog();
    await click(chip("添加标签 AI"));
    await click(chip("添加标签 AI"));
    assert.equal(chip("添加标签 AI").getAttribute("aria-pressed"), "false");

    submit();
    assert.deepEqual(tagged, [], "取消之后提交不该带上任何标签");
});

test("推荐排的标签点了也要算进提交", async () => {
    const { tagged } = mount({ allTags: [] });
    await openDialog();
    const first = groupChips("recommend")[0];
    const label = first.textContent!;
    await click(first);
    submit();
    assert.deepEqual(tagged, [[label]]);
});

test("勾的 + 手打的合并去重后一起提交", async () => {
    const { tagged } = mount();
    await openDialog();
    await click(chip("添加标签 AI"));

    const input = document.querySelector<HTMLInputElement>(".nav-tag-dialog input");
    assert.ok(input, "弹窗里要有标签输入框");
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
        )!.set!;
        setter.call(input!, "AI, 效率");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    submit();
    assert.deepEqual(tagged, [["AI", "效率"]], "AI 勾过一次，不能出现两遍");
});

test("标签超过 12 个时默认只露 12 个，但要有入口够到后面的", async () => {
    const all = Array.from({ length: 15 }, (_, i) => `t${i}`);
    mount({ allTags: all });
    await openDialog();

    // 第一个 chip 是「常用」这个说明文字（span，不是 chip），所以这里的 chip 全是标签 + 展开入口
    const first = groupChips("common");
    assert.equal(first.length, 13, "12 个标签 + 1 个「显示全部」入口");

    const expand = chip(`显示全部 ${all.length} 个标签`);
    assert.ok(expand.textContent!.includes("15"));
    await click(expand);
    assert.equal(
        groupChips("common").length,
        16,
        "展开后 15 个标签 + 1 个「收起」"
    );
});

function submit() {
    const btn = document.querySelector<HTMLButtonElement>(".nav-tag-submit");
    assert.ok(btn, "弹窗里要有提交按钮");
    act(() => {
        btn!.click();
    });
}
