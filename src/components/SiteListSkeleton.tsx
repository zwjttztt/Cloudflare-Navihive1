// src/components/SiteListSkeleton.tsx
// 首屏加载时的骨架屏：两组「分组标题 + 一行卡片占位」，给用户结构感的等待信号。
// 抽出来的目的是让 App.tsx 主 JSX 段瘦下来；这里没逻辑、纯渲染。
import { Box, Skeleton, Stack } from "@mui/material";

/**
 * 骨架屏：两组（每组 1 个标题 + 5 张卡片占位）。
 * 桌面/平板/大屏卡片宽度不同（50% / 33% / 25% / 20%），跟真实布局对齐，避免闪烁。
 */
export default function SiteListSkeleton() {
    return (
        <Stack spacing={5}>
            {[0, 1].map(section => (
                <Box key={section}>
                    <Skeleton
                        variant='rounded'
                        width={180}
                        height={32}
                        sx={{ mb: 2.5 }}
                    />
                    <Box sx={{ display: "flex", flexWrap: "wrap", margin: -1 }}>
                        {[0, 1, 2, 3, 4].map(i => (
                            <Box
                                key={i}
                                sx={{
                                    width: {
                                        xs: "50%",
                                        sm: "33.33%",
                                        md: "25%",
                                        lg: "25%",
                                        xl: "20%",
                                    },
                                    padding: 1,
                                    boxSizing: "border-box",
                                }}
                            >
                                <Skeleton variant='rounded' height={104} />
                            </Box>
                        ))}
                    </Box>
                </Box>
            ))}
        </Stack>
    );
}