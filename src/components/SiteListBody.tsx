// 站点列表主体：三种排序模式各有一套渲染，外加「什么都没匹配到」的空状态。
// 原来内联在 App 的 <Container> 里，抽出来单独维护 —— 组件只渲染，
// 状态与回调全部由 App 通过 props 下发，行为与抽取前逐行一致。
import { Box, Stack } from "@mui/material";
import {
    DndContext,
    closestCenter,
    DragOverlay,
    useSensors,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortMode } from "../constants";
import type { Group, Site } from "../API/http";
import type { GroupWithSites } from "../types";
import type { Density } from "../context/UIPrefsContext";
import SortableGroupItem from "./SortableGroupItem";
import GroupCard from "./GroupCard";
import SiteCard from "./SiteCard";
import SiteListEmptyState from "./SiteListEmptyState";
import { groupAccent } from "../utils/groupColor";

export interface SiteListBodyProps {
    sortMode: SortMode;
    sensors: ReturnType<typeof useSensors>;
    /** 分组排序模式：拖完落位 */
    onGroupDragEnd: (event: DragEndEvent) => void;
    groups: GroupWithSites[];
    /** 分组排序模式里的「上移 / 下移一位」（键盘可达的拖拽替代） */
    onNudgeGroup: (groupId: string, delta: number) => void;

    /** 站点排序模式：四个拖拽回调 */
    onSiteDragStart: (event: DragStartEvent) => void;
    onSiteDragOver: (event: DragOverEvent) => void;
    onSiteDragEnd: (event: DragEndEvent) => void;
    onSiteDragCancel: () => void;
    /** 正在被拖动的站点（用于跟随指针的浮层） */
    draggingSite: Site | null;

    darkMode: boolean;
    onSiteUpdate: (updatedSite: Site) => void;
    onSiteDelete: (siteId: number) => void;
    onSaveSiteOrder: (groupId: number, sites: Site[]) => void;
    onStartSiteSort: (groupId: number) => void;
    onAddSite: (groupId: number) => void;
    onGroupUpdate: (group: Group) => void;
    onGroupDelete: (groupId: number) => void;

    /** 真正渲染的分组（已含「常用」置前等派生处理） */
    displayedGroups: GroupWithSites[];
    density: Density;
    /** 卡片太多时整体关掉入场动画 */
    reduceEntryAnimation: boolean;
    currentSortingGroupId: number | null;
    /** 分组强调色存在 configs[`group.color.<id>`] 里 */
    configs: Record<string, string>;
    onGroupAccentChange: (groupId: number, color: string) => void;

    /** 批量多选 */
    selectMode: boolean;
    selectedIds: number[];
    onToggleSelect: (siteId: number) => void;

    /** 空状态要用的一组筛选条件 */
    query: string;
    activeTags: string[];
    starFilter: boolean;
    deadOnly: boolean;
    onClearSearch: () => void;
    onClearFilters: () => void;
}

export default function SiteListBody({
    sortMode,
    sensors,
    onGroupDragEnd,
    groups,
    onNudgeGroup,
    onSiteDragStart,
    onSiteDragOver,
    onSiteDragEnd,
    onSiteDragCancel,
    draggingSite,
    darkMode,
    onSiteUpdate,
    onSiteDelete,
    onSaveSiteOrder,
    onStartSiteSort,
    onAddSite,
    onGroupUpdate,
    onGroupDelete,
    displayedGroups,
    density,
    reduceEntryAnimation,
    currentSortingGroupId,
    configs,
    onGroupAccentChange,
    selectMode,
    selectedIds,
    onToggleSelect,
    query,
    activeTags,
    starFilter,
    deadOnly,
    onClearSearch,
    onClearFilters,
}: SiteListBodyProps) {
    return (
        <Box
            sx={{
                "& > *": { mb: 5 },
                minHeight: "100px",
            }}
        >
            {sortMode === SortMode.GroupSort ? (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={onGroupDragEnd}
                >
                    <SortableContext
                        items={groups.map(group => group.id.toString())}
                        strategy={verticalListSortingStrategy}
                    >
                        <Stack
                            spacing={2}
                            sx={{
                                "& > *": {
                                    transition: "none",
                                },
                            }}
                        >
                            {groups.map((group, idx) => (
                                <SortableGroupItem
                                    key={group.id}
                                    id={group.id.toString()}
                                    group={group}
                                    onNudge={onNudgeGroup}
                                    isFirst={idx === 0}
                                    isLast={idx === groups.length - 1}
                                />
                            ))}
                        </Stack>
                    </SortableContext>
                </DndContext>
            ) : sortMode === SortMode.SiteSort ? (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={onSiteDragStart}
                    onDragOver={onSiteDragOver}
                    onDragEnd={onSiteDragEnd}
                    onDragCancel={onSiteDragCancel}
                >
                    <Stack spacing={5}>
                        {groups.map(group => (
                            <GroupCard
                                key={`group-${group.id}`}
                                group={group}
                                accentColor={groupAccent(group.id, darkMode ? "dark" : "light")}
                                sortMode="SiteSort"
                                currentSortingGroupId={null}
                                globalSiteSort
                                onUpdate={onSiteUpdate}
                                onDelete={onSiteDelete}
                                onSaveSiteOrder={onSaveSiteOrder}
                                onStartSiteSort={onStartSiteSort}
                                onAddSite={onAddSite}
                                onUpdateGroup={onGroupUpdate}
                                onDeleteGroup={onGroupDelete}
                            />
                        ))}
                    </Stack>

                    {/* 跟随指针的拖拽浮层：比原位卡片略大、略微倾斜 */}
                    <DragOverlay dropAnimation={null}>
                        {draggingSite && (
                            <Box
                                className='nav-drag-overlay'
                                sx={{ width: 200, pointerEvents: "none" }}
                            >
                                <SiteCard
                                    site={draggingSite}
                                    onUpdate={onSiteUpdate}
                                    onDelete={onSiteDelete}
                                    isEditMode
                                />
                            </Box>
                        )}
                    </DragOverlay>
                </DndContext>
            ) : displayedGroups.length > 0 ? (
                <Stack
                    spacing={density === "compact" ? 3 : 5}
                    className={reduceEntryAnimation ? "nav-static-entry" : undefined}
                >
                    {displayedGroups.map(group => (
                        <GroupCard
                            key={`group-${group.id}`}
                            group={group}
                            sortMode={
                                sortMode === SortMode.None ? "None" : "SiteSort"
                            }
                            currentSortingGroupId={currentSortingGroupId}
                            onUpdate={onSiteUpdate}
                            onDelete={onSiteDelete}
                            onSaveSiteOrder={onSaveSiteOrder}
                            onStartSiteSort={onStartSiteSort}
                            onAddSite={onAddSite}
                            onUpdateGroup={onGroupUpdate}
                            onDeleteGroup={onGroupDelete}
                            searchQuery={query}
                            accentColor={
                                configs[`group.color.${group.id}`] ||
                                groupAccent(group.id, darkMode ? "dark" : "light")
                            }
                            onAccentChange={onGroupAccentChange}
                            selectMode={selectMode}
                            selectedIds={selectedIds}
                            onToggleSelect={onToggleSelect}
                        />
                    ))}
                </Stack>
            ) : (
                <SiteListEmptyState
                    query={query}
                    hasTagFilter={activeTags.length > 0}
                    starFilter={starFilter}
                    deadOnly={deadOnly}
                    onClearSearch={onClearSearch}
                    onClearFilters={onClearFilters}
                />
            )}
        </Box>
    );
}
