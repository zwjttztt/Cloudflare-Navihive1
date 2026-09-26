// src/components/MobileTabBar.tsx
// 手机端底部胶囊导航：把最常用的操作（搜索 / 分组 / 新增 / 更多）收到底部拇指区，
// 顶部那一排按钮在窄屏上就不用挤在一起了。只在 md 以下显示。
import { Box, Paper, Typography } from "@mui/material";
import type React from "react";
import SearchIcon from "@mui/icons-material/Search";
import DashboardIcon from "@mui/icons-material/Dashboard";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";

interface MobileTabBarProps {
    onSearch: () => void;
    onGroups: (event: React.MouseEvent<HTMLElement>) => void;
    onAdd: () => void;
    onMore: (event: React.MouseEvent<HTMLElement>) => void;
    /** 切换「只看星标」（窄屏上顶栏那颗胶囊要滚到顶才点得到，这里补一个） */
    onToggleStar?: () => void;
    starActive?: boolean;
    badge?: number;
}

export default function MobileTabBar({
    onSearch,
    onGroups,
    onAdd,
    onMore,
    onToggleStar,
    starActive = false,
    badge = 0,
}: MobileTabBarProps) {
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
                display: { xs: "flex", md: "none" },
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
                        transition: "all .18s ease",
                        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                    }}
                >
                    {item.icon}
                    <Typography sx={{ fontSize: 11, lineHeight: 1.2 }}>
                        {item.label}
                    </Typography>
                    {item.key === "groups" && badge > 0 && (
                        <Box
                            sx={{
                                position: "absolute",
                                mt: -3.5,
                                ml: 3,
                                minWidth: 16,
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
            ))}
        </Paper>
    );
}
