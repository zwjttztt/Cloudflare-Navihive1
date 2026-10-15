// tests/importPreviewDialog.dom.test.tsx
// 导入预览弹窗：写库前的**最后一道闸门**。
//
// computeImportDiff / applyImportSelection 本身有 tests/importDiff.test.ts 盯着，
// 这里盯的是「界面语义」，也就是纯函数测不到的那半边：
//   1. 点取消一定不能写库（这是全站唯一能一键覆盖全部数据的入口）；
//   2. 筛选**只影响显示、不影响勾选** —— 注释里写得清清楚楚，但极容易写反：
//      一旦写反，用户在几百条清单里搜一下关键字，没显示出来的那些就被悄悄放弃了。
//   3. 「全不选」要真的把导入按钮置灰，而不是点了才弹错误。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ImportPreviewDialog from "../src/components/ImportPreviewDialog";
import type { ExportData, Site } from "../src/API/http";
import type { GroupWithSites } from "../src/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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
    configs: {},
    version: "1.2",
    exportDate: "2026-09-26T00:00:00.000Z",
    groups: [
        { id: 1, name: "常用工具", order_num: 0 },
        { id: 3, name: "新增分组", order_num: 2 },
    ],
    sites: [
        site({ id: 11, group_id: 1, name: "云设", url: "https://yunso.net" }),
        site({ id: 12, group_id: 1, name: "示例二（改过）", url: "https://example.com" }),
        site({ id: 31, group_id: 3, name: "新卡片", url: "https://new.example.com" }),
    ],
};

interface Handlers {
    data?: ExportData | null;
    /** 覆盖导入：预览要列「将删除」清单并要求显式确认 */
    overwrite?: boolean;
    onConfirm?: (data: ExportData) => void;
    onCancel?: () => void;
}

function mount(handlers: Handlers = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <ImportPreviewDialog
                open
                data={handlers.data ?? incoming}
                current={current}
                overwrite={handlers.overwrite}
                onCancel={handlers.onCancel ?? (() => {})}
                onConfirm={handlers.onConfirm ?? (() => {})}
            />
        );
    });
}

/** 换一份备份：模拟用户重新选了文件 */
function rerender(handlers: Handlers = {}) {
    act(() => {
        root!.render(
            <ImportPreviewDialog
                open
                data={handlers.data ?? incoming}
                current={current}
                overwrite={handlers.overwrite}
                onCancel={handlers.onCancel ?? (() => {})}
                onConfirm={handlers.onConfirm ?? (() => {})}
            />
        );
    });
}

function cleanup() {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

/** 「导入 3 / 5 项」（覆盖模式是「覆盖导入 5 / 5 项（删除 N）」），带计数只能模糊匹配 */
const importButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(b =>
        /导入\s*\d/.test((b.textContent || "").trim())
    );

async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** 往输入框里打字（受控组件要走 native setter + input 事件，否则 React 收不到） */
async function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
    )?.set;
    await act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
}

const rows = () => document.querySelectorAll<HTMLElement>("[data-import-row]");

const checkedRows = () =>
    [...rows()].filter(
        r => r.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked
    );

// 断言失败时如果没人收尾，MUI 的 Portal 会留在 body 上污染下一条用例，
// 表现为「上一条明明失败了，后面却莫名其妙全绿」。每条末尾手写的 cleanup()
// 只在走到那一行时才生效，这里再兜一层。
afterEach(cleanup);

test("点取消：onConfirm 一次都不许被调用", async () => {
    let confirmed = 0;
    mount({ onConfirm: () => void confirmed++ });
    const cancel = buttonByText("取消");
    assert.ok(cancel, "应有取消按钮");
    await clickAsync(cancel);
    assert.equal(confirmed, 0, "取消是这条链路上最后一道闸门，点了就不能写库");
    cleanup();
});

test("关掉弹窗（右上 X）也走取消，不写库", async () => {
    let confirmed = 0;
    let cancelled = 0;
    mount({ onConfirm: () => void confirmed++, onCancel: () => void cancelled++ });
    const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭导入预览"]');
    assert.ok(close, "应有带 aria-label 的关闭按钮");
    await clickAsync(close);
    assert.equal(confirmed, 0);
    assert.equal(cancelled, 1);
    cleanup();
});

test("增量导入：默认只勾「新增 + 更新」，无变化的不勾", () => {
    mount();
    const checked = [...rows()].filter(r => r.getAttribute("data-status") !== "unchanged");
    const unchecked = [...rows()].filter(r => r.getAttribute("data-status") === "unchanged");
    assert.ok(checked.length > 0);
    for (const row of checked) {
        const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
        assert.equal(box?.checked, true, `${row.getAttribute("data-import-row")} 该被勾上`);
    }
    for (const row of unchecked) {
        const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
        assert.equal(box?.checked, false, "无变化的默认不勾");
    }
    cleanup();
});

test("点一行能切换勾选，计数跟着变", async () => {
    // 放在对象里而不是裸 let：TS 会把「只在回调里赋值」的变量收窄成 null，
    // 后面取 .sites 就报「Property does not exist on type 'never'」
    const captured: { preview: ExportData | null } = { preview: null };
    mount({ onConfirm: d => void (captured.preview = d) });

    const target = [...rows()].find(r => r.getAttribute("data-status") === "unchanged");
    assert.ok(target, "夹具里应有一条无变化的条目");
    const before = importButton()?.textContent ?? "";
    await clickAsync(target!);
    const after = importButton()?.textContent ?? "";
    assert.notEqual(before, after, "勾上一条后「导入 N / M 项」的计数应当变化");

    await clickAsync(importButton()!);
    assert.ok(captured.preview, "确认后应把裁剪过的预览数据交出去");
    assert.equal(
        [...rows()].filter(
            r => r.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked
        ).length,
        (captured.preview.groups?.length ?? 0) + (captured.preview.sites?.length ?? 0),
        "交出去的条目数应与界面上勾选的条目数一致"
    );
    cleanup();
});

test("全不选：导入按钮置灰，且点不动", async () => {
    let confirmed = 0;
    mount({ onConfirm: () => void confirmed++ });
    const none = buttonByText("全不选");
    assert.ok(none);
    await clickAsync(none);
    const btn = importButton();
    assert.ok(btn);
    assert.equal(btn.disabled, true, "一条都没选时导入按钮必须置灰，而不是点了才报错");
    assert.match(btn.textContent ?? "", /导入\s*0\s*\//);
    await clickAsync(btn);
    assert.equal(confirmed, 0);
    cleanup();
});

test("筛选只影响显示，不影响勾选（最容易写反的一条）", async () => {
    const captured: { preview: ExportData | null } = { preview: null };
    mount({ onConfirm: d => void (captured.preview = d) });

    const totalBefore = importButton()?.textContent ?? "";
    const rowCountBefore = rows().length;

    // 按 placeholder 找，不按 aria-label：TextField 上的 aria-label 会落到外层
    // FormControl 上（不是 input），拿它去调 value setter 会直接抛
    // 「called on an object that is not a valid instance of HTMLInputElement」。
    const search = [...document.querySelectorAll<HTMLInputElement>("input")].find(i =>
        (i.getAttribute("placeholder") || "").includes("在清单里找")
    );
    assert.ok(search, "应有清单搜索框");
    await typeInto(search, "云设");

    const rowCountAfter = rows().length;
    assert.ok(rowCountAfter < rowCountBefore, "搜索后列表应当变短，否则这条没在测筛选");
    assert.equal(
        importButton()?.textContent ?? "",
        totalBefore,
        "搜索只是「看清」，勾选项一个都不能少 —— 写反的话用户搜一下就悄悄丢数据"
    );

    await clickAsync(importButton()!);
    assert.ok(captured.preview);
    assert.ok(
        (captured.preview.sites?.length ?? 0) > 0,
        "被筛掉的条目依然要在交出去的数据里"
    );
    cleanup();
});

test("预览里不再预告任何删除：这一页以前会说「覆盖后还会删掉 N 个分组」", () => {
    mount();
    const text = document.body.textContent ?? "";
    assert.doesNotMatch(text, /覆盖/, "不该再有覆盖的说法");
    assert.doesNotMatch(text, /还会删掉/, "不该预告会删任何东西");
    assert.match(text, /增量合并/, "要说明现在是不删数据的增量合并");
    cleanup();
});

test("data 为空时不渲染（没有备份却弹个空窗会让人以为导入了空数据）", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <ImportPreviewDialog
                open
                data={null}
                current={current}
                onCancel={() => {}}
                onConfirm={() => {}}
            />
        );
    });
    assert.equal(document.body.textContent?.includes("导入预览"), false);
    cleanup();
});

// ============ 下面这半边是后补的：默认勾选的**播种时机**与批量按钮 ============
// 上面已经盯住了「筛选不改勾选」和「全不选要置灰」，但还差两类：
//   1. 换一份备份时要按新规则重新勾一遍（seededFor 那段渲染期 setState）。
//      写错的表现是「上一次的勾选莫名其妙留到了这一份备份上」。
//   2. 「不勾选」= 那条不动，绝不是「那条会被删」——以前覆盖模式下还得靠全选来自救。

test("没有覆盖模式了：不再存在「必须全选否则丢数据」的压力", () => {
    mount();
    assert.equal(rows().length, 5, "2 个分组 + 3 张卡片");
    assert.equal(
        checkedRows().length,
        3,
        "默认只勾新增 + 更新；没勾的那两条是无变化，导入时原位不动（不是被删）"
    );
});

test("换一份备份：按新数据的默认规则重新勾一遍", async () => {
    const captured: { preview: ExportData | null } = { preview: null };
    mount({ onConfirm: d => void (captured.preview = d) });
    const none = buttonByText("全不选");
    assert.ok(none);
    await clickAsync(none);
    assert.equal(checkedRows().length, 0);

    // 用户重新选了一份备份（内容一样，但是另一个对象）
    rerender({ data: { ...incoming }, onConfirm: d => void (captured.preview = d) });
    assert.equal(
        checkedRows().length,
        3,
        "换了数据要重新播种，不能把上一次的「全不选」留着"
    );
});

test("同一份数据反复渲染不重新播种（勾选状态要稳）", () => {
    mount();
    assert.equal(checkedRows().length, 3);
    rerender({ data: incoming });
    assert.equal(checkedRows().length, 3, "数据对象没换，勾选不该被重置");
});

test("「只看新增与更新」只勾这两类，无变化的留空", async () => {
    mount();
    const all = buttonByText("全选");
    assert.ok(all);
    await clickAsync(all);
    assert.equal(checkedRows().length, 5);

    const only = buttonByText("只看新增与更新");
    assert.ok(only);
    await clickAsync(only);

    const statuses = checkedRows().map(r => r.getAttribute("data-status"));
    assert.equal(statuses.length, 3);
    assert.equal(statuses.includes("unchanged"), false, "无变化的不该被勾上");
});

test("取消勾选一条后，交出去的数据里真的没有它", async () => {
    const captured: { preview: ExportData | null } = { preview: null };
    mount({ onConfirm: d => void (captured.preview = d) });

    const target = [...rows()].find(r => r.getAttribute("data-status") === "added");
    assert.ok(target, "夹具里应有一条「新增」");
    await clickAsync(target!);
    assert.equal(
        target!.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
        false
    );

    await clickAsync(importButton()!);
    assert.ok(captured.preview);
    const names = (captured.preview.sites ?? []).map(s => s.name);
    assert.equal(
        names.includes("新卡片"),
        false,
        "取消勾选的那条不该出现在交出去的数据里"
    );
    assert.equal(names.includes("示例二（改过）"), true, "别的勾选照常导出");
});

// ============ 覆盖导入：删除清单 + 显式确认闸门 ============

test("覆盖导入：列出将删除清单，确认前导入按钮置灰", async () => {
    let confirmed = 0;
    mount({ overwrite: true, onConfirm: () => void confirmed++ });

    const text = document.body.textContent ?? "";
    assert.match(text, /将删除\s*1/, "「开发」分组不在备份里，要预告删除");
    assert.match(text, /开发/, "删除清单里要能看到名字");
    assert.match(text, /覆盖导入/, "要说明当前是覆盖模式");

    // 覆盖默认全选（没勾的会被删，默认值必须保守）
    assert.equal(checkedRows().length, 5);

    const btn = importButton();
    assert.ok(btn);
    assert.equal(btn.disabled, true, "没勾「我已确认删除」就不许放行");

    const ack = document.querySelector<HTMLInputElement>('[aria-label="确认删除这些条目"]');
    assert.ok(ack, "要有删除确认勾选框");
    await clickAsync(ack);
    assert.equal(importButton()!.disabled, false, "确认之后才放行");
    await clickAsync(importButton()!);
    assert.equal(confirmed, 1);
});

test("覆盖导入：没有要删的东西时不挡人（备份覆盖一份同构数据应当一路绿灯）", () => {
    const same = {
        ...incoming,
        groups: [...incoming.groups, { id: 2, name: "开发", order_num: 1 }],
        sites: [
            ...incoming.sites,
            // 「开发」分组里的本地卡片也必须在备份里，否则它要被删
            site({ id: 21, group_id: 2, name: "示例三", url: "https://example.org" }),
        ],
    };
    mount({ overwrite: true, data: same });
    assert.match(document.body.textContent ?? "", /将删除\s*0/);
    assert.equal(importButton()!.disabled, false, "没有删除就不需要确认");
});

test("覆盖导入：取消勾选一条，它要立刻出现在将删除清单里", async () => {
    mount({ overwrite: true });
    const target = [...rows()].find(
        r => (r.textContent || "").includes("新卡片")
    );
    assert.ok(target, "夹具里应有「新卡片」");
    await clickAsync(target!);
    // 新卡片没勾 → 它不在要导入的数据里 → 覆盖时它所在的「新增分组」也不在 → 无连带；
    // 但备份里没有别的卡片挂在常用工具/开发之外，删的是「新卡片」自己吗？
    // 不：删除清单算的是「本地有、裁剪后的备份里没有」——新卡片本来就是新增项，
    // 本地没有它，所以不进删除清单；真正变化的是「新增分组」没人勾了也不影响本地。
    assert.match(
        document.body.textContent ?? "",
        /将删除\s*1/,
        "清单本身不该被这次取消勾选改变（本地没有这张卡）"
    );
});

test("覆盖导入：取消勾选一个已有分组里的卡片，那张卡要进删除清单", async () => {
    mount({ overwrite: true });
    const target = [...rows()].find(r => (r.textContent || "").includes("云设"));
    assert.ok(target, "夹具里应有「云设」");
    await clickAsync(target!);
    assert.match(
        document.body.textContent ?? "",
        /云设/,
        "勾掉一张本地已有的卡，它就成了「备份里没有」，必须如实列进删除清单"
    );
});
