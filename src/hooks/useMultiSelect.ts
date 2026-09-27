// src/hooks/useMultiSelect.ts
// 批量多选域的纯状态：进入/退出、勾选集合、批量删除确认弹窗的开关。
// 只管「选了什么」；星标 / 标签 / 移动 / 删除这些批量动作仍留在 App——
// 它们各自牵着通知、撤销栈、分组数据等多个子系统，收进来只会得到一个
// 十几个回调的上帝 hook（handleSiteDelete 的教训：耦合没消失只是换地方）。

import { useCallback, useState } from "react";

export interface MultiSelectState {
    /** 是否处于多选模式：进入后点卡片是「勾选」而不是打开网页 */
    multiSelect: boolean;
    /** 已勾选的站点 id */
    selectedIds: number[];
    /** 批量删除前的确认弹窗 */
    bulkDeleteOpen: boolean;
    /** 进入 / 退出多选模式（退出时顺手清空勾选） */
    setMultiSelect: (value: boolean) => void;
    setBulkDeleteOpen: (value: boolean) => void;
    /** 退出多选模式：模式关掉 + 勾选清空 */
    exitMultiSelect: () => void;
    /** 点卡片切换勾选态 */
    toggleSelect: (siteId: number) => void;
    /** 只清空勾选（保留多选模式）：批量删除等收尾动作用 */
    clearSelection: () => void;
}

export function useMultiSelect(): MultiSelectState {
    const [multiSelect, setMultiSelectState] = useState(false);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

    // 退出多选模式时顺手清掉勾选，避免下次进来还残留上一次的选择
    const exitMultiSelect = useCallback(() => {
        setMultiSelectState(false);
        setSelectedIds([]);
    }, []);

    const toggleSelect = useCallback((siteId: number) => {
        setSelectedIds(prev =>
            prev.includes(siteId) ? prev.filter(id => id !== siteId) : [...prev, siteId]
        );
    }, []);

    const clearSelection = useCallback(() => setSelectedIds([]), []);

    const setMultiSelect = useCallback((value: boolean) => {
        if (!value) setSelectedIds([]);
        setMultiSelectState(value);
    }, []);

    return {
        multiSelect,
        selectedIds,
        bulkDeleteOpen,
        setMultiSelect,
        setBulkDeleteOpen,
        exitMultiSelect,
        toggleSelect,
        clearSelection,
    };
}
