import { useEffect, useMemo, useState } from "react";
import { createTheme } from "@mui/material/styles";
import type { ThemeMode } from "../components/ThemeToggle";

/**
 * 主题控制器：把「深浅模式状态 + 跟随系统监听 + 切换逻辑 + MUI 主题对象创建」
 * 从 App.tsx 抽出。原 App 里 themeMode/systemDark/darkMode/toggleTheme/theme
 * 这五个名字直接解构自本 hook，引用点无需改动。
 *
 * accent 由 App 计算后传入：只允许合法的 #rgb / #rrggbb，避免脏数据把主题搞坏。
 */
export function useThemeController(accent: string) {
    // 主题模式状态（默认跟随系统；老用户存过的 light/dark 依然兼容）
    const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
        const saved = localStorage.getItem("theme");
        return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    });
    // 系统当前的深浅偏好
    const [systemDark, setSystemDark] = useState(() =>
        window.matchMedia("(prefers-color-scheme: dark)").matches
    );

    useEffect(() => {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);

    const darkMode = themeMode === "system" ? systemDark : themeMode === "dark";

    // 切换主题：每一档点下去都要有可见变化
    // 浅色 → 深色 → 跟随系统（系统深时则先给浅色，保证「点一下就有反应」）
    const toggleTheme = () => {
        const next: ThemeMode =
            themeMode === "light"
                ? "dark"
                : themeMode === "dark"
                ? "system"
                : systemDark
                    ? "light"
                    : "dark";
        setThemeMode(next);
        localStorage.setItem("theme", next);
    };

    // 创建 Material UI 主题（放在 configs 之后，才能读到自定义主色）
    const theme = useMemo(
        () =>
            createTheme({
                palette: {
                    mode: darkMode ? "dark" : "light",
                    // 未设置主色时保持默认（亮/暗各一套，暗色下自动换成更亮的蓝）
                    ...(accent ? { primary: { main: accent } } : {}),
                    // 次级文字（caption/说明文案）默认 rgba(0,0,0,.6)，在带底色的面板上
                    // 对比度 4.59 压线 AA（4.5）。各提半档留安全余量，视觉上几乎无差别
                    // （harness/contrast-audit.mjs 守着这条）
                    text:
                        darkMode
                            ? { secondary: "rgba(255,255,255,0.76)" }
                            : { secondary: "rgba(0,0,0,0.66)" },
                    // 凭据警告等 warning.dark 文案：MUI 亮色默认 orange[900]（#e65100）
                    // 在白底上只有 ~3.8:1，低于 AA(4.5)。main 保持默认只加深 dark，
                    // 暗色用 MUI 默认（contrast-audit 无不合格）
                    ...(!darkMode && { warning: { main: "#ed6c02", dark: "#9c4f00" } }),
                },
                typography: {
                    // 跟随全局字体栈（index.css 的 --font-sans）
                    fontFamily: "var(--font-sans)",
                    h1: { fontWeight: 700, letterSpacing: "-0.02em" },
                    h2: { fontWeight: 600, letterSpacing: "-0.01em" },
                    h3: { fontWeight: 700, letterSpacing: "-0.02em" },
                    h4: { fontWeight: 600 },
                    h5: { fontWeight: 600 },
                    button: { fontWeight: 500, textTransform: "none" },
                },
                shape: {
                    // 统一放大圆角，观感更柔和
                    borderRadius: 14,
                },
                components: {
                    // 弹层（菜单/对话框/抽屉/下拉）一律不锁背景滚动。MUI 的滚动锁会
                    // 把 body 的滚动条收走再补 padding，开合之间有效宽度进出 10px ——
                    // 页面缩放时这 10px 刚好能跨过 900px 断点，顶栏字号档位跟着跳，
                    // 「导航站」一开菜单就从一行挤成两行。禁掉后滚动条从头到尾都在，
                    // 加上 index.css 的 scrollbar-gutter: stable，开合弹层零重排。
                    // 代价是弹层开着时背景还能滚 —— 菜单/弹窗跟随锚点重定位，无碍。
                    MuiPopover: { defaultProps: { disableScrollLock: true } },
                    MuiDrawer: { defaultProps: { disableScrollLock: true } },
                    // 键盘焦点环：index.css 里那条全局 :focus-visible 只对原生元素管用，
                    // MUI 组件的样式是运行时由 emotion 注入的，排在意料之外的位置把它压掉了 ——
                    // 实测 Tab 到搜索框 / 更多选项 / 视图切换时，computed outline 与 boxShadow 全是 none，
                    // 键盘用户过了左侧分组栏就彻底看不到自己在哪。这里按组件补回来。
                    MuiButtonBase: {
                        styleOverrides: {
                            root: {
                                "&:focus-visible": {
                                    outline: "2px solid var(--accent)",
                                    outlineOffset: 2,
                                },
                            },
                        },
                    },
                    // 所有弹窗默认走同一套毛玻璃面板：半透明底 + 模糊 + 细边框 + 柔和投影，
                    // 单个弹窗自己写了 paper sx 的话会覆盖这里（比如确认弹窗、命令面板）
                    MuiDialog: {
                        defaultProps: { disableScrollLock: true },
                        styleOverrides: {
                            paper: ({ theme }) => ({
                                borderRadius: "var(--card-radius)",
                                backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                                WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                                border: "1px solid var(--glass-panel-border)",
                                boxShadow: "var(--glass-shadow-hover)",
                                backgroundColor:
                                    theme.palette.mode === "dark"
                                        ? "rgba(23,27,38,0.94)"
                                        : "rgba(255,255,255,0.94)",
                                // 小屏别贴边
                                "@media (max-width:600px)": { margin: 12 },
                            }),
                        },
                    },
                    // 移动端触控尺寸：以前写在 App.css 里用 !important 全站强压
                    // （button/a/[role=button] padding 12px + min-height 36px），
                    // 结果是连左侧分组栏、卡片右上角的图标按钮都被撑成 32×36 的长方形。
                    // 改成按组件在断点里给尺寸后，组件自己写的 sx 优先级更高、可以覆盖，
                    // 只有没特别声明的按钮才拿到这套保底尺寸。
                    MuiButton: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    minHeight: 36,
                                    paddingInline: 12,
                                },
                            },
                        },
                    },
                    MuiIconButton: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    padding: 6,
                                    minWidth: 36,
                                    minHeight: 36,
                                },
                            },
                        },
                    },
                    MuiInputBase: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    "& .MuiInputBase-input": { padding: "10px 12px" },
                                },
                                // 输入框**不**补外圈 outline：
                                // outlined 输入框自己就有聚焦指示（边框 1px 灰 → 2px 主色），
                                // 之前额外给 root 补一圈 outline 后，两者叠成两道同心环——
                                // 点一下搜索框就看到「双红圈」。
                                // 统一交给 MUI 的边框后，任何主题、带不带 label 都只有一圈，
                                // 顺带也不再需要「带 label 的输入框单独排除 outline」那条例外
                                // （label 骑在边框线上、外圈横穿文字的问题一并消失）。
                            },
                        },
                    },
                    MuiDivider: {
                        styleOverrides: {
                            root: { "@media (max-width:600px)": { margin: "8px 0" } },
                        },
                    },
                    MuiMenu: {
                        defaultProps: { disableScrollLock: true },
                        styleOverrides: {
                            paper: { "@media (max-width:600px)": { minWidth: 200 } },
                        },
                    },
                },
            }),
        [darkMode, accent]
    );

    return { themeMode, setThemeMode, systemDark, darkMode, toggleTheme, theme };
}
