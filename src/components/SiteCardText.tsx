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
                fontWeight='medium'
                noWrap
                title={name}
                sx={{
                    fontSize: { xs: "0.875rem", sm: "1rem" },
                    transition: "color .2s ease",
                }}
            >
                <Highlighted text={name} query={highlight} />
            </Typography>
            {dead && (
                <Tooltip title='链接可能已失效（点右键 → 复制链接确认）'>
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
    /** 紧凑密度：少显示一行 */
    compact?: boolean;
    /** 开了缩略图：描述区要给它让出空间 */
    withThumb?: boolean;
}

export const SiteCardDescription = memo(function SiteCardDescription({
    description,
    highlight,
    compact = false,
    withThumb = false,
}: SiteCardDescriptionProps) {
    return (
        <Typography
            variant='body2'
            color='text.secondary'
            sx={{
                display: "-webkit-box",
                WebkitLineClamp: compact ? 2 : withThumb ? 2 : 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                flexGrow: 1,
                fontSize: { xs: "0.75rem", sm: "0.875rem" },
            }}
        >
            <Highlighted text={description || "暂无描述"} query={highlight} />
        </Typography>
    );
});
