// src/components/HeaderActions.tsx
// 顶栏工具行的「动作区」：平时的「新增 + 更多选项」。
//
// 「新增」现在是默认动作 + 下拉的组合：主按钮直接开「新增网站」（导航站最常用的动作），
// 右边的小箭头里才有「新增分组」—— 建分组是搭结构时才做的事，不该和加网址平起平坐。
// 菜单本身不在这里渲染 —— 由 App 以 menu 插槽传进来，省得把十几个菜单动作
// 再从这里转发一遍。
//
// 排序模式下这里只渲染一颗**钉在页面右侧的固定工具条**（保存 / 取消编辑），
// 不在顶栏占位 —— 理由见下面 sortMode 分支里的注释。
import { useState } from "react";
import type { ReactNode } from "react";
import { Box, Button, ButtonGroup, Menu, MenuItem } from "@mui/material";
import { prefetchChunk } from "../utils/lazyPrefetch";
import { dialogChunks } from "../utils/dialogChunks";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import AddIcon from "@mui/icons-material/Add";
import MenuIcon from "@mui/icons-material/Menu";
import StickyNote2Icon from "@mui/icons-material/StickyNote2";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import LanguageIcon from "@mui/icons-material/Language";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import { SortMode, HEADER_CONTROL_H, HEADER_RADIUS, headerControlSx } from "../constants";

/**
 * 提前把记事本那块代码拉下来（鼠标移到入口上时调）。
 *
 * 只预取**入口块**（NotesOverlay）：编辑器与预览那两块加起来近 900 KB，
 * 连它们一起预取的话，用户只是把鼠标扫过按钮就下掉 1 MB —— 太浪费。
 * 入口块本身是「点了必须等」的那一个，预取它就已经把干等消掉了；
 * 剩下的两块在记事本打开过程中加载，本来就在用户的等待预期里。
 * 失败一律忽略：这只是加速，取不到就退回「点了再下」。
 */
let notesPrefetched = false;
function prefetchNotes(): void {
    if (notesPrefetched) return;
    notesPrefetched = true;
    void import("./NotesOverlay").catch(() => {
        // 取不到就退回原来的行为（点开时再取），不影响功能
    });
}

export interface HeaderActionsProps {
    sortMode: SortMode;
    onSaveGroupOrder: () => void;
    onSaveSiteSort: () => void;
    onCancelSort: () => void;
    /** 主按钮：默认新增网站（没有分组时退化成新增分组） */
    onQuickAdd: () => void;
    /** 新增会落到哪个分组（为空表示还没有分组，会去建分组） */
    addTargetName?: string;
    /** 下拉里的「新增分组」 */
    onOpenAddGroup: () => void;
    onMenuOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
    /** 打开记事本面板 */
    onOpenNotes: () => void;
    /** 笔记条数：在按钮上显示一个角标（0 条时不显示） */
    notesCount: number;
    menuOpen: boolean;
    /** 「更多选项」菜单节点，挂在按钮后面（菜单自己管 anchor 与开关状态） */
    menu: ReactNode;
}

export default function HeaderActions({
    sortMode,
    onSaveGroupOrder,
    onSaveSiteSort,
    onCancelSort,
    onQuickAdd,
    onOpenAddGroup,
    addTargetName,
    onMenuOpen,
    onOpenNotes,
    notesCount,
    menuOpen,
    menu,
}: HeaderActionsProps) {
    const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
    const addOpen = Boolean(addAnchor);
    const closeAdd = () => setAddAnchor(null);

    return (
        <>
            {sortMode !== SortMode.None ? (
                /* 排序模式的「保存 / 取消编辑」（2026-10-17 用户要求改位置）：
                   从顶栏挪到页面右侧，position:fixed 让滚动时始终跟着视口。
                   排序是「边走边看」的动作 —— 按钮留在顶栏的话，滚两屏就得先
                   滚回顶部才能保存；钉在右侧随手可达，视线不用离开列表。
                   竖排 + 右缘居中：两颗按钮文字都短（2~6 字），横排会横向
                   伸进卡片区；玻璃底是为了让透明描边的「取消编辑」在
                   多色多图的列表上依然看得清字。 */
                <Box
                    data-sort-dock='1'
                    sx={{
                        position: "fixed",
                        right: { xs: 10, sm: 16 },
                        top: "50%",
                        transform: "translateY(-50%)",
                        // 抽屉级：压在卡片与回到顶部之上，仍在弹窗 / 提示条之下
                        zIndex: t => t.zIndex.drawer,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "stretch",
                        gap: 1,
                        p: 0.5,
                        borderRadius: HEADER_RADIUS,
                        bgcolor: "var(--glass-bg-hover)",
                        border: "1px solid var(--glass-border)",
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                        boxShadow: "0 2px 10px rgba(15,23,42,0.14)",
                    }}
                >
                    {sortMode === SortMode.GroupSort && (
                        <Button
                            variant='contained'
                            color='primary'
                            startIcon={<SaveIcon />}
                            onClick={onSaveGroupOrder}
                            size="small"
                            sx={headerControlSx}
                        >
                            保存分组顺序
                        </Button>
                    )}
                    {sortMode === SortMode.SiteSort && (
                        <Button
                            variant='contained'
                            color='primary'
                            startIcon={<SaveIcon />}
                            onClick={onSaveSiteSort}
                            size="small"
                            sx={headerControlSx}
                        >
                            保存
                        </Button>
                    )}
                    <Button
                        variant='outlined'
                        color='inherit'
                        startIcon={<CancelIcon />}
                        onClick={onCancelSort}
                        size="small"
                        sx={headerControlSx}
                    >
                        取消编辑
                    </Button>
                </Box>
            ) : (
                <>
                    {/* 新增：主按钮 + 下拉。
                        显示门槛从 sm(600px) 提到 md(900px)：底部导航栏管到 899.98px，
                        600~899px 这一段顶部和底栏会同时出现「新增 / 更多」，同一个动作两个入口。 */}
                    <ButtonGroup
                        variant='contained'
                        size='small'
                        color='primary'
                        sx={{
                            display: { xs: "none", md: "inline-flex" },
                            flexShrink: 0,
                        }}
                    >
                        <Button
                            startIcon={<AddIcon />}
                            onClick={onQuickAdd}
                            // 悬停预取（2026-10-17 首开延迟排查）：新增弹窗块在点下去
                            // 之前就开始下载，首开不再等块
                            onPointerEnter={() => prefetchChunk("addSite", dialogChunks.addSite)}
                            onFocus={() => prefetchChunk("addSite", dialogChunks.addSite)}
                            aria-label={
                                addTargetName
                                    ? `新增网站到「${addTargetName}」`
                                    : "新增分组"
                            }
                            title={
                                addTargetName
                                    ? `新增网站到「${addTargetName}」`
                                    : "还没有分组，点这里先建一个"
                            }
                            sx={headerControlSx}
                        >
                            新增
                        </Button>
                        <Button
                            onClick={event => setAddAnchor(event.currentTarget)}
                            aria-label='更多新增选项'
                            aria-haspopup='menu'
                            aria-expanded={addOpen ? "true" : undefined}
                            aria-controls={addOpen ? "header-add-menu" : undefined}
                            sx={{
                                minWidth: "auto",
                                // 原来 28px：箭头按钮窄到几乎点不中，这里拉到和主按钮一样高、宽度够一根手指
                                width: 36,
                                height: HEADER_CONTROL_H,
                                p: 0,
                            }}
                        >
                            <ArrowDropDownIcon fontSize='small' />
                        </Button>
                    </ButtonGroup>
                    <Menu
                        id='header-add-menu'
                        anchorEl={addAnchor}
                        open={addOpen}
                        onClose={closeAdd}
                        slotProps={{
                            list: { "aria-label": "新增", dense: true }
                        }}
                    >
                        <MenuItem
                            onClick={() => {
                                closeAdd();
                                onQuickAdd();
                            }}
                        >
                            <LanguageIcon fontSize='small' sx={{ mr: 1 }} />
                            新增网站
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                closeAdd();
                                onOpenAddGroup();
                            }}
                        >
                            <CreateNewFolderIcon fontSize='small' sx={{ mr: 1 }} />
                            新增分组
                        </MenuItem>
                    </Menu>

                    {/* 记事本：高频入口，给独立按钮而不是塞进「更多选项」 */}
                    <Button
                        variant='outlined'
                        color='primary'
                        startIcon={<StickyNote2Icon />}
                        onClick={onOpenNotes}
                        // 鼠标移上来（或键盘聚焦到它）就把那块代码先下下来。
                        //
                        // 为什么是 hover 而不是「页面空闲就预取」：记事本那块近 1.2 MB
                        // （编辑器 + 预览 + 视图），后台偷偷下完对**不打开记事本**的人
                        // 是纯浪费。hover 到入口上是很明确的意图信号 ——
                        // 从悬停到点下去通常有几百毫秒，够把第一个块拉回来了；
                        // 在这条每请求 1~3 秒的链路上，这一步能把「点了要干等」变成「点了就开」。
                        // 键盘用户走 onFocus，语义不变（只是提前下载，不改变行为）。
                        onMouseEnter={prefetchNotes}
                        onFocus={prefetchNotes}
                        aria-label='打开记事本'
                        size="small"
                        sx={{ ...headerControlSx }}
                    >
                        记事本
                        {notesCount > 0 ? `（${notesCount}）` : ""}
                    </Button>

                    <Button
                        variant='outlined'
                        color='primary'
                        startIcon={<MenuIcon />}
                        onClick={onMenuOpen}
                        // 悬停预取（2026-10-17 首开延迟排查）：菜单块 + 它的 MUI Menu
                        // 机器在点下去之前就开始下载；菜单展开后 MoreMenu 自己再预取
                        // 全部菜单项的目标弹窗块（见 MoreMenu 的 mount effect）
                        onPointerEnter={() => prefetchChunk("moreMenu", dialogChunks.moreMenu)}
                        onFocus={() => prefetchChunk("moreMenu", dialogChunks.moreMenu)}
                        // MoreMenu 用 aria-labelledby="navigation-button" 指回这个按钮
                        id='navigation-button'
                        aria-controls={menuOpen ? "navigation-menu" : undefined}
                        aria-haspopup='true'
                        aria-expanded={menuOpen ? "true" : undefined}
                        size="small"
                        sx={{
                            ...headerControlSx,
                            // 与「新增」同一个门槛：底部导航栏已经有一个「更多」，600~899px 别再重复
                            display: { xs: "none", md: "inline-flex" },
                            flexShrink: 0,
                        }}
                    >
                        更多选项
                    </Button>
                    {menu}
                </>
            )}
        </>
    );
}
