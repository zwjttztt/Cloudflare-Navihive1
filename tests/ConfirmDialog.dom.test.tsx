// tests/ConfirmDialog.dom.test.tsx
// 第一个组件级用例。文件名走 *.dom.test.tsx，运行器会为它单独补一套 jsdom 环境
// （见 script/unit-tests.mjs：纯函数用例只给一个 localStorage 替身，组件用例给完整 DOM）。
//
// 为什么先拿 ConfirmDialog 开刀：站内所有破坏性操作（删卡片、删分组、批量删除、清空访问
// 记录……）都走它。它的回调一旦接错，后果是「点了删除什么都没发生」或者更糟——
// 「点了取消却真删了」。这类错误散落在 264 条黑盒冒烟里不容易覆盖全，而在这里几行就能钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ConfirmDialog from "../src/components/ConfirmDialog";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 在真实 DOM 里挂载一个组件（MUI 的 Dialog 会 portal 到 body，所以查 body 而不是 host） */
function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
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

/** 按可见文字找按钮 */
const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

const allButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];

/** 只数**带可见文字**的按钮：弹窗右上角还有个纯图标的关闭按钮，不该混进动作按钮的计数 */
const labeledButtons = () =>
    allButtons().filter(b => (b.textContent || "").trim() !== "");

/** 合成一次点击；MUI 的按钮就是普通 onClick，冒泡的 click 事件足够 */
function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** 统计回调调用次数 */
function counter() {
    const calls: unknown[] = [];
    return {
        calls,
        fn: (...args: unknown[]) => void calls.push(args),
        get count() {
            return calls.length;
        },
    };
}

test("ConfirmDialog：默认渲染标题与正文，并给出「确定 / 取消」", t => {
    t.after(cleanup);
    mount(
        <ConfirmDialog
            open
            title='删除「示例站点」'
            description='删除后可以用撤销找回来。'
            onConfirm={() => {}}
            onClose={() => {}}
        />
    );

    const text = document.body.textContent || "";
    assert.ok(text.includes("删除「示例站点」"), "标题应渲染出来");
    assert.ok(text.includes("删除后可以用撤销找回来。"), "正文应渲染出来");
    assert.ok(buttonByText("确定"), "应有默认的「确定」按钮");
    assert.ok(buttonByText("取消"), "应有默认的「取消」按钮");
});

test("ConfirmDialog：confirmText / cancelText 可覆盖默认文案", t => {
    t.after(cleanup);
    mount(
        <ConfirmDialog
            open
            title='清空记录'
            confirmText='清空'
            cancelText='算了'
            onConfirm={() => {}}
            onClose={() => {}}
        />
    );

    assert.ok(buttonByText("清空"), "应显示自定义的确认文案");
    assert.ok(buttonByText("算了"), "应显示自定义的取消文案");
    assert.equal(buttonByText("确定"), undefined, "默认文案应被覆盖掉");
});

test("ConfirmDialog：点「取消」只触发 onClose，绝不触发 onConfirm", t => {
    t.after(cleanup);
    const confirm = counter();
    const close = counter();
    mount(
        <ConfirmDialog open title='删除分组' onConfirm={confirm.fn} onClose={close.fn} />
    );

    const cancelBtn = buttonByText("取消");
    assert.ok(cancelBtn, "应有取消按钮");
    click(cancelBtn!);

    assert.equal(close.count, 1, "onClose 应被调用一次");
    assert.equal(confirm.count, 0, "onConfirm 不该被调用——这条错了就是「点取消反而删了」");
});

test("ConfirmDialog：点确认触发 onConfirm，成功后自己关掉（调用方不用再写 finally）", async t => {
    t.after(cleanup);
    const confirm = counter();
    const close = counter();
    mount(
        <ConfirmDialog open title='删除卡片' onConfirm={confirm.fn} onClose={close.fn} />
    );

    const okBtn = buttonByText("确定");
    assert.ok(okBtn, "应有确认按钮");
    click(okBtn!);
    // 确认是 async 的（哪怕回调本身是同步函数），要等一个微任务让状态落下来
    await act(async () => {});

    assert.equal(confirm.count, 1, "onConfirm 应被调用一次");
    assert.equal(close.count, 1, "成功后应由弹窗自己关闭");
});

test("ConfirmDialog：提交中禁重复点击——连点三次只执行一次，按钮全程禁用", async t => {
    t.after(cleanup);
    const confirm = counter();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    mount(
        <ConfirmDialog
            open
            title='删除 37 个网站'
            busyText='删除中…'
            onConfirm={() => {
                confirm.fn();
                return gate;
            }}
            onClose={() => {}}
        />
    );

    const okBtn = buttonByText("确定")!;
    click(okBtn);
    await act(async () => {});
    assert.equal(confirm.count, 1, "第一次点击应生效");

    // 提交中：按钮变成 disabled，文案切到 busyText
    const busyLabel = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b =>
        (b.textContent || "").includes("删除中…")
    );
    assert.ok(busyLabel, "提交中应显示 busyText");
    assert.ok(busyLabel!.disabled, "提交中确认按钮必须禁用");
    assert.ok(
        buttonByText("取消")!.disabled,
        "提交中连「取消」也要禁用：否则一边跑着请求一边把弹窗收掉"
    );

    // 再来两下（模拟手抖双击 / 键盘连按）
    click(busyLabel!);
    click(busyLabel!);
    await act(async () => {});
    assert.equal(confirm.count, 1, "提交期间的重复点击必须被吃掉");

    release();
    await act(async () => {});
});

test("ConfirmDialog：失败不关闭表单——reject 后弹窗留在原地，可以再点一次", async t => {
    t.after(cleanup);
    const confirm = counter();
    const close = counter();
    let attempt = 0;
    mount(
        <ConfirmDialog
            open
            title='清空回收站'
            onConfirm={() => {
                attempt += 1;
                confirm.fn();
                // 第一次失败，第二次成功
                return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
            }}
            onClose={close.fn}
        />
    );

    click(buttonByText("确定")!);
    await act(async () => {});
    assert.equal(close.count, 0, "失败时不该关闭——关了用户就得重走一遍流程");
    assert.ok(buttonByText("确定"), "确认按钮应恢复可用");

    click(buttonByText("确定")!);
    await act(async () => {});
    assert.equal(confirm.count, 2, "失败后应能再点一次");
    assert.equal(close.count, 1, "第二次成功后才关闭");
});

test("ConfirmDialog：impact 写出影响对象、数量与可撤销性", t => {
    t.after(cleanup);
    mount(
        <ConfirmDialog
            open
            title='删除标签'
            danger
            impact={{ object: "网站", count: 12, undoable: true }}
            onConfirm={() => {}}
            onClose={() => {}}
        />
    );
    const text = document.body.textContent || "";
    assert.ok(text.includes("影响范围：网站 12 项"), `应写出对象与数量，实际 ${text}`);
    assert.ok(text.includes("可撤销"), "应说明可撤销");
    cleanup();

    mount(
        <ConfirmDialog
            open
            title='清空回收站'
            danger
            impact={{ object: "回收站条目", count: 5, undoable: false }}
            onConfirm={() => {}}
            onClose={() => {}}
        />
    );
    const text2 = document.body.textContent || "";
    assert.ok(text2.includes("不可撤销"), "不可撤销时要明说，不能拿「进回收站」含糊过去");
    assert.ok(!text2.includes("可撤销，"), "不该出现自相矛盾的措辞");
});

test("ConfirmDialog：不传 impact 时不编造影响面", t => {
    t.after(cleanup);
    mount(<ConfirmDialog open title='继续' onConfirm={() => {}} onClose={() => {}} />);
    const text = document.body.textContent || "";
    assert.ok(!text.includes("影响范围"), "没给信息就不要凭空显示一行");
});

test("ConfirmDialog：extraAction 传了才渲染，且排在「取消」左边、只触发自己", t => {
    t.after(cleanup);
    const confirm = counter();
    const close = counter();
    const extra = counter();

    mount(
        <ConfirmDialog
            open
            title='链接重复'
            extraAction={{ label: "跳到那张", onClick: extra.fn }}
            onConfirm={confirm.fn}
            onClose={close.fn}
        />
    );

    const extraBtn = buttonByText("跳到那张");
    assert.ok(extraBtn, "传了 extraAction 就该多出一个按钮");

    // 顺序：辅助动作 → 取消 → 确定
    const labels = labeledButtons().map(b => (b.textContent || "").trim());
    const iExtra = labels.indexOf("跳到那张");
    const iCancel = labels.indexOf("取消");
    const iConfirm = labels.indexOf("确定");
    assert.ok(iExtra < iCancel, `辅助按钮应排在「取消」左边，实际顺序 ${JSON.stringify(labels)}`);
    assert.ok(iCancel < iConfirm, `「取消」应排在确认左边，实际顺序 ${JSON.stringify(labels)}`);

    click(extraBtn!);
    assert.equal(extra.count, 1, "应触发 extraAction.onClick");
    assert.equal(confirm.count, 0, "辅助动作不该顺手确认");
    assert.equal(close.count, 0, "辅助动作不该关掉弹窗");
});

test("ConfirmDialog：没传 extraAction 时只有「取消 / 确定」两个动作按钮", t => {
    t.after(cleanup);
    mount(<ConfirmDialog open title='删除' onConfirm={() => {}} onClose={() => {}} />);
    const labels = labeledButtons().map(b => (b.textContent || "").trim());
    assert.deepEqual(labels, ["取消", "确定"], JSON.stringify(labels));
});

test("ConfirmDialog：danger 时确认按钮走错误色，普通时走主色", t => {
    t.after(cleanup);

    mount(<ConfirmDialog open title='删除' danger onConfirm={() => {}} onClose={() => {}} />);
    const dangerClass = buttonByText("确定")?.className || "";
    cleanup();

    mount(<ConfirmDialog open title='继续' onConfirm={() => {}} onClose={() => {}} />);
    const normalClass = buttonByText("确定")?.className || "";

    assert.ok(/Error/.test(dangerClass), `危险操作应有错误色类名，实际 ${dangerClass}`);
    assert.ok(
        !/Error/.test(normalClass),
        `非危险操作不该带错误色类名，实际 ${normalClass}`
    );
});
