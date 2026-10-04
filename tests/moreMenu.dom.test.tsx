// tests/moreMenu.dom.test.tsx
// 顶栏「更多选项」菜单。
//
// 为什么补它：这一列十几项的重排（分区、顺序、出现条件）此前**只有仓库外的 ui-smoke 盯着**，
// CI 里没有任何东西守着。而这里最容易写坏的两处都不报错：
//   1. **回调顺序** —— 每一项都必须是「先 onClose() 再执行动作」，反过来的话
//      弹窗会在菜单还开着的时候打开，菜单失去锚点飘到左上角，关掉弹窗后菜单还在；
//   2. **出现条件** —— 审计日志只给 owner、账号与安全和退出登录只在登录后、
//      安装到桌面只在浏览器给了安装事件时。少一个条件判断不会崩，
//      只是「普通账号点进去看到一句 403」或者「没登录也有退出登录」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import MoreMenu, { type MoreMenuProps } from "../src/components/MoreMenu";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let anchor: HTMLButtonElement | null = null;

interface Log {
    calls: string[];
}

function makeProps(overrides: Partial<MoreMenuProps> = {}): { props: MoreMenuProps; log: Log } {
    const log: Log = { calls: [] };
    const rec = (name: string) => () => void log.calls.push(name);
    return {
        log,
        props: {
            anchorEl: null,
            open: true,
            onClose: rec("onClose"),
            onOpenConfig: rec("onOpenConfig"),
            onStartGroupSort: rec("onStartGroupSort"),
            canInstall: false,
            onInstallApp: rec("onInstallApp"),
            onOpenVisits: rec("onOpenVisits"),
            onOpenBackup: (tab: number) => void log.calls.push(`onOpenBackup(${tab})`),
            isAuthenticated: true,
            onLogout: rec("onLogout"),
            onOpenRecycle: rec("onOpenRecycle"),
            onOpenAudit: rec("onOpenAudit"),
            onOpenAccount: rec("onOpenAccount"),
            onOpenAiAssistant: rec("onOpenAiAssistant"),
            isSiteOwner: true,
            onOpenShortcuts: rec("onOpenShortcuts"),
            ...overrides,
        },
    };
}

function mount(props: MoreMenuProps) {
    anchor = document.createElement("button");
    anchor.textContent = "更多选项";
    document.body.appendChild(anchor);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<MoreMenu {...props} anchorEl={anchor} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    anchor?.remove();
    root = null;
    host = null;
    anchor = null;
    document.body.innerHTML = "";
}

/** 菜单是 portal 到 body 的，且只有可见的菜单项才算（MUI 会保留一份隐藏的副本） */
const menuItems = () =>
    [...document.querySelectorAll<HTMLLIElement>('ul[role="menu"] > li')].filter(
        li => (li.textContent || "").trim() !== ""
    );

const labels = () => menuItems().map(li => (li.textContent || "").trim());

async function clickItem(label: string) {
    const item = menuItems().find(li => (li.textContent || "").trim() === label);
    assert.ok(item, `菜单里应有「${label}」，实际 ${JSON.stringify(labels())}`);
    await act(async () => {
        item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

test("四个分区按「整理与数据 → 设置与账号 → 帮助与安装 → 会话」排列", t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    const text = document.body.textContent || "";
    const at = (s: string) => text.indexOf(s);
    assert.ok(at("整理与数据") >= 0, "应有分区小标题");
    assert.ok(
        at("整理与数据") < at("设置与账号") &&
            at("设置与账号") < at("帮助与安装") &&
            at("帮助与安装") < at("会话"),
        "分区顺序应是「整理与数据 → 设置与账号 → 帮助与安装 → 会话」"
    );
});

test("退出登录沉在最底部，且和上面的数据操作隔着一条分隔线", t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    const list = labels();
    assert.equal(list.at(-1), "退出登录", `退出登录应沉底，实际 ${JSON.stringify(list)}`);
});

test("点每一项：先关菜单再执行动作（反过来的话菜单会飘到左上角、关不掉）", async t => {
    t.after(cleanup);
    const cases: Array<[string, string]> = [
        ["分组排序", "onStartGroupSort"],
        ["访问统计", "onOpenVisits"],
        ["备份与恢复", "onOpenBackup(0)"],
        ["回收站", "onOpenRecycle"],
        ["审计日志", "onOpenAudit"],
        ["网站设置", "onOpenConfig"],
        ["AI 设置", "onOpenAiAssistant"],
        ["账号与安全", "onOpenAccount"],
        ["快捷键与操作帮助", "onOpenShortcuts"],
    ];
    for (const [label, action] of cases) {
        const { props, log } = makeProps();
        cleanup();
        mount(props);
        await clickItem(label);
        assert.deepEqual(
            log.calls,
            ["onClose", action],
            `「${label}」应先 onClose 再 ${action}，实际 ${JSON.stringify(log.calls)}`
        );
    }
});

test("备份入口进去默认落在「备份」页（tab 0）", async t => {
    t.after(cleanup);
    const { props, log } = makeProps();
    mount(props);
    await clickItem("备份与恢复");
    assert.ok(log.calls.includes("onOpenBackup(0)"), `实际 ${JSON.stringify(log.calls)}`);
});

test("审计日志：非站点所有者时整个入口不出现（后端也会 403，别让人白点一次）", t => {
    t.after(cleanup);
    const owner = makeProps({ isSiteOwner: true });
    mount(owner.props);
    assert.ok(labels().includes("审计日志"), "owner 应看得到审计日志");
    cleanup();

    const guest = makeProps({ isSiteOwner: false });
    mount(guest.props);
    assert.ok(
        !labels().includes("审计日志"),
        `普通账号不该有审计日志入口，实际 ${JSON.stringify(labels())}`
    );
});

test("未登录：没有「账号与安全」和「退出登录」，但整理类还在", t => {
    t.after(cleanup);
    const { props } = makeProps({ isAuthenticated: false });
    mount(props);
    const list = labels();
    assert.ok(!list.includes("账号与安全"), `实际 ${JSON.stringify(list)}`);
    assert.ok(!list.includes("退出登录"), `实际 ${JSON.stringify(list)}`);
    assert.ok(list.includes("网站设置"), "网站设置跟登录无关，未登录也要在");
    assert.ok(!list.includes("会话"), "没有会话区就不该留一个「会话」小标题");
});

test("安装到桌面：只有浏览器真的给了安装事件时才出现", t => {
    t.after(cleanup);
    const withInstall = makeProps({ canInstall: true });
    mount(withInstall.props);
    assert.ok(labels().includes("安装到桌面"));
    cleanup();

    const without = makeProps({ canInstall: false });
    mount(without.props);
    assert.ok(!labels().includes("安装到桌面"), `实际 ${JSON.stringify(labels())}`);
});

test("菜单关着的时候不渲染任何菜单项（省掉一整屏隐藏 DOM）", t => {
    t.after(cleanup);
    const { props } = makeProps({ open: false });
    mount(props);
    assert.deepEqual(labels(), []);
});
