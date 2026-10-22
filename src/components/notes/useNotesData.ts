// src/components/notes/useNotesData.ts
// 记事本的「与筛选无关的纯数据派生」（2026-10-22 从 NotesPage 抽出，第五步）。
//
// 边界：这里只放**只依赖 notes + folders/tags/noteTags** 的派生 —— 它们与搜索词、
// 视图、排序、选中的文件夹都无关，所以搬进来不会和 useNotesFilters 打架。
//
// ⚠️ 刻意**没搬**的（都留着 NotesPage，原因见各段注释）：
//   - `filtered` / `sorted` / `listGroups` / `visibleIds`：依赖搜索词、视图、排序键，
//     且 `filtered` 要吃 `searchHits`（高亮区间）—— 那是独立一轮；
//   - `viewCounts`：依赖 `trashedNotes`（回收站派生），搬它会把回收站逻辑一起拖出来；
//   - `attachmentRefCounts`：依赖 `settingsOpen` / `attManagerOpen` 两个开关，
//     且要读模块级常量 EMPTY_REF_COUNTS，牵连面大、收益小。
import { useMemo } from "react";
import type { Note, NoteFolder, NoteTag } from "../../API/types";
import { isFolderColor } from "../../utils/folderAppearance";
import { tagOf } from "./sidebarSection";

export interface NotesDataDeps {
    notes: Note[];
    folders: NoteFolder[];
    tags: NoteTag[];
    /** { [noteId]: tagId[] } —— 左栏算「每个标签几条」要用 */
    noteTags: Record<number, number[]>;
    /** 当前打开的笔记 id */
    activeId: number | null;
}

export function useNotesData(deps: NotesDataDeps) {
    const { notes, folders, tags, noteTags, activeId } = deps;

    /** 当前打开的笔记 */
    const active = useMemo(() => notes.find(n => n.id === activeId) || null, [notes, activeId]);

    /**
     * 每个文件夹下的笔记数（左栏那个灰色小数字）。
     *
     * ⚠️ 必须**一次遍历** notes：原来是「外层遍历 folders × 内层 filter 全量 notes」，
     * 置顶 / 移动 / 保存时这里要跑 `folders.length × notes.length` 次判断
     * （用户报「文件夹下方置顶笔记等操作卡顿」的组成部分之一，2026-10-18 修）。
     */
    const folderCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const n of notes) {
            if (n.archived || n.folder_id === null || n.folder_id === undefined) continue;
            map.set(n.folder_id, (map.get(n.folder_id) ?? 0) + 1);
        }
        // 没笔记的文件夹也要有 0，否则左栏读不到值（Map.get 返回 undefined）
        for (const f of folders) {
            if (f.id !== undefined && !map.has(f.id)) map.set(f.id, 0);
        }
        return map;
    }, [notes, folders]);

    /**
     * 每条笔记的计数：服务端 listFolders/listTags 也带了 count，但那要等接口回来，
     * 本地 notes 一变就应该立刻反映到左栏，所以这里按本地数据算（同号重算）。
     */
    const tagCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const t of tags) {
            if (typeof t.id === "number") map.set(t.id, 0);
        }
        for (const n of notes) {
            if (n.archived) continue;
            for (const id of tagOf(n, noteTags)) {
                map.set(id, (map.get(id) ?? 0) + 1);
            }
        }
        return map;
    }, [tags, notes, noteTags]);

    /**
     * 标签名 → 颜色。列表里的徽章按它着色。
     *
     * ⚠️ 按**名字**索引而不是 id：`tagNamesOf` 返回的是名字串（渲染用的是名字），
     * 再拿名字回查一次 id 会让列表每行多一次线性查表。
     * 名字重复时取「先出现且有颜色」的那一个 —— 两个同名标签本来就该合并。
     */
    const tagColorByName = useMemo(() => {
        const map = new Map<string, string>();
        for (const t of tags) {
            if (!t.name || !isFolderColor(t.color)) continue;
            const key = t.name.trim();
            if (!map.has(key)) map.set(key, t.color);
        }
        return map;
    }, [tags]);

    /** 每个文件夹下的笔记（左栏内联展开用；按更新时间倒序） */
    const notesByFolder = useMemo(() => {
        const raw = new Map<number, Note[]>();
        for (const n of notes) {
            if (n.archived || n.folder_id === null || n.folder_id === undefined) continue;
            const list = raw.get(n.folder_id);
            if (list) list.push(n);
            else raw.set(n.folder_id, [n]);
        }
        const map = new Map<number, { id: number; title: string }[]>();
        for (const [folderId, list] of raw) {
            list.sort((a, b) =>
                String(b.updated_at || b.created_at || "").localeCompare(
                    String(a.updated_at || a.created_at || "")
                )
            );
            map.set(
                folderId,
                list.map(n => ({ id: n.id!, title: n.title || "" }))
            );
        }
        return map;
    }, [notes]);

    return { active, folderCounts, tagCounts, tagColorByName, notesByFolder };
}

/** 空引用计数：附件管理器没打开时用它，避免每次渲染新建 Map */
export const EMPTY_REF_COUNTS: ReadonlyMap<string, number> = new Map();
