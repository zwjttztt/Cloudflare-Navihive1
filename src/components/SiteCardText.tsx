// 卡片里的文字部分：标题（含失效徽标）与描述。
//
// 从 SiteCard.tsx 搬来的纯搬迁。抽出来的理由和 SiteCardAvatar 一样：卡片 1000 多行
// 里，这三块是「纯展示」—— 不碰任何事件与状态，只看数据与两个显示开关。
// 单独放之后，「搜索命中会高亮」「失效会打个红点」「描述最多显示几行」这些规则
// 各自有了落脚点。
//
// 两个都是具名 memo：卡片会渲染 N 次，props 又全是基本类型，父组件重渲染时
// 它们不会白跑一遍。

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { memo } from "react";
import Highlighted from "./Highlighted";

export interface SiteCardTitleProps {
    name: string;
    /** 搜索词：命中部分要高亮 */
    highlight?: string;
    /** 失效链接：标题后面挂一个红点 */
    dead?: boolean;
    /** 墙视图用更小的字号 */
    compactTitle?: boolean;
}

export const SiteCardTitle = memo(function SiteCardTitle({
    name,
    highlight,
    dead = false,
    compactTitle = false,
}: SiteCardTitleProps) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                minWidth: 0,
                flexShrink: 1,
            }}
        >
            <Typography
                className='nav-card-title'
                variant={compactTitle ? "caption" : "subtitle1"}
                noWrap
                title={name}
                sx={{
                    fontWeight: 'medium',
                    // rem 只认根字号，不吃 .nav-root 上那条 font-size: 94% / 107%，
                    // 所以这里显式乘上字号档位变量（与笔记页的 --notes-font-scale 同一档值）。
                    // 兜底 1：卡片被单独渲染（单测 / 脱离 .nav-root 的场景）时不至于算成 0。
                    fontSize: {
                        xs: "calc(0.875rem * var(--font-scale, 1))",
                        sm: "calc(1rem * var(--font-scale, 1))",
                    },
                    transition: "color .2s ease"
                }}>
                <Highlighted text={name} query={highlight} />
            </Typography>
            {dead && (
                // 说清「两次」很重要：用户看到自己天天用的站被标灰，第一反应是这个功能不准。
                // 告诉他判定依据、以及怎么纠偏（右键里那条「标记为可访问」）。
                <Tooltip title='连续两次检测都没连上，可能已失效；右键卡片可「标记为可访问」'>
                    <Box className='nav-dead-dot' aria-label='链接可能已失效'>
                        失效
                    </Box>
                </Tooltip>
            )}
        </Box>
    );
});

export interface SiteCardDescriptionProps {
    description?: string;
    highlight?: string;
    /** 紧凑密度：描述只给一行 */
    compact?: boolean;
}

export const SiteCardDescription = memo(function SiteCardDescription({
    description,
    highlight,
    compact = false,
}: SiteCardDescriptionProps) {
    return (
        <Typography
            variant='body2'
            sx={{
                color: 'text.secondary',
                display: "-webkit-box",
                // 两行而不是三行（P1-3，2026-10-26）：三行在 25% 列宽下经常只装得下「半行中文」，
                // 视觉上就是被切了一刀；一句描述的信息量两行足够，卡片也因此统一矮一档 ——
                // 「1 张卡」和「8 张卡」两种分组的密度才落在同一个档里。
                // 紧凑档按 densityMetrics 里的定义（单行）压成一行。
                WebkitLineClamp: compact ? 1 : 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                // 下面两条才是「省略号」的保障：line-clamp 只在**行末**补省略号，
                // 它管不住行内放不下的长串 —— 中文没有空格、URL 更是连成一坨，
                // 不显式允许断词就会横向溢出，再被卡片外壳的 overflow:hidden 硬切在边上
                // （这就是「到边就断、没有省略号」的来源）。
                textOverflow: "ellipsis",
                wordBreak: "break-word",
                // 撑满剩下的高度：同一行的卡片才会等高，卡片底边齐平
                flexGrow: 1,
                fontSize: { xs: "0.75rem", sm: "0.875rem" }
            }}>
            <Highlighted text={description || "暂无描述"} query={highlight} />
        </Typography>
    );
});
