// src/components/BackToTop.tsx
// 回到顶部：页面滚过小半屏后右下角浮出，点一下平滑滚回顶部。
// 圆形 + 纯图标（向上箭头）、不带文字，底色/边框/投影跟左上角那批毛玻璃胶囊同源，
// 模糊强度跟着用户在设置里拖的滑块走。位置避开底部多选操作条和移动端底栏，小屏抬得更高。
import { useEffect, useState } from "react";
import { Fab, Tooltip } from "@mui/material";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";

export default function BackToTop() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const onScroll = () => {
            // 文档滚动条可能挂在 body 上，两个都读一遍取最大值
            const y = Math.max(
                window.scrollY || 0,
                document.documentElement.scrollTop || 0
            );
            // 滚过小半屏就出现：以前要滚满 0.9 屏才露面，分组不多的页面几乎等不到它
            setVisible(y > window.innerHeight * 0.35);
        };
        // 滚动条也可能挂在某个内部容器上（页面布局换过几种），两个都听一遍
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        document.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
            document.removeEventListener("scroll", onScroll);
        };
    }, []);

    return (
        <Tooltip title='回到顶部' placement='left'>
            {/* 一直渲染、用透明度控制显隐：
                带 backdrop-filter 的元素别用 animation + fill-mode:both 做入场
                （fill 会让它一直挂在独立合成层上，圆角边缘容易渗出暗边，还会压住 hover 的 transform）。 */}
            <Fab
                size='small'
                aria-label='回到顶部'
                className='nav-back-to-top'
                tabIndex={visible ? 0 : -1}
                aria-hidden={!visible}
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                sx={{
                    position: "fixed",
                    right: { xs: 12, md: 22 },
                    bottom: { xs: 76, md: 24 },
                    zIndex: t => t.zIndex.appBar + 1,
                    // 与左上角胶囊同一套变量，theme 切换 / 强度滑块都会同步过来
                    bgcolor: "var(--glass-bg)",
                    color: "text.primary",
                    border: "1px solid var(--glass-border)",
                    backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                    WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                    boxShadow: "var(--glass-shadow)",
                    opacity: visible ? 1 : 0,
                    transform: visible ? "scale(1)" : "scale(.82)",
                    pointerEvents: visible ? "auto" : "none",
                    // 只过渡这几个属性：不能写 transition: all（会把 backdrop-filter 拉进补间，
                    // 浏览器就得逐帧重采样背后的画面，圆角边缘会透出一圈暗边）
                    transition:
                        "opacity .22s ease, transform .22s ease, background-color .2s ease, box-shadow .2s ease",
                    "&:hover": {
                        bgcolor: "var(--glass-bg-hover)",
                        boxShadow: "var(--glass-shadow-hover)",
                    },
                }}
            >
                <KeyboardArrowUpIcon />
            </Fab>
        </Tooltip>
    );
}
