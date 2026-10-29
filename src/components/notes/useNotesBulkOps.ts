import { useCallback, useMemo } from "react";
import type {
    Note
} from "../../API/http";

export interface NotesBulkOpsDeps {
    /** 当前列表（filtered）里的笔记 */
    filtered: Note[];
    /** 多选里勾中的 id 集合 */
    checked: Set<number>;
    /** 逐条走现有的归档（混选按「多数」取向） */
    onToggleArchive: (note: Note) => void | Promise<void>;
    /** 逐条删除 */
    onDelete: (note: Note) => void | Promise<void>;
    /** 回执 */
    onNotify?: (message: string, kind?: "success" | "error" | "info") => void;
    /** 清空勾选 */
    setChecked: (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
    /** 关闭批量删除确认弹窗 */
    setBulkDeleteOpen: (open: boolean) => void;
    /** 忙碌态（防重复提交） */
    bulkBusy: boolean;
    /** 设置忙碌态 */
    setBulkBusy: (busy: boolean) => void;
}


export function useNotesBulkOps(deps: NotesBulkOpsDeps) {
    const { filtered, checked, onToggleArchive, onDelete, onNotify, setChecked, setBulkDeleteOpen, bulkBusy, setBulkBusy } = deps;

    const checkedNotes = useMemo(
        () => filtered.filter(n => n.id !== undefined && checked.has(n.id)),
        [filtered, checked]
    );

    const bulkArchive = useCallback(async () => {
        if (bulkBusy) return;
        setBulkBusy(true);
        try {
            // 逐条走现有的归档：混选（有归档有没归档）时按「多数」取向 ——
            // 只要还有没归档的就全部归档，否则全部取回，避免一次点完变成「反的」
            const target = checkedNotes.some(n => !n.archived);
            for (const n of checkedNotes) {
                // ⚠️ 判据是「当前状态 === 目标」就跳过（已经归档的不用再归档一次）。
                // 写成 !== 会把**所有**条目都跳过：批量归档变成「点了没反应」
                //（用例里 archived 一直是空数组才抓出来的）。
                if (Boolean(n.archived) === target) continue;
                await onToggleArchive(n);
            }
            onNotify?.(
                target ? `已归档 ${checkedNotes.length} 条` : `已取回 ${checkedNotes.length} 条`,
                "success"
            );
            setChecked(new Set());
        } catch (error) {
            onNotify?.("批量归档失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBulkBusy(false);
        }
    }, [bulkBusy, setBulkBusy, checkedNotes, onNotify, setChecked, onToggleArchive]);

    const bulkDelete = useCallback(async () => {
        if (bulkBusy) return;
        setBulkBusy(true);
        try {
            for (const n of checkedNotes) await onDelete(n);
            onNotify?.(`已删除 ${checkedNotes.length} 条（可在回收站里还原）`, "success");
            setChecked(new Set());
            setBulkDeleteOpen(false);
        } catch (error) {
            onNotify?.("批量删除失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBulkBusy(false);
        }
    }, [bulkBusy, checkedNotes, onDelete, onNotify, setBulkBusy, setBulkDeleteOpen, setChecked]);

    return { checkedNotes, bulkArchive, bulkDelete };
}
