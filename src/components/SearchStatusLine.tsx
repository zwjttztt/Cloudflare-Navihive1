// 搜索框下面那几行「现在筛成什么样了」的说明。
//
// 从 App.tsx 搬来的纯搬迁：结果计数、展开更多、语法写错的点名、语义搜索的两句话。
// 它们共同点是**都只在 SortMode.None 下有意义**，且都跟着搜索状态变 —— 放一处之后
// App 里只剩一行 <SearchStatusLine ... />。
//
// 三块的顺序是刻意排的：
//   1. 结果计数（最常用，也最该先看到）
//   2. 语法写错的点名（不点名用户只会以为「没有匹配」，而不是自己打错了）
//   3. 语义搜索提示（没索引就教他建一个，搜不到就说清下面是关键词结果）

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

export interface SearchStatusLineProps {
    /** 有没有在筛（搜索词 / 星标 / 死链 / 标签任一） */
    filtering: boolean;
    matchedCount: number;
    /** 渲染有上限，实际只画了这么多 */
    renderedCount: number;
    searchTruncated: boolean;
    searchExpanded: boolean;
    onExpand: () => void;
    onCollapse: () => void;
    /** 语法写错时的点名文案；没有就传空串 */
    hint: string;
    // ---- 语义搜索那两句话 ----
    semanticEnabled: boolean;
    semanticNote: string;
    /** AI 可用（配置好了） */
    aiReady: boolean;
    /** 已建索引的站点数；0 表示还没建过 */
    embeddedCount: number;
    semanticBusy: boolean;
    onBuildSemanticIndex: () => void;
}

export default function SearchStatusLine({
    filtering,
    matchedCount,
    renderedCount,
    searchTruncated,
    searchExpanded,
    onExpand,
    onCollapse,
    hint,
    semanticEnabled,
    semanticNote,
    aiReady,
    embeddedCount,
    semanticBusy,
    onBuildSemanticIndex,
}: SearchStatusLineProps) {
    return (
        <>
            {/* 结果计数：搜索框在上方标题栏里，这里只保留一行轻提示 */}
            {filtering && (
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        flexWrap: "wrap",
                        mt: -2,
                        mb: 3,
                    }}
                >
                    <Typography
                        variant='caption'
                        color='text.secondary'
                        // 结果数变了要念出来：读屏用户看不到「列表变短了」
                        component='div'
                        role='status'
                        aria-live='polite'
                        aria-atomic='true'
                        sx={{ display: "block" }}
                    >
                        找到 {matchedCount} 个匹配的网站
                        {searchTruncated ? `，先显示前 ${renderedCount} 个` : ""}
                    </Typography>
                    {/* 渲染有上限，但用户有权一次看全：给个明确的出口，
                        而不是让他继续输入去猜该怎么写关键词 */}
                    {searchTruncated && (
                        <Button size='small' onClick={searchExpanded ? onCollapse : onExpand}>
                            {searchExpanded
                                ? "收起结果"
                                : `显示更多（还有 ${matchedCount - renderedCount} 个）`}
                        </Button>
                    )}
                </Box>
            )}

            {/* 语法写错了要说出来：is:deleted 这种条件如果不点名，
                用户只会以为「没有匹配的卡片」，而不是自己打错了 */}
            {hint && (
                <Typography
                    variant='caption'
                    color='warning.main'
                    sx={{ display: "block", mt: -2, mb: 2 }}
                >
                    {hint}
                </Typography>
            )}

            {/* 语义搜索的两句话：没索引就教他建一个，搜不到就说清楚下面的是关键词结果 */}
            {semanticEnabled && (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", mt: -2, mb: 2 }}
                >
                    {semanticNote ? `${semanticNote}。` : null}
                    {aiReady && embeddedCount === 0 ? (
                        <>
                            {" "}
                            语义搜索要先给站点建一次索引。
                            <Button
                                size='small'
                                disabled={semanticBusy}
                                onClick={onBuildSemanticIndex}
                                sx={{ minWidth: 0, px: 0.5, fontSize: 12 }}
                            >
                                {semanticBusy ? "正在生成…" : "现在生成"}
                            </Button>
                        </>
                    ) : null}
                </Typography>
            )}
        </>
    );
}
