// src/components/SiteListHeader.tsx
// 网站列表区顶部标题栏的展示组件：站名 + 右侧操作区。
// 从 App.tsx 抽出来单纯为了给那个近 900 行的渲染树瘦身；它不持有任何状态，
// 右侧操作区（搜索框 / 菜单 / 显示控制 / 时钟）作为 children 透传，渲染结果与原内联写法完全一致。
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";

export interface SiteListHeaderProps {
    /** 站名（settings 里配的 site.name） */
    siteName: string;
    /** 向下滚动后是否进入紧凑模式（改字号与间距） */
    headerCompact: boolean;
    /** 右侧操作区：搜索框 + 菜单 + 显示控制 + 时钟，由 App 透传 */
    actions: ReactNode;
}

export default function SiteListHeader({ siteName, headerCompact, actions }: SiteListHeaderProps) {
    return (
        <Box
            component="header"
            className={headerCompact ? "nav-header-compact" : undefined}
            sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: headerCompact ? 2.5 : 5,
                flexDirection: { xs: "column", sm: "row" },
                gap: { xs: 2, sm: 0 },
                // 向下滚动后收掉一点高度，内容区往上顶
                pt: headerCompact ? 0 : 0.5,
                transition: "margin .25s ease",
            }}
        >
            <Typography
                variant="h3"
                component="h1"
                fontWeight="bold"
                color="text.primary"
                sx={{
                    fontSize: headerCompact
                        ? { xs: "1.25rem", sm: "1.5rem", md: "1.9rem" }
                        : { xs: "1.75rem", sm: "2.125rem", md: "3rem" },
                    textAlign: { xs: "center", sm: "left" },
                    transition: "font-size .25s ease",
                }}
            >
                {siteName}
            </Typography>
            <Stack
                direction={{ xs: "row", sm: "row" }}
                spacing={{ xs: 1, sm: 1.5 }}
                alignItems="center"
                width={{ xs: "100%", sm: "auto" }}
                justifyContent={{ xs: "center", sm: "flex-end" }}
                flexWrap="wrap"
                useFlexGap
                sx={{ rowGap: 1.5, py: { xs: 1, sm: 0 } }}
            >
                {actions}
            </Stack>
        </Box>
    );
}
