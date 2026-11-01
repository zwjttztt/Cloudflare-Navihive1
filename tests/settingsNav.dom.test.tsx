// tests/settingsNav.dom.test.tsx
// 设置中心左栏的**搜索过滤**（单独挂 SettingsWorkspaceNav）。
//
// 为什么单独一个 dom 文件、而不塞进 tests/navigationCenter.dom.test.tsx：
//   · 那一个要挂出整个 MUI Dialog + 两级 lazy，一条用例就是几百毫秒、几百 MB；
//     这里零 lazy、零 Dialog，直接挂左栏，毫秒级、永远不会撞上
//     "Array buffer allocation failed" 那个坑；
//   · 过滤的所有交互（打字、清除、↓、Esc）都只发生在左栏内部，
//     和中心 / 面板没有任何关系，挂整个中心反而让失败原因更难定位。
//
// 钉的四件事（都是「改错了不报错，只有手点才发现」）：
//   1. 输入即过滤、清空即恢复（含分组分割线的下标必须是过滤后的）；
//   2. 空态给出两步提示，且**不放**第二颗「清空」按钮（Tab 到一个什么都不做的按钮很差）；
//   3. ↓ 把焦点交给第一个可见条目（键盘用户不必 Tab 穿过整列）；
//   4. Esc 有词时只清空搜索、**不冒出去**（冒出去 = 中心被关掉，MUI 不看 defaultPrevented）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SettingsWorkspaceNav from "../src/components/settingsWorkspace/SettingsWorkspaceNav";
import type {
    WorkspaceNavGroup,
    WorkspaceNavItem,
} from "../src/components/settingsWorkspace/SettingsWorkspaceNav";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

/** 样本：三个分组 5 条，label / 别名 / 说明 三面都有内容可搜 */
const GROUPS: WorkspaceNavGroup[] = [
    {
        title: "数据与活动",
        items: [
            { id: "stats", label: "统计", icon: null, searchText: "统计 排行 访问统计与运营看板" },
            {
                id: "audit",
                label: "审计日志",
                icon: null,
                searchText: "审计日志 记录 谁在什么时候改了什么",
            },
        ],
    },
    {
        title: "外观与工具",
        items: [
            {
                id: "config-appearance",
                label: "外观与搜索",
                icon: null,
                searchText: "外观与搜索 主题 站点名称主色自定义 CSS",
            },
            { id: "ai", label: "AI 设置", icon: null, searchText: "AI 设置 密钥 模型服务" },
        ],
    },
    {
        title: "个人与支持",
        items: [
            {
                id: "shortcuts",
                label: "快捷键与操作帮助",
                icon: null,
                searchText: "快捷键与操作帮助 键盘 安装到桌面",
            },
        ],
    },
];

const DANGER: WorkspaceNavItem[] = [{ id: "logout", label: "退出登录", icon: null }];

const ALL_IDS = ["stats", "audit", "config-appearance", "ai", "shortcuts", "logout"];

const render = (activeId = "stats") => (
    <SettingsWorkspaceNav
        groups={GROUPS}
        activeId={activeId}
        onSelect={() => {}}
        dangerItems={DANGER}
        onSelectDanger={() => {}}
    />
);

/** 当前左栏所有条目 id（含底部危险区） */
const navIds = (): string[] =>
    [...document.querySelectorAll<HTMLElement>("[data-workspace-nav]")].map(
        el => el.dataset.workspaceNav ?? ""
    );

const searchInput = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]');
    assert.ok(el, "左栏要有一个可访问名为「搜索设置」的输入框（aria-label 得挂在原生 input 上）");
    return el!;
};

/** 给受控输入赋值：必须走原生 value setter 再派发 input，直接改 el.value 会被 React 吞掉 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

async function pressKey(el: HTMLElement, key: string) {
    await act(async () => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
}

test("输入即过滤：只剩命中的条目，空分组整组不渲染，危险区常驻", async t => {
    t.after(cleanup);
    mount(render());

    assert.deepEqual(navIds(), ALL_IDS, "没输入时九宫格原样");

    setInputValue(searchInput(), "css");
    assert.deepEqual(
        navIds(),
        ["config-appearance", "logout"],
        "只剩命中的「外观与搜索」，底部退出登录不参与过滤、必须还在"
    );

    // 分组数 = 命中的 1 组 + 底部危险区 1 组；空分组必须整组不渲染
    // （否则就是一个只有 aria-label、念完什么都没有的 role=group）
    const groups = [...document.querySelectorAll('[role="group"]')].map(
        el => el.getAttribute("aria-label") ?? ""
    );
    assert.deepEqual(groups, ["外观与工具", "会话"], `不该出现空分组，实际 ${groups.join("/")}`);
});

test("清空即恢复：点清除按钮回到全部条目，焦点留在输入框", async t => {
    t.after(cleanup);
    mount(render());

    setInputValue(searchInput(), "css");
    assert.equal(navIds().length, 2, "先确认已经过滤");

    const clearBtn = document.querySelector<HTMLElement>('button[aria-label="清空搜索"]');
    assert.ok(clearBtn, "有词时必须出现「清空搜索」按钮");
    await act(async () => {
        clearBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(navIds(), ALL_IDS, "清空后要回到完整列表");
    assert.equal(searchInput().value, "", "输入框要真的被清空");
    assert.equal(
        document.activeElement,
        searchInput(),
        "清空后焦点必须留在输入框（焦点甩回 body 的话键盘用户得从头 Tab 一遍）"
    );
});

test("空态：给两句可执行的提示，且不放第二颗「清空」按钮", async t => {
    t.after(cleanup);
    mount(render());

    setInputValue(searchInput(), "绝不可能命中的词");

    const text = document.body.textContent ?? "";
    assert.ok(text.includes("没有匹配的设置项"), "空态要说清「没命中」");
    assert.ok(text.includes("换个词试试，或清空搜索框"), "空态要告诉用户下一步怎么做");
    assert.equal(
        document.querySelectorAll('button[aria-label="清空搜索"]').length,
        1,
        "「清空」只有输入框里那一颗 —— 空态再放一颗，Tab 过去按了等于什么都没变"
    );
    // 危险区照样在：空结果不等于「把退出登录也藏了」
    assert.deepEqual(navIds(), ["logout"]);
});

test("选中项被筛掉时只提示、不自动切换（右栏内容不许凭空变化）", async t => {
    t.after(cleanup);
    mount(render("stats"));

    setInputValue(searchInput(), "css");

    const text = document.body.textContent ?? "";
    assert.ok(
        text.includes("当前打开的是「统计」，不在这次筛选结果里"),
        "选中项被筛掉时必须明说，否则用户以为选中态丢了"
    );
    // 反证：不许自动把选中态挪到第一个命中项上 —— 用户一个东西都没点
    const current = document.querySelector<HTMLElement>(
        "[data-workspace-nav][aria-current='true']"
    );
    assert.equal(current, null, "被筛掉的选中项不渲染，但也不许自动改成别的条目");
});

test("↓ 把焦点交给第一个可见条目（键盘用户不必 Tab 穿过整列）", async t => {
    t.after(cleanup);
    mount(render());

    setInputValue(searchInput(), "键");
    await pressKey(searchInput(), "ArrowDown");

    const first = document.querySelector<HTMLElement>('[data-workspace-nav="shortcuts"]');
    assert.ok(first, "过滤后应只剩「快捷键与操作帮助」");
    assert.equal(document.activeElement, first, "↓ 之后焦点要落在第一个可见条目上");
});

test("Esc 有词：只清空搜索，不把事件冒出去（冒出去就等于关掉中心）", async t => {
    t.after(cleanup);
    mount(render());

    // 监听挂在 body 上：只有事件真的冒出左栏根节点才会被记到
    let bubbled = 0;
    const spy = (e: KeyboardEvent) => {
        if (e.key === "Escape") bubbled += 1;
    };
    document.body.addEventListener("keydown", spy);
    t.after(() => document.body.removeEventListener("keydown", spy));

    setInputValue(searchInput(), "css");
    await pressKey(searchInput(), "Escape");

    assert.equal(searchInput().value, "", "有词时 Esc 要清空搜索");
    assert.deepEqual(navIds(), ALL_IDS, "清空后列表恢复");
    assert.equal(
        bubbled,
        0,
        "有词时的 Esc 必须 stopPropagation —— MUI 的 Modal 不看 defaultPrevented，" +
            "事件冒上去它就会 onClose('escapeKeyDown')，把整个中心关掉"
    );

    // 没词时必须**不拦**：Esc 要让上层照常关弹窗
    await pressKey(searchInput(), "Escape");
    assert.equal(bubbled, 1, "空搜索框上的 Esc 不能被吞掉，要留给上层关弹窗");
});
