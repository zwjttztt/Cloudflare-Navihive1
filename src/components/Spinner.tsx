// 全站「整页级转圈」的唯一实现。
//
// 2026-11-06 用户第二次提同一件事：「两个转圈不一样统一一下」。
// 病根很具体：启动占位（index.html 里的 .bs-spinner）是我们自己画的 border 环
// （40px / 3.5px / 0.9s 匀速），而登录检查态、登录页 chunk 兜底、列表加载态用的是
// MUI 的 <CircularProgress> —— 那是 SVG 弧线，转的同时弧长还在伸缩，跟上面那个环
// **完全是两种观感**。这两屏一前一后出现，用户看到的是「同一个等待被换了个动画」。
//
// 所以这个组件**不自己定义样式**，只渲染一枚 `<span class="bs-spinner">` 去复用
// index.html 文档头里那份唯一定义（40px / 3.5px / 22% / 0.9s 匀速，见那边
// `.bs-spinner` 段的注释）。渲染层没有第二份规格，就没有「两边数值漂开」这回事 ——
// tests/spinnerUnified.test.ts 断言的是「真的只有一份定义」，而不是「两份一样」。
//
// 这里只干两件事：
//   ① 用 role=progressbar 告诉读屏「在等」；
//   ② 用 data-mode 告诉 CSS「当前是亮档还是暗档」
//      （暗色档在 index.html 的 `.bs-spinner[data-mode="dark"]` 里，只改 --bs-brand）。
//
// ⚠️ 颜色**故意不吃 primary.main**（虽然那是最省事的写法）：
// primary 会被用户在「外观 → 强调色」里挑的颜色覆盖
// （hooks/useThemeController.ts 的 `primary: { main: accent }`），
// 而 index.html 那枚环不可能知道用户挑了什么颜色 —— 强调色存在 configs 表里、
// 不在 localStorage，启动占位读不到。
// 一旦这里跟着 primary 走，用户换个主色，两边**又会不一样** —— 正是这次要治的病。
// 所以两档色值写死在 index.html 的 CSS 里：亮色 #1976d2（--bs-brand 的兜底值）/
// 暗色 #90caf9（data-mode="dark" 覆盖），与启动占位那两档同值。
//
// 无障碍：只给 role=progressbar，**不自带 aria-label** ——
// 调用方外层已经有 role=status + aria-label（「正在加载站点」之类），
// 两个可访问名会被读屏连念两遍。MUI 那颗本来也是无名的，所以不算退化。
import Box from "@mui/material/Box";
import { useTheme, type SxProps, type Theme } from "@mui/material/styles";

/** 转圈的那个类名。全站（含 index.html 的启动占位）只有这一处定义它。 */
const SPINNER_CLASS = "bs-spinner";

export interface SpinnerProps {
    /**
     * 追加类名。只做叠加，**不改默认尺寸** —— 整页级转圈必须始终是 40px，
     * 它要和 index.html 的启动占位接得上（两屏之间不能有大小跳变）。
     */
    className?: string;
    /**
     * 少数场景要补个外边距 / 位置时的逃生口。
     * ⚠️ 别用 sx 改尺寸、边框或颜色：那正是「两个转圈又不一样」的入口。
     */
    sx?: SxProps<Theme>;
}

/**
 * 40px / 0.9s 匀速的 border 环，规格就是 index.html 文档头的 `.bs-spinner`。
 *
 * @example
 * // 整页加载态（外层容器自己负责居中与底色）
 * <Box role='status' aria-label='正在加载站点'><Spinner /></Box>
 */
export default function Spinner({ className, sx }: SpinnerProps) {
    // 取 theme.palette.mode 而不是等 html.dark：
    // useDocumentEffects 是用 useEffect 往 <html> 上挂 .dark 的（commit 之后才跑），
    // 挂载首帧读到的是「没有 .dark」，暗色下会先闪一帧亮蓝再变浅蓝 ——
    // 而这次改动要消灭的恰恰就是这种闪。theme.mode 在首帧就是对的。
    const theme = useTheme();
    return (
        <Box
            component='span'
            role='progressbar'
            data-mode={theme.palette.mode}
            className={className ? `${SPINNER_CLASS} ${className}` : SPINNER_CLASS}
            sx={sx}
        />
    );
}
