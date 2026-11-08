import { useCallback, useMemo } from "react";
import type {
    Note
} from "../../API/http";
import { mapWithConcurrency } from "../../utils/concurrency";

export interface NotesBulkOpsDeps {
    /** 当前列表（filtered）里的笔记 */
    filtered: Note[];
    /** 多选里勾中的 id 集合 */
    checked: Set<number>;
    /** 逐条走现有的归档（混选按「多数」取向） */
    onToggleArchive: (note: Note) => void | Promise<void>;
    /** 逐条删除（没有 onDeleteMany 时的降级路径） */
    onDelete: (note: Note) => void | Promise<void>;
    /** 批量删除：一次请求删掉一批，返回没删掉的 id（勾选要保留在它们上） */
    onDeleteMany?: (notes: Note[]) => Promise<{ failed: number[] }>;
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
    const { filtered, checked, onToggleArchive, onDelete, onDeleteMany, onNotify, setChecked, setBulkDeleteOpen, bulkBusy, setBulkBusy } = deps;

    const checkedNotes = useMemo(
        () => filtered.filter(n => n.id !== undefined && checked.has(n.id)),
        [filtered, checked]
    );

    const bulkArchive = useCallback(async () => {
        if (bulkBusy) return;
        setBulkBusy(true);
        try {
            // 并发走现有的归档（mapWithConcurrency，并发度 6），不再串行 await 每一条：
            // 混选（有归档有没归档）时按「多数」取向 —— 只要还有没归档的就全部归档，
            // 否则全部取回，避免一次点完变成「反的」。
            // ⚠️ 判据仍是「当前状态 === 目标」就跳过（已经归档的不用再归档一次），
            // 且每条依旧单独调 onToggleArchive，单条语义一点没变。
            const target = checkedNotes.some(n => !n.archived);
            await mapWithConcurrency(checkedNotes, 6, async n => {
                if (Boolean(n.archived) === target) return;
                await onToggleArchive(n);
            });
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
            let failed: number[] = [];
            if (onDeleteMany) {
                // 一次请求 + 一次 setState：界面一下清空，不再一条条消失
                failed = (await onDeleteMany(checkedNotes)).failed ?? [];
            } else {
                // 降级：老调用方没接批量接口时保留原来的逐条循环
                for (const n of checkedNotes) await onDelete(n);
            }
            const deletedCount = checkedNotes.length - failed.filter(id =>
                checkedNotes.some(n => n.id === id)
            ).length;
            onNotify?.(`已删除 ${deletedCount} 条（可在回收站里还原）`, "success");
            // 没删掉的保留勾选，别无条件清空
            setChecked(new Set(failed));
            setBulkDeleteOpen(false);
        } catch (error) {
            onNotify?.("批量删除失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBulkBusy(false);
        }
    }, [bulkBusy, checkedNotes, onDelete, onDeleteMany, onNotify, setBulkBusy, setBulkDeleteOpen, setChecked]);

    return { checkedNotes, bulkArchive, bulkDelete };
}
