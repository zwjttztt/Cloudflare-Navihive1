// src/components/notes/useNotesRowActions.ts
// 记事本的「行操作 / 多选 / 删除确认」状态（2026-10-22 从 NotesPage 抽出，第二步）。
//
// 与 useNotesPanels 的分工：那边是「看内容的面板」（版本历史、灯箱、大纲…），
// 这边是「对条目做动作时的一次性交互」—— 右键菜单、批量选择、删除/重命名的确认弹窗。
// 共同点依旧是**只服务各自那块 UI**，不牵涉列表数据本身，所以零外部依赖：
// 搬进来不会产生新的调用顺序问题。
import { useCallback, useState } from "react";
import type { MenuAnchor } from "./sidebarSection";

/** 新建 / 重命名文件夹与标签的提示框配置 */
export interface NamePromptState {
    kind: "folder" | "tag";
    title: string;
    description?: string;
    defaultValue?: string;
    confirmText: string;
    /** 只有文件夹有：新建子文件夹时要挂到谁下面 */
    parentId: number | null;
    /** 重命名时：要改的是哪一个 */
    renameId?: number;
}

/** 待删除对象（确认弹窗用） */
export interface RemoveTarget {
    kind: "folder" | "tag";
    id: number;
    name: string;
}

/** 列表行操作菜单的锚点状态 */
export interface RowMenuState {
    noteId: number;
    /** ⋯按钮打开 = 元素本身；右键打开 = 鼠标坐标虚拟元素 */
    el: MenuAnchor;
    /** 菜单从哪里打开：列表行菜单全量；左栏内联笔记给精简菜单 */
    source: "list" | "rail";
}

/** 行内的标签选择 / 导出选择浮层 */
export interface RowPickState {
    el: MenuAnchor;
    noteId: number;
}

export function useNotesRowActions() {
    /** 批量多选模式：开了之后列表行显示复选框 */
    const [multiSelect, setMultiSelect] = useState(false);
    const [checked, setChecked] = useState<Set<number>>(() => new Set());

    /** 导出菜单（工具栏那个）的锚点 */
    const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);

    /** 新建 / 重命名文件夹与标签的提示框 */
    const [namePrompt, setNamePrompt] = useState<NamePromptState | null>(null);

    /** 待删除对象（确认弹窗用） */
    const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
    const closeRemove = useCallback(() => setRemoveTarget(null), []);

    /** 列表行的操作菜单：记住是哪条笔记 + 锚在哪 + 从哪打开的 */
    const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
    /**
     * 行菜单正在关闭（退出动画那 ~200ms + 焦点还原窗口，共 300ms）：
     * 给行内「⋯」按钮打 --closing 硬压 opacity，避免菜单没了按钮还亮着。
     */
    const [menuClosing, setMenuClosing] = useState(false);
    /** 刚刚因为操作关掉菜单的那一行：短时间内不再响应它的行内按钮 */
    const [rowActionsSuppressed, setRowActionsSuppressed] = useState<number | null>(null);

    /** 行内「加标签」「导出」两个浮层 */
    const [tagPick, setTagPick] = useState<RowPickState | null>(null);
    const [exportPick, setExportPick] = useState<RowPickState | null>(null);

    /** 批量删除的确认弹窗与忙碌态（忙碌时按钮禁用，挡重复提交） */
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
    const [bulkBusy, setBulkBusy] = useState(false);

    return {
        multiSelect,
        setMultiSelect,
        checked,
        setChecked,
        exportAnchor,
        setExportAnchor,
        namePrompt,
        setNamePrompt,
        removeTarget,
        setRemoveTarget,
        closeRemove,
        rowMenu,
        setRowMenu,
        menuClosing,
        setMenuClosing,
        rowActionsSuppressed,
        setRowActionsSuppressed,
        tagPick,
        setTagPick,
        exportPick,
        setExportPick,
        bulkDeleteOpen,
        setBulkDeleteOpen,
        bulkBusy,
        setBulkBusy,
    };
}
