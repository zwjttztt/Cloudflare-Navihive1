// src/components/MobileTabBar.tsx
// 底部胶囊导航：把最常用的操作（搜索 / 分组 / 新增 / 更多 / 星标）收到底部拇指区，
// 顶部那一排按钮在窄屏上就不用挤在一起了。
//
// 显示时机：只要左侧分组栏（GroupNavRail，>=1344px 才显示）藏起来就出现，
// 即视口 <=1343.98px——这样浏览器放大到 125%~200% 让有效视口落进 900~1343px 时，
// 窄桌面窗口也有分组跳转入口，不会像原来那样「左栏没、底栏也没」断档。
import { Box, Paper, Typography, useMediaQuery } from "@mui/material";
import { useEffect } from "react";
import type React from "react";
import SearchIcon from "@mui/icons-material/Search";
import DashboardIcon from "@mui/icons-material/Dashboard";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";

// 与 GroupNavRail 的 SHOW_QUERY（min-width:1344px）正好互补：
// 1344px 起左栏接管分组导航，1343.98px 及以下改由本底栏提供，
// 取 .98 是为了吃掉 1343.5 这类亚像素宽度，避免两者都不显示。
const TABBAR_SHOW_QUERY = "(max-width: 1343.98px)";

interface MobileTabBarProps {
    onSearch: () => void;
    onGroups: (event: React.MouseEvent<HTMLElement>) => void;
    onAdd: () => void;
    onMore: (event: React.MouseEvent<HTMLElement>) => void;
    /** 切换「只看星标」（窄屏上顶栏那颗胶囊要滚到顶才点得到，这里补一个） */
    onToggleStar?: () => void;
    starActive?: boolean;
    badge?: number;
    /** 视口变宽跨过 1344px、本栏退场时回调。此时挂在底栏按钮上的菜单
     *  （「分组」「更多」）anchor 会从 DOM 分离，MUI 重定位会飘到左上角，
     *  得让上层把它们收掉 —— resize 事件跑在 React 卸载之前，靠不住 */
    onExitViewport?: () => void;
}

export default function MobileTabBar({
    onSearch,
    onGroups,
    onAdd,
    onMore,
    onToggleStar,
    starActive = false,
    badge = 0,
    onExitViewport,
}: MobileTabBarProps) {
    // 左栏显示时（>=1344px）本底栏让位，避免两个分组入口重叠
    const showTabBar = useMediaQuery(TABBAR_SHOW_QUERY);
    useEffect(() => {
        if (!showTabBar) onExitViewport?.();
    }, [showTabBar, onExitViewport]);
    if (!showTabBar) return null;
    const items: {
        key: string;
        label: string;
        icon: React.ReactNode;
        onClick: (event: React.MouseEvent<HTMLElement>) => void;
        active?: boolean;
    }[] = [
        { key: "search", label: "搜索", icon: <SearchIcon fontSize='small' />, onClick: onSearch },
        { key: "groups", label: "分组", icon: <DashboardIcon fontSize='small' />, onClick: onGroups },
        { key: "add", label: "新增", icon: <AddCircleOutlineIcon fontSize='small' />, onClick: onAdd },
        ...(onToggleStar
            ? [
                  {
                      key: "star",
                      label: starActive ? "星标中" : "星标",
                      icon: starActive ? (
                          <StarIcon fontSize='small' />
                      ) : (
                          <StarBorderIcon fontSize='small' />
                      ),
                      onClick: () => onToggleStar(),
                      active: starActive,
                  },
              ]
            : []),
        { key: "more", label: "更多", icon: <MoreHorizIcon fontSize='small' />, onClick: onMore },
    ];

    return (
        <Paper
            component='nav'
            aria-label='主导航'
            className='nav-mobile-tabbar'
            elevation={0}
            sx={{
                position: "fixed",
                left: 12,
                right: 12,
                bottom: 12,
                zIndex: (t) => t.zIndex.appBar + 2,
                display: "flex",
                justifyContent: "space-around",
                alignItems: "center",
                gap: 0.5,
                p: 0.75,
                borderRadius: "20px",
                bgcolor: "var(--glass-bg-hover)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(16px) saturate(1.5)",
                WebkitBackdropFilter: "blur(16px) saturate(1.5)",
                boxShadow: "0 6px 24px rgba(15,23,42,0.18)",
            }}
        >
            {items.map(item => (
                <Box
                    key={item.key}
                    component='button'
                    type='button'
                    onClick={item.onClick}
                    aria-label={item.label}
                    aria-pressed={item.active ? true : undefined}
                    sx={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 0.25,
                        py: 0.5,
                        border: 0,
                        borderRadius: "14px",
                        cursor: "pointer",
                        bgcolor: item.active ? "action.selected" : "transparent",
                        color: item.active ? "var(--accent)" : "text.secondary",
                        // 显式列出属性：写 all 会连 outline-offset 一起补间，
                        // 焦点环在中途还落在容器外面，容易被底部栏的边缘剪掉
                        transition: "background-color .18s ease, color .18s ease",
                        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                    }}
                >
                    {item.key === "groups" ? (
                        // 角标贴在**图标**右上角，不是按钮右上角（按钮 flex:1 占一整格，
                        // 贴按钮边角会离图标老远）。包裹层必须是定位基准：
                        // 以前角标直接 absolute 挂在按钮里，按钮却没有 position:relative，
                        // 基准跑到了 fixed 的底栏上 —— 那个「5」会飘到底栏顶部中间，
                        // 换个屏宽位置还跟着变
                        <Box sx={{ position: "relative", display: "inline-flex" }}>
                            {item.icon}
                            {badge > 0 && (
                                <Box
                                    sx={{
                                        position: "absolute",
                                        top: -5,
                                        right: -9,
                                        minWidth: 16,
                                        height: 16,
                                        px: 0.4,
                                        borderRadius: "8px",
                                        fontSize: 10,
                                        lineHeight: "16px",
                                        textAlign: "center",
                                        bgcolor: "var(--accent)",
                                        color: "#fff",
                                    }}
                                >
                                    {badge > 99 ? "99+" : badge}
                                </Box>
                            )}
                        </Box>
                    ) : (
                        item.icon
                    )}
                    <Typography sx={{ fontSize: 11, lineHeight: 1.2 }}>
                        {item.label}
                    </Typography>
                </Box>
            ))}
        </Paper>
    );
}
