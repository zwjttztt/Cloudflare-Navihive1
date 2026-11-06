// 全站「整页级转圈」的唯一实现。
//
// 2026-11-06 用户第二次提同一件事：「两个转圈不一样统一一下」。
// 病根很具体：启动占位（index.html 里的 .bs-spinner）是我们自己画的环，
// 而登录检查态、登录页 chunk 兜底、列表加载态用的是 MUI 的 <CircularProgress> ——
// 那是另一套弧线（弧长还在伸缩），跟启动占位那个环**完全是两种观感**。
// 这两屏一前一后出现，用户看到的是「同一个等待被换了个动画」。
//
// 所以这个组件**不自己定义样式**，只渲染一枚 `<svg class="bs-spinner">` 去复用
// index.html 文档头里那份唯一定义。渲染层没有第二份规格，就没有「两边数值漂开」这回事 ——
// tests/spinnerUnified.test.ts 断言的是「真的只有一份定义」，而不是「两份一样」。
//
// ⚠️⚠️ 为什么是内联 SVG、不是 CSS border 环 —— 别「优化」回去 ⚠️⚠️
// 32.4.0 第一版这里/启动占位画的都是 border 环（border: 3.5px solid + border-top-color）。
// CI 的「首屏体感审计」当场红：回访 FCP 148ms → 504ms、冷启动 1904 → 3084，LCP 几乎没动
// （504 = 504）——「早期那次绘制不再被算作内容」的指纹。
// 禁 JS 的受控实验证明：纯 CSS border 环只产生 first-paint、**没有 FCP**；
// 内联 <svg><circle> 才有 first-contentful-paint。也就是说 Chrome 不把 border 环算作
// 内容绘制，而 SVG 算 —— 而 32.3.0 的 FCP 锚点一直是 MUI CircularProgress 渲染的那个
// 内联 <svg>。所以这里必须保持 SVG：这不是审美选择，是首屏 FCP 的锚点。
// （顺带：stroke-width 是 SVG 用户单位，不再被 subpixel 取整成 3px。）
//
// 几何与 index.html 的占位完全一致（spinnerUnified 逐项钉着）：
//   viewBox 0 0 40 40、r = 18.25、stroke-width = 3.5 → 外径 18.25×2 + 3.5 = 40；
//   弧长 = 周长 2π×18.25 ≈ 114.67 的四分之一 ≈ 28.67（stroke-dasharray）；
//   rotate(-135 20 20) 让那 90° 弧居中在 12 点钟（与原来 border-top 的位置一致）。
//
// 这里只干三件事：把 role=progressbar 告诉读屏、用 data-mode 选色档、渲染同一份标记。
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

/**
 * 环的半径。**唯一**一个必须写在标记里的几何量（SVG 的 `r` 属性没有 CSS 等价物）。
 * 描边宽度、弧长、动画都在 index.html 的 CSS 里 —— 别在这里补，
 * 补一条就是第二份规格（守卫会红）。
 * 不变量：外径 = `RADIUS * 2 + 3.5`（stroke-width）= 40，由
 * tests/spinnerUnified.test.ts 从 CSS 侧取值后与这个字面量比对。
 */
const RADIUS = 18.25;

export interface SpinnerProps {
    /**
     * 追加类名。只做叠加，**不改默认尺寸** —— 整页级转圈必须始终是 40px，
     * 它要和 index.html 的启动占位接得上（两屏之间不能有大小跳变）。
     */
    className?: string;
    /**
     * 少数场景要补个外边距 / 位置时的逃生口。
     * ⚠️ 别用 sx 改尺寸、描边或颜色：那正是「两个转圈又不一样」的入口。
     */
    sx?: SxProps<Theme>;
}

/**
 * 40px / 0.9s 匀速的 SVG 圆环，规格就是 index.html 文档头的 `.bs-spinner`。
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
            component='svg'
            role='progressbar'
            data-mode={theme.palette.mode}
            className={className ? `${SPINNER_CLASS} ${className}` : SPINNER_CLASS}
            viewBox='0 0 40 40'
            width={40}
            height={40}
            sx={sx}
        >
            <circle className='bs-spinner-track' cx={20} cy={20} r={RADIUS} />
            <g transform='rotate(-135 20 20)'>
                <circle className='bs-spinner-arc' cx={20} cy={20} r={RADIUS} />
            </g>
        </Box>
    );
}
