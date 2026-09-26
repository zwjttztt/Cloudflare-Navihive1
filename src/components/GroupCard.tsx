import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import { Site, Group } from "../API/http";
import SiteCard from "./SiteCard";
import { GroupWithSites } from "../types";
import EditGroupDialog from "./EditGroupDialog";
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    useDroppable,
} from "@dnd-kit/core";
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
// 引入Material UI组件
import { Paper, Typography, Button, Box, IconButton, Tooltip, Collapse } from "@mui/material";
import SortIcon from "@mui/icons-material/Sort";
import SaveIcon from "@mui/icons-material/Save";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import EmptyArt from "./EmptyArt";
import { useUIPrefs } from "../context/UIPrefsContext";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import {
    COLLAPSED_EVENT,
    readCollapsedGroupIds,
    writeCollapsedGroupIds,
} from "../utils/collapse";

// 虚拟「最近访问」分组的 id（本地统计出来，不存在于数据库）
const RECENT_GROUP_ID = -1;

// 更新组件属性接口
interface GroupCardProps {
    group: GroupWithSites;
    index?: number; // 用于Draggable的索引，仅在分组排序模式下需要
    sortMode: "None" | "GroupSort" | "SiteSort";
    currentSortingGroupId: number | null;
    globalSiteSort?: boolean; // 是否为跨分组站点排序模式（由父级统一 DndContext 驱动）
    onUpdate: (updatedSite: Site) => void;
    onDelete: (siteId: number) => void;
    onSaveSiteOrder: (groupId: number, sites: Site[]) => void;
    onStartSiteSort: (groupId: number) => void;
    onAddSite?: (groupId: number) => void; // 新增添加卡片的可选回调函数
    onUpdateGroup?: (group: Group) => void; // 更新分组的回调函数
    onDeleteGroup?: (groupId: number) => void; // 删除分组的回调函数
    searchQuery?: string; // 搜索关键词，命中片段在卡片里高亮
    accentColor?: string; // 分组强调色（留空则用全局主色）
    onAccentChange?: (groupId: number, color: string) => void;
    /** 批量多选模式：点卡片变成勾选 */
    selectMode?: boolean;
    selectedIds?: number[];
    onToggleSelect?: (siteId: number) => void;
}

// 卡片多的分组先渲染一批，滚到底再补，避免一次铺几百张卡拖慢首屏
const PAGE_SIZE = 40;

const GroupCard: React.FC<GroupCardProps> = ({
    group,
    sortMode,
    currentSortingGroupId,
    globalSiteSort = false,
    onUpdate,
    onDelete,
    onSaveSiteOrder,
    onStartSiteSort,
    onAddSite,
    onUpdateGroup,
    onDeleteGroup,
    searchQuery = "",
    accentColor = "",
    onAccentChange,
    selectMode = false,
    selectedIds,
    onToggleSelect,
}) => {
    const { viewMode, density, clearVisits, isStarred, starred } = useUIPrefs();
    const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

    /** 一键清空「最近访问」：清掉本机访问统计，分组随之消失（不弹提示，肉眼可见） */
    const handleClearRecent = () => {
        clearVisits();
    };
    const isCompact = density === "compact";

    // 分组懒挂载：视口外的分组先不创建卡片（只留占位高度），
    // content-visibility 只省了布局与绘制，React 元素和 DOM 节点照样是全量建的，
    // 几百张卡片时那部分开销才是大头。排序模式必须全量渲染，否则拖拽落点会算错。
    const [sitesMounted, setSitesMounted] = useState(sortMode === "None" ? false : true);
    const panelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (sortMode !== "None") {
            setSitesMounted(true);
            return;
        }
        const el = panelRef.current;
        if (!el || typeof IntersectionObserver === "undefined") {
            setSitesMounted(true);
            return;
        }
        const io = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    setSitesMounted(true);
                    io.disconnect(); // 一旦挂上就不卸载，避免来回滚动反复重建
                }
            },
            { rootMargin: "600px 0px" }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [sortMode]);

    // 未挂载时的占位高度：按「一行约 3 张、每张约 150px」粗估，
    // 与 content-visibility 的 contain-intrinsic-size 思路一致，滚动条不会大幅跳动
    const placeholderHeight = useMemo(() => {
        const count = group.sites.length || 1;
        const perRow = viewMode === "list" ? 1 : 3;
        const cardH = viewMode === "list" ? 64 : isCompact ? 120 : 150;
        return Math.max(120, Math.ceil(count / perRow) * cardH);
    }, [group.sites.length, viewMode, isCompact]);
    // 列表视图下卡片挨得更紧，分组内间距同步收一档
    const gridGap = viewMode === "list" ? (isCompact ? -0.25 : 0) : isCompact ? -0.5 : -1;
    // 添加本地状态来管理站点排序
    const [sites, setSites] = useState<Site[]>(group.sites);
    // 添加编辑弹窗的状态
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    // 分组是否收起（记录在 localStorage）
    const [collapsed, setCollapsed] = useState(() =>
        readCollapsedGroupIds().includes(String(group.id))
    );

    // 父级站点数据变化时同步本地列表（免刷新即时更新后，进入排序模式要拿到最新数据）
    useEffect(() => {
        setSites(group.sites);
    }, [group.sites]);

    // 「最近访问」是本地统计出来的虚拟分组（id < 0），不给它增删改的入口，
    // 否则会往不存在的 group_id 里塞卡片
    const isVirtualGroup = typeof group.id === "number" && group.id < 0;
    /** 是否可以显示添加卡片 / 排序 / 编辑分组这些管理入口 */
    const canManageGroup = !isVirtualGroup;

    // 加了星标的卡片排到分组最前面（排序模式 / 拖拽中 / 虚拟分组保持原顺序，免得手一抖顺序就乱）
    const orderedSites = useMemo(() => {
        if (sortMode !== "None" || globalSiteSort || isVirtualGroup) return group.sites;
        const stars = group.sites.filter(site => isStarred(site.id));
        if (stars.length === 0) return group.sites;
        const rest = group.sites.filter(site => !isStarred(site.id));
        return [...stars, ...rest];
    }, [group.sites, sortMode, globalSiteSort, isVirtualGroup, starred]);

    // 分组本身变化时同步一次收起状态；同时监听「全部折叠/展开」广播与跨标签页改动
    useEffect(() => {
        const sync = () =>
            setCollapsed(readCollapsedGroupIds().includes(String(group.id)));
        sync();
        window.addEventListener(COLLAPSED_EVENT, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(COLLAPSED_EVENT, sync);
            window.removeEventListener("storage", sync);
        };
    }, [group.id]);

    // 懒加载：分组切换或版式变化时回到第一批
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        setVisibleCount(PAGE_SIZE);
    }, [group.id, viewMode, density]);

    const toggleCollapsed = () => {
        const key = String(group.id);
        const ids = new Set(readCollapsedGroupIds());
        if (ids.has(key)) {
            ids.delete(key);
        } else {
            ids.add(key);
        }
        writeCollapsedGroupIds([...ids]);
        setCollapsed(ids.has(key));
    };

    // 排序模式与搜索时都强制展开：卡片被收起就没法拖拽 / 看不到搜到的结果
    const isCollapsed = collapsed && sortMode === "None" && !searchQuery.trim();

    // 普通模式下先渲染前 40 个，剩下的等滚动到哨兵再补
    const hasMoreSites = group.sites.length > visibleCount && sortMode === "None";

    // 哨兵进入视口就再补一批
    useEffect(() => {
        if (!hasMoreSites || isCollapsed) return;
        const el = sentinelRef.current;
        if (!el || typeof IntersectionObserver === "undefined") return;

        const io = new IntersectionObserver(
            entries => {
                if (entries.some(e => e.isIntersecting)) {
                    setVisibleCount(c => c + PAGE_SIZE);
                }
            },
            { rootMargin: "240px" }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [hasMoreSites, isCollapsed, visibleCount]);

    // 分组作为跨组拖拽的放置容器
    const { setNodeRef: setGroupDropRef, isOver: isGroupOver } = useDroppable({
        id: `group-${group.id}`,
        data: { type: "group" },
    });

    // 配置传感器，支持鼠标、触摸和键盘操作
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5, // 5px 的移动才激活拖拽，防止误触
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 250, // 延迟250ms激活，防止误触
                tolerance: 5, // 容忍5px的移动
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // 站点拖拽结束处理函数
    const handleSiteDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (!over) return;

        if (active.id !== over.id) {
            // 查找拖拽的站点索引
            const oldIndex = sites.findIndex(site => `site-${site.id}` === active.id);
            const newIndex = sites.findIndex(site => `site-${site.id}` === over.id);

            if (oldIndex !== -1 && newIndex !== -1) {
                // 更新本地站点顺序
                const newSites = arrayMove(sites, oldIndex, newIndex);
                setSites(newSites);
            }
        }
    };

    // 编辑分组处理函数
    const handleEditClick = () => {
        setEditDialogOpen(true);
    };

    // 更新分组处理函数
    const handleUpdateGroup = (updatedGroup: Group) => {
        if (onUpdateGroup) {
            onUpdateGroup(updatedGroup);
            setEditDialogOpen(false);
        }
    };

    // 删除分组处理函数
    const handleDeleteGroup = (groupId: number) => {
        if (onDeleteGroup) {
            onDeleteGroup(groupId);
            setEditDialogOpen(false);
        }
    };

    // 判断是否为当前正在编辑的分组
    const isCurrentEditingGroup = sortMode === "SiteSort" && currentSortingGroupId === group.id;

    // 卡片外层容器宽度：列表一行一个，图标墙排得更密，紧凑密度只收内边距
    const cardBoxSx = {
        width:
            viewMode === "list"
                ? "100%"
                : viewMode === "wall"
                  ? { xs: "33.33%", sm: "25%", md: "16.66%", lg: "12.5%", xl: "10%" }
                  : { xs: "50%", sm: "33.33%", md: "25%", lg: "25%", xl: "20%" },
        padding: isCompact ? 0.5 : 1, // 内部间距，更均匀的分布
        boxSizing: "border-box" as const, // 确保padding不影响宽度计算
    };

    // 渲染站点卡片区域
    const renderSites = () => {
        // 跨分组排序模式：由父级统一 DndContext 驱动，所有分组的卡片都可拖拽
        // （「最近访问」是本地统计的虚拟分组，永远排除在外：既不能移入也不能移出）
        if (globalSiteSort && !isVirtualGroup) {
            return (
                <Box ref={setGroupDropRef} sx={{ width: "100%" }}>
                    <SortableContext
                        items={group.sites.map((site, idx) => `site-${site.id || idx}`)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <Box
                            sx={{
                                display: "flex",
                                flexWrap: "wrap",
                                margin: -1, // 抵消内部padding，确保边缘对齐
                                minHeight: 72,
                                borderRadius: 3,
                                border: "1.5px dashed",
                                borderColor: isGroupOver ? "primary.main" : "transparent",
                                bgcolor: isGroupOver ? "action.hover" : "transparent",
                                transition: "all 0.2s ease",
                                // 拖拽经过时给出明确的放置提示
                                boxShadow: isGroupOver
                                    ? "0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)"
                                    : "none",
                            }}
                        >
                            {group.sites.map((site, idx) => (
                                <Box
                                    key={site.id || idx}
                                    sx={{
                                        width: {
                                            xs: "50%",
                                            sm: "50%",
                                            md: "25%",
                                            lg: "25%",
                                            xl: "25%",
                                        },
                                        padding: 1, // 内部间距，更均匀的分布
                                        boxSizing: "border-box", // 确保padding不影响宽度计算
                                    }}
                                >
                                    <SiteCard
                                        site={site}
                                        onUpdate={onUpdate}
                                        onDelete={onDelete}
                                        isEditMode={true}
                                        index={idx}
                                    />
                                </Box>
                            ))}
                            {group.sites.length === 0 && (
                                <Box
                                    width='100%'
                                    display='flex'
                                    justifyContent='center'
                                    alignItems='center'
                                    minHeight={72}
                                >
                                    <Typography variant='body2' color='text.secondary'>
                                        空分组，可将其他分组的卡片拖到这里
                                    </Typography>
                                </Box>
                            )}
                        </Box>
                    </SortableContext>
                </Box>
            );
        }

        // 使用本地状态中的站点数据（普通模式下顺带把星标卡片提上来）
        const sitesToRender = isCurrentEditingGroup ? sites : orderedSites;

        // 如果当前不是正在编辑的分组且处于站点排序模式，不显示站点
        if (!isCurrentEditingGroup && sortMode === "SiteSort") {
            return null;
        }

        // 如果是编辑模式，使用DndContext包装
        if (isCurrentEditingGroup) {
            return (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleSiteDragEnd}
                >
                    <SortableContext
                        items={sitesToRender.map(site => `site-${site.id}`)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <Box sx={{ width: "100%" }}>
                            <Box
                                sx={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    margin: -1, // 抵消内部padding，确保边缘对齐
                                }}
                            >
                                {sitesToRender.map((site, idx) => (
                                    <Box
                                        key={site.id || idx}
                                        sx={{
                                            width: {
                                                xs: "50%",
                                                sm: "50%",
                                                md: "25%",
                                                lg: "25%",
                                                xl: "25%",
                                            },
                                            padding: 1, // 内部间距，更均匀的分布
                                            boxSizing: "border-box", // 确保padding不影响宽度计算
                                        }}
                                    >
                                        <SiteCard
                                            site={site}
                                            onUpdate={onUpdate}
                                            onDelete={onDelete}
                                            isEditMode={true}
                                            index={idx}
                                        />
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    </SortableContext>
                </DndContext>
            );
        }

        // 普通模式下的渲染
        // 普通模式下整组没有卡片：给一个引导性的空状态，而不是留一片空白
        if (sitesToRender.length === 0) {
            return (
                <Box
                    sx={{
                        py: 4,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 1,
                        borderRadius: "18px",
                        border: "1.5px dashed",
                        borderColor: "divider",
                        color: "text.secondary",
                    }}
                >
                    <EmptyArt variant={searchQuery ? "search" : "group"} size={104} />
                    <Typography variant='body2'>
                        {searchQuery ? "本组没有匹配的网站" : "这个分组还没有卡片"}
                    </Typography>
                    <Typography variant='caption' color='text.secondary'>
                        {searchQuery
                            ? "试试换个关键词，或清空搜索框"
                            : canManageGroup
                              ? "放入第一个网站，这个分组就有内容了"
                              : "这个分组暂未放入网站"}
                    </Typography>
                    {/* 空分组直接给个入口，不用先去右上角找按钮 */}
                    {!searchQuery && canManageGroup && onAddSite && (
                        <Button
                            size='small'
                            variant='outlined'
                            startIcon={<AddIcon />}
                            onClick={() => onAddSite(group.id!)}
                            sx={{ mt: 0.5 }}
                            className='nav-empty-add-site'
                        >
                            添加卡片
                        </Button>
                    )}
                </Box>
            );
        }

        // 「最近访问」虚拟分组：由 App 按 7 天内点击次数倒序取好前 10 个，
        // 这里保持原顺序平铺，不再分「今天 / 昨天 / 更早」小节
        if (group.id === RECENT_GROUP_ID) {
            return (
                <Box
                    sx={{
                        display: viewMode === "list" ? "block" : "flex",
                        flexWrap: "wrap",
                        margin: gridGap,
                    }}
                >
                    {sitesToRender.map(site => (
                        <Box key={site.id} sx={cardBoxSx}>
                            <SiteCard
                                site={site}
                                onUpdate={onUpdate}
                                onDelete={onDelete}
                                isEditMode={false}
                                highlight={searchQuery}
                                selectMode={selectMode}
                                selected={selectedSet.has(site.id as number)}
                                onToggleSelect={onToggleSelect}
                            />
                        </Box>
                    ))}
                </Box>
            );
        }

        // 卡片特别多的分组：只渲染当前这一批，剩的等滚动到哨兵再补
        const visibleSites = sitesToRender.slice(0, visibleCount);
        const hasMore = sitesToRender.length > visibleCount;

        return (
            <Box
                sx={{
                    display: viewMode === "list" ? "block" : "flex",
                    flexWrap: "wrap",
                    margin: gridGap, // 抵消内部padding，确保边缘对齐
                }}
            >
                {visibleSites.map((site, idx) => (
                    <Box key={site.id} sx={cardBoxSx}>
                        <SiteCard
                            site={site}
                            onUpdate={onUpdate}
                            onDelete={onDelete}
                            isEditMode={false}
                            index={idx}
                            highlight={searchQuery}
                            selectMode={selectMode}
                            selected={selectedSet.has(site.id as number)}
                            onToggleSelect={onToggleSelect}
                        />
                    </Box>
                ))}
                {hasMore && (
                    <Box
                        ref={sentinelRef}
                        sx={{
                            width: "100%",
                            py: 1.5,
                            textAlign: "center",
                            color: "text.secondary",
                            fontSize: 12,
                        }}
                    >
                        继续滚动加载剩余 {sitesToRender.length - visibleCount} 个…
                    </Box>
                )}
            </Box>
        );
    };

    // 保存站点排序
    const handleSaveSiteOrder = () => {
        onSaveSiteOrder(group.id!, sites);
    };

    // 正常模式或站点排序模式下渲染完整的分组卡片
    return (
        <Paper
            ref={panelRef}
            elevation={0}
            id={`group-anchor-${group.id}`}
            data-group-anchor={group.id}
            className='nav-group-panel'
            data-sort-mode={sortMode}
            style={{ ["--group-accent" as string]: accentColor || undefined }}
            sx={{
                borderRadius: "var(--card-radius)",
                p: { xs: 2, sm: 3 },
                // 与卡片同源的毛玻璃，只是更淡一层，形成「面板 → 卡片」的层次
                background: "var(--glass-panel-bg)",
                backdropFilter: "blur(var(--glass-blur)) saturate(1.3)",
                WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.3)",
                border: "1px solid var(--glass-panel-border)",
                boxShadow: "var(--glass-shadow)",
                // backdrop-filter 单独钉成 0s：这个属性一旦参与补间，浏览器就得逐帧
                // 重新采样面板背后的像素，圆角边界采样补不齐会透出一圈暗边（像「外圈变黑」）。
                // 其余属性照旧走 all 的 0.3s；CSS 过渡里同名属性以最后一条为准。
                transition:
                    "all 0.3s ease-in-out, backdrop-filter 0s, -webkit-backdrop-filter 0s",
                "&:hover": {
                    boxShadow: "var(--glass-shadow-hover)",
                    borderColor: (theme) => theme.palette.primary.main,
                    transform: sortMode === "None" ? "scale(1.005)" : "none",
                },
            }}
        >
            <Box 
                display='flex' 
                flexDirection={{ xs: 'column', sm: 'row' }}
                justifyContent='space-between' 
                alignItems={{ xs: 'flex-start', sm: 'center' }} 
                mb={isCollapsed ? 0 : 2.5}
                gap={1}
                className='nav-sticky'
                sx={{
                    py: 1,
                    px: 1,
                    mx: -1,
                    // 与分组面板同色：这里只负责「卡片滑过时把背后糊掉」，
                    // 不再额外垫一层比面板更白的底色
                    bgcolor: "transparent",
                    backdropFilter: "blur(8px)",
                    WebkitBackdropFilter: "blur(8px)",
                }}
            >
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 0.5,
                    }}
                >
                    {/* 分组强调色条：没单独设色时按分组 id 自动给一个稳定色 */}
                    <Box
                        className='nav-group-accent-bar'
                        sx={{
                            width: 3,
                            height: 20,
                            borderRadius: "3px",
                            bgcolor: "var(--group-accent)",
                            flexShrink: 0,
                        }}
                    />
                    <Tooltip title={isCollapsed ? "展开分组" : "收起分组"}>
                        <IconButton
                            size='small'
                            onClick={toggleCollapsed}
                            aria-label={isCollapsed ? "展开分组" : "收起分组"}
                            aria-expanded={!isCollapsed}
                            sx={{ ml: -0.5 }}
                        >
                            {isCollapsed ? (
                                <ExpandMoreIcon fontSize='small' />
                            ) : (
                                <ExpandLessIcon fontSize='small' />
                            )}
                        </IconButton>
                    </Tooltip>
                    <Typography
                        variant='h5'
                        component='h2'
                        fontWeight='600'
                        color='text.primary'
                        sx={{ mb: { xs: 1, sm: 0 } }}
                    >
                        {group.name}
                    </Typography>
                    <Typography
                        variant='body2'
                        color='text.secondary'
                        sx={{ ml: 0.5, mb: { xs: 1, sm: 0 } }}
                    >
                        ({group.sites.length})
                    </Typography>
                </Box>

                {globalSiteSort && (
                    <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{ display: { xs: 'none', sm: 'inline' }, alignSelf: 'center' }}
                    >
                        可拖拽卡片到其他分组
                    </Typography>
                )}

                <Box 
                    sx={{ 
                        display: 'flex', 
                        flexDirection: { xs: 'row', sm: 'row' }, 
                        gap: 1,
                        width: { xs: '100%', sm: 'auto' },
                        flexWrap: 'wrap',
                        justifyContent: { xs: 'flex-start', sm: 'flex-end' }
                    }}
                >
                    {/* 「最近访问」是本地统计出来的名单，只给一个一键清空 */}
                    {sortMode === "None" && group.id === RECENT_GROUP_ID ? (
                        <Button
                            variant='outlined'
                            color='primary'
                            size='small'
                            startIcon={<DeleteSweepIcon />}
                            onClick={handleClearRecent}
                            sx={{
                                minWidth: "auto",
                                fontSize: { xs: "0.75rem", sm: "0.875rem" },
                            }}
                        >
                            清空
                        </Button>
                    ) : isCurrentEditingGroup ? (
                        <Button
                            variant='contained'
                            color='primary'
                            size='small'
                            startIcon={<SaveIcon />}
                            onClick={handleSaveSiteOrder}
                            sx={{ 
                                minWidth: 'auto',
                                fontSize: { xs: '0.75rem', sm: '0.875rem' }
                            }}
                        >
                            保存顺序
                        </Button>
                    ) : selectMode && canManageGroup ? (
                        <Button
                            variant='outlined'
                            color='primary'
                            size='small'
                            className='nav-select-group-btn'
                            onClick={() => {
                                const ids = orderedSites
                                    .map(site => site.id)
                                    .filter((id): id is number => typeof id === "number");
                                const allSelected =
                                    ids.length > 0 && ids.every(id => selectedSet.has(id));
                                ids.forEach(id => {
                                    if (allSelected === selectedSet.has(id)) {
                                        onToggleSelect?.(id);
                                    }
                                });
                            }}
                            sx={{
                                minWidth: "auto",
                                fontSize: { xs: "0.75rem", sm: "0.875rem" },
                            }}
                        >
                            {orderedSites.length > 0 &&
                            orderedSites.every(site => selectedSet.has(site.id as number))
                                ? "取消本组"
                                : "全选本组"}
                        </Button>
                    ) : (
                        sortMode === "None" && canManageGroup && !selectMode && (
                            <>
                                {onAddSite && (
                                    <Button
                                        variant='contained'
                                        color='primary'
                                        size='small'
                                        onClick={() => onAddSite(group.id!)}
                                        startIcon={<AddIcon />}
                                        sx={{ 
                                            minWidth: 'auto',
                                            fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                        }}
                                    >
                                        添加卡片
                                    </Button>
                                )}
                                <Button
                                    variant='outlined'
                                    color='primary'
                                    size='small'
                                    startIcon={<SortIcon />}
                                    onClick={() => onStartSiteSort(group.id!)}
                                    sx={{ 
                                        minWidth: 'auto',
                                        fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                    }}
                                >
                                    排序
                                </Button>
                                
                                {onUpdateGroup && onDeleteGroup && (
                                    <Tooltip title="编辑分组">
                                        <IconButton 
                                            color="primary" 
                                            onClick={handleEditClick}
                                            size="small"
                                            aria-label="编辑分组"
                                            sx={{ alignSelf: 'center' }}
                                        >
                                            <EditIcon />
                                        </IconButton>
                                    </Tooltip>
                                )}
                            </>
                        )
                    )}
                </Box>
            </Box>

            {/* 站点卡片区域（收起时隐藏） */}
            <Collapse in={!isCollapsed} timeout={250} unmountOnExit={false}>
                {sitesMounted ? renderSites() : <Box sx={{ height: placeholderHeight }} />}
            </Collapse>

            {/* 编辑分组弹窗 */}
            {onUpdateGroup && onDeleteGroup && canManageGroup && (
                <EditGroupDialog
                    open={editDialogOpen}
                    group={group}
                    onClose={() => setEditDialogOpen(false)}
                    onSave={handleUpdateGroup}
                    onDelete={handleDeleteGroup}
                    color={accentColor}
                    onColorChange={
                        onAccentChange
                            ? next => onAccentChange(group.id!, next)
                            : undefined
                    }
                />
            )}
        </Paper>
    );
};

// 用 memo 包一层：父级 App 的无关状态变化（Snackbar、主题、对话框等）不再触发所有分组重渲染。
// 生效前提是父级传入的回调都用 useCallback 保持了稳定引用。
export default memo(GroupCard);
