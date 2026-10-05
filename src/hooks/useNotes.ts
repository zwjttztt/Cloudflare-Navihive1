// src/hooks/useNotes.ts
// 记事本这个域的状态与请求：从 App.tsx 抽出来，和 useSiteCreator 同一分工 ——
// 这里只管「拿到列表 / 增删改 / 提示」，不碰渲染。
//
// 一个刻意的取舍：**乐观更新 + 失败回滚**，而不是等服务端回来再改界面。
// 记事本是「想到就写」的场景，保存要是有 200ms 的延迟，手感会立刻变差；
// 而失败时回滚到旧值 + 提示，代价远小于「每敲一个字都等一下」。
import { useCallback, useEffect, useState } from "react";
import type { Note } from "../API/http";
import { reportError } from "../utils/errorReporter";
import type { NotifySeverity } from "./useNotify";

/** 回收站里的一条（阶段三：只把 kind='note' 的拎出来给记事本用） */
export interface TrashedNote {
    /** recycle_bin.id —— 还原 / 彻底删除都用它，不是 notes.id */
    recycleId: number;
    title: string;
    /** 删除时间（毫秒时间戳） */
    deletedAt: number;
}

/** 本域用到的后端方法，单测里可以塞假实现 */
export type NotesApiLike = {
    listNotes(): Promise<Note[]>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }>;
    // 阶段三：回收站。⚠️ 这几个是**可选**的 —— 老 mock / 老调用方没实现时，
    // 记事本要能优雅降级成「回收站视图不可用」，而不是整个页面崩。
    getRecycleBin?(): Promise<{
        items?: Array<{ id: number; kind: "site" | "group" | "note"; name: string; deletedAt: number }>;
    }>;
    restoreRecycleItem?(id: number): Promise<{ success: boolean }>;
    purgeRecycleItem?(id: number): Promise<{ success: boolean }>;
    emptyRecycleBin?(): Promise<{ success: boolean }>;
};

type UseNotesParams = {
    api: NotesApiLike;
    onError: (message: string) => void;
    onNotify: (message: string, level?: NotifySeverity) => void;
};

export function useNotes({ api, onError, onNotify }: UseNotesParams) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loaded, setLoaded] = useState(false);
    /** 阶段三：回收站里的笔记（懒加载，进「回收站」视图时才拉） */
    const [trash, setTrash] = useState<TrashedNote[]>([]);

    const reload = useCallback(async () => {
        try {
            const list = await api.listNotes();
            setNotes(Array.isArray(list) ? list : []);
            setLoaded(true);
        } catch (error) {
            reportError(error, { source: "notes-list" });
            onError("加载记事本失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onError]);

    // 首屏拉一次：笔记条数要显示在顶栏按钮上，不能等用户点开面板才加载
    useEffect(() => {
        void reload();
    }, [reload]);

    const createNote = useCallback(
        async (draft: Partial<Note> = {}) => {
            try {
                const created = await api.createNote(draft);
                setNotes(prev => [...prev, created]);
                return created;
            } catch (error) {
                reportError(error, { source: "note-create" });
                onError("新建笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onError]
    );

    /** 乐观更新：先把界面上改掉，失败再回滚到旧值并提示 */
    const updateNote = useCallback(
        async (id: number, patch: Partial<Note>) => {
            const before = notes.find(n => n.id === id);
            if (!before) return;
            setNotes(prev => prev.map(n => (n.id === id ? { ...n, ...patch } : n)));
            try {
                const saved = await api.updateNote(id, patch);
                if (saved) {
                    setNotes(prev => prev.map(n => (n.id === id ? saved : n)));
                }
            } catch (error) {
                reportError(error, { source: "note-update" });
                setNotes(prev => prev.map(n => (n.id === id ? before : n)));
                onError("保存笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [notes, api, onError]
    );

    /** 置顶：走同一个 updateNote（服务端白名单里有 pinned） */
    const togglePin = useCallback(
        async (note: Note) => {
            await updateNote(note.id!, { pinned: !note.pinned });
        },
        [updateNote]
    );

    const deleteNote = useCallback(
        async (note: Note) => {
            const before = notes;
            // 先从列表里拿掉，用户点删除就该马上看到它消失
            setNotes(prev => prev.filter(n => n.id !== note.id));
            try {
                const res = await api.deleteNote(note.id!);
                onNotify(
                    res.recycleId
                        ? "笔记已移到回收站，可在「回收站」里还原"
                        : "笔记已删除",
                    "success"
                );
            } catch (error) {
                reportError(error, { source: "note-delete" });
                setNotes(before);
                onError("删除笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [notes, api, onNotify, onError]
    );

    /** 拖拽排序后把新顺序写回去；失败不重排（服务端是唯一真相） */
    const saveOrder = useCallback(
        async (ordered: Note[]) => {
            setNotes(ordered);
            try {
                await (api as unknown as {
                    updateNoteOrder(o: { id: number; order_num: number }[]): Promise<boolean>;
                }).updateNoteOrder(
                    ordered.map((n, i) => ({ id: n.id!, order_num: i }))
                );
            } catch (error) {
                reportError(error, { source: "note-order" });
                onError("保存排序失败，正在重新加载");
                void reload();
            }
        },
        [api, onError, reload]
    );

    // ---------- 阶段三：回收站 + 归档 ----------

    /**
     * 拉回收站里的笔记。
     *
     * 只留 `kind === "note"`：同一个回收站还放着被删的卡片和分组，
     * 那是主站那边的界面管的事，记事本不该把它们列进来。
     */
    const loadTrash = useCallback(async () => {
        if (typeof api.getRecycleBin !== "function") {
            setTrash([]);
            return;
        }
        try {
            const res = await api.getRecycleBin();
            setTrash(
                (res?.items || [])
                    .filter(i => i.kind === "note")
                    .map(i => ({ recycleId: i.id, title: i.name, deletedAt: i.deletedAt }))
            );
        } catch (error) {
            reportError(error, { source: "notes-trash-list" });
            setTrash([]);
            onError("读取回收站失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onError]);

    /** 从回收站还原一条：服务端会插回一条**新 id** 的笔记，所以要整表重拉 */
    const restoreTrashed = useCallback(
        async (recycleId: number) => {
            if (typeof api.restoreRecycleItem !== "function") return;
            try {
                await api.restoreRecycleItem(recycleId);
                onNotify("已还原到全部笔记", "success");
                await loadTrash();
                await reload();
            } catch (error) {
                reportError(error, { source: "notes-trash-restore" });
                onError("还原失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onNotify, onError, loadTrash, reload]
    );

    /** 彻底删除：这一下就找不回来了，所以按钮要跟「还原」分开放 */
    const purgeTrashed = useCallback(
        async (recycleId: number) => {
            if (typeof api.purgeRecycleItem !== "function") return;
            try {
                await api.purgeRecycleItem(recycleId);
                onNotify("已彻底删除", "success");
                await loadTrash();
            } catch (error) {
                reportError(error, { source: "notes-trash-purge" });
                onError("彻底删除失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onNotify, onError, loadTrash]
    );

    /** 清空回收站（只清笔记，不动卡片和分组） */
    const emptyTrash = useCallback(async () => {
        if (typeof api.emptyRecycleBin !== "function") return;
        try {
            await api.emptyRecycleBin();
            onNotify("回收站已清空", "success");
            await loadTrash();
        } catch (error) {
            reportError(error, { source: "notes-trash-empty" });
            onError("清空回收站失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onNotify, onError, loadTrash]);

    /** 归档 / 取回归档：乐观更新走 updateNote，归档后不在「全部」里露面 */
    const toggleArchive = useCallback(
        async (note: Note) => {
            await updateNote(note.id!, { archived: !note.archived });
        },
        [updateNote]
    );

    return {
        notes,
        loaded,
        reload,
        createNote,
        updateNote,
        deleteNote,
        togglePin,
        saveOrder,
        trash,
        loadTrash,
        restoreTrashed,
        purgeTrashed,
        emptyTrash,
        toggleArchive,
    };
}
