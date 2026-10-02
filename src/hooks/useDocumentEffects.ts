// 一串「改的是 DOM 而不是 React 树」的副作用：文档标题、自定义 CSS、根节点 class、
// 主色与毛玻璃的 CSS 变量。原来内联在 App 里，搬出来后 App 只剩一行调用。
// 这些效果彼此独立、只读配置，所以收在一个 hook 里按顺序跑就行。
import { useEffect } from "react";
import { brandTitle } from "../brand";
import { sanitizeCustomCss } from "../utils/customCss";

type UseDocumentEffectsParams = {
    configs: Record<string, string>;
    darkMode: boolean;
    /** 校验过的自定义主色（非法值为空串，此时回退到 index.css 的默认色） */
    accent: string;
    /** 毛玻璃总开关 */
    glassEffects: boolean;
    /** 清爽模式：一次性摘掉模糊 / 装饰动画 / 悬浮阴影 */
    liteMode: boolean;
};

export function useDocumentEffects({
    configs,
    darkMode,
    accent,
    glassEffects,
    liteMode,
}: UseDocumentEffectsParams) {
    // 设置文档标题
    useEffect(() => {
        document.title = brandTitle(configs["site.title"]);
    }, [configs]);

    // 应用自定义CSS
    useEffect(() => {
        const customCss = configs["site.customCss"];
        let styleElement = document.getElementById("custom-style");

        if (!styleElement) {
            styleElement = document.createElement("style");
            styleElement.id = "custom-style";
            document.head.appendChild(styleElement);
        }

        // 添加安全过滤，防止CSS注入攻击
        const sanitizedCss = sanitizeCustomCss(customCss || "");
        styleElement.textContent = sanitizedCss;
    }, [configs]);

    // 同步HTML的class以保持与现有CSS兼容
    useEffect(() => {
        if (darkMode) {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
    }, [darkMode]);

    // 把主色同步成 CSS 变量，供原生 CSS（如搜索高亮）跟随主题
    useEffect(() => {
        const root = document.documentElement;
        if (accent) {
            root.style.setProperty("--accent", accent);
        } else {
            // 清空后回退到 index.css 里亮/暗各自的默认值
            root.style.removeProperty("--accent");
        }
    }, [accent]);

    // 毛玻璃强度：0 表示关掉模糊（纯半透明），留空/非法值用默认 14px
    // 注意 Number("") === 0，所以必须先排除空字符串，否则默认配置会被算成「关闭模糊」
    const glassBlurRaw = configs["site.glassBlur"];
    const glassBlurParsed = Number(glassBlurRaw);
    const glassBlur =
        glassBlurRaw === undefined || glassBlurRaw === "" || !Number.isFinite(glassBlurParsed)
            ? 14
            : Math.min(24, Math.max(0, glassBlurParsed));
    useEffect(() => {
        document.documentElement.style.setProperty("--glass-blur", `${glassBlur}px`);
    }, [glassBlur]);

    // 毛玻璃总开关：打开时保持上面的 --glass-blur；关掉时给根节点挂 .nav-no-glass，
    // 由 index.css 统一摘掉 backdrop-filter 并换成接近不透明的底色。
    // 之前这里做的是「滚动时把模糊降到 1/3」——实测收益有限，但每次滚动都会让所有毛玻璃层
    // 重新采样背景，边缘反而更容易露出黑边，所以回退了，改成让用户自己决定要不要这层特效。
    useEffect(() => {
        document.documentElement.classList.toggle("nav-no-glass", !glassEffects);
    }, [glassEffects]);

    // 清爽模式：给根节点挂 .nav-lite，由 index.css 一次性摘掉 backdrop-filter、
    // 柔光背景、装饰动画与悬浮阴影。走 CSS 而不是逐个组件判断，
    // 这样新加的装饰效果只要用到那几个类，默认就跟着一起被关掉。
    useEffect(() => {
        document.documentElement.classList.toggle("nav-lite", liteMode);
    }, [liteMode]);
}
