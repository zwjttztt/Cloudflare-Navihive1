// src/hooks/useTagOpsActions.ts
// 标签的重命名 / 合并：调纯函数算出结果 → 整份写回 → 给一次「撤销」。
//
// 两个操作都会一次改动几十张卡片，所以必须留退路：提示条上挂「撤销」，
// 撤销就是把改动前的整份标签表原样写回（比逐条反算可靠得多）。
import { useCallback } from "react";
import { mergeTags, renameTag, type TagMap } from "../utils/tagOps";

type NotifyFn = (
    text: string,
    level?: "success" | "error" | "info",
    ms?: number,
    act?: { label: string; onClick: () => void }
) => void;

export interface TagOpsActionsParams {
    /** 当前整份标签表（站点 id -> 标签数组） */
    tags: TagMap;
    /** 整份写回（UIPrefs 的 applyTagOps） */
    applyTagOps: (next: TagMap) => void;
    /** 正在用哪些标签筛选：改名后筛选条件要跟着换，否则瞬间筛出一片空白 */
    setActiveTags: React.Dispatch<React.SetStateAction<string[]>>;
    notify: NotifyFn;
}

export interface TagOpsActions {
    renameTagWithUndo: (from: string, to: string) => boolean;
    mergeTagsWithUndo: (sources: string[], target: string) => boolean;
}

export function useTagOpsActions({
    tags,
    applyTagOps,
    setActiveTags,
    notify,
}: TagOpsActionsParams): TagOpsActions {
    /** 写回 + 同步筛选条件，并把旧表交出去供撤销 */
    const commit = useCallback(
        (next: TagMap, moved: { from: string[]; to: string }, message: string) => {
            const before = tags;
            applyTagOps(next);
            setActiveTags(prev => {
                const changed = prev.map(t => (moved.from.includes(t) ? moved.to : t));
                return Array.from(new Set(changed));
            });
            notify(message, "info", 8000, {
                label: "撤销",
                onClick: () => {
                    applyTagOps(before);
                    setActiveTags(prev =>
                        Array.from(new Set(prev.map(t => (t === moved.to ? moved.from[0] : t))))
                    );
                    notify("已撤销", "success");
                },
            });
        },
        [tags, applyTagOps, setActiveTags, notify]
    );

    const renameTagWithUndo = useCallback(
        (from: string, to: string) => {
            const result = renameTag(tags, from, to);
            if (!result) {
                notify(`「${from.trim()}」没有可改动的卡片，或者新名字是空的`, "info");
                return false;
            }
            const target = to.trim();
            commit(
                result.tags,
                { from: [from.trim()], to: target },
                `已把「${from.trim()}」改名为「${target}」（${result.affected.length} 个网站）`
            );
            return true;
        },
        [tags, commit, notify]
    );

    const mergeTagsWithUndo = useCallback(
        (sources: string[], target: string) => {
            const result = mergeTags(tags, sources, target);
            if (!result) {
                notify("没有可合并的标签，或者目标名是空的", "info");
                return false;
            }
            const wanted = sources.map(s => s.trim()).filter(Boolean);
            commit(
                result.tags,
                { from: wanted, to: target.trim() },
                `已把 ${wanted.map(s => `「${s}」`).join("、")} 合并到「${target.trim()}」（${result.affected.length} 个网站）`
            );
            return true;
        },
        [tags, commit, notify]
    );

    return { renameTagWithUndo, mergeTagsWithUndo };
}
