// src/hooks/useAppCommands.ts
// 命令面板（Ctrl/Cmd + K）里的条目：站点跳转 + 常用操作。
//
// 从 App 里搬出来的原因不是「App 太长」——是这条列表把二十来个互不相关的动作
// 聚在同一个地方，加一个快捷键 / 改一处文案都要在 3700 行里翻。搬到这里之后，
// 它由一份显式的动作表驱动：App 只负责把动作传进来，这里只负责「哪条命令叫什么、
// 属于哪个分组、按下去跑哪个动作」。
//
// 全部依赖都是传进来的值 / 回调，本文件不持有任何状态 —— 所以它也是可测的：
// 给一份假动作表，就能断言「站点命令带上分组名」「开关类命令的文案跟着状态变」。
import { useMemo } from "react";
import type { CommandItem } from "../components/CommandPalette";
import type { GroupWithSites } from "../types";
// 只取类型：编译期擦掉，不会把 UIPrefsContext（含 Provider 与 localStorage 读写）拖进包里
import type { Density, ViewMode } from "../context/uiPrefsStore";
import { safeOpenSite } from "../utils/safeOpen";

/** 命令面板需要的那几个动作。App 逐个传进来，这里不反向依赖 App */
export interface AppCommandActions {
    setViewMode: (mode: ViewMode) => void;
    density: Density;
    setDensity: (density: Density) => void;
    toggleTheme: () => void;
    favoritesEnabled: boolean;
    setFavoritesEnabled: (enabled: boolean) => void;
    glassEffects: boolean;
    setGlassEffects: (enabled: boolean) => void;
    setOpenShortcuts: (open: boolean) => void;
    handleOpenAddGroup: () => void;
    startGroupSort: () => void;
    handleOpenConfig: () => void;
    setOpenAccount: (open: boolean) => void;
    fetchAccountList: () => Promise<void> | void;
    handleOpenBackup: (tab: number) => void;
    setBookmarkOpen: (open: boolean) => void;
    runLinkCheck: () => Promise<void> | void;
    setOpenVisits: (open: boolean) => void;
    toggleCollapseAll: () => void;
    allGroupsCollapsed: boolean;
    multiSelect: boolean;
    setMultiSelect: (on: boolean) => void;
    exitMultiSelect: () => void;
    starFilter: boolean;
    setStarFilter: (on: boolean) => void;
    railCollapsed: boolean;
    setRailCollapsed: (collapsed: boolean) => void;
    clearVisits: () => void;
    canUndo: boolean;
    runUndo: () => void;
    canRedo: boolean;
    runRedo: () => void;
    /** 打开一张卡片时顺带记一次访问（与点击卡片同一个入口） */
    recordVisit: (siteId: number) => void;
}

export interface AppCommandsInput extends AppCommandActions {
    groups: GroupWithSites[];
}

/** 站点命令的上限：再长也翻不到底，翻页比多几行更有用 */
const SITE_COMMAND_LIMIT = 120;

export function useAppCommands(input: AppCommandsInput): CommandItem[] {
    const {
        groups,
        canUndo,
        canRedo,
        density,
        favoritesEnabled,
        glassEffects,
        allGroupsCollapsed,
        multiSelect,
        starFilter,
        setStarFilter,
        railCollapsed,
        recordVisit,
        runUndo,
        runRedo,
        setViewMode,
        setDensity,
        toggleTheme,
        setFavoritesEnabled,
        setGlassEffects,
        setOpenShortcuts,
        handleOpenAddGroup,
        startGroupSort,
        handleOpenConfig,
        setOpenAccount,
        fetchAccountList,
        handleOpenBackup,
        setBookmarkOpen,
        runLinkCheck,
        setOpenVisits,
        toggleCollapseAll,
        exitMultiSelect,
        setMultiSelect,
        setRailCollapsed,
        clearVisits,
    } = input;

    return useMemo<CommandItem[]>(() => {
        const siteCommands: CommandItem[] = groups
            .flatMap(group =>
                group.sites.map(site => ({
                    id: `cmd-site-${group.id}-${site.id}`,
                    label: site.name || site.url || "未命名",
                    hint: group.name,
                    section: "打开网站",
                    keywords: `${site.url || ""} ${site.description || ""}`,
                    iconUrl: site.icon,
                    run: () => {
                        recordVisit(site.id as number);
                        safeOpenSite(site.url);
                    },
                }))
            )
            .slice(0, SITE_COMMAND_LIMIT);

        const actionCommands: CommandItem[] = [
            // 撤销 / 重做放在最前面：删完卡片想反悔时，Ctrl+K 之后一眼就能看到
            {
                id: "cmd-undo",
                label: canUndo ? "撤销上一步" : "撤销上一步（暂无可撤销）",
                section: "撤销",
                run: () => void runUndo(),
            },
            {
                id: "cmd-redo",
                label: canRedo ? "重做" : "重做（暂无可重做）",
                section: "撤销",
                run: () => void runRedo(),
            },
            {
                id: "cmd-view-card",
                label: "切换到卡片视图",
                section: "显示",
                run: () => setViewMode("card"),
            },
            {
                id: "cmd-view-list",
                label: "切换到列表视图",
                section: "显示",
                run: () => setViewMode("list"),
            },
            {
                id: "cmd-view-wall",
                label: "切换到图标墙视图",
                section: "显示",
                run: () => setViewMode("wall"),
            },
            {
                id: "cmd-density",
                label: density === "compact" ? "切换到舒适密度" : "切换到紧凑密度",
                section: "显示",
                run: () => setDensity(density === "compact" ? "comfortable" : "compact"),
            },
            {
                id: "cmd-theme",
                label: "切换主题（浅色 / 深色 / 跟随系统）",
                section: "显示",
                run: () => toggleTheme(),
            },
            {
                id: "cmd-favorites",
                label: favoritesEnabled ? "关闭最近访问置前" : "开启最近访问置前",
                section: "显示",
                run: () => setFavoritesEnabled(!favoritesEnabled),
            },
            {
                id: "cmd-glass",
                label: glassEffects ? "关闭毛玻璃特效" : "开启毛玻璃特效",
                section: "显示",
                run: () => setGlassEffects(!glassEffects),
            },
            {
                id: "cmd-shortcuts",
                label: "键盘快捷键",
                section: "帮助",
                run: () => setOpenShortcuts(true),
            },
            {
                id: "cmd-add-group",
                label: "新增分组",
                section: "操作",
                run: () => handleOpenAddGroup(),
            },
            {
                id: "cmd-group-sort",
                label: "进入编辑排序",
                section: "操作",
                run: () => startGroupSort(),
            },
            {
                id: "cmd-config",
                label: "打开网站设置",
                section: "操作",
                run: () => handleOpenConfig(),
            },
            {
                id: "cmd-account",
                label: "打开账号管理",
                section: "操作",
                run: () => {
                    setOpenAccount(true);
                    void fetchAccountList();
                },
            },
            {
                id: "cmd-backup",
                label: "数据备份",
                section: "操作",
                run: () => handleOpenBackup(0),
            },
            {
                id: "cmd-bookmarks",
                label: "导入浏览器书签",
                section: "操作",
                run: () => setBookmarkOpen(true),
            },
            {
                id: "cmd-link-check",
                label: "检测失效链接",
                section: "操作",
                run: () => void runLinkCheck(),
            },
            {
                id: "cmd-visits",
                label: "查看访问统计",
                section: "显示",
                run: () => setOpenVisits(true),
            },
            {
                id: "cmd-collapse-all",
                label: allGroupsCollapsed ? "展开全部分组" : "折叠全部分组",
                section: "显示",
                run: () => toggleCollapseAll(),
            },
            {
                id: "cmd-multiselect",
                label: multiSelect ? "退出批量多选" : "批量多选",
                section: "操作",
                run: () => (multiSelect ? exitMultiSelect() : setMultiSelect(true)),
            },
            {
                id: "cmd-star-filter",
                label: starFilter ? "取消只看星标" : "只看星标",
                section: "显示",
                run: () => setStarFilter(!starFilter),
            },
            {
                id: "cmd-rail",
                label: railCollapsed ? "展开左侧分组栏" : "收起左侧分组栏",
                section: "显示",
                run: () => setRailCollapsed(!railCollapsed),
            },
            {
                id: "cmd-clear-visits",
                label: "清除访问记录",
                section: "操作",
                run: () => {
                    clearVisits();
                    // 清除访问记录不弹提示：「最近访问」分组会当场消失，本身就是反馈
                },
            },
        ];

        return [...siteCommands, ...actionCommands];
    }, [
        groups,
        canUndo,
        canRedo,
        density,
        favoritesEnabled,
        glassEffects,
        allGroupsCollapsed,
        multiSelect,
        starFilter,
        setStarFilter,
        railCollapsed,
        recordVisit,
        runUndo,
        runRedo,
        setViewMode,
        setDensity,
        toggleTheme,
        setFavoritesEnabled,
        setGlassEffects,
        setOpenShortcuts,
        handleOpenAddGroup,
        startGroupSort,
        handleOpenConfig,
        setOpenAccount,
        fetchAccountList,
        handleOpenBackup,
        setBookmarkOpen,
        runLinkCheck,
        setOpenVisits,
        toggleCollapseAll,
        exitMultiSelect,
        setMultiSelect,
        setRailCollapsed,
        clearVisits,
    ]);
}
