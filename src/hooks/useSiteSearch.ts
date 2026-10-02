// 搜索与筛选的派生链：关键词 → 检索索引 → 高级语法 → 语义叠加 → 星标/标签/失效
// → 渲染上限 → 「常用」置前。原来内联在 App 里（约 225 行纯计算），搬出来后 App
// 只剩一次调用。本次搬迁是原样搬运，行为与抽取前逐行一致。
import {
    useCallback,
    useDeferredValue,
    useMemo,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { Site } from "../API/http";
import type { GroupWithSites } from "../types";
import type { TagMap } from "../utils/tagOps";
import type { DeadLinks } from "../utils/linkHealth";
import type { VisitStat } from "../context/UIPrefsContext";
import { buildFavoritesGroup, deriveDisplayedGroups } from "../utils/siteView";
import {
    hasAdvancedSyntax,
    matchesAdvanced,
    matchesExcludes,
    parseAdvancedQuery,
} from "../utils/advancedSearch";
import { buildSearchIndex, matchesPrepared, prepareQuery, siteHaystack } from "../utils/search";
import { safeOpenSite } from "../utils/safeOpen";

export type UseSiteSearchParams = {
    groups: GroupWithSites[];
    /** 输入框里的原始关键词（未 trim、未小写） */
    searchQuery: string;
    /** 拼音词典已就绪且开关打开 */
    usePinyin: boolean;

    semanticSearch: boolean;
    semanticHits: { id: number; score: number }[];

    starred: number[];
    tags: TagMap;
    deadLinks: DeadLinks;
    starFilter: boolean;
    deadOnly: boolean;
    activeTags: string[];
    setStarFilter: Dispatch<SetStateAction<boolean>>;
    setDeadOnly: Dispatch<SetStateAction<boolean>>;
    setActiveTags: Dispatch<SetStateAction<string[]>>;

    /** 搜索面板的聚焦态与历史关键词（下拉面板要用） */
    searchFocused: boolean;
    searchHistory: string[];
    pushSearchHistory: (term: string) => void;
    setSearchFocused: Dispatch<SetStateAction<boolean>>;
    setActiveResult: Dispatch<SetStateAction<number>>;
    setSearchQuery: Dispatch<SetStateAction<string>>;
    searchInputRef: { current: HTMLInputElement | null };

    visits: Record<string, VisitStat>;
    favoritesEnabled: boolean;
    /** 左侧分组栏选中的分组（数字键 1~9 打开的就是它） */
    activeGroupId: number | null;
};

export function useSiteSearch({
    groups,
    searchQuery,
    usePinyin,
    semanticSearch,
    semanticHits,
    starred,
    tags,
    deadLinks,
    starFilter,
    deadOnly,
    activeTags,
    setStarFilter,
    setDeadOnly,
    setActiveTags,
    searchFocused,
    searchHistory,
    pushSearchHistory,
    setSearchFocused,
    setActiveResult,
    setSearchQuery,
    searchInputRef,
    visits,
    favoritesEnabled,
    activeGroupId,
}: UseSiteSearchParams) {
    // 按关键词筛选：命中「网站名称 / 网站链接 / 网站描述」的卡片会被保留，分组名命中则整组保留。
    // 用 useDeferredValue 把过滤推迟到空闲帧：输入框始终跟手，卡片多的时候也不会边打边卡。
    const query = useDeferredValue(searchQuery.trim().toLowerCase());

    // 检索索引：站点侧与分组侧的归一化文本只在**数据变了**时算一次。
    // 以前是每次按键对每个站点跑三趟正则，几千张卡片时输入会开始发涩。
    const searchIndex = useMemo(() => buildSearchIndex(groups), [groups]);
    // 高级语法（tag: / group: / url: / is: / -关键词）：先从输入里剥出来，
    // 剩下的自由词才交给普通检索。不写语法的人完全不受影响。
    const advancedQuery = useMemo(() => parseAdvancedQuery(query), [query]);
    // 查询侧同理：一个关键词只归一化一次，全站点复用
    const preparedQuery = useMemo(
        () => prepareQuery(advancedQuery.text),
        [advancedQuery.text]
    );

    const filteredGroups = useMemo(() => {
        if (!preparedQuery.text && !hasAdvancedSyntax(query)) return groups;

        return groups
            .map(group => {
                const groupHaystack =
                    group.id !== undefined ? searchIndex.groups.get(group.id) ?? "" : "";
                if (matchesPrepared(groupHaystack, group.name, preparedQuery, usePinyin)) {
                    return group;
                }
                const sites = group.sites.filter(site => {
                    // 索引里没有（刚离线新建、还没回填 id）就现算一次，别把它当成不命中
                    const entry = site.id !== undefined ? searchIndex.sites.get(site.id) : undefined;
                    if (
                        preparedQuery.text &&
                        !matchesPrepared(
                            entry?.haystack ?? siteHaystack(site),
                            entry?.name ?? site.name ?? "",
                            preparedQuery,
                            usePinyin
                        )
                    ) {
                        return false;
                    }
                    // 语法条件：tag: / group: / url: / is:
                    const own = tags[String(site.id)] ?? [];
                    if (
                        !matchesAdvanced(site, group.name, advancedQuery, {
                            tags: own,
                            starred: starred.includes(site.id as number),
                            dead: Boolean(deadLinks[site.url ?? ""]),
                        })
                    ) {
                        return false;
                    }
                    // -排除词
                    return !matchesExcludes(site, group.name, advancedQuery.excludes);
                });
                return { ...group, sites };
            })
            .filter(group => group.sites.length > 0);
    }, [
        groups,
        preparedQuery,
        usePinyin,
        searchIndex,
        advancedQuery,
        tags,
        starred,
        deadLinks,
    ]);

    /**
     * 语义搜索的结果叠加。
     * 只在「开关开着且真的有命中」时生效：命中列表为空就原样保留关键词结果 ——
     * AI 没帮上忙不该变成「什么都看不到」。
     */
    const semanticGroups = useMemo(() => {
        if (!semanticSearch || semanticHits.length === 0) return filteredGroups;
        const order = new Map(semanticHits.map((hit, idx) => [String(hit.id), idx]));
        return filteredGroups
            .map(group => {
                const sites = (group.sites ?? [])
                    .filter(site => order.has(String(site.id)))
                    .slice()
                    .sort(
                        (a, b) =>
                            (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0)
                    );
                return { ...group, sites };
            })
            .filter(group => group.sites.length > 0);
    }, [semanticSearch, semanticHits, filteredGroups]);

    // 星标 / 标签筛选：在搜索结果之上再叠一层。
    // 标签取交集（同时带「工具」「AI」两个标签才命中），星标是独立的开关。
    const matchFilters = useCallback(
        (site: Site) => {
            if (starFilter && !starred.includes(site.id as number)) return false;
            // 「只看失效」：只留检测出问题的那些链接
            if (deadOnly && !deadLinks[site.url ?? ""]) return false;
            if (activeTags.length === 0) return true;
            const own = tags[String(site.id)] ?? [];
            return activeTags.every(tag => own.includes(tag));
        },
        [starFilter, starred, deadOnly, deadLinks, activeTags, tags]
    );

    const visibleGroups = useMemo(() => {
        // 从语义结果出发：语义命中已经收窄过一轮，星标 / 标签 / 失效再叠在它上面
        if (!starFilter && !deadOnly && activeTags.length === 0) return semanticGroups;
        return semanticGroups
            .map(group => ({ ...group, sites: group.sites.filter(matchFilters) }))
            .filter(group => group.sites.length > 0);
    }, [semanticGroups, starFilter, deadOnly, activeTags, matchFilters]);

    // 一次性清掉星标 / 失效 / 标签三档筛选（空状态里的「清除筛选」用）
    const clearAllFilters = useCallback(() => {
        setStarFilter(false);
        setDeadOnly(false);
        setActiveTags([]);
    }, []);

    // 点标签：多选取交集，再点一次取消
    const toggleActiveTag = useCallback((tag: string) => {
        setActiveTags(prev =>
            prev.includes(tag) ? prev.filter(item => item !== tag) : [...prev, tag]
        );
    }, []);

    // 检出失效的链接条数：决定是否显示「只看失效」入口
    const deadCount = Object.keys(deadLinks).length;

    // 筛选生效时页面里还剩多少张卡片（搜索结果计数要用）
    const matchedCount = useMemo(
        () => visibleGroups.reduce((sum, group) => sum + group.sites.length, 0),
        [visibleGroups]
    );

    // 命中太多时先只渲染一部分：几百张卡片一次性铺开会卡住输入（实测一次过滤 ~116ms），
    // 计数照常按真实命中数显示，只是不把它们全部挂到 DOM 上。
    const SEARCH_PER_GROUP_LIMIT = 24;
    const SEARCH_TOTAL_LIMIT = 60;
    const searchTruncated = query ? matchedCount > SEARCH_TOTAL_LIMIT : false;
    const renderGroups = useMemo(
        () =>
            searchTruncated
                ? visibleGroups.map(group =>
                      group.sites.length > SEARCH_PER_GROUP_LIMIT
                          ? { ...group, sites: group.sites.slice(0, SEARCH_PER_GROUP_LIMIT) }
                          : group
                  )
                : visibleGroups,
        [visibleGroups, searchTruncated]
    );
    // 「当前分组」：左侧栏选中的那个；没选中就取第一个可见分组。
    // 数字键 1~9 打开的就是这个分组里的第 N 张卡片。
    const currentGroupSites = useMemo(() => {
        if (renderGroups.length === 0) return [] as Site[];
        const picked =
            activeGroupId != null ? renderGroups.find(g => g.id === activeGroupId) : undefined;
        return (picked ?? renderGroups[0]).sites;
    }, [renderGroups, activeGroupId]);

    // 卡片很多时整体关掉入场动画：几百张同时跑 transform 动画，
    // 合成开销比动画本身还贵，视觉上也看不出「依次浮现」了
    const ENTRY_ANIMATION_LIMIT = 60;
    const reduceEntryAnimation = matchedCount > ENTRY_ANIMATION_LIMIT;

    const renderedCount = useMemo(
        () => (searchTruncated ? renderGroups.reduce((sum, g) => sum + g.sites.length, 0) : matchedCount),
        [searchTruncated, renderGroups, matchedCount]
    );

    // 下拉面板的扁平结果：跨分组取前 8 条，够用又不至于太长
    const flatResults = useMemo(() => {
        if (!query) return [];
        const items: { site: Site; groupName: string }[] = [];
        for (const group of visibleGroups) {
            for (const site of group.sites) {
                items.push({ site, groupName: group.name });
                if (items.length >= 8) break;
            }
            if (items.length >= 8) break;
        }
        return items;
    }, [visibleGroups, query]);

    const dropdownOpen = query.length > 0 && searchFocused && flatResults.length > 0;
    // 没有输入但曾经搜过：把历史关键词亮出来，点一下就能接着搜
    const historyOpen = searchFocused && query.length === 0 && searchHistory.length > 0;

    // 打开下拉面板里的某一项（用户主动选择，直接前台打开）
    const openResult = (site: Site) => {
        setSearchFocused(false);
        // 从搜索面板打开的，把这次关键词记进搜索历史
        if (searchQuery.trim()) pushSearchHistory(searchQuery);
        if (site.url) {
            safeOpenSite(site.url);
        }
    };

    // 点历史关键词：回填到搜索框并保持聚焦，方便直接回车打开
    const applyHistoryTerm = (term: string) => {
        setSearchQuery(term);
        setActiveResult(0);
        setSearchFocused(true);
        searchInputRef.current?.focus();
    };

    // 「最近访问」虚拟分组：7 天内点开过、且点开次数最多的前 10 个网站
    // （纯派生逻辑抽到 utils/siteView.ts，便于单测，不再和 App 绑死）
    const favoritesGroup = useMemo(
        () => buildFavoritesGroup(groups, visits),
        [groups, visits]
    );

    // 真正渲染的分组列表：常用置前（排序模式与关闭时不插）
    const displayedGroups = useMemo(
        () =>
            deriveDisplayedGroups(
                renderGroups,
                favoritesEnabled,
                favoritesGroup,
                query,
                matchFilters,
                usePinyin
            ),
        [renderGroups, favoritesEnabled, favoritesGroup, query, matchFilters, usePinyin]
    );
    return {
        query,
        advancedQuery,
        clearAllFilters,
        toggleActiveTag,
        deadCount,
        matchedCount,
        searchTruncated,
        currentGroupSites,
        reduceEntryAnimation,
        renderedCount,
        flatResults,
        dropdownOpen,
        historyOpen,
        openResult,
        applyHistoryTerm,
        displayedGroups,
    };
}
