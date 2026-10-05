// src/components/HeaderActions.tsx
// 顶栏工具行的「动作区」：排序模式下的「保存 / 取消编辑」，平时的「新增 + 更多选项」。
//
// 「新增」现在是默认动作 + 下拉的组合：主按钮直接开「新增网站」（导航站最常用的动作），
// 右边的小箭头里才有「新增分组」—— 建分组是搭结构时才做的事，不该和加网址平起平坐。
// 菜单本身不在这里渲染 —— 由 App 以 menu 插槽传进来，省得把十几个菜单动作
// 再从这里转发一遍。
import { useState } from "react";
import type { ReactNode } from "react";
import { Button, ButtonGroup, Menu, MenuItem } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import AddIcon from "@mui/icons-material/Add";
import MenuIcon from "@mui/icons-material/Menu";
import StickyNote2Icon from "@mui/icons-material/StickyNote2";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import LanguageIcon from "@mui/icons-material/Language";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import { SortMode, HEADER_CONTROL_H, headerControlSx } from "../constants";

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
                <>
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
                </>
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
