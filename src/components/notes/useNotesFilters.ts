// src/components/notes/useNotesFilters.ts
// 记事本的「筛选与排序条件」（2026-10-22 从 NotesPage 抽出，第四步）。
//
// ⚠️ 这里**只搬纯输入态**：搜索词、视图、排序键、选中的文件夹/标签、远端搜索结果、最近打开。
//    `notes` 列表本身和那些派生 useMemo（按关键词过滤、按文件夹归类、排序后的可见列表…）
//    **刻意留在了 NotesPage** —— 它们与分组树、拖拽、虚拟列表缠在一起，
//    要搬得连派生一起搬，那是独立一轮的事（见 deliverables/notespage-split-plan-2026-10-22.md）。
//
// 为什么能安全地只搬这些：它们全是「用户此刻的筛选意图」，没有一个是算出来的，
// 也不依赖 props —— 所以搬进来不会产生新的调用顺序问题。
import { useState } from "react";
import type { NoteView } from "./notesPageCtx";

/** 列表排序方式 */
export type NoteSortKey = "default" | "title" | "created";

/** 服务端搜索的结果（本地没命中时走远端） */
export interface RemoteSearchState {
    keyword: string;
    hits: { id: number; title: string; snippet: string; score: number }[];
    /** 服务端用的检索方式：fts = 全文索引，like = 降级成 LIKE 全表扫 */
    mode?: "fts" | "like";
}

export function useNotesFilters() {
    /** 搜索框里的词（本地过滤用） */
    const [keyword, setKeyword] = useState("");

    /** 视图：全部 / 收藏 / 归档 / 回收站… */
    const [view, setView] = useState<NoteView>("all");

    /** 排序方式 + 排序菜单的锚点 */
    const [sortKey, setSortKey] = useState<NoteSortKey>("default");
    const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);

    /** 左栏当前选中的文件夹 / 标签（null = 未筛选） */
    const [activeFolder, setActiveFolder] = useState<number | null>(null);
    const [activeTag, setActiveTag] = useState<number | null>(null);

    /** 远端搜索结果：本地没命中时才去问服务端，结果连同检索方式一起存 */
    const [remoteSearch, setRemoteSearch] = useState<RemoteSearchState | null>(null);

    /** 最近打开的笔记 id（命令面板与「最近」入口用） */
    const [recentNoteIds, setRecentNoteIds] = useState<number[]>([]);

    return {
        keyword,
        setKeyword,
        view,
        setView,
        sortKey,
        setSortKey,
        sortAnchor,
        setSortAnchor,
        activeFolder,
        setActiveFolder,
        activeTag,
        setActiveTag,
        remoteSearch,
        setRemoteSearch,
        recentNoteIds,
        setRecentNoteIds,
    };
}
