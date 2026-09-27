// src/components/SiteListEmptyState.tsx
// 站点列表为空时的占位面板：分「没建分组」与「搜索没命中」两态，按钮给出路。
// 抽出来的目的是让 App.tsx 主 JSX 段瘦下来；这里没逻辑，纯渲染。
import { Box, Button, Stack, Typography } from "@mui/material";
import EmptyArt from "./EmptyArt";

interface SiteListEmptyStateProps {
    /** 当前搜索关键词。空 = 没建分组，非空 = 搜不到东西 */
    query: string;
    /** 当前标签筛选是否激活 */
    hasTagFilter: boolean;
    /** 星标筛选是否激活 */
    starFilter: boolean;
    /** 仅显示失效链接筛选是否激活 */
    deadOnly: boolean;
    /** 清空搜索框 */
    onClearSearch: () => void;
    /** 清除所有筛选（标签/星标/失效） */
    onClearFilters: () => void;
}

export default function SiteListEmptyState({
    query,
    hasTagFilter,
    starFilter,
    deadOnly,
    onClearSearch,
    onClearFilters,
}: SiteListEmptyStateProps) {
    const hasFilter = starFilter || deadOnly || hasTagFilter;
    return (
        <Box
            sx={{
                py: 8,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1.5,
                textAlign: "center",
                borderRadius: "18px",
                border: "1.5px dashed",
                borderColor: "divider",
            }}
        >
            <EmptyArt variant={query ? "search" : "empty"} size={132} />
            <Typography variant='subtitle1' fontWeight='600'>
                {query ? "没有找到匹配的网站" : "还没有任何分组"}
            </Typography>
            <Typography variant='body2' color='text.secondary'>
                {query
                    ? "换个关键词试试，或清空搜索框查看全部网站"
                    : "点击左上角「新增分组」开始搭建你的导航页"}
            </Typography>
            {/* 空状态也要有出路：能搜就给「清空搜索」，筛没了就给「清除筛选」 */}
            <Stack direction='row' spacing={1} sx={{ mt: 1 }}>
                {query && (
                    <Button
                        variant='outlined'
                        size='small'
                        onClick={onClearSearch}
                        className='nav-empty-clear-search'
                    >
                        清空搜索
                    </Button>
                )}
                {hasFilter && (
                    <Button
                        variant='outlined'
                        size='small'
                        onClick={onClearFilters}
                        className='nav-empty-clear-filter'
                    >
                        清除筛选
                    </Button>
                )}
            </Stack>
        </Box>
    );
}