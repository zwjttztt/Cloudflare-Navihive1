// tests/settingsDirectOpen.dom.test.tsx
// R09：**窄屏下命令直达的那一屏被重置回目录页**。
//
// 病灶在设置中心的外壳（components/settingsWorkspace/SettingsWorkspaceDialog）：
// 它有一个 `useEffect(() => { if (open) setMobileStep("list") }, [open])`，
// 每次打开都把「窄屏两步式」的步进按回目录。于是命令面板点「打开网站设置」
// （目标 = config-appearance）之后，窄屏用户看到的仍是那份九条目录，得再点一次
// 才进得去 —— 命令的意义（少点几次）正好被抹掉。
//
// 这一组钉四件事：
//   1. **意图要显式**：带目标打开 → 窄屏直接进面板；不带目标打开 → 落在目录。
//      同一份组件、同一条 open 状态，区别只能来自「调用方有没有说出目标」。
//   2. **步进只由本次打开决定**：进面板后点「返回」回目录，不会被 effect 再按回去
//      （open 整个过程都是 true，重置逻辑必须跟着「本次打开」这个生命周期走）。
//   3. **焦点要接力**：窄屏同一时刻只有一栏在 DOM 里，切那一步会把刚拿焦点的
//      元素卸载掉 —— 直达后焦点要在面板标题上，返回后要在目录对应条目上。
//   4. **宽屏不受影响**：≥600 两栏同时可见，不做任何跳焦点，也没有「返回」按钮。
//
// 断点只用 QUERY_BELOW_600（max-width: 599.95px）这一条线，所以边界两侧取
// 375 / 599（窄）与 600 / 1024（宽）—— 599 与 600 是那条线上**相邻的两个整数**，
// 谁把 599.95 写成 600 或 599，这一对就会翻。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import NavigationCenterDialog, {
    type NavigationCenterDialogProps,
} from "../src/components/NavigationCenterDialog";
import type { NavCenterPanelId } from "../src/components/navigationCenter/model";
import { useAppCommands, type AppCommandsInput } from "../src/hooks/useAppCommands";
import type { GroupWithSites } from "../src/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/**
 * 让 jsdom 的视口「真的」是某个宽度。
 *
 * 只写 innerWidth 不够：外壳的 fullScreen 走 `useMediaQuery(QUERY_BELOW_600)`，
 * 而 MUI 的 useMediaQuery 读的是 **window.matchMedia** —— jsdom 没有这个 API，
 * 单测 banner 给的那个桩恒返回 matches:false（= 永远是宽屏），
 * 那样这一组用例全都只会跑到「宽屏」那一支，窄屏的 bug 一条都钉不住。
 * 所以这里按查询里的 min/max-width 现算。
 */
function setViewportWidth(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    const matchMedia = (query: string) => {
        const max = /max-width:\s*([\d.]+)px/.exec(query);
        const min = /min-width:\s*([\d.]+)px/.exec(query);
        let matches = true;
        if (max) matches = matches && width <= Number(max[1]);
        if (min) matches = matches && width >= Number(min[1]);
        return {
            matches,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
        };
    };
    (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
    (globalThis as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
}

async function settle(times = 4) {
    for (let i = 0; i < times; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
        });
    }
}

async function mount(element: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(element);
        await new Promise(r => setTimeout(r, 0));
    });
    // 面板是第二层 lazy：给几拍把块 resolve 掉
    await settle();
}

async function cleanup() {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = "";
}

async function click(el: HTMLElement | null | undefined) {
    assert.ok(el, "要点的元素不存在");
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
    });
    await settle(2);
}

/** 左栏条目 id（`[data-workspace-nav]` 是外壳与导航约定的认人属性） */
const navItems = () =>
    [...document.querySelectorAll<HTMLElement>("[data-workspace-nav]")].map(
        el => el.dataset.workspaceNav ?? ""
    );
/** 面板主标题：外壳拿它当窄屏直达的焦点落点（见 SettingsWorkspacePanel） */
const panelTitle = () =>
    document.querySelector<HTMLElement>("[data-workspace-panel-title]");
/** 窄屏那颗「全部选项」（返回目录） */
const backButton = () => document.querySelector<HTMLElement>("[data-workspace-back='1']");
/**
 * 焦点落在哪儿 —— 用**字符串**描述，不要直接 assert.equal 两个 DOM 节点。
 * 节点一旦比较失败，node:assert 会去 inspect 整棵 jsdom 节点（自引用 + 上千个
 * 属性），实测能把内存顶爆成 `Array buffer allocation failed`，
 * 看起来像「面板把堆打爆了」，其实是一次失败断言的报错文本。
 */
function focusDescriptor() {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "(none)";
    const panelTitleMark = el.getAttribute("data-workspace-panel-title");
    const navId = el.getAttribute("data-workspace-nav");
    if (panelTitleMark) return `panel-title:${(el.textContent || "").trim()}`;
    if (navId) return `nav-item:${navId}`;
    return `other:${el.tagName.toLowerCase()}`;
}

function makeProps(
    overrides: Partial<NavigationCenterDialogProps> = {}
): NavigationCenterDialogProps {
    const noop = () => {};
    return {
        open: true,
        onClose: noop,
        isAuthenticated: true,
        isSiteOwner: true,
        stats: {
            client: {} as never,
            isSiteOwner: true,
            nameOf: (id: string) => `#${id}`,
            exists: () => true,
            onClear: noop,
            syncEnabled: false,
        },
        backup: {
            initialTab: 0,
            client: {} as never,
            webdavConfig: {} as never,
            onSaveWebdavConfig: async () => {},
            autoBackup: false,
            lastBackupAt: "",
            lastBackupInfo: "",
            lastAutoBackupAt: "",
            onToggleAutoBackup: async () => {},
            onBuildExportData: () => ({}) as never,
            onDownloadLocal: async () => {},
            onImportData: async () => null,
            onRequestImportPreview: async () => null,
            onNotify: noop,
            includeCredentials: false,
            onIncludeCredentialsChange: noop,
            onOpenBookmark: noop,
            cronError: null,
        },
        recycle: { client: {} as never, retentionDays: undefined, onChanged: noop, onNotify: noop },
        audit: { client: {} as never, retentionDays: undefined },
        config: {
            onSave: noop,
            tempConfigs: {},
            setTempConfigs: noop,
            onConfigInputChange: noop,
            onMaskOpacityChange: noop,
            onPickAccent: noop,
            onCancelAccentPreview: noop,
            radius: "md" as never,
            onRadiusChange: noop,
            fontScale: 1 as never,
            onFontScaleChange: noop,
            glassBlur: 0,
            onGlassBlurChange: noop,
            glassEffects: false,
            onGlassEffectsChange: noop,
            offlineFull: false,
            onOfflineFullChange: noop,
            iconPrivacy: false,
            onIconPrivacyChange: noop,
            liteMode: false,
            onLiteModeChange: noop,
            pinyinSearch: false,
            onPinyinSearchChange: noop,
            syncHealth: false,
            onSyncHealthChange: noop,
            syncPrefs: false,
            onSyncPrefsChange: noop,
            isSiteOwner: true,
        },
        vault: { client: {} as never, onNotify: noop },
        ai: { api: {} as never, ai: {} as never },
        account: {
            open: true,
            onClose: noop,
            sites: [] as never,
            auth: { username: "", currentPassword: "", newPassword: "" },
            onAuthChange: noop,
            onSaveAuth: noop,
            currentUser: null,
            sessions: [],
            accounts: [],
            onDeleteAccount: undefined,
        },
        onAccountActivate: noop,
        shortcuts: { canInstall: false, onInstallApp: noop },
        onLogout: noop,
        ...overrides,
    };
}

// ─────────────────────────── 1. 带目标 / 不带目标 ───────────────────────────

for (const width of [375, 599]) {
    test(`${width}px：带目标打开 → 直接看到目标那一屏，目录不在 DOM 里`, async t => {
        t.after(cleanup);
        setViewportWidth(width);
        // 「有目标」= 显式传 initialPanel，这是**意图**，不是「id 不等于默认项」的推断
        await mount(<NavigationCenterDialog {...makeProps({ initialPanel: "config-appearance" })} />);

        assert.deepEqual(navItems(), [], "窄屏直达时目录不该出现（正是 R09 的症状：用户先看到目录）");
        assert.ok(panelTitle(), "窄屏直达时要直接看到面板");
        assert.equal(panelTitle()!.textContent?.trim(), "外观与搜索", "落到的必须是命令指定的那一屏");
        assert.ok(
            (document.body.textContent || "").includes("获取图标API URL"),
            "面板业务体要真的是「外观与搜索」这一屏，不能只是个空壳标题"
        );
        // 焦点接力：落到面板标题上（而不是掉回 body）
        assert.equal(
            focusDescriptor(),
            "panel-title:外观与搜索",
            "直达之后焦点要在面板标题上，否则键盘用户按 Tab 会从头重新走进弹窗"
        );
    });

    test(`${width}px：不带目标打开 → 落在目录（普通打开的老行为不变）`, async t => {
        t.after(cleanup);
        setViewportWidth(width);
        // 不传 initialPanel = 普通打开（用户点设置按钮）
        await mount(<NavigationCenterDialog {...makeProps()} />);

        assert.deepEqual(
            navItems(),
            [
                "stats",
                "config-data",
                "backup",
                "audit",
                "config-appearance",
                "vault",
                "ai",
                "account",
                "shortcuts",
                "logout",
            ],
            "普通打开必须落在目录页（九项 + 退出登录）"
        );
        assert.equal(panelTitle(), null, "目录页里不该同时出现面板");
        assert.equal(backButton(), null, "目录页里没有「返回」—— 已经在目录上了");
    });
}

// ─────────────────────────── 2. 返回目录 + 焦点回位 ───────────────────────────

test("375px：面板里点「全部选项」→ 回目录，且步进不被重置逻辑按回面板", async t => {
    t.after(cleanup);
    setViewportWidth(375);
    await mount(<NavigationCenterDialog {...makeProps({ initialPanel: "config-appearance" })} />);

    assert.ok(backButton(), "窄屏第二步要有「全部选项」返回按钮");
    await click(backButton());

    assert.equal(
        navItems().includes("config-appearance"),
        true,
        "点「返回」之后要真的回到目录（open 全程是 true，重置逻辑不能把它按回去）"
    );
    assert.equal(panelTitle(), null, "回到目录后右栏不该还在");
    // 焦点回位：交给目录里「刚才那一屏」那条
    assert.equal(
        focusDescriptor(),
        "nav-item:config-appearance",
        "焦点要回到目录里对应的条目上（当前项靠 aria-current 认）"
    );
});

// ─────────────────────────── 3. 宽屏不受影响 ───────────────────────────

for (const width of [600, 1024]) {
    for (const intent of ["direct", "plain"] as const) {
        test(`${width}px（${intent === "direct" ? "带目标" : "不带目标"}）：两栏同时在，没有「返回」，不跳焦点`, async t => {
            t.after(cleanup);
            setViewportWidth(width);
            await mount(
                <NavigationCenterDialog
                    {...makeProps(
                        intent === "direct" ? { initialPanel: "config-appearance" } : {}
                    )}
                />
            );

            assert.ok(navItems().includes("stats"), "宽屏左栏要在");
            assert.equal(
                panelTitle()?.textContent?.trim(),
                intent === "direct" ? "外观与搜索" : "统计",
                intent === "direct"
                    ? "带目标：右栏就是那一屏（宽屏行为与改动前一致）"
                    : "不带目标：右栏仍是左栏第一项「统计」"
            );
            assert.equal(backButton(), null, "宽屏两栏同时可见，不该出现「返回」按钮");
            assert.equal(
                focusDescriptor().startsWith("panel-title:"),
                false,
                "宽屏不跳焦点（跳焦点会打断正在看的内容，两栏本来都看得见）"
            );
        });
    }
}

// ─────────────────────────── 4. 命令入口这条链 ───────────────────────────

const commandGroups: GroupWithSites[] = [
    {
        id: 1,
        name: "常用工具",
        order_num: 0,
        sites: [
            {
                id: 11,
                group_id: 1,
                name: "云设",
                url: "https://s11.com",
                icon: "",
                description: "",
                notes: "",
                username: "",
                password: "",
                order_num: 0,
            },
        ],
    },
];

/**
 * 命令面板 → 设置中心：把 App 里那三行接线搬过来（`openNavCenter(panel)` 写目标 +
 * 开；关掉时清目标），然后用**真的** useAppCommands 与真的弹窗跑一遍。
 *
 * 为什么不 mock 掉 openNavCenter：R09 的抱怨是「我点了命令，还是看到目录」，
 * 只断言「回调收到了字符串」证明不了这一点 —— 必须让字符串真的走到弹窗里，
 * 再看窄屏落在哪一步。
 */
function CommandToDialogHarness() {
    const [panel, setPanel] = useState<NavCenterPanelId | null>(null);
    const [open, setOpen] = useState(false);

    const input: AppCommandsInput = {
        groups: commandGroups,
        setViewMode: () => {},
        density: "comfortable",
        setDensity: () => {},
        toggleTheme: () => {},
        favoritesEnabled: false,
        setFavoritesEnabled: () => {},
        glassEffects: false,
        setGlassEffects: () => {},
        setOpenShortcuts: () => {},
        handleOpenAddGroup: () => {},
        startGroupSort: () => {},
        setOpenAccount: () => {},
        fetchSessions: () => {},
        fetchAccountList: () => {},
        // App 的 openNavCenter：写目标 + 开（目标就是「直达」这个意图的载体）
        openNavCenter: target => {
            setPanel(target);
            setOpen(true);
        },
        setBookmarkOpen: () => {},
        runLinkCheck: () => {},
        toggleCollapseAll: () => {},
        allGroupsCollapsed: false,
        multiSelect: false,
        setMultiSelect: () => {},
        exitMultiSelect: () => {},
        starFilter: false,
        setStarFilter: () => {},
        railCollapsed: false,
        setRailCollapsed: () => {},
        clearVisits: () => {},
        canUndo: false,
        runUndo: () => {},
        canRedo: false,
        runRedo: () => {},
        recordVisit: () => {},
    };
    const commands = useAppCommands(input);
    const fire = (id: string) => {
        const cmd = commands.find(c => c.id === id);
        assert.ok(cmd, `命令 ${id} 不存在`);
        cmd!.run();
    };

    return (
        <>
            {/* 命令面板里那两条「进设置」的命令，按 id 摆成按钮，测试点它们 */}
            <button type='button' data-cmd='cmd-config' onClick={() => fire("cmd-config")}>
                打开网站设置
            </button>
            <button type='button' data-cmd='cmd-visits' onClick={() => fire("cmd-visits")}>
                查看统计
            </button>
            {/* 普通打开（顶栏 / 底栏那颗设置按钮）：只开，不带目标 */}
            <button type='button' data-cmd='plain-open' onClick={() => setOpen(true)}>
                设置
            </button>
            <NavigationCenterDialog
                {...makeProps()}
                open={open}
                initialPanel={panel ?? undefined}
                onClose={() => {
                    // App 侧那条 effect 的等价物：一关就清目标，残留值不许带到下次
                    setPanel(null);
                    setOpen(false);
                }}
            />
        </>
    );
}

test("命令链：`打开网站设置` → 375px 直接落在外观与搜索（目标真的进了弹窗）", async t => {
    t.after(cleanup);
    setViewportWidth(375);
    await mount(<CommandToDialogHarness />);
    assert.equal(navItems().length, 0, "还没开命令时弹窗是关的");

    await click(document.querySelector<HTMLElement>("[data-cmd='cmd-config']"));

    assert.equal(panelTitle()?.textContent?.trim(), "外观与搜索", "命令带的目标要一路走到弹窗上");
    assert.deepEqual(navItems(), [], "窄屏下命令直达不该先给目录（R09 的正题）");
});

test("命令链：`查看统计`（目标正好是默认项）同样算直达，不算普通打开", async t => {
    t.after(cleanup);
    setViewportWidth(375);
    await mount(<CommandToDialogHarness />);

    // 反证「靠值猜意图」为什么错：这里的目标 stats 与默认项一模一样。
    // 若下游用「id 是不是 stats」来判意图，这条命令就会被当成普通打开、落回目录。
    await click(document.querySelector<HTMLElement>("[data-cmd='cmd-visits']"));

    assert.equal(panelTitle()?.textContent?.trim(), "统计");
    assert.deepEqual(navItems(), [], "带目标就该直达，哪怕目标正好是默认那一屏");
});

test("命令链：关掉之后再用普通入口打开 → 清掉上次的目标，落在目录", async t => {
    t.after(cleanup);
    setViewportWidth(375);
    await mount(<CommandToDialogHarness />);

    await click(document.querySelector<HTMLElement>("[data-cmd='cmd-config']"));
    assert.equal(panelTitle()?.textContent?.trim(), "外观与搜索");

    // 关：走唯一关闭出口（×）
    await click(document.querySelector<HTMLElement>("[data-dialog-close='1']"));
    await cleanup();
    setViewportWidth(375);
    await mount(<CommandToDialogHarness />);

    await click(document.querySelector<HTMLElement>("[data-cmd='plain-open']"));

    assert.equal(
        navItems().includes("config-appearance"),
        true,
        "普通打开必须落在目录；上一次命令的目标残留会让用户以为「设置按钮坏了」"
    );
    assert.equal(panelTitle(), null, "普通打开（窄屏）不该直接进面板");
});
