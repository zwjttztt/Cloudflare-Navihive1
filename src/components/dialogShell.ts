// src/components/dialogShell.ts
// 弹窗外壳：站内所有对话框共用同一套「标题 / 正文 / 底部操作」三区尺寸与材质。
// 之前每个弹窗各写一份 paper 样式，圆角、内边距、背景浓度逐个漂移，
// 同一个「确定」按钮在不同弹窗里高度都不一样。这里收成一份，新弹窗直接套。
import type { SxProps, Theme } from "@mui/material";

/**
 * 纸面材质 token：弹窗外观的**唯一真源**。
 *
 * 之前这里用的是 `--radius-lg / --border-subtle / --shadow-3 / --blur-md`，
 * 而参考样式（网站设置弹窗的 settingsPaper）用的是 `--card-radius /
 * --glass-panel-border / --glass-shadow-hover / --glass-blur`。两套名字今天
 * 恰好是别名、取值相同，但只要哪天有人只改其中一套，弹窗就会分裂成两种材质。
 * 现在统一取「玻璃面板」这一套（语义 token 那一层），两边都从这里拼。
 *
 * ⚠️ 小屏「底部面板」的行为（贴底 / 全宽 / 92dvh）不在这里，在 index.css 的
 * `@media (max-width: 599.95px)` 段：那段是全局 CSS，能覆盖全部 32 个弹窗，
 * 放进 sx 就只有用外壳的这十来个生效。
 */
export const dialogPaperTokens = {
    borderRadius: "var(--card-radius)",
    backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
    WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
    border: "1px solid var(--glass-panel-border)",
    boxShadow: "var(--glass-shadow-hover)",
    // 毛玻璃面板本身是半透明的，铺一层高不透明度底色保证文字对比度
    backgroundColor: "var(--surface-modal)",
};

/** 弹窗纸面：圆角、材质、边框、阴影统一走设计 tokens */
export const dialogPaperSx: SxProps<Theme> = {
    ...dialogPaperTokens,
    p: 0.5,
};

/**
 * 命令面板（Ctrl/⌘ K）专用纸面：比普通弹窗更「轻」—— 浮在页面上方一点，
 * 不贴底、不铺满，读完即走。
 *
 * 两个命令面板（全站 / 记事本）各抄了一份一模一样的 sx，改一处忘一处就会漂移，
 * 收在这里共用。
 */
export const commandPalettePaperSx: SxProps<Theme> = {
    borderRadius: "18px",
    overflow: "hidden",
    bgcolor: "var(--glass-bg-hover)",
    border: "1px solid var(--glass-border)",
    backdropFilter: "blur(18px) saturate(1.5)",
    WebkitBackdropFilter: "blur(18px) saturate(1.5)",
    mt: "8vh",
    alignSelf: "flex-start",
};

/** 标题区：17px / 600，右侧留出关闭按钮的位置。
 *  必须是 flex：标题旁边带关闭按钮的弹窗靠 flexGrow 占位把按钮推到右边，
 *  没有 flex 的话那个占位 Box 会自己占一行，按钮掉到标题下面去。 */
export const dialogTitleSx: SxProps<Theme> = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    py: 1.75,
    pr: 5,
    fontSize: 17,
    fontWeight: 600,
};

/** 正文区：标题贴着排，底部收一点，给操作区让位 */
export const dialogContentSx: SxProps<Theme> = {
    pt: 0,
    pb: 1.5,
    // 帮助文字里常带长 URL / 长 token（占位符示例之类），默认只在空白处换行，
    // 窄屏下会整段伸出输入框——375 视口实测溢出 16px。
    // 统一在这里断词，所有用公共外壳的弹窗都受益（docs/dialogs-audit-2026-10-16.md P2-1）。
    "& .MuiFormHelperText-root": {
        overflowWrap: "anywhere",
        wordBreak: "break-word",
    },
};

/** 底部操作区：按钮右对齐，间距统一 */
export const dialogActionsSx: SxProps<Theme> = {
    px: 2,
    pb: 2,
    pt: 0.5,
    gap: 1,
};
