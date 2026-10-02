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
    /** 下拉里的「新增分组」 */
    onOpenAddGroup: () => void;
    onMenuOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
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
    onMenuOpen,
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
                    {/* 新增：主按钮 + 下拉。窄屏整个交给底部导航栏，顶部不再重复 */}
                    <ButtonGroup
                        variant='contained'
                        size='small'
                        color='primary'
                        sx={{
                            display: { xs: "none", sm: "inline-flex" },
                            flexShrink: 0,
                        }}
                    >
                        <Button
                            startIcon={<AddIcon />}
                            onClick={onQuickAdd}
                            aria-label='新增网站'
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
                                width: 28,
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
                        MenuListProps={{ "aria-label": "新增", dense: true }}
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
                            display: { xs: "none", sm: "inline-flex" },
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
