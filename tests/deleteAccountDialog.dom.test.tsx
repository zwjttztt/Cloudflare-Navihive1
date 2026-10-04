// tests/deleteAccountDialog.dom.test.tsx
// 注销账号弹窗。
//
// 全站最不可逆的操作，而且它把守的是一条**安全**约束，不只是交互细节：
//   「只凭『当前是登录状态』就允许注销，等于捡到一台已登录的电脑就能毁掉整个账号。」
// 所以注销要求再输一次当前密码。这条约束此前一个用例都没有 —— 改坏了的表现是
// 「弹窗照常弹出、按钮照常可点」，冒烟根本看不出来。
//
// 另一条容易漏的是 busy 期间的状态：注销请求发出去之后，关闭按钮必须失效
// （onClose 里那句 `busy ? undefined : onClose()`）。不然用户能在请求飞行途中关掉
// 弹窗，然后面对一个「到底注销没注销」的页面。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DeleteAccountDialog from "../src/components/DeleteAccountDialog";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

let confirmCalls = 0;
let closeCalls = 0;

interface MountOpts {
    password?: string;
    busy?: boolean;
    username?: string;
}

/**
 * 受控组件：password 由外部 state 提供，所以这里用 onPasswordChange 回写，
 * 模拟真实用法（App 里就是这么接的）。
 */
let currentPassword = "";

function mount(opts: MountOpts = {}) {
    confirmCalls = 0;
    closeCalls = 0;
    currentPassword = opts.password ?? "";

    const render = () => {
        act(() => {
            root!.render(
                <DeleteAccountDialog
                    open
                    username={opts.username}
                    busy={opts.busy ?? false}
                    password={currentPassword}
                    onPasswordChange={v => {
                        currentPassword = v;
                        render();
                    }}
                    onConfirm={() => {
                        confirmCalls += 1;
                    }}
                    onClose={() => {
                        closeCalls += 1;
                    }}
                />
            );
        });
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render();
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

// 兜底：断言失败会跳过用例末尾那句 cleanup，残留的弹窗会污染下一条
afterEach(cleanup);

const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

const confirmButton = () => buttonByText("确认注销") ?? buttonByText("注销中…");

const passwordInput = () =>
    document.querySelector<HTMLInputElement>("#delete-account-password");

async function typePassword(value: string) {
    const input = passwordInput();
    assert.ok(input, "要有密码框");
    await act(async () => {
        // React 受控组件要走原生 setter 才能触发 onChange
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
}

async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

test("没输密码时不能注销 —— 这是这个弹窗存在的全部意义", () => {
    mount();
    const btn = confirmButton();
    assert.ok(btn, "要有确认按钮");
    assert.equal(
        btn.disabled,
        true,
        "只凭登录状态就能注销的话，捡到已登录的电脑就能毁掉整个账号"
    );
    cleanup();
});

test("输了密码才解锁注销按钮", async () => {
    mount();
    await typePassword("hunter2");
    assert.equal(confirmButton()?.disabled, false);
    cleanup();
});

test("只有空格不算输过密码", async () => {
    mount();
    await typePassword("   ");
    assert.equal(confirmButton()?.disabled, true);
    cleanup();
});

test("点确认真的调起注销", async () => {
    mount({ password: "hunter2" });
    await clickAsync(confirmButton()!);
    assert.equal(confirmCalls, 1);
    cleanup();
});

test("注销进行中：按钮禁用且文案变「注销中…」", () => {
    mount({ password: "hunter2", busy: true });
    const btn = confirmButton();
    assert.equal(btn?.disabled, true, "请求飞行期间不能再点一次");
    assert.equal((btn?.textContent || "").trim(), "注销中…");
    cleanup();
});

async function pressEscape() {
    // MUI 把 keydown 绑在 Modal 的根节点上（不是 document），得往弹窗里派发再冒泡上去
    const dialog =
        document.querySelector<HTMLElement>('[role="dialog"]') ??
        document.querySelector<HTMLElement>(".MuiDialog-root") ??
        document;
    await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await Promise.resolve();
    });
}

test("注销进行中点取消不生效 —— 不能在请求飞行途中关掉弹窗", async () => {
    mount({ password: "hunter2", busy: true });
    const cancel = buttonByText("取消");
    assert.ok(cancel);
    await clickAsync(cancel);
    assert.equal(closeCalls, 0, "关掉之后用户就不知道到底注销没注销了");
    cleanup();
});

test("注销进行中按 ESC 也不关闭（那句 busy 守卫管的是遮罩 / 键盘）", async () => {
    // 「取消」按钮自己有 disabled，但点遮罩和按 ESC 走的是 Dialog 的 onClose ——
    // 两个入口都得堵上，否则用户还是能在注销飞行途中把弹窗关掉
    mount({ password: "hunter2", busy: true });
    await pressEscape();
    assert.equal(closeCalls, 0);
    cleanup();
});

test("不忙的时候按 ESC 是可以关的", async () => {
    mount({ password: "hunter2" });
    await pressEscape();
    assert.equal(closeCalls, 1);
    cleanup();
});

test("注销进行中密码框也锁上", () => {
    mount({ password: "hunter2", busy: true });
    assert.equal(passwordInput()?.disabled, true);
    cleanup();
});

test("不忙的时候关闭是生效的", async () => {
    mount({ password: "hunter2" });
    await clickAsync(buttonByText("取消")!);
    assert.equal(closeCalls, 1);
    cleanup();
});

test("回车提交：只在填了密码且不忙时才触发", async () => {
    mount();
    const input = passwordInput();
    assert.ok(input);

    // 空密码时回车不该注销
    await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await Promise.resolve();
    });
    assert.equal(confirmCalls, 0);

    await typePassword("hunter2");
    await act(async () => {
        passwordInput()!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
        await Promise.resolve();
    });
    assert.equal(confirmCalls, 1);
    cleanup();
});

test("提示里要说清「注销的是哪个账号」和「不可恢复」", () => {
    mount({ username: "admin" });
    const text = document.body.textContent || "";
    assert.ok(text.includes("admin"), "不点名账号，用户可能以为在注销别的号");
    assert.ok(text.includes("无法恢复") || text.includes("不可撤销"));
    assert.ok(text.includes("备份"), "要提醒先备份再注销");
    cleanup();
});

test("注销中按回车也不会重复提交", async () => {
    mount({ password: "hunter2", busy: true });
    const input = passwordInput();
    assert.ok(input);
    await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await Promise.resolve();
    });
    assert.equal(confirmCalls, 0);
    cleanup();
});
