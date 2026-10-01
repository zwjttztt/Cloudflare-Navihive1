// src/components/dialogShell.ts
// 弹窗外壳：站内所有对话框共用同一套「标题 / 正文 / 底部操作」三区尺寸与材质。
// 之前每个弹窗各写一份 paper 样式，圆角、内边距、背景浓度逐个漂移，
// 同一个「确定」按钮在不同弹窗里高度都不一样。这里收成一份，新弹窗直接套。
import type { SxProps, Theme } from "@mui/material";

/** 弹窗纸面：圆角、材质、边框、阴影统一走设计 tokens */
export const dialogPaperSx: SxProps<Theme> = {
    borderRadius: "var(--radius-lg)",
    p: 0.5,
    backdropFilter: "blur(var(--blur-md)) saturate(1.4)",
    WebkitBackdropFilter: "blur(var(--blur-md)) saturate(1.4)",
    border: "1px solid var(--border-subtle)",
    boxShadow: "var(--shadow-3)",
    // 毛玻璃面板本身是半透明的，铺一层高不透明度底色保证文字对比度
    backgroundColor: theme =>
        theme.palette.mode === "dark" ? "rgba(23,27,38,0.94)" : "rgba(255,255,255,0.94)",
};

/** 标题区：17px / 600，右侧留出关闭按钮的位置 */
export const dialogTitleSx: SxProps<Theme> = {
    py: 1.75,
    pr: 5,
    fontSize: 17,
    fontWeight: 600,
};

/** 正文区：标题贴着排，底部收一点，给操作区让位 */
export const dialogContentSx: SxProps<Theme> = {
    pt: 0,
    pb: 1.5,
};

/** 底部操作区：按钮右对齐，间距统一 */
export const dialogActionsSx: SxProps<Theme> = {
    px: 2,
    pb: 2,
    pt: 0.5,
    gap: 1,
};
