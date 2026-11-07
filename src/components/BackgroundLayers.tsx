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
                    opacity: hasImage ? 0.35 : 0.55,
                    // 去掉 blur(48px)：原 blur 让这块全屏柔光持续重绘，拖得带
                    // backdrop-filter 的弹窗/卡片/顶栏每帧重新采样而闪烁。去掉后
                    // 径向渐变本就柔和，仅少一点扩散；下面把三处尺寸略放大以补偿。
                    background: darkMode
                        ? "radial-gradient(46% 54% at 18% 22%, rgba(63,94,206,.45) 0%, transparent 72%), radial-gradient(42% 48% at 82% 28%, rgba(126,63,206,.38) 0%, transparent 70%), radial-gradient(48% 56% at 62% 86%, rgba(20,120,140,.34) 0%, transparent 72%)"
                        : "radial-gradient(46% 54% at 18% 22%, rgba(88,140,255,.24) 0%, transparent 72%), radial-gradient(42% 48% at 82% 28%, rgba(196,120,255,.20) 0%, transparent 70%), radial-gradient(48% 56% at 62% 86%, rgba(80,200,220,.18) 0%, transparent 72%)",
                    transition: "opacity .4s ease",
                }}
            />
        </>
    );
}
