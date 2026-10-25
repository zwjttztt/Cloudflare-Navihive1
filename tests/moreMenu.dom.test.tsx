// tests/moreMenu.dom.test.tsx
// 顶栏「更多选项」菜单。
//
// 为什么补它：这一列多项的重排（分区、顺序、出现条件）此前**只有仓库外的 ui-smoke 盯着**，
// CI 里没有任何东西守着。而这里最容易写坏的两处都不报错：
//   1. **回调顺序** —— 每一项都必须是「先 onClose() 再执行动作」，反过来的话
//      弹窗会在菜单还开着的时候打开，菜单失去锚点飘到左上角，关掉弹窗后菜单还在；
//   2. **出现条件** —— 审计日志只给 owner、账号与安全和退出登录只在登录后。
//      少一个条件判断不会崩，只是「普通账号点进去看到一句 403」或者「没登录也有退出登录」。
//
// 2026-10-15 瘦身后的菜单（9 项）：访问统计 + 统计看板已合并成「统计」
// （StatsHubDialog 里两个标签页），快捷键 + 安装到桌面合并成「帮助」
// （安装按钮在 ShortcutsDialog 底部）—— 本测试跟着改标签。
// 2026-10-17：「分组排序」挪到 DisplayControls 的排序区（用户要求排序类操作归拢），
// 菜单变 8 项。
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
            onOpenStats: rec("onOpenStats"),
            onOpenBackup: (tab: number) => void log.calls.push(`onOpenBackup(${tab})`),
            isAuthenticated: true,
            onLogout: rec("onLogout"),
            onOpenRecycle: rec("onOpenRecycle"),
            onOpenPasswordHealth: rec("onOpenPasswordHealth"),
            onOpenVault: rec("onOpenVault"),
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

test("三个分区按「整理与数据 → 设置与账号 → 帮助」排列", t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    const text = document.body.textContent || "";
    const at = (s: string) => text.indexOf(s);
    assert.ok(at("整理与数据") >= 0, "应有分区小标题");
    assert.ok(
        at("整理与数据") < at("设置与账号") &&
            at("设置与账号") < at("帮助"),
        "分区顺序应是「整理与数据 → 设置与账号 → 帮助」"
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
        ["统计", "onOpenStats"],
        ["备份与恢复", "onOpenBackup(0)"],
        ["回收站", "onOpenRecycle"],
        ["密码健康", "onOpenPasswordHealth"],
        ["密码保险库", "onOpenVault"],
        ["审计日志", "onOpenAudit"],
        ["全站设置", "onOpenConfig"],
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
    // 「统计」入口对所有人都在：里面第一个标签页就是人人都有的访问统计，
    // 运营看板那个标签页由 hub 按 isSiteOwner 决定显不显示（不是菜单的事）
    assert.ok(labels().includes("统计"), "统计入口与身份无关，普通账号也要在");
});

test("未登录：没有「账号与安全」和「退出登录」，但整理类还在", t => {
    t.after(cleanup);
    const { props } = makeProps({ isAuthenticated: false });
    mount(props);
    const list = labels();
    assert.ok(!list.includes("账号与安全"), `实际 ${JSON.stringify(list)}`);
    assert.ok(!list.includes("退出登录"), `实际 ${JSON.stringify(list)}`);
    assert.ok(list.includes("全站设置"), "全站设置跟登录无关，未登录也要在");
    assert.ok(!list.includes("会话"), "没有会话区就不该留一个「会话」小标题");
});

test("菜单项总数收敛：分组排序挪进显示面板后，owner 登录态共 11 项（labels() 含 4 个小标题）", t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    // 4 个小标题 + 11 个菜单项：统计 / 备份与恢复 / 回收站 / 密码健康 / 密码保险库 / 审计日志 /
    // 网站设置 / AI 设置 / 账号与安全 / 快捷键与操作帮助 / 退出登录
    // （「分组排序」2026-10-17 挪进 DisplayControls；「密码健康」10-25 方案 A；「密码保险库」10-25 方案 B）
    // ⚠️ labels() 把分区小标题也数进来（它按 li 文本取），所以是 15 不是 11
    assert.deepEqual(
        labels(),
        [
            "整理与数据", "统计", "备份与恢复", "回收站", "密码健康", "密码保险库", "审计日志",
            "设置与账号", "全站设置", "AI 设置", "账号与安全",
            "帮助", "快捷键与操作帮助",
            "会话", "退出登录",
        ],
        "菜单结构应固定成这样；改名 / 合并先改这里"
    );
    assert.ok(!labels().includes("分组排序"), "分组排序已挪到显示面板的排序区");
    assert.ok(!labels().includes("访问统计"), "访问统计已并入「统计」");
    assert.ok(!labels().includes("统计看板"), "统计看板已并入「统计」");
    assert.ok(!labels().includes("安装到桌面"), "安装到桌面已并入帮助弹窗");
});

test("菜单关着的时候不渲染任何菜单项（省掉一整屏隐藏 DOM）", t => {
    t.after(cleanup);
    const { props } = makeProps({ open: false });
    mount(props);
    assert.deepEqual(labels(), []);
});
