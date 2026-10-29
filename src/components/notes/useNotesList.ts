import { useCallback, useEffect, useRef } from "react";
import { fuzzyFilter, fuzzyMatch } from "../../utils/fuzzy";
import type { NotesPageProps } from "./notesPageCtx";
import { tagNamesOf } from "./sidebarSection";
import type { useNotesFilters } from "./useNotesFilters";
// src/components/notes/useNotesList.ts
// 记事本的「列表派生链」（2026-10-22 从 NotesPage 抽出，第六步，也是最后一块）。
//
// 这条链是 `searchableText → filtered → sorted → listGroups → visibleIds`：
//    filtered  按「视图 + 选中的文件夹/标签 + 关键词」筛出可见笔记
//    sorted    在 filtered 之上按排序键再排（default = 服务端顺序）
//    listGroups 置顶单独一组，其余按相对时间（今天/昨天/本周/…）分桶
//    visibleIds 当前渲染顺序里的 id 序列（批量操作按它取范围）
//
// ⚠️ 搜索子系统**刻意不搬进来**：`searchHits` / `highlightRanges` / `searchEpoch` /
//    拉远端搜索的 effect 都还留在 NotesPage —— 那里面有 abort 与竞态处理，
//    跟列表派生不是一件事。这里只把 `searchHits` 作为**入参**吃进来
//    （`filtered` 在搜索视图下只要笔记本体，不要高亮区间）。
import { useMemo } from "react";
import type { Note } from "../../API/types";
import { groupLabel } from "../../utils/noteTime";
import { shouldVirtualize } from "../../utils/virtualWindow";
import type { NoteView } from "./notesPageCtx";
import { tagOf } from "./sidebarSection";
import type { NoteSortKey } from "./useNotesFilters";

export interface NotesListDeps {
    notes: Note[];
    /** 视图：全部 / 最近 / 收藏 / 归档 / 未归类 / 搜索 */
    view: NoteView;
    keyword: string;
    activeFolder: number | null;
    activeTag: number | null;
    sortKey: NoteSortKey;
    /** { [noteId]: tagId[] } */
    noteTags: Record<number, number[]>;
    /** 搜索子系统的产物（带高亮区间），搜索视图下只要它的 note 本体 */
    searchHits: { note: Note }[];
    /**
     * 一条笔记参与搜索的文本。**由调用方传入**而不是在 hook 里定义 ——
     * 它必须早于搜索子系统声明（那边的 searchHits 也要用它），
     * 而 hook 本身又要吃 searchHits，在 hook 里定义会成循环依赖。
     */
    searchableText: (n: Note) => string;
}

/** 一个分组：置顶组或某个相对时间段 */
export interface NoteGroup {
    key: string;
    label: string;
    items: Note[];
}

/** 模糊搜索的上限：超过这个数就不再本地全量匹配（交给远端搜索） */
const FUZZY_LIMIT = 300;

export function useNotesList(deps: NotesListDeps) {
    const { notes, view, keyword, activeFolder, activeTag, sortKey, noteTags, searchHits, searchableText } = deps;

    const filtered = useMemo(() => {
        // 搜索视图：只给命中列表，不受「文件夹 / 标签选中」叠加影响 ——
        // 用户搜东西时想看的是「所有命中」，再被一个残留的文件夹选中态筛一遍
        // 只会让人以为「搜不到」。没关键词时回落到全部。
        if (view === "search") {
            // ⚠️ searchHits 带命中区间（为了高亮），这里只要笔记本身
            return keyword.trim() ? searchHits.map(h => h.note) : notes.filter(n => !n.archived);
        }
        // 归档的笔记默认从「全部 / 最近 / 收藏 / 未归类」里隐去，只在「归档」视图露面
        const live = notes.filter(n => !n.archived);
        const byView = live.filter(n => {
            // ⚠️ 2026-10-09：收藏判的是 starred 而不是 pinned —— 之前两个是同一个开关，
            // 用户想标记常用就把排序也改了（详见 Note.starred 的注释）
            if (view === "starred") return Boolean(n.starred);
            // 阶段三收尾：选中了某个文件夹（或标签）就只看那一份，
            // 和「全部 / 最近」这些视图是**叠加**关系，不是互斥的。
            // ⚠️ 但文件夹/标签只在 live 里筛 —— 归档的笔记不该出现在任何文件夹视图里，
            // 那个视图要看归档笔记得先切到「归档」。
            if (activeFolder !== null) return n.folder_id === activeFolder;
            if (activeTag !== null) return tagOf(n, noteTags).has(activeTag);
            return true;
        });
        const bySort =
            view === "recent"
                ? [...byView].sort(
                    (a, b) =>
                        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                        String(b.updated_at || b.created_at || "").localeCompare(
                            String(a.updated_at || a.created_at || "")
                        )
                )
                : byView;
        const kw = keyword.trim();
        const matched = kw
            ? fuzzyFilter(bySort, kw, searchableText, FUZZY_LIMIT).map(({ item }) => item)
            : bySort;
        if (view === "archived") {
            // 归档视图看的是**全部**归档笔记（不管收藏不收藏）
            const kw2 = keyword.trim();
            const all = notes.filter(n => n.archived);
            return kw2 ? fuzzyFilter(all, kw2, searchableText, FUZZY_LIMIT).map(({ item }) => item) : all;
        }
        if (view === "uncategorized") {
            // 「未归类」= **没有归到任何文件夹**的笔记（folder_id 为空）。
            // ⚠️ 这里原来筛的是 `site_id` —— 那是「没挂在站点上」，可记事本里
            // 根本没有「把笔记挂到某个站点」的入口，site_id 永远是 null，
            // 于是这个视图跟「全部」**完全等价**（左栏两个计数一模一样），
            // 而用户看到「未归类」时想的是文件夹，不是站点。阶段三加了文件夹，
            // 这个判据没跟着换过来。
            return matched.filter(n => n.folder_id === null || n.folder_id === undefined);
        }
        return matched;
    }, [notes, keyword, view, activeFolder, activeTag, noteTags, searchHits, searchableText]);

    /**
     * 列表要不要走组级懒挂载（LazyGroup）。条数低于阈值时全量渲染 ——
     * 不改变 DOM 结构，守卫与真机探针在小数据量下的行为与从前完全一致。
     * 占位行高与 CSS content-visibility 的占位估计值同源（56/96 两档）。
     */
    const lazyListGroups = shouldVirtualize(filtered.length);

    const sorted = useMemo(() => {
        const list = [...filtered];
        if (sortKey === "title") {
            list.sort((a, b) => (a.title || "无标题").localeCompare(b.title || "无标题"));
        } else if (sortKey === "created") {
            list.sort((a, b) =>
                String(b.created_at || "").localeCompare(String(a.created_at || ""))
            );
        }
        return list;
    }, [filtered, sortKey]);

    /**
     * 列表分组（照 inkstone 的 `buildGroups`）：**置顶单独一组**，
     * 其余按 `groupLabel` 的相对时间（今天 / 昨天 / 本周 / 本月 / 9 月 / 2026 年 8 月）。
     * ⚠️ 之前是纯按 `YYYY-MM` 分组，列表顶上永远是「2026 年 10 月」这种
     * 又长又没信息量的标题，而「今天动过的几条」被埋在里面看不出来。
     */
    const listGroups = useMemo<NoteGroup[]>(() => {
        const groups: NoteGroup[] = [];
        const pinned = sorted.filter(n => Boolean(n.pinned));
        if (pinned.length) groups.push({ key: "pinned", label: "置顶", items: pinned });
        const rest = sorted.filter(n => !n.pinned);
        if (!rest.length) return groups;
        // 按排序键决定用哪个时间戳分组：按创建时间排就用创建时间，
        // 否则用最后编辑时间（inkstone 的 buildGroups 同一条规则）。
        const stampOf = (n: Note) =>
            sortKey === "created" ? n.created_at : n.updated_at || n.created_at;
        // ⚠️ 按标题排的时候**不分组**（inkstone 也是这样：一组「其他」，不挂标题）。
        // 分了组反而会骗人 —— 标题顺序和「今天/昨天」毫无关系。
        if (sortKey === "title") {
            groups.push({ key: "rest", label: "", items: rest });
            return groups;
        }
        // ⚠️ 必须先按时间**从新到旧**排一遍再分桶。
        // inkstone 的 buildGroups 假设传进来的 items 已经是这个顺序（它由 store 保证），
        // 我们这边 `sorted` 只是保留了服务端顺序 —— 不先排一次的话，
        // 分组会跟着「接口返回的顺序」走，出现「9 月」排在「本周」前面。
        const ordered = [...rest].sort(
            (a, b) => String(stampOf(b) || "").localeCompare(String(stampOf(a) || ""))
        );
        let currentKey = "";
        let bucket: NoteGroup | null = null;
        for (const n of ordered) {
            const label = groupLabel(stampOf(n));
            // 分组键带上序号：同一个标签可能在列表里出现多段
            // （比如中间夹了置顶），光靠 label 会并到不该并的一组里。
            if (label !== currentKey) {
                currentKey = label;
                bucket = { key: `${label}-${groups.length}`, label, items: [] };
                groups.push(bucket);
            }
            bucket?.items.push(n);
        }
        return groups;
    }, [sorted, sortKey]);

    /** 列表**当前渲染顺序**里的 id 序列（批量操作按它取范围） */
    const visibleIds = useMemo(
        () =>
            listGroups
                .flatMap(g => g.items.map(n => n.id))
                .filter((id): id is number => id !== undefined),
        [listGroups]
    );

    return { filtered, lazyListGroups, sorted, listGroups, visibleIds };
}

/**
 * 列表空状态：插画 + 一句话（照 inkstone 的 9 种场景配置）。
 * ⚠️ 之前只有「还没有笔记 / 没有匹配的笔记」两句，六种情况共用，
 * 用户看到空白不知道是「没写」还是「筛掉了」—— 这两件事的下一步完全相反。
 */
export type EmptyArt =
    | "notes"
    | "search"
    | "starred"
    | "archive"
    | "folder"
    | "tag"
    | "trash";

export interface NotesEmptyCopy {
    title: string;
    desc: string;
}

export interface NotesEmptyStateDeps {
    view: NoteView;
    activeFolder: number | null;
    activeTag: number | null;
    notesLength: number;
}

export function useNotesEmptyState(deps: NotesEmptyStateDeps): { emptyArt: EmptyArt; emptyCopy: NotesEmptyCopy } {
    const { view, activeFolder, activeTag, notesLength } = deps;
    const { art: emptyArt, ...emptyCopy } = useMemo((): {
        art: "notes" | "search" | "starred" | "archive" | "folder" | "tag" | "trash";
        title: string;
        desc: string;
    } => {
        if (view === "search") {
            return { art: "search", title: "没有匹配的笔记", desc: "换个词再搜一次，或者清掉筛选条件。" };
        }
        if (view === "starred") {
            return { art: "starred", title: "还没有收藏", desc: "在笔记上右键就能收藏，收藏过的会出现在这里。" };
        }
        if (view === "archived") {
            return { art: "archive", title: "归档里是空的", desc: "把暂时不看的笔记归档，它就不会出现在列表里了。" };
        }
        if (view === "trash") {
            return { art: "trash", title: "回收站是空的", desc: "删掉的笔记会先放到这里，随时能还原。" };
        }
        if (activeFolder !== null) {
            return { art: "folder", title: "这个文件夹还是空的", desc: "把笔记拖进来，或者直接在这个文件夹里新建一条。" };
        }
        if (activeTag !== null) {
            return { art: "tag", title: "没有带这个标签的笔记", desc: "在笔记里写 #这个标签，它就会自动归到这里。" };
        }
        if (notesLength === 0) {
            return { art: "notes", title: "还没有笔记", desc: "点「新建笔记」写第一条。" };
        }
        return { art: "notes", title: "这里没有要显示的笔记", desc: "换个筛选条件看看。" };
    }, [view, activeFolder, activeTag, notesLength]);
    return { emptyArt, emptyCopy };
}

/** Remote search preserves its epoch and debounce; local matching remains the fallback. */
export function useNotesSearch({ notes, noteTags, tags, keyword, remoteSearch, setRemoteSearch, folderTags }: Pick<ReturnType<typeof useNotesFilters>, "keyword" | "remoteSearch" | "setRemoteSearch"> & Pick<NotesPageProps, "notes" | "folderTags"> & { noteTags: Record<number, number[]>; tags: NonNullable<NotesPageProps["folderTags"]>["tags"] }) {
    const searchableText = useCallback(
        (n: Note) =>
            `${n.title || ""} ${n.content || ""} ${tagNamesOf(n, noteTags, tags).join(" ")}`,
        [noteTags, tags]
    );

    const searchEpoch = useRef(0);

    const searchRemote = folderTags?.onSearchRemote;

    useEffect(() => {
        const kw = keyword.trim();
        if (!searchRemote || !kw) {
            setRemoteSearch(null);
            return;
        }
        const epoch = ++searchEpoch.current;
        // 打一个 250ms 的防抖：搜索框每敲一个字都打一次接口太浪费
        const timer = setTimeout(() => {
            void searchRemote(kw, 100).then(res => {
                if (epoch !== searchEpoch.current) return; // 过期结果直接丢
                setRemoteSearch(
                    res && Array.isArray(res.results)
                        ? { keyword: kw, hits: res.results, mode: res.mode }
                        : null
                );
            }).catch(() => {
                if (epoch !== searchEpoch.current) return;
                setRemoteSearch(null); // 失败就退回本地搜，不弹错误
            });
        }, 250);
        return () => clearTimeout(timer);
    }, [keyword, searchRemote, setRemoteSearch]);

    const searchSnippets = useMemo(() => {
        const map = new Map<number, string>();
        if (remoteSearch && remoteSearch.keyword === keyword.trim()) {
            for (const hit of remoteSearch.hits) {
                if (hit.snippet) map.set(hit.id, hit.snippet);
            }
        }
        return map;
    }, [remoteSearch, keyword]);

    const searchHits = useMemo(() => {
        const kw = keyword.trim();
        if (!kw) return [];
        // 服务端有结果就按它的相关度排（bm25：标题命中权重更高）。
        // 高亮区间仍然本地算 —— fuzzyMatch 是纯函数，同一份标题两边结果一致。
        if (remoteSearch && remoteSearch.keyword === kw && remoteSearch.hits.length > 0) {
            const byId = new Map<number, Note>();
            for (const n of notes) if (n.id !== undefined) byId.set(n.id, n);
            const out: { note: Note; ranges: [number, number][] }[] = [];
            for (const hit of remoteSearch.hits) {
                const note = byId.get(hit.id);
                if (!note) continue; // 索引里可能残留已删的
                const match = fuzzyMatch(note.title || "", kw);
                out.push({ note, ranges: match?.ranges ?? [] });
            }
            if (out.length > 0) return out;
        }
        return fuzzyFilter(notes, kw, searchableText, 300).map(({ item, match }) => ({
            note: item,
            // ⚠️ 区间要裁到标题长度内：模糊匹配是在「标题 + 正文」上跑的，
            // 落在正文里的区间拿去标标题会标到别处去（inkstone 同样只标标题）。
            ranges: match.ranges.filter(([start]) => start < (item.title || "").length),
        }));
    }, [notes, keyword, searchableText, remoteSearch]);

    const highlightRanges = useMemo(() => {
        const map = new Map<number, [number, number][]>();
        for (const hit of searchHits) {
            if (hit.note.id !== undefined && hit.ranges.length) map.set(hit.note.id, hit.ranges);
        }
        if (!keyword.trim()) return map;
        // 非搜索视图里也在列表顶部过滤（见 filtered），那里同样要能高亮
        for (const n of notes) {
            if (n.id === undefined || map.has(n.id)) continue;
            const match = fuzzyMatch(`${n.title || ""}`, keyword.trim());
            if (match && match.ranges.length) map.set(n.id, match.ranges);
        }
        return map;
    }, [searchHits, notes, keyword]);
    return { searchableText, searchHits, searchSnippets, highlightRanges };
}
