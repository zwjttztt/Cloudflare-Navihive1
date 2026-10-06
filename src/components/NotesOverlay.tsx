// src/components/NotesOverlay.tsx
// 记事本的**懒加载入口**：hook（useNotes）与视图（NotesPage）都在这里面，
// 于是「打开记事本」之前，这整块代码一行都不进首屏包。
//
// 为什么值得单独一个文件（2026-10-06）：
// `NotesPage` 组件本身早就是 `lazy(() => import(...))` 了，但 **hook 还在首屏** ——
// 因为 App 顶层直接调了 `useNotes()`，而 hooks 不能异步调用。
// 结果：首屏包里still留着 hook 的全部逻辑与文案（实测 22 条中文文案、
// 连带整个 notes/recycle 的数据层都跟着进去）。
//
// ⚠️ 唯一从 App 那边漏出来的需求是**菜单上那个「记事本（N）」的计数**。
// 那个数字改由 App 自己用一个 `notesCount` state 持有，进入本组件时同步一次 ——
// 一个数字换一整个 hook 出首屏，这笔买卖很划算。
//
// 换句话说：这里的 props 只有「关掉自己」和「通知」两件事，
// 凡是记事本自己的状态，都由本组件内部持有。
import { useEffect, useMemo, useState } from "react";
import NotesPage from "./NotesPage";
import type { NoteShareApi } from "./NoteShareDialog";
import { useNotes, type NotesApiLike } from "../hooks/useNotes";

export interface NotesOverlayProps {
    /**
     * 只需要 useNotes 要的那一部分 API。
     *
     * ⚠️ 这里刻意用 `NotesApiLike` 而不是 App 里的具体 client 类型：
     * 那个类型的 `restoreRecycleItem` 返回 `Promise<boolean>`，
     * 而 useNotes 声明的接口要 `Promise<{success:boolean}>` ——
     * 直接写具体类型会在此报一个和业务毫无关系的类型不兼容。
     */
    api: NotesApiLike & Partial<NoteShareApi>;
    /** 关掉整个记事本层 */
    onClose: () => void;
    onError: (message: string) => void;
    onNotify: (message: string, severity?: "success" | "error" | "info") => void;
    /** 把当前笔记数回报给宿主（菜单上那个「记事本（N）」要用） */
    onCountChange: (count: number) => void;
    /** 左下角显示的账号名（inkstone 布局）。没传就不显示具体用户名 */
    accountName?: string;
}

export default function NotesOverlay({
    api,
    onClose,
    onError,
    onNotify,
    onCountChange,
    accountName,
}: NotesOverlayProps) {
    const {
        notes,
        trash,
        loadTrash,
        restoreTrashed,
        purgeTrashed,
        emptyTrash,
        toggleArchive,
        createNote,
        updateNote,
        deleteNote,
        togglePin,
        folders,
        tags,
        noteTags,
        createFolder,
        moveFolder,
        reorderFolder,
        renameFolder,
        styleFolder,
        removeFolder,
        createTag,
        renameTag,
        removeTag,
        assignTags,
        listRevisions,
        restoreRevision,
    } = useNotes({ api, onError, onNotify });

    /**
     * 打包给左栏第一列的那一套。
     *
     * ⚠️ 用 useMemo 而不是每次渲染新造一个字面量：NotesPage 里那几个 callback 会把
     * 这里挂进去的方法当依赖，外层对象每次都变会让它们跟着重跑（回调一变，
     * 下方 memo 与 effect 全失效，严重的会滚成「内存打满」那类死循环）。
     * （这段原本在 App.tsx 里，跟着 hook 一起搬到了这里。）
     */
    const folderTags = useMemo(
        () => ({
            folders,
            tags,
            noteTags,
            onCreateFolder: createFolder,
            onMoveFolder: moveFolder,
            onReorderFolder: reorderFolder,
            onRenameFolder: renameFolder,
            onStyleFolder: styleFolder,
            onRemoveFolder: removeFolder,
            onCreateTag: createTag,
            onRenameTag: renameTag,
            onRemoveTag: removeTag,
            onAssignTags: assignTags,
            onListRevisions: listRevisions,
            onRestoreRevision: restoreRevision,
        }),
        [
            folders,
            tags,
            noteTags,
            createFolder,
            moveFolder,
            reorderFolder,
            renameFolder,
            styleFolder,
            removeFolder,
            createTag,
            renameTag,
            removeTag,
            assignTags,
            listRevisions,
            restoreRevision,
        ]
    );

    // 笔记数变化时回报宿主。
    // ⚠️ 依赖里放 `notes.length` 而不是 `notes` 本身：notes 每次保存都会换新引用，
    // 用它当依赖会在这里多跑一轮（而这里只是算个数字，不值当）。
    const [lastCount, setLastCount] = useState(notes.length);
    useEffect(() => {
        if (notes.length !== lastCount) {
            setLastCount(notes.length);
            onCountChange(notes.length);
        }
    }, [notes.length, lastCount, onCountChange]);

    return (
        <NotesPage
            shareApi={api.getNoteShare && api.createNoteShare && api.revokeNoteShare ? api as NotesApiLike & NoteShareApi : undefined}
            notes={notes}
            onClose={onClose}
            accountName={accountName}
            onCreate={createNote}
            onUpdate={updateNote}
            onDelete={deleteNote}
            onTogglePin={togglePin}
            trashedNotes={trash}
            onLoadTrash={loadTrash}
            onRestoreTrashed={restoreTrashed}
            onPurgeTrashed={purgeTrashed}
            onEmptyTrash={emptyTrash}
            onToggleArchive={toggleArchive}
            onNotify={onNotify}
            folderTags={folderTags}
        />
    );
}
