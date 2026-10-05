// 顶栏右侧那一整组动作（含「更多选项」菜单）。
//
// 从 App.tsx 搬来的纯搬迁：原先是内联在 SiteListHeader 的 actions 里的一坨 ——
// 47 行密集 JSX 加上十几个「点一下要顺手关菜单、再开某个弹窗」的回调。
// 单独放一处之后，App 里只剩一行 <HeaderActionsSlot .../>。
//
// ⚠️ 菜单项那些回调看着重复（每个都是 handleMenuClose() + setXxx(true)），
// 别合并成一个 openDialog(id)：这批弹窗各有各的附加动作（开账号要顺带拉一次
// 账号列表与会话列表），合成一个分发函数反而要把这些差异塞进去。

import HeaderActions from "./HeaderActions";
import MoreMenu from "./MoreMenu";
import { SortMode } from "../constants";

export interface HeaderActionsSlotProps {
    sortMode: SortMode;
    onSaveGroupOrder: () => void;
    onSaveSiteSort: () => void;
    onCancelSort: () => void;
    onQuickAdd: () => void;
    addTargetName?: string;
    onOpenAddGroup: () => void;
    /** 打开记事本面板 */
    onOpenNotes: () => void;
    /** 笔记条数（0 时按钮不显示角标） */
    notesCount: number;
    onMenuOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
    /** 菜单开关状态。菜单实际是否展开由内部再叠一层排序模式判断 */
    menuOpen: boolean;
    // ---- 「更多选项」菜单需要的 ----
    menuAnchorEl: HTMLElement | null;
    onMenuClose: () => void;
    onOpenConfig: () => void;
    onOpenAccount: () => void;
    onStartGroupSort: () => void;
    canInstall: boolean;
    onInstallApp: () => void;
    onOpenVisits: () => void;
    onOpenBackup: () => void;
    onOpenRecycle: () => void;
    onOpenAudit: () => void;
    isAuthenticated: boolean;
    onLogout: () => void;
    onOpenAiAssistant: () => void;
    onOpenShortcuts: () => void;
    isSiteOwner: boolean;
}

export default function HeaderActionsSlot({
    sortMode,
    onSaveGroupOrder,
    onSaveSiteSort,
    onCancelSort,
    onQuickAdd,
    addTargetName,
    onOpenAddGroup,
    onOpenNotes,
    notesCount,
    onMenuOpen,
    menuOpen,
    menuAnchorEl,
    onMenuClose,
    onOpenConfig,
    onOpenAccount,
    onStartGroupSort,
    canInstall,
    onInstallApp,
    onOpenVisits,
    onOpenBackup,
    onOpenRecycle,
    onOpenAudit,
    isAuthenticated,
    onLogout,
    onOpenAiAssistant,
    onOpenShortcuts,
    isSiteOwner,
}: HeaderActionsSlotProps) {
    return (
        <HeaderActions
            sortMode={sortMode}
            onSaveGroupOrder={onSaveGroupOrder}
            onSaveSiteSort={onSaveSiteSort}
            onCancelSort={onCancelSort}
            onQuickAdd={onQuickAdd}
            addTargetName={addTargetName}
            onOpenAddGroup={onOpenAddGroup}
            onOpenNotes={onOpenNotes}
            notesCount={notesCount}
            onMenuOpen={onMenuOpen}
            menuOpen={menuOpen}
            menu={
                <MoreMenu
                    anchorEl={menuAnchorEl}
                    // 排序模式下整组动作都换成「保存 / 取消」，菜单不该还开着
                    open={menuOpen && sortMode === SortMode.None}
                    onClose={onMenuClose}
                    onOpenConfig={onOpenConfig}
                    onOpenAccount={onOpenAccount}
                    onStartGroupSort={onStartGroupSort}
                    canInstall={canInstall}
                    onInstallApp={onInstallApp}
                    onOpenVisits={onOpenVisits}
                    onOpenBackup={onOpenBackup}
                    onOpenRecycle={onOpenRecycle}
                    onOpenAudit={onOpenAudit}
                    isAuthenticated={isAuthenticated}
                    onLogout={onLogout}
                    onOpenAiAssistant={onOpenAiAssistant}
                    onOpenShortcuts={onOpenShortcuts}
                    isSiteOwner={isSiteOwner}
                />
            }
        />
    );
}
