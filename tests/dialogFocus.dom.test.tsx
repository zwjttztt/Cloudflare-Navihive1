// tests/dialogFocus.dom.test.tsx
// P2-18：弹窗的「焦点陷阱 / 焦点归位」DOM 守卫。
//
// 为什么要有它：全站弹窗统一走 MUI Dialog（ConfirmDialog 是使用面最广的一个）。
// MUI 自带焦点管理，但这件事**没有任何自动检查在守着** —— 一旦有人给 Dialog 传了
// `disableAutoFocus` / `disableRestoreFocus`，或把它换成自绘的 div 弹窗，键盘用户的
// 焦点就会漏到背后的页面上（读屏会念到遮罩后面的东西），而所有现有用例都不会红。
//
// 这里钉住三条最小但关键的行为：
//   1. 打开后焦点进入弹窗（aria-modal 容器内）；
//   2. Tab 一下焦点仍在弹窗内（不逃到背景页）；
//   3. 关闭后焦点回到打开它的那个按钮（不丢到 body）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ConfirmDialog from "../src/components/ConfirmDialog";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

/** 等一轮宏任务：MUI Modal 的焦点迁移/归位都在 effect + 定时器里完成 */
async function tick() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

/** 等退场过渡跑完：MUI Dialog 关闭后要先播完 Fade（默认 ~225ms）才真正卸载 */
async function waitExit() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 350));
    });
}

/** 带触发按钮的受控外壳：真实形态就是「点按钮开弹窗」 */
function Harness() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button id='open-confirm' onClick={() => setOpen(true)}>
                打开确认
            </button>
            <ConfirmDialog
                open={open}
                title='确认删除'
                description='这条记录将被删除。'
                impact={{ object: "网站", count: 2, undoable: false }}
                danger
                onConfirm={() => setOpen(false)}
                onClose={() => setOpen(false)}
            />
        </>
    );
}

function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Harness />);
    });
}

function queryDialog(): HTMLElement | null {
    return document.querySelector('[role="dialog"]') as HTMLElement | null;
}

test("打开弹窗后焦点进入弹窗，且容器声明 aria-modal", async () => {
    mount();
    const trigger = host!.querySelector("#open-confirm") as HTMLButtonElement;
    trigger.focus();
    assert.equal(document.activeElement, trigger, "前置：触发按钮已获得焦点");

    act(() => {
        trigger.click();
    });
    await tick();

    const dialog = queryDialog();
    assert.ok(dialog, "弹窗应已渲染（role=dialog）");
    assert.equal(dialog!.getAttribute("aria-modal"), "true", "弹窗必须声明 aria-modal=true");
    assert.ok(
        dialog!.contains(document.activeElement),
        "打开后焦点必须进入弹窗（否则键盘/读屏会落到遮罩后的页面）"
    );
});

test("弹窗内 Tab 不会把焦点漏到背景页", async () => {
    mount();
    const trigger = host!.querySelector("#open-confirm") as HTMLButtonElement;
    trigger.focus();
    act(() => {
        trigger.click();
    });
    await tick();

    const dialog = queryDialog();
    assert.ok(dialog, "弹窗应已渲染");

    // 连按几次 Tab：无论 MUI 把焦点在弹窗内怎么循环，都不能回到背景页
    for (let i = 0; i < 6; i += 1) {
        act(() => {
            document.activeElement!.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
            );
        });
        await tick();
        assert.ok(
            dialog!.contains(document.activeElement),
            `第 ${i + 1} 次 Tab 后焦点漏出了弹窗：${document.activeElement?.outerHTML?.slice(0, 80)}`
        );
    }
});

test("关闭弹窗后焦点归位到触发按钮", async () => {
    mount();
    const trigger = host!.querySelector("#open-confirm") as HTMLButtonElement;
    trigger.focus();
    act(() => {
        trigger.click();
    });
    await tick();

    const dialog = queryDialog();
    assert.ok(dialog, "弹窗应已渲染");

    const cancel = dialog!.querySelector('[data-confirm-action="cancel"]') as HTMLButtonElement | null;
    assert.ok(cancel, "弹窗里应有取消按钮");
    act(() => {
        cancel!.click();
    });
    await waitExit();

    // ⚠️ 不要用 assert.equal 比 DOM 节点：失败时 Node 会去序列化整个元素，
    // 实测直接把进程搞成 RangeError（Array buffer allocation failed）。
    assert.ok(queryDialog() === null, "取消后弹窗应关闭");
    assert.ok(
        document.activeElement === trigger,
        "关闭后焦点必须回到打开它的按钮（不能掉到 body 上）"
    );
});
