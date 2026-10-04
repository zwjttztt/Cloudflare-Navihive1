// src/components/SiteListHeader.tsx
// 顶栏：拆成上下两层。
//   第一层 = 品牌状态行（站名 + 时钟），第二层 = 核心工具行（搜索 / 显示 / 新增 / 更多）。
// 这样站名变长、或者按钮变多时，挤的是各自那一行，不会把搜索框压扁。
// 它不持有任何状态：时钟与工具都作为插槽由 App 透传。
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export interface SiteListHeaderProps {
    /** 站名（settings 里配的 site.name） */
    siteName: string;
    /** 向下滚动后是否进入紧凑模式（改字号与间距） */
    headerCompact: boolean;
    /** 第一层右侧：时钟。窄屏自己隐藏，这里只管位置 */
    clock?: ReactNode;
    /** 第二层：搜索框 + 显示控制 + 新增 + 更多选项，由 App 透传 */
    actions: ReactNode;
}

export default function SiteListHeader({
    siteName,
    headerCompact,
    clock,
    actions,
}: SiteListHeaderProps) {
    return (
        <Box
            component="header"
            className={headerCompact ? "nav-header-compact" : undefined}
            sx={{
                display: "flex",
                flexDirection: "column",
                // 两层之间：常态 12px，收紧 8px
                gap: headerCompact ? 1 : 1.5,
                mb: headerCompact ? 2.5 : 3.5,
                pt: headerCompact ? 0 : 0.5,
                transition: "margin .25s ease",
            }}
        >
            {/* 第一层：站名 + 时钟。站名不再和工具抢同一行的宽度 */}
            <Box
                sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 2,
                    minWidth: 0,
                }}
            >
                <Typography
                    variant="h3"
                    component="h1"
                    noWrap
                    sx={{
                        fontWeight: "bold",
                        color: "text.primary",

                        // 原来最大 3rem：站名一长就把工具行挤到换行，现在收到 32px
                        fontSize: headerCompact
                            ? { xs: "1.25rem", sm: "1.5rem", md: "1.75rem" }
                            : { xs: "1.5rem", sm: "1.75rem", md: "2rem" },

                        textAlign: { xs: "center", sm: "left" },
                        minWidth: 0,
                        transition: "font-size .25s ease"
                    }}>
                    {siteName}
                </Typography>
                {clock}
            </Box>

            {/* 第二层：核心工具行。窄屏上搜索整行独占，其余控件按需隐藏 */}
            <Box
                className="nav-header-tools"
                sx={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    columnGap: { xs: 1, sm: 1.5 },
                    rowGap: 1.25,
                    justifyContent: { xs: "center", sm: "flex-start" },
                }}
            >
                {actions}
            </Box>
        </Box>
    );
}
