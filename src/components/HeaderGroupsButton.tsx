// src/components/HeaderGroupsButton.tsx
// 窄桌面窗口（900~1343.98px）的「分组」入口。
//
// 这一段宽度很尴尬：左侧分组栏要 1344px 才出现，而底栏现在只给小屏（<=899.98px），
// 于是「左栏没有、底栏也没有」，想跳分组只能一路滚。这里补一个顶部按钮，
// 复用底栏那套分组菜单（anchor 由 App 的 mobileGroupsAnchor 持有）。
//
// 为什么要单独一个组件：显示条件是个既不在 MUI 默认断点里、又要和另外两个组件
// 严格互补的区间查询，写进 App 会把它和一堆无关渲染混在一起。
import { useEffect } from "react";
import { Box, Button, useMediaQuery } from "@mui/material";
import DashboardIcon from "@mui/icons-material/Dashboard";
import { headerControlSx } from "../constants";

// 上界与 GroupNavRail 的 min-width:1344px 互补，下界与 MobileTabBar 的 max-width:899.98px 互补
const SHOW_QUERY = "(min-width: 900px) and (max-width: 1343.98px)";

export interface HeaderGroupsButtonProps {
    /** 点一下把菜单挂到这个按钮上 */
    onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
    open: boolean;
    /** 分组数量，当作角标提示有多少组可跳 */
    count: number;
    /** 跨断点退场时回调：菜单挂在按钮上，按钮卸载后 anchor 会失效 */
    onExitViewport?: () => void;
}

export default function HeaderGroupsButton({
    onOpen,
    open,
    count,
    onExitViewport,
}: HeaderGroupsButtonProps) {
    const show = useMediaQuery(SHOW_QUERY);
    useEffect(() => {
        if (!show) onExitViewport?.();
    }, [show, onExitViewport]);

    if (!show) return null;

    return (
        <Button
            variant='outlined'
            color='primary'
            size='small'
            startIcon={<DashboardIcon />}
            onClick={onOpen}
            aria-haspopup='true'
            aria-expanded={open ? "true" : undefined}
            sx={{
                ...headerControlSx,
                flexShrink: 0,
                display: "inline-flex",
            }}
        >
            分组
            {count > 0 && (
                <Box
                    component='span'
                    aria-hidden
                    sx={{
                        ml: 0.75,
                        minWidth: 16,
                        height: 16,
                        px: 0.4,
                        borderRadius: "8px",
                        fontSize: 10,
                        lineHeight: "16px",
                        bgcolor: "var(--glass-bg-hover)",
                        color: "text.secondary",
                    }}
                >
                    {count > 99 ? "99+" : count}
                </Box>
            )}
        </Button>
    );
}
