// src/theme/mediaQueries.ts
// 视口断点的**唯一真源**。
//
// 为什么需要这个文件：全站曾经有 5 个不同的小数尾巴在跑 —— 359.98 / 599.95 /
// 599.98 / 899.95 / 899.98。它们看起来是「随手写的数字」，其实是**两套语义完全
// 不同的约定**混在一起，一律统一成某一个值会改变行为：
//
//   · `.95` 尾巴 = 对齐 MUI `theme.breakpoints.down()` 的边界。
//     MUI 把 `down('sm')` 编译成 `(max-width: 599.95px)`（600 − 0.05），
//     `down('md')` 编译成 `(max-width: 899.95px)`（900 − 0.05）。
//     自己手写的媒体查询必须**逐位相等**地写 599.95，才能和
//     `useMediaQuery(theme.breakpoints.down("sm"))` 落在同一条线上；
//     写成 599.98 会让 599.96~599.98 这 0.02px 的带子里「CSS 认为是大屏、
//     MUI 认为是小屏」，两者打架。
//
//   · `.98` 尾巴 = 手写档位，目的是「吃掉亚像素宽度」。
//     真实设备上报的视口宽可能是 899.5（1920 屏放大的 Zoom 档），
//     `(max-width: 899px)` 会漏掉它，`.98` 能吃进去（见 MobileTabBar 里的原话）。
//     站内「小屏」这个概念一律用这一档：底栏 → 顶栏入口 → 弹窗高度，
//     三处必须在同一条线上，否则会出现「底栏已经出来了、弹窗还按大屏算高度」。
//
// 所以：**不要**把这里的值再往一处改。要动就动这个文件，并且同一批把
// `src/index.css` 里对应的字面量一起改 —— `tests/mediaBreakpoints.test.ts` 会
// 拦住「CSS 里冒出一个不在本文件里的新数字」。
//
// ⚠️ CSS 读不到 TS 常量，`src/index.css` 里只能写字面量。守卫测试会把两边的
// 数字逐一对齐，所以改这里必须同步改 CSS（以及 `script/ci-smoke.mjs` 里的
// matchMedia 字面量）。

/**
 * 窄屏 / 手机：`max-width: 599.95px`，即 **< 600px**。
 *
 * 语义：对齐 MUI `theme.breakpoints.down("sm")` 生成的边界（600 − 0.05），
 * 与 `useMediaQuery(theme.breakpoints.down("sm"))` 完全等价。
 *
 * 用途：
 * - `src/index.css` 的小屏段：弹窗走底部面板 / 92dvh / safe-area 让位；
 * - `SettingsWorkspaceDialog` 的 `fullScreen`（面板里全是长表单，底部抽屉会被
 *   软键盘反复挤压）；
 * - `NoteGraphDialog` / `ShortcutsDialog` 的 `useMediaQuery`。
 */
export const QUERY_BELOW_600 = "(max-width: 599.95px)";

/**
 * 小屏 / 手机横竖屏通用：`max-width: 899.98px`，即 **< 900px**。
 *
 * 语义：手写档位，`.98` 是为了吃掉 899.5 这类亚像素视口宽（见文件头）。
 * 与 MUI `down("md")`（899.95）**故意**差 0.03px —— 只要站内所有「小屏」判断
 * 都用同一个手写值就自洽：底栏出现 ⇔ 顶栏入口隐藏 ⇔ 弹窗按矮屏算高度。
 *
 * 用途：
 * - `MobileTabBar` 的 `TABBAR_SHOW_QUERY`（底栏出现）；
 * - `HeaderGroupsButton` 的区间下界（与底栏互补）；
 * - `src/index.css` 的「横屏矮屏」弹窗高度段（上界）。
 */
export const QUERY_BELOW_900 = "(max-width: 899.98px)";

/**
 * 超窄屏：`max-width: 359.98px`，即 **< 360px**。
 *
 * 语义：手写档位，**没有**对应的 MUI 断点（MUI 最小档 xs 是 0）。
 * `.98` 同样是为了吃掉 359.5 这类亚像素宽度。
 *
 * 用途：`src/index.css` 里再收一层内边距（iPhone SE / 320~359px 一类），
 * 让弹窗正文与批量操作条不顶到屏幕边上。
 */
export const QUERY_BELOW_360 = "(max-width: 359.98px)";

/**
 * 宽屏：`min-width: 900px`，即 **≥ 900px**。
 *
 * 语义：MUI `theme.breakpoints.up("md")` 的等价手写形式（MUI 生成的是
 * `@media (min-width:900px)`，无小数尾巴）。与 `QUERY_BELOW_900` 互补，
 * 两者只在 899.99px 这一个点上都为假 —— 那是刻意的，宁可有 0.01px 的空档，
 * 也不要两套样式同时生效。
 *
 * 用途：`HeaderGroupsButton` 的区间下界；`HeaderActions` / `DisplayControls`
 * 里「窄屏隐藏」的说明文案（代码本身用 MUI 的 `md`，值与此相同）。
 */
export const QUERY_AT_LEAST_900 = "(min-width: 900px)";

/**
 * 窄桌面：**900 ~ 1343.98px**。
 *
 * 语义：一段区间，两端的来历不一样 ——
 * - 下界 900 与 `QUERY_BELOW_900` 互补（底栏在这之上退场）；
 * - 上界 1343.98 与 `QUERY_GROUP_RAIL_MIN`（1344）互补
 *   （左栏分组栏在那之下不出现），`.98` 同样是手写吃亚像素的约定。
 *
 * 这一段宽度很尴尬：左侧分组栏还没出现、底部导航栏已经退场，若不补一个入口，
 * 用户想跳分组只能一路滚（`docs/` 里记过这次回归）。
 *
 * 用途：`HeaderGroupsButton` 的显示条件；`script/ci-smoke.mjs` 里的同名 matchMedia。
 */
export const QUERY_COMPACT_DESKTOP = "(min-width: 900px) and (max-width: 1343.98px)";

/**
 * 左侧分组栏出现的宽度：`min-width: 1344px`，即 **≥ 1344px**。
 *
 * ⚠️ 1344 不是一个手挑的数字，它是 `GroupNavRail.tsx` 里按栏宽常量算出来的
 * （`RAIL_CONTENT_MAX_WIDTH + 2 * (RAIL_COLLAPSED_EDGE + RAIL_GUTTER)`）：
 * 内容最宽 148 + 两侧收起边距/间隙 —— 窄于这个宽度，栏里连收起态的圆点列都放不下。
 * 这里把它固化成字符串，是为了让 `QUERY_COMPACT_DESKTOP` 的上界有可对照的出处；
 * 那边改常量导致 1344 变化时，`tests/mediaBreakpoints.test.ts` 里的互补断言会红。
 *
 * 用途：与 `QUERY_COMPACT_DESKTOP` 互补；`script/ci-smoke.mjs` 的诊断字段 `qRail`。
 */
export const QUERY_GROUP_RAIL_MIN = "(min-width: 1344px)";

/**
 * 横屏矮屏：**高度 < 481px 且宽 < 900px**。
 *
 * 语义：宽的那一半必须与 `QUERY_BELOW_900` 逐位相等 —— 「横屏矮屏」和
 * 「底栏出现」是同一件事的两面（手机横过来时两者同时成立），
 * 曾经这里写的是 899.95，与底栏的 899.98 差 0.03px，属于真漂移。
 *
 * 这里的常量只用于「值和语义要有出处」：`src/index.css` 的
 * `@media (max-height: 480px) and (max-width: 899.98px)` 段没法 import 它，
 * 由守卫测试保证两边的宽度字面量一致。
 */
export const QUERY_LANDSCAPE_SHORT = "(max-height: 480px) and (max-width: 899.98px)";

/**
 * `QUERY_BELOW_600` 的「可直接当样式键」版本。
 *
 * MUI 的 `styleOverrides` / `sx` 里写媒体查询时，键必须是完整的
 * `@media (...)` 字符串（`useThemeController` 的全局触控尺寸、弹窗小屏边距
 * 都挂在那儿）。原来那六处写的是 `"@media (max-width:600px)"` ——
 * 比 MUI 的 sm 下沿多含了整 1px（600px 本身属于 sm 区间），
 * 于是 600px 宽时「小屏舒适内边距」和「sm 及以上」两套样式同时生效。
 * 统一到这个键之后，边界与 `QUERY_BELOW_600` 完全一致。
 */
export const MQ_BELOW_600 = `@media ${QUERY_BELOW_600}`;
