// src/components/notes/useNotesPanels.ts
// 记事本的「弹层 / 浮层」状态（2026-10-22 从 NotesPage 抽出，第一步）。
//
// 为什么单独抽：NotesPage 有 67 个 useState，其中十来個是「某个面板开没开、面板里装的是什么」。
// 这类状态的共同点是**只影响自己那块 UI**，与列表、草稿、保存都无关 ——
// 把它们聚到一起，NotesPage 就少一分噪音，改某个面板时也不必在 3800 行里翻。
//
// ⚠️ 这里刻意**不收** `outlineActiveLine`（大纲高亮行）：它的 effect 依赖预览窗的滚动 ref，
//    与滚动同步逻辑强耦合，等「编辑器滚动」那一轮再一起搬。
// ⚠️ 也不收 `graphOpen` / `attManagerOpen` / `backlinksOpen` / `templatePick`：
//    它们各自还牵着别的业务状态，留到对应那一轮。
import { useCallback, useEffect, useState } from "react";
import type { NoteRevision } from "../../API/types";
import { loadNotesSettings } from "../../utils/notesSettings";

export interface NotesPanelsDeps {
    /** 当前打开的笔记 id：版本历史要按它拉列表（没有就空列表） */
    activeId?: number;
    /** 拉版本历史的接口；没配（guest 演示模式）就返回空列表 */
    onListRevisions?: (noteId: number) => Promise<NoteRevision[]>;
}

export function useNotesPanels(deps: NotesPanelsDeps) {
    const { activeId, onListRevisions } = deps;

    // ---------- 文件夹外观弹窗（icon / color） ----------
    const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(null);

    // ---------- 标签颜色弹窗（note_tag.color） ----------
    const [tagColorId, setTagColorId] = useState<number | null>(null);

    // ---------- 「移动到文件夹」右侧抽屉 ----------
    const [moveDrawerNoteId, setMoveDrawerNoteId] = useState<number | null>(null);

    // ---------- 大纲面板（预览窗右侧，inkstone 的「大纲」） ----------
    // 默认开不开读用户设置：偏好是持久的，每次挂载都要认它
    const [outlineOpen, setOutlineOpen] = useState(loadNotesSettings().defaultOutline);

    /** 顶栏「⋯」：对**当前打开的笔记**弹出与右键同一套操作菜单 */
    const [activeMenuAnchor, setActiveMenuAnchor] = useState<HTMLElement | null>(null);

    // ---------- 版本历史（inkstone 顶栏「版本历史」）----------
    const [revisionsOpen, setRevisionsOpen] = useState(false);
    const [shareId, setShareId] = useState<number | null>(null);
    const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);

    /**
     * 打开面板时才拉列表：不为一条没打开过的笔记请求历史。
     * ⚠️ 不保留「正在恢复的版本 id」state：面板自己有 busy 态，
     *    恢复按钮在期间禁用，连点重复提交由面板挡住。
     */
    const openRevisions = useCallback(async () => {
        setRevisionsOpen(true);
        if (activeId === undefined || !onListRevisions) {
            setRevisions([]);
            return;
        }
        setRevisions(null);
        setRevisions(await onListRevisions(activeId));
    }, [activeId, onListRevisions]);

    // ---------- 图片灯箱（inkstone 的 ui.lightbox）：点预览里的图片放大看 ----------
    const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
    const [imageScale, setImageScale] = useState(1);
    const [imageFailed, setImageFailed] = useState(false);
    // 换图就复位缩放与失败态：上一张的「加载失败」不能跟着赖到下一张上
    useEffect(() => {
        setImageScale(1);
        setImageFailed(false);
    }, [lightbox?.src]);

    // ---------- 键盘快捷键帮助 ----------
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    return {
        appearanceFolderId,
        setAppearanceFolderId,
        tagColorId,
        setTagColorId,
        moveDrawerNoteId,
        setMoveDrawerNoteId,
        outlineOpen,
        setOutlineOpen,
        activeMenuAnchor,
        setActiveMenuAnchor,
        revisionsOpen,
        setRevisionsOpen,
        revisions,
        setRevisions,
        openRevisions,
        lightbox,
        setLightbox,
        imageScale,
        setImageScale,
        imageFailed,
        setImageFailed,
        shortcutsOpen,
        setShortcutsOpen,
        shareId,
        setShareId,
    };
}
