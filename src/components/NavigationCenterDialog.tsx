// src/components/NavigationCenterDialog.tsx
// 导航页「设置」的**统一中心弹窗**：一个弹窗装下原来那十来个菜单动作。
//
// 为什么换掉原来的下拉菜单（2026-10-29 用户要求）：菜单里有长表单（全站设置、
// AI 设置）、列表（回收站、审计日志）、备份恢复与账号管理，每一项点开都是
// 一个独立弹窗 —— 尺寸、标题栏、底部按钮文案各不相同，找东西要在两层之间
// 来回跳。现在收成「一个中心 + 左栏换面板」：入口只有一个，尺寸与视觉统一，
// 分类与权限写在 model.ts 一处。
//
// 本文件只做三件事：定义条目从哪来（model.ts）、按 id 分发到哪个面板
// （九个面板各自 lazy，只有被选中那一个会真的下载）、以及左栏底部那颗
// 「退出登录」的二次确认。面板内部怎么画在各面板文件里。
//
// ⚠️ 两条别踩的线：
//   1. 本组件与九个面板**都必须只走动态 import** —— 它挂在首屏的按钮后面，
//      静态 import 会把整套外壳焊进首屏（首屏 gzip 预算只剩约 3% 余量）。
//      守卫：tests/navigationCenterLazyGuard.test.ts。
//   2. 弹出层的无障碍命名只能写在 `slotProps.paper` 上（写 <Dialog> 顶层会
//      落到 Modal 根）。这件事由 settingsWorkspace/SettingsWorkspaceDialog 负责，
//      这里不要再覆盖。
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ChunkBoundary from "./ChunkBoundary";
import ConfirmDialogGate from "./ConfirmDialogGate";
import SettingsWorkspaceDialog from "./settingsWorkspace/SettingsWorkspaceDialog";
import SettingsWorkspaceNav from "./settingsWorkspace/SettingsWorkspaceNav";
import SettingsWorkspacePanel from "./settingsWorkspace/SettingsWorkspacePanel";
import type { WorkspaceNavItem } from "./settingsWorkspace/SettingsWorkspaceNav";
import { prefetchChunk } from "../utils/lazyPrefetch";
import { dialogChunks } from "../utils/dialogChunks";
import {
    findNavItem,
    resolveNavActiveId,
    visibleNavDanger,
    visibleNavGroups,
    type NavCenterPanelId,
} from "./navigationCenter/model";
// 面板的 props 类型走 `import type`：编译期就擦掉了，
// 不会把面板块拉进本 chunk（静态值 import 才会）。
import type { StatsPanelProps } from "./navigationCenter/panels/StatsPanel";
import type { BackupCenterPanelProps } from "./navigationCenter/panels/BackupPanel";
import type { RecycleCenterPanelProps } from "./navigationCenter/panels/RecyclePanel";
import type { AuditCenterPanelProps } from "./navigationCenter/panels/AuditPanel";
import type { ShortcutsCenterPanelProps } from "./navigationCenter/panels/ShortcutsPanel";
import type { VaultCenterPanelProps } from "./navigationCenter/panels/VaultPanel";
import type { AiCenterPanelProps } from "./navigationCenter/panels/AiPanel";
import type { ConfigCenterPanelProps } from "./navigationCenter/panels/ConfigPanel";
import type { AccountCenterPanelProps } from "./navigationCenter/panels/AccountPanel";

// ---- 九个面板：全部按需加载，且**只有被选中那一个会真的下载** ----
// 与 App.tsx 里那些 lazy 弹窗不同，这里是「中心之内再分一层」：
// 打开中心只下外壳块，切到哪个面板才下哪一块（首屏预算经不起九个一起下）。
const StatsPanel = lazy(() => import("./navigationCenter/panels/StatsPanel"));
const BackupPanel = lazy(() => import("./navigationCenter/panels/BackupPanel"));
const RecyclePanel = lazy(() => import("./navigationCenter/panels/RecyclePanel"));
const AuditPanel = lazy(() => import("./navigationCenter/panels/AuditPanel"));
const ConfigPanel = lazy(() => import("./navigationCenter/panels/ConfigPanel"));
const AiPanel = lazy(() => import("./navigationCenter/panels/AiPanel"));
const VaultPanel = lazy(() => import("./navigationCenter/panels/VaultPanel"));
const AccountPanel = lazy(() => import("./navigationCenter/panels/AccountPanel"));
const ShortcutsPanel = lazy(() => import("./navigationCenter/panels/ShortcutsPanel"));

export interface NavigationCenterDialogProps {
    open: boolean;
    /** 关闭中心（× / Esc / 遮罩 / 底栏完成都走这一条） */
    onClose: () => void;
    /**
     * 打开时默认选中哪个面板。
     * 命令面板等外部入口要直达某一屏时用它；不传 = 左栏第一项（统计）。
     */
    initialPanel?: NavCenterPanelId;
    isAuthenticated: boolean;
    isSiteOwner: boolean;
    /** 「统计」面板的输入（App 组装；中心不认识 api / groups） */
    stats: StatsPanelProps;
    /** 「备份与恢复」面板的输入 */
    backup: BackupCenterPanelProps;
    /** 「回收站」面板的输入 */
    recycle: RecycleCenterPanelProps;
    /** 「审计日志」面板的输入（只有 owner 选得到这一屏） */
    audit: AuditCenterPanelProps;
    /** 「全站设置」面板的输入（App 组装；中心不认识那 30 个配置项） */
    config: ConfigCenterPanelProps;
    /** 「AI 设置」面板的输入（App 组装；中心不认识 ai / api） */
    ai: AiCenterPanelProps;
    /** 「密码保险库」面板的输入（App 组装；中心不认识 api / client） */
    vault: VaultCenterPanelProps;
    /** 「账号与安全」面板的输入（App 组装；中心不认识那堆账号状态） */
    account: AccountCenterPanelProps;
    /** 「快捷键与操作帮助」面板的输入（App 组装；中心不认识安装事件） */
    shortcuts: ShortcutsCenterPanelProps;
    /** 退出登录（已过二次确认） */
    onLogout: () => void;
    /**
     * 当「账号与安全」这一屏被激活时触发（拉会话列表 / 账号清单）。
     * 原来这些是在打开独立弹窗时拉的；迁入中心后，中心接管了「打开」语义，
     * 所以把这次拉取钩子挂在这里，避免这一屏进去看到空数据。可选。
     */
    onAccountActivate?: () => void;
}

export default function NavigationCenterDialog({
    open,
    onClose,
    initialPanel,
    isAuthenticated,
    isSiteOwner,
    stats,
    backup,
    recycle,
    audit,
    config,
        vault,
        ai,
        account,
        shortcuts,
        onLogout,
        onAccountActivate,
}: NavigationCenterDialogProps) {
    const [activeId, setActiveId] = useState<NavCenterPanelId>("stats");
    const [logoutConfirm, setLogoutConfirm] = useState(false);

    // 中心一挂载就把九个目标弹窗的块并行取掉（照原 MoreMenu 的做法）：
    // 用户读左栏那几秒足够下完，点哪个都不用再现场等一个 RTT。
    useEffect(() => {
        prefetchChunk("settings", dialogChunks.settings);
        prefetchChunk("stats", dialogChunks.stats);
        prefetchChunk("backup", dialogChunks.backup);
        prefetchChunk("recycle", dialogChunks.recycle);
        prefetchChunk("audit", dialogChunks.audit);
        prefetchChunk("aiAssistant", dialogChunks.aiAssistant);
        prefetchChunk("account", dialogChunks.account);
        prefetchChunk("shortcuts", dialogChunks.shortcuts);
    }, []);

    // 每次打开都回到「这次要去的那一屏」，并把选中项校正成真的可见的那一个。
    // 不记住上次停在哪：第二次打开多半是找另一件事，直接落进上次那屏等于替用户
    // 做了决定。initialPanel 变化（命令面板直达）时同样切过去。
    useEffect(() => {
        if (!open) return;
        setActiveId(
            resolveNavActiveId(initialPanel ?? "stats", { isAuthenticated, isSiteOwner })
        );
    }, [open, initialPanel, isAuthenticated, isSiteOwner]);

    const groups = useMemo(
        () => visibleNavGroups({ isAuthenticated, isSiteOwner }),
        [isAuthenticated, isSiteOwner]
    );
    const dangerItems = useMemo(
        () => visibleNavDanger({ isAuthenticated, isSiteOwner }),
        [isAuthenticated, isSiteOwner]
    );
    // 选中项可能因为权限变化而不可见（退登 / 换账号）：这里统一校正，
    // 不留一个空面板 —— 用户看到空右栏只会以为弹窗坏了
    const active = resolveNavActiveId(activeId, { isAuthenticated, isSiteOwner });

    const navGroups = useMemo(
        () =>
            groups.map(group => ({
                title: group.title,
                items: group.items.map(
                    (item): WorkspaceNavItem => ({
                        id: item.id,
                        label: item.label,
                        icon: <item.icon fontSize='small' />,
                    })
                ),
            })),
        [groups]
    );
    const navDanger = useMemo(
        () =>
            dangerItems.map(
                (item): WorkspaceNavItem => ({
                    id: item.id,
                    label: item.label,
                    icon: <item.icon fontSize='small' />,
                })
            ),
        [dangerItems]
    );

    // 「账号与安全」被激活时拉一次会话列表 / 账号清单（原来是在打开独立弹窗时拉的）。
    // 迁入中心后中心接管了「打开」语义，所以钩子挂在这里，避免这一屏进去看到空数据。
    useEffect(() => {
        if (open && active === "account") onAccountActivate?.();
    }, [open, active, onAccountActivate]);

    /** 右栏正文：九屏全部是真实面板（T01~T04 迁完，不再有占位） */
    const renderPanel = (): ReactNode => {
        if (active === "stats") return <StatsPanel {...stats} />;
        if (active === "backup") return <BackupPanel {...backup} />;
        if (active === "recycle") return <RecyclePanel {...recycle} />;
        if (active === "audit") return <AuditPanel {...audit} />;
        if (active === "config") return <ConfigPanel {...config} />;
        if (active === "account") return <AccountPanel {...account} />;
        if (active === "shortcuts") return <ShortcutsPanel {...shortcuts} />;
        if (active === "vault") return <VaultPanel {...vault} />;
        if (active === "ai") return <AiPanel {...ai} />;
        return null;
    };

    const activeItem = findNavItem(active);

    return (
        <>
            <SettingsWorkspaceDialog
                open={open}
                onClose={onClose}
                title='设置'
                nav={
                    <SettingsWorkspaceNav
                        groups={navGroups}
                        activeId={active}
                        onSelect={id => setActiveId(id as NavCenterPanelId)}
                        dangerItems={navDanger}
                        onSelectDanger={id => {
                            // 退出登录不是导航项：不改选中态，直接过二次确认
                            if (id === "logout") setLogoutConfirm(true);
                        }}
                    />
                }
                actions={
                    <Button
                        variant='contained'
                        size='small'
                        onClick={onClose}
                        data-nav-center-done='1'
                        sx={{ minHeight: 44 }}
                    >
                        完成
                    </Button>
                }
            >
                <SettingsWorkspacePanel
                    title={activeItem?.label ?? "设置"}
                    description={activeItem?.description}
                >
                    {/* 面板是第二层 lazy：块取不到时只坏这一屏，不牵连整个中心 */}
                    <ChunkBoundary>
                        <Suspense fallback={null}>{renderPanel()}</Suspense>
                    </ChunkBoundary>
                </SettingsWorkspacePanel>
            </SettingsWorkspaceDialog>

            {/* 退出登录：二次确认。原来是点一下就退，没有回头的机会 */}
            <ConfirmDialogGate
                open={logoutConfirm}
                title='退出登录'
                description={
                    <Box component='span'>
                        退出后要重新登录才能管理这个站点。站点数据不受影响。
                    </Box>
                }
                confirmText='退出登录'
                cancelText='取消'
                danger
                onConfirm={() => {
                    setLogoutConfirm(false);
                    onClose();
                    onLogout();
                }}
                onClose={() => setLogoutConfirm(false)}
            />
        </>
    );
}
