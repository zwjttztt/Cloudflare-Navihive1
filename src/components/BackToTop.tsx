// src/components/BackToTop.tsx
// 回到顶部：页面滚过一屏后右下角浮出，点一下平滑滚回顶部。
// 位置避开底部多选操作条和移动端底栏，所以小屏要抬得更高一点。
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
            // 滚过一屏再出现，短页面就别来打扰
            setVisible(y > window.innerHeight * 0.9);
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

    if (!visible) return null;

    return (
        <Tooltip title='回到顶部' placement='left'>
            <Fab
                size='small'
                aria-label='回到顶部'
                className='nav-back-to-top'
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                sx={{
                    position: "fixed",
                    right: { xs: 12, md: 22 },
                    bottom: { xs: 76, md: 24 },
                    zIndex: t => t.zIndex.appBar + 1,
                    bgcolor: "var(--glass-bg-hover)",
                    color: "text.primary",
                    border: "1px solid var(--glass-border)",
                    backdropFilter: "blur(14px) saturate(1.5)",
                    WebkitBackdropFilter: "blur(14px) saturate(1.5)",
                    boxShadow: "var(--glass-shadow-hover)",
                    "&:hover": {
                        bgcolor: "var(--glass-bg-hover)",
                        transform: "translateY(-2px)",
                    },
                }}
            >
                <KeyboardArrowUpIcon />
            </Fab>
        </Tooltip>
    );
}
