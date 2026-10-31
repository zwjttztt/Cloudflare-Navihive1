// 顶栏右侧那一整组动作（含「更多选项」）。
//
// 从 App.tsx 搬来的纯搬迁：原先是内联在 SiteListHeader 的 actions 里的一坨 ——
// 47 行密集 JSX 加上十几个「点一下要顺手关菜单、再开某个弹窗」的回调。
// 单独放一处之后，App 里只剩一行 <HeaderActionsSlot .../>。
//
// 2026-10-29：「更多选项」从**下拉菜单**换成**统一中心弹窗**
// （NavigationCenterDialog）。中心本身不再挂在这里 —— 它带九个面板、
// 十来个回调，而且移动端底栏的「更多」也要开同一个中心；挂在 App 里才
// 有单一的挂载点（桌面与移动两个入口打开的是同一个实例）。
// 这里只剩一件事：把「打开中心」的回调与开关状态转发给 HeaderActions。

import HeaderActions from "./HeaderActions";
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
    /** 打开「更多选项」中心 */
    onMenuOpen: () => void;
    /** 中心是否开着（按钮的 aria-expanded 用它） */
    menuOpen: boolean;
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
        />
    );
}
