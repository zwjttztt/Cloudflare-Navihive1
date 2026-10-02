// tests/SiteSettingsModal.dom.test.tsx
// 第二个组件级用例：网站设置弹窗（改站点信息的主入口，737 行）。
//
// 为什么是它：所有「改一张卡片」的操作都走这里。它身上有几个错了就会被用户立刻察觉、
// 但黑盒冒烟很难钉死的约定：
//   - 没改动就点保存，应该静默关闭（不该弹「已更新」，更不该写库）
//   - 点「删除」不能直接删，必须先弹站内确认框
//   - 站点没图标时，打开就按「图标 API 模板 + 链接」自动补一个
// 这几条散在 265 条冒烟里覆盖不全，在这里几行就能锁死。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteSettingsModal from "../src/components/SiteSettingsModal";
import { AppConfigProvider } from "../src/context/AppConfigContext";
import type { AppConfigContextValue } from "../src/context/appConfigStore";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Site } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const CONFIG: AppConfigContextValue = {
    iconApi: "https://ico.example/{domain}",
    thumbApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

function makeSite(overrides: Partial<Site> = {}): Site {
    return {
        id: 7,
        group_id: 3,
        name: "示例站点",
        url: "https://www.example.com",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
        ...overrides,
    };
}

/** 组件依赖 AppConfig（图标 API）与 UIPrefs（星标/标签），用真实 Provider 包一层 */
function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <AppConfigProvider value={CONFIG}>
                <UIPrefsProvider>{ui}</UIPrefsProvider>
            </AppConfigProvider>
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

/** 弹窗会叠加（主弹窗 + 删除确认），取最后一个才是当前最上层的那个 */
const topDialogButtons = (): HTMLButtonElement[] => {
    const papers = [...document.querySelectorAll(".MuiDialog-paper")];
    const top = papers[papers.length - 1];
    return top ? [...top.querySelectorAll<HTMLButtonElement>("button")] : [];
};

/**
 * 按 MUI 的 label 文案找到对应输入框（比按 DOM 顺序稳）。
 * 必填字段 MUI 会在 label 后面追加一个「*」，比对前先抹掉。
 */
function inputByLabel(label: string): HTMLInputElement | null {
    const norm = (s: string) => (s || "").trim().replace(/\s*\*\s*$/, "").trim();
    const fc = [...document.querySelectorAll(".MuiFormControl-root")].find(
        el => norm(el.querySelector("label")?.textContent ?? "") === norm(label)
    );
    return fc ? fc.querySelector("input") : null;
}

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/**
 * 给受控输入赋值：必须走原生 value setter 再派发 input，
 * 直接改 el.value 会被 React 的 value tracker 吞掉，onChange 不触发。
 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function counter<T = unknown>() {
    const calls: T[] = [];
    return {
        calls,
        // rest 参数：onUpdate 要 (site) => void、onClose 只要 () => void，
        // 形参个数写死成 1 就没法赋给零参数的那个
        fn: (...args: unknown[]) => void calls.push(args[0] as T),
        get count() {
            return calls.length;
        },
    };
}

test("SiteSettingsModal：站点没图标时，打开就按图标 API 模板自动补一个", t => {
    t.after(cleanup);
    const update = counter<Site>();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );

    const iconInput = inputByLabel("图标 URL");
    assert.ok(iconInput, "应能找到「图标 URL」输入框");
    assert.equal(
        iconInput!.value,
        "https://ico.example/www.example.com",
        `应把 {domain} 换成真实域名，实际 ${iconInput!.value}`
    );
});

test("SiteSettingsModal：什么都不改点「保存」→ 只关闭，不写库", t => {
    t.after(cleanup);
    const update = counter<Site>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "https://already/set.png" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={close.fn}
        />
    );

    const saveBtn = buttonByText("保存");
    assert.ok(saveBtn, "应有保存按钮");
    click(saveBtn!);

    assert.equal(close.count, 1, "应关闭弹窗");
    assert.equal(update.count, 0, "没改动就不该触发 onUpdate（否则会误弹「已更新」）");
});

test("SiteSettingsModal：改了名称再保存 → onUpdate 收到新值且 group_id 是数字", t => {
    t.after(cleanup);
    const update = counter<Site>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "https://already/set.png" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={close.fn}
        />
    );

    const nameInput = inputByLabel("网站名称");
    assert.ok(nameInput, "应能找到「网站名称」输入框");
    setInputValue(nameInput!, "改过的名字");

    const saveBtn = buttonByText("保存");
    click(saveBtn!);

    assert.equal(update.count, 1, "改动后保存应触发 onUpdate");
    const payload = update.calls[0] as Site;
    assert.equal(payload.name, "改过的名字", "新名称应带出去");
    assert.equal(typeof payload.group_id, "number", "group_id 应转成数字");
    assert.equal(payload.id, 7, "站点 id 应保留");
    assert.equal(close.count, 1, "保存后应关闭");
});

test("SiteSettingsModal：点「删除」不直接删，先弹站内二次确认", t => {
    t.after(cleanup);
    const del = counter<number>();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x" })}
            onUpdate={() => {}}
            onDelete={del.fn}
            onClose={() => {}}
        />
    );

    const deleteBtn = buttonByText("删除");
    assert.ok(deleteBtn, "应有删除按钮");
    click(deleteBtn!);

    assert.equal(del.count, 0, "第一次点删除不能直接删——必须等用户再确认一次");
    const text = document.body.textContent || "";
    assert.ok(text.includes("删除这个网站？"), "应弹出确认框");
});

test("SiteSettingsModal：确认框里点「删除」→ 才真的删，并带上站点 id", t => {
    t.after(cleanup);
    const del = counter<number>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x" })}
            onUpdate={() => {}}
            onDelete={del.fn}
            onClose={close.fn}
        />
    );

    click(buttonByText("删除")!);
    // 确认框是后弹出的，取最上层那个弹窗里的「删除」
    const confirmBtn = topDialogButtons().find(b => (b.textContent || "").trim() === "删除");
    assert.ok(confirmBtn, "确认框里应有确认删除按钮");
    click(confirmBtn!);

    assert.equal(del.count, 1, "确认后应触发 onDelete");
    assert.equal(del.calls[0], 7, "onDelete 应收到站点 id");
    assert.equal(close.count, 1, "删除后应关闭弹窗");
});

test("SiteSettingsModal：密码默认掩码，点「显示密码」才变明文", t => {
    t.after(cleanup);
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x", password: "secret123" })}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );

    const pwdInput = inputByLabel("密码");
    assert.ok(pwdInput, "应能找到密码输入框");
    assert.equal(pwdInput!.getAttribute("type"), "password", "默认应掩码");

    const eye = document.querySelector<HTMLButtonElement>('[aria-label="显示密码"]');
    assert.ok(eye, "应有显示密码按钮");
    click(eye!);

    assert.equal(
        inputByLabel("密码")?.getAttribute("type"),
        "text",
        "点过之后应切为明文"
    );
});
