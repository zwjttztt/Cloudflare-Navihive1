// tests/navigationCenter.dom.test.tsx
// 导航页「设置」统一中心弹窗。
//
// 它是原来 tests/moreMenu.dom.test.tsx 那位（下拉菜单）的接班人，钉的还是那几件
// 「写错了不报错、只有手点才能发现」的事，判据换成新结构：
//   1. **弹窗的无障碍命名**：role=dialog 的 paper 上的 aria-labelledby 必须能
//      解析到一个存在且非空的标题节点 —— MUI 把 role/aria-modal 放在 paper 上，
//      写在 <Dialog> 顶层的 aria-* 会落到 Modal 根，读屏就念不出弹窗名字；
//   2. **出现条件**：审计日志只给 owner、账号与安全 / 退出登录只在登录后。
//      少一个判断不会崩，只是「普通账号点进去看到一句 403」或「没登录也有退出登录」；
//   3. **退出登录要二次确认**：原来菜单里点一下就退，没有回头的机会；
//   4. **关闭只有一个出口**：× 与 Esc 走同一个回调。
//      （底栏那颗「完成」2026-10-31 撤掉了 —— 它不是保存，是第二个关闭按钮，
//      却占掉一整条 44px + 一条描边；关闭出口仍有 × / Esc / 点遮罩三个。）
//   5. **面板必须内联**：「全站设置」「账号与安全」在中心右栏直接渲染业务体，
//      不许再套一层 Dialog。转发层要是拿了默认导出（`withDialog` 被硬写成 true），
//      页面上就会叠出第二个 role=dialog —— 手点才看得出来，单测必须钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NavigationCenterDialog, {
    type NavigationCenterDialogProps,
} from "../src/components/NavigationCenterDialog";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeProps(
    overrides: Partial<NavigationCenterDialogProps> = {}
): { props: NavigationCenterDialogProps; log: string[] } {
    const log: string[] = [];
    const rec = (name: string) => () => void log.push(name);
    return {
        log,
        props: {
            open: true,
            onClose: rec("onClose"),
            isAuthenticated: true,
            isSiteOwner: true,
            stats: {
                client: {} as never,
                isSiteOwner: true,
                nameOf: (id: string) => `#${id}`,
                exists: () => true,
                onClear: () => {},
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
                onNotify: () => {},
                includeCredentials: false,
                onIncludeCredentialsChange: () => {},
                onOpenBookmark: () => {},
                cronError: null,
            },
            recycle: {
                client: {} as never,
                retentionDays: undefined,
                onChanged: () => {},
                onNotify: () => {},
            },
            audit: {
                client: {} as never,
                retentionDays: undefined,
            },
            config: {
                open: true,
                onClose: () => {},
                onSave: () => {},
                tempConfigs: {},
                setTempConfigs: () => {},
                onConfigInputChange: () => {},
                onMaskOpacityChange: () => {},
                onPickAccent: () => {},
                radius: "md" as never,
                onRadiusChange: () => {},
                fontScale: 1 as never,
                onFontScaleChange: () => {},
                glassBlur: 0,
                onGlassBlurChange: () => {},
                glassEffects: false,
                onGlassEffectsChange: () => {},
                offlineFull: false,
                onOfflineFullChange: () => {},
                iconPrivacy: false,
                onIconPrivacyChange: () => {},
                liteMode: false,
                onLiteModeChange: () => {},
                pinyinSearch: false,
                onPinyinSearchChange: () => {},
                syncHealth: false,
                onSyncHealthChange: () => {},
                syncPrefs: false,
                onSyncPrefsChange: () => {},
                isSiteOwner: true,
            },
            vault: { client: {} as never, onNotify: () => {} },
            ai: { api: {} as never, ai: {} as never },
            account: {
                open: true,
                onClose: () => {},
                sites: [] as never,
                auth: { username: "", currentPassword: "", newPassword: "" },
                onAuthChange: () => {},
                onSaveAuth: () => {},
                currentUser: null,
                sessions: [],
                accounts: [],
                onDeleteAccount: undefined,
            },
            onAccountActivate: () => {},
            shortcuts: { canInstall: false, onInstallApp: () => {} },
            onLogout: rec("onLogout"),
            ...overrides,
        },
    };
}

async function mount(props: NavigationCenterDialogProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<NavigationCenterDialog {...props} />);
        // 让两级 lazy（中心外壳 → 九个面板）都有机会 resolve
        await new Promise(r => setTimeout(r, 0));
    });
}

async function cleanup() {
    if (root) {
        await act(async () => root!.unmount());
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 左栏条目（危险区那条也带这个属性） */
const navItems = () =>
    [...document.querySelectorAll<HTMLElement>("[data-workspace-nav]")].map(
        el => el.dataset.workspaceNav ?? ""
    );

/** 按 Esc：MUI 把 keydown 绑在 Modal 根节点上（不是 document），得往弹窗里派发再冒泡 */
async function pressEscape() {
    const dialog =
        document.querySelector<HTMLElement>('[role="dialog"]') ??
        document.querySelector<HTMLElement>(".MuiDialog-root") ??
        document;
    await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
    });
}

async function click(el: HTMLElement | null) {
    assert.ok(el, "要点的元素不存在");
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
    });
}

test("role=dialog 的 paper 有可解析的 aria-labelledby，且指向非空标题", async t => {
    t.after(cleanup);
    const { props } = makeProps();
    await mount(props);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, "要渲染出一个 role=dialog 的弹窗");
    // MUI 把 role / aria-modal 放在 **paper** 上：这条断言顺带钉住「命名写在 paper 上」
    assert.equal(dialog.getAttribute("aria-modal"), "true", "对话框要带 aria-modal");

    const id = dialog.getAttribute("aria-labelledby");
    assert.ok(id, "paper 上必须写 aria-labelledby（写在 <Dialog> 顶层会落到 Modal 根）");
    const title = document.getElementById(id!);
    assert.ok(title, `aria-labelledby="${id}" 指向的节点不存在`);
    assert.equal((title!.textContent || "").trim(), "设置", "标题要能说出弹窗叫什么");
});

test("owner 登录态：九个导航项 + 底部退出登录，顺序照注册表", async t => {
    t.after(cleanup);
    const { props } = makeProps();
    await mount(props);
    assert.deepEqual(
        navItems(),
        [
            "stats",
            "backup",
            "recycle",
            "audit",
            "config",
            "ai",
            "vault",
            "account",
            "shortcuts",
            "logout",
        ],
        "条目顺序应与 model.ts 的注册表一致（改名 / 增删先改这里）"
    );
});

test("审计日志：非站点所有者时整个入口不出现（后端也会 403，别让人白点一次）", async t => {
    t.after(cleanup);
    const { props } = makeProps({ isSiteOwner: false });
    await mount(props);
    const list = navItems();
    assert.ok(!list.includes("audit"), `普通账号不该有审计日志入口，实际 ${list.join("/")}`);
    assert.ok(list.includes("stats"), "统计与身份无关，所有人都要在");
});

test("未登录：没有「账号与安全」和「退出登录」，其余照旧", async t => {
    t.after(cleanup);
    const { props } = makeProps({ isAuthenticated: false });
    await mount(props);
    const list = navItems();
    assert.ok(!list.includes("account"), `实际 ${list.join("/")}`);
    assert.ok(!list.includes("logout"), `实际 ${list.join("/")}`);
    assert.ok(list.includes("config"), "全站设置跟登录无关，未登录也要在");
});

test("退出登录：点一下只弹确认，不直接退出", async t => {
    t.after(cleanup);
    const { props, log } = makeProps();
    await mount(props);

    await click(document.querySelector<HTMLElement>('[data-workspace-nav="logout"]'));
    assert.deepEqual(log, [], "点退出登录不该立刻执行退出");
    assert.ok(
        (document.body.textContent || "").includes("退出后要重新登录才能管理这个站点"),
        "要先弹站内二次确认（不用 window.confirm）"
    );

    // 确认弹窗里的「退出登录」才是真正执行的那一下。
    // ⚠️ 不能只按文案找：左栏那颗危险区按钮文案也是「退出登录」，而且在 DOM 里
    //    排得更前 —— 只按文案会点回左栏，确认弹窗又开一次，退出永远不执行。
    //    两个弹窗都 portal 到 body，后挂载的那个（确认框）在最后面。
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const confirmDialog = dialogs[dialogs.length - 1];
    assert.ok(confirmDialog && !confirmDialog.querySelector("[data-workspace-nav]"), "取到的应是确认弹窗，不是中心");
    const confirmBtn = [...confirmDialog!.querySelectorAll<HTMLElement>("button")].find(
        b => (b.textContent || "").trim() === "退出登录"
    );
    await click(confirmBtn ?? null);
    assert.deepEqual(log, ["onClose", "onLogout"], "确认后才退出，且先收起中心");
});

test("关闭只有一个出口：× 与 Esc 都走 onClose", async t => {
    t.after(cleanup);
    const { props, log } = makeProps();
    await mount(props);

    await click(document.querySelector<HTMLElement>("[data-dialog-close='1']"));
    assert.deepEqual(log, ["onClose"], "右上角 × 走 onClose");

    log.length = 0;
    await pressEscape();
    assert.deepEqual(log, ["onClose"], "Esc 走同一个 onClose");

    // 反证：底栏那颗「完成」已经不在了 —— 它要是在，上面的「只有一个出口」
    // 就是假的（多一个实质相同的出口，还白占 44px）
    assert.equal(
        document.querySelector("[data-nav-center-done='1']"),
        null,
        "底栏「完成」按钮已撤掉，不该再出现"
    );
});

test("隐藏当前选中项时自动回退到第一个可见项（不留空面板）", async t => {
    t.after(cleanup);
    // 先在登录态选中「账号与安全」，再切到未登录 —— 那一项整组都不可见了，
    // 右栏必须回退到一个真的存在的面板，不能留空。
    const { props } = makeProps();
    await mount(props);
    await click(document.querySelector<HTMLElement>('[data-workspace-nav="account"]'));
    await act(async () => {
        root!.render(<NavigationCenterDialog {...props} isAuthenticated={false} />);
        await new Promise(r => setTimeout(r, 0));
    });

    const current = document
        .querySelector<HTMLElement>("[data-workspace-nav][aria-current='true']")
        ?.dataset.workspaceNav;
    assert.equal(current, "stats", "退登后应回退到第一个可见项，右栏不留空");
    assert.ok(
        (document.body.textContent || "").includes("访问统计与运营看板"),
        "右栏要真的渲染出回退后面板的内容"
    );
});

test("全站设置 / 账号与安全：在中心内联，不再弹出第二层 Dialog", async t => {
    t.after(cleanup);
    const { props } = makeProps();
    await mount(props);

    for (const id of ["config", "account"]) {
        await click(document.querySelector<HTMLElement>(`[data-workspace-nav="${id}"]`));
        // 面板是第二层 lazy，给它几拍把块 resolve 掉
        for (let i = 0; i < 3; i++) {
            await act(async () => {
                await new Promise(r => setTimeout(r, 0));
            });
        }
        const dialogs = document.querySelectorAll('[role="dialog"]');
        assert.equal(
            dialogs.length,
            1,
            `选中 ${id} 后只应存在中心这一个 dialog（面板必须内联），实际 ${dialogs.length} 个`
        );
    }
});
