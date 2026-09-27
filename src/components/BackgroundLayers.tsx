// src/components/BackgroundLayers.tsx
// 背景装饰层：壁纸（固定铺满 + 蒙版压暗）与缓慢漂移的柔光光晕。
// 原来内联在 App.tsx 里 44 行。纯装饰、不拦截点击，只依赖 4 个值。
import { Box } from "@mui/material";

/** 预设壁纸存的是 CSS 渐变，可以直接当 background-image；普通图片才包 url() */
const isCssGradient = (value: string) =>
    /^\s*(linear|radial|conic)-gradient\(/i.test(value);

export interface BackgroundLayersProps {
    /** 背景图片 URL，空字符串表示不使用 */
    imageUrl: string;
    /** 蒙版透明度 0~1（值越大压得越暗） */
    maskOpacity: number;
    darkMode: boolean;
}

export default function BackgroundLayers({
    imageUrl,
    maskOpacity,
    darkMode,
}: BackgroundLayersProps) {
    const hasImage = imageUrl.length > 0;

    return (
        <>
            {/* 背景图片层：固定铺满视口，用蒙版压暗以保证内容可读 */}
            {hasImage && (
                <Box
                    aria-hidden
                    sx={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 0,
                        pointerEvents: "none",
                        backgroundImage: isCssGradient(imageUrl)
                            ? imageUrl
                            : `url("${imageUrl.replace(/"/g, '\\"')}")`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        backgroundRepeat: "no-repeat",
                        "&::after": {
                            content: '""',
                            position: "absolute",
                            inset: 0,
                            bgcolor: "background.default",
                            opacity: maskOpacity,
                        },
                    }}
                />
            )}

            {/* 动态背景：缓慢漂移的柔光光晕，纯装饰、不拦截点击 */}
            <Box
                aria-hidden
                className='nav-aurora'
                sx={{
                    position: "fixed",
                    inset: "-12%",
                    zIndex: 0,
                    pointerEvents: "none",
                    filter: "blur(48px)",
                    opacity: hasImage ? 0.35 : 0.55,
                    background: darkMode
                        ? "radial-gradient(38% 44% at 18% 22%, rgba(63,94,206,.45) 0%, transparent 62%), radial-gradient(34% 40% at 82% 28%, rgba(126,63,206,.38) 0%, transparent 60%), radial-gradient(40% 46% at 62% 86%, rgba(20,120,140,.34) 0%, transparent 62%)"
                        : "radial-gradient(38% 44% at 18% 22%, rgba(88,140,255,.24) 0%, transparent 62%), radial-gradient(34% 40% at 82% 28%, rgba(196,120,255,.20) 0%, transparent 60%), radial-gradient(40% 46% at 62% 86%, rgba(80,200,220,.18) 0%, transparent 62%)",
                    transition: "opacity .4s ease",
                }}
            />
        </>
    );
}
