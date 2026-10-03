// 卡片左上角那块图标：有图标就贴图，取不到就用站点名首字母顶上。
//
// 从 SiteCard.tsx（1093 行）搬来的纯搬迁。之所以单独成一个组件：它是卡片里
// 唯一一处「两个分支形状完全不同」的渲染（图片那一支还挂着骨架屏与淡入），
// 内联在 1093 行的卡片里很难一眼看出「取不到图标会长什么样」。
//
// ⚠️ 卡片是列表项，会渲染 N 次 —— 所以这里用**具名的 memo**（不是 React.memo），
// 且 props 全是基本类型 / 稳定回调，父组件重渲染时它不会跟着白跑一遍。

import Box from "@mui/material/Box";
import Fade from "@mui/material/Fade";
import Skeleton from "@mui/material/Skeleton";
import { alpha } from "@mui/material/styles";
import { memo } from "react";

export interface SiteCardAvatarProps {
    /** 当前选中的图标地址（自带图标 → 图标 API → favicon → 公共服务的胜者） */
    icon?: string;
    /** 图标加载失败过：走首字母块 */
    iconError: boolean;
    /** 图标已加载完（未加载完先盖一层骨架屏） */
    imageLoaded: boolean;
    /** 图标来自本地 blob 缓存时的 objectURL（优先于 icon） */
    iconObjectUrl?: string | null;
    onIconError: () => void;
    onImageLoad: () => void;
    /** 图片 alt，也是首字母的取值来源 */
    siteName: string;
    /** 首字母块用的首字母（父组件算好，避免这里再做一次 charAt） */
    fallbackChar: string;
    tone: { soft: string; strong: string };
    isDark: boolean;
    /** 外边距（不同密度下卡片给图标留的位置不一样） */
    mr?: number | string;
    size?: number;
}

const SiteCardAvatar = memo(function SiteCardAvatar({
    icon,
    iconError,
    imageLoaded,
    iconObjectUrl,
    onIconError,
    onImageLoad,
    siteName,
    fallbackChar,
    tone,
    isDark,
    mr = 1.5,
    size = 36,
}: SiteCardAvatarProps) {
    if (!iconError && icon) {
        return (
            <Box
                className='nav-card-icon'
                position='relative'
                mr={mr}
                width={size}
                height={size}
                flexShrink={0}
                sx={{
                    // 统一底板：浅色 logo 有边框托底不至于「消失」，深色 logo 也不会糊在一起
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "11px",
                    bgcolor: isDark ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.94)",
                    border: "1px solid",
                    borderColor: isDark ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.09)",
                    boxShadow: isDark ? "none" : "0 1px 3px rgba(15,23,42,0.08)",
                    transition: "transform .22s cubic-bezier(.22,.61,.36,1)",
                }}
            >
                <Skeleton
                    variant='rounded'
                    width={size - 12}
                    height={size - 12}
                    sx={{
                        display: !imageLoaded ? "block" : "none",
                        position: "absolute",
                        inset: 0,
                        margin: "auto",
                    }}
                />
                <Fade in={imageLoaded} timeout={400}>
                    <Box
                        component='img'
                        src={iconObjectUrl || icon}
                        alt={siteName}
                        loading='lazy'
                        decoding='async'
                        sx={{
                            width: size - 12,
                            height: size - 12,
                            borderRadius: "6px",
                            objectFit: "contain",
                        }}
                        onError={onIconError}
                        onLoad={onImageLoad}
                    />
                </Fade>
            </Box>
        );
    }

    return (
        <Box
            className='nav-card-icon'
            sx={{
                width: size,
                height: size,
                mr: mr,
                borderRadius: 1.5,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                fontSize: size > 40 ? 20 : 15,
                // 图标取不到时用站点名首字母顶上，底色做成同色系渐变，比纯色块耐看
                background: `linear-gradient(135deg, ${alpha(
                    isDark ? tone.soft : tone.strong,
                    isDark ? 0.34 : 0.2
                )} 0%, ${alpha(isDark ? tone.strong : tone.soft, isDark ? 0.16 : 0.08)} 100%)`,
                color: isDark ? tone.soft : tone.strong,
                border: "1px solid",
                borderColor: alpha(isDark ? tone.soft : tone.strong, isDark ? 0.3 : 0.22),
                transition: "transform .22s cubic-bezier(.22,.61,.36,1)",
            }}
        >
            {fallbackChar}
        </Box>
    );
});

export default SiteCardAvatar;
