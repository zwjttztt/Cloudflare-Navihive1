// src/components/HeaderActions.tsx
// 顶栏中段：排序模式下的「保存 / 取消编辑」，以及平时的「新增分组 + 更多选项」。
// 菜单本身不在这里渲染 —— 由 App 以 menu 插槽传进来，省得把十几个菜单动作
// 再从这里转发一遍。
import type { ReactNode } from "react";
import { Button } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import AddIcon from "@mui/icons-material/Add";
import MenuIcon from "@mui/icons-material/Menu";
import { SortMode, headerControlSx } from "../constants";

export interface HeaderActionsProps {
    sortMode: SortMode;
    onSaveGroupOrder: () => void;
    onSaveSiteSort: () => void;
    onCancelSort: () => void;
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
    onOpenAddGroup,
    onMenuOpen,
    menuOpen,
    menu,
}: HeaderActionsProps) {
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
                    <Button
                        variant='contained'
                        color='primary'
                        startIcon={<AddIcon />}
                        onClick={onOpenAddGroup}
                        size="small"
                        sx={headerControlSx}
                    >
                        新增分组
                    </Button>

                    <Button
                        variant='outlined'
                        color='primary'
                        startIcon={<MenuIcon />}
                        onClick={onMenuOpen}
                        aria-controls={menuOpen ? "navigation-menu" : undefined}
                        aria-haspopup='true'
                        aria-expanded={menuOpen ? "true" : undefined}
                        size="small"
                        sx={headerControlSx}
                    >
                        更多选项
                    </Button>
                    {menu}
                </>
            )}
        </>
    );
}
