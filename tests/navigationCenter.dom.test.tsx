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
//     2026-11-01 起这个出口还要顺手撤掉「试色预览」：预览即时生效，不撤会泄漏到全站。
//   5. **面板必须内联**：「全站设置」「账号与安全」在中心右栏直接渲染业务体，
//      不许再套一层 Dialog。SettingsDialog 的独立弹窗外壳已整块删除（2026-11-01），
//      转发层只要有人再塞回一层 Dialog，页面就会叠出第二个 role=dialog —— 单测必须钉住。
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
                onSave: () => {},
                tempConfigs: {},
                setTempConfigs: () => {},
                onConfigInputChange: () => {},
                onMaskOpacityChange: () => {},
                // 试色通道：App 就是把这个回调塞进 config 的（`onPickAccent: pickAccent`），
                // 这里换成记录器，用例才能断言「点配色真的走了预览这条路」
                onPickAccent: rec("onPickAccent"),
                // 退出协议：中心在唯一关闭出口里调它（App 侧接线 = setAccentPreview(null)）
                onCancelAccentPreview: rec("onCancelAccentPreview"),
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
        "条目顺序应与 model.ts 的注册表一致（A+B 后 11 条收敛到 9 条：备份+回收站合成「数据安全」，高级拆散；改名 / 增删先改这里）"
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
    assert.ok(list.includes("config-appearance"), "外观与搜索跟登录无关，未登录也要在");
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
    assert.deepEqual(
        log,
        ["onCancelAccentPreview", "onClose", "onLogout"],
        "确认后才退出：先撤试色预览、再收起中心、最后才退"
    );
});

test("关闭只有一个出口：× 与 Esc 都走 onClose", async t => {
    t.after(cleanup);
    const { props, log } = makeProps();
    await mount(props);

    await click(document.querySelector<HTMLElement>("[data-dialog-close='1']"));
    assert.deepEqual(
        log,
        ["onCancelAccentPreview", "onClose"],
        "右上角 × 走同一个关闭出口（先撤试色预览，再关）"
    );

    log.length = 0;
    await pressEscape();
    assert.deepEqual(
        log,
        ["onCancelAccentPreview", "onClose"],
        "Esc 走同一个关闭出口（先撤试色预览，再关）"
    );

    // 反证：底栏那颗「完成」已经不在了 —— 它要是在，上面的「只有一个出口」
    // 就是假的（多一个实质相同的出口，还白占 44px）
    assert.equal(
        document.querySelector("[data-nav-center-done='1']"),
        null,
        "底栏「完成」按钮已撤掉，不该再出现"
    );
});

test("试了色不保存直接关中心 → 预览色被撤销", async t => {
    t.after(cleanup);
    // 直达「外观与搜索」：全程只渲染这一个面板，不切面板
    // （多叠几次 MUI 卸载路径会把测试进程的内存顶爆）
    const { props, log } = makeProps({ initialPanel: "config-appearance" });
    await mount(props);
    // 面板是第二层 lazy，给它几拍把块 resolve 掉
    for (let i = 0; i < 3; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
        });
    }

    // 1. 试色：第一颗配色按钮 → config.onPickAccent（App 侧就是 `pickAccent`，
    //    它写的是 accentPreview，全站立刻换色，属于「即时生效」而不是草稿）
    const swatch = document.querySelector<HTMLElement>('button[aria-label^="使用配色"]');
    await click(swatch);
    assert.deepEqual(log, ["onPickAccent"], "点配色必须经 config.onPickAccent 走实时预览");

    // 2. 不点「保存设置」，直接 ×（× / Esc / 遮罩 / 退出登录确认是同一条出口）
    await click(document.querySelector<HTMLElement>("[data-dialog-close='1']"));

    // 3. 预览必须被撤掉，而且撤在「关」之前 —— 关的动作会把面板卸载，
    //    撤销要赶在卸载前落下。撤掉的正是 setAccentPreview(null) 这条线。
    assert.deepEqual(
        log,
        ["onPickAccent", "onCancelAccentPreview", "onClose"],
        "试了色没保存就关：必须先撤预览（setAccentPreview(null)），否则预览色会泄漏到全站"
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

test("全站设置两段 / 数据安全 / 账号与安全：在中心内联，不再弹出第二层 Dialog", async t => {
    t.after(cleanup);
    const { props } = makeProps();
    await mount(props);

    for (const id of ["config-appearance", "config-data", "backup", "account"]) {
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

test("摊平后的面板：点哪条渲染哪段，中心内不再有二级 Tab", async t => {
    t.after(cleanup);
    // B1 之前「全站设置」面板内部还有三张 Tab（外观与搜索 / 数据 / 高级）——
    // 左栏是第一层目录、面板里又藏一层 Tab，目录里看不见的就找不到。
    // 摊平之后：点左栏哪条就渲染哪段，且中心内不许再出现 [role=tab]。
    //
    // ⚠️ 2026-10-31：这条用例原来在**一次挂载**里连点三条面板、来回切换四次。
    //    jsdom 下那样跑会在「backup → config-data」这一步把堆打爆（20 秒内
    //    Array buffer allocation failed / heap OOM，实测与产品无关：单挂 backup、
    //    挂 backup 再卸载、backup 直接切 config-data 三条探针都正常）。
    //    已按「一条用例只做一次切换」拆成三条：第 1 条走点击链路（点 config-appearance），
    //    后两条用 initialPanel 直达（零点击），断言点一个不少，内存压力降到最低。
    const { props } = makeProps();
    await mount(props);

    await click(document.querySelector<HTMLElement>('[data-workspace-nav="config-appearance"]')!);
    for (let i = 0; i < 4; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
        });
    }
    const text = document.body.textContent || "";
    for (const marker of ["获取图标API URL", "自定义CSS"]) {
        assert.ok(text.includes(marker), `选中 config-appearance 后应看到「${marker}」`);
    }
    assert.equal(
        document.querySelector('[role="tab"]'),
        null,
        "摊平后中心内不许再有二级 Tab（那层藏东西的目录已删）"
    );
});

test("数据与维护段：只有离线/同步/维护/版本升级，数据保留已迁走", async t => {
    t.after(cleanup);
    // 数据保留迁家（A+B）：规则跟着被管的东西走 —— 它管的是回收站/审计的
    // 过期清除，所以必须住在「数据安全」，不许再出现在「数据与维护」里。
    const { props } = makeProps({ initialPanel: "config-data" });
    await mount(props);
    for (let i = 0; i < 4; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
        });
    }
    const text = document.body.textContent || "";
    assert.ok(text.includes("离线增强"), "数据与维护段应看到「离线增强」");
    assert.ok(text.includes("检查更新"), "版本升级已从「高级」迁到本段尾");
    assert.equal(
        document.getElementById("retention-days"),
        null,
        "数据保留不许留在「数据与维护」—— 它已经迁进「数据安全」"
    );
    assert.equal(
        document.querySelector('[role="tab"]'),
        null,
        "摊平后中心内不许再有二级 Tab"
    );
});

test("数据安全段：保留策略 + 备份与恢复 + 回收站，三节同屏", async t => {
    t.after(cleanup);
    // A+B：「备份与恢复」+「回收站」合成一个讲完整故事的面板，
    // 数据保留策略住在最上面（先定策略、再看现状）。
    //
    // 2026-11（第二波）：本面板原来叠着两条整宽下划线 Tab 栏（备份 / 恢复 / 导入、
    // 站点 / 分组），现在都换成了紧凑分段控件 SegmentedSwitch（role=group +
    // aria-pressed 的按钮组）。原实现根本没兑现 ARIA Tab 契约（没有 role=tabpanel、
    // 没有 aria-controls/id 配对、没有 roving tabindex），所以这里是「把假页签拆掉」
    // 而不是「多了一层合法页签」——中心内现在真的**一个** [role=tab] 都没有了。
    const { props } = makeProps({ initialPanel: "backup" });
    await mount(props);
    for (let i = 0; i < 4; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
        });
    }
    const text = document.body.textContent || "";
    for (const marker of ["审计与回收站保留", "备份与恢复", "回收站"]) {
        assert.ok(text.includes(marker), `数据安全段应看到「${marker}」`);
    }
    assert.equal(
        document.querySelector('[role="tab"]'),
        null,
        "备份视图 / 回收站类型已改成分段控件，数据安全段里不许再有 [role=tab]"
    );
});
