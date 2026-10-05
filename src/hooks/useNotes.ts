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

/** 本域用到的后端方法，单测里可以塞假实现 */
export type NotesApiLike = {
    listNotes(): Promise<Note[]>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }>;
};

type UseNotesParams = {
    api: NotesApiLike;
    onError: (message: string) => void;
    onNotify: (message: string, level?: NotifySeverity) => void;
};

export function useNotes({ api, onError, onNotify }: UseNotesParams) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loaded, setLoaded] = useState(false);

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

    return { notes, loaded, reload, createNote, updateNote, deleteNote, togglePin, saveOrder };
}
