// src/utils/ClipChipNode.tsx
// 行内「复制胶囊」的渲染组件：点一下把内容写进剪贴板，成功则变绿打勾约 1.2s 再复原。
// 语法 `{{clip:内容}}` 与纯文本降级都在 ./markdownClipChip.ts。
//
// 为什么单独一个文件、而不是塞进 markdownToReact.tsx（与 AttachmentLink 同款理由）：
// 那是个纯函数模块（导出 renderMarkdownToReact 等一堆非组件），再往里加组件会
// 触发 react-refresh/only-export-components 警告，热更新边界也会变糊。
//
// 为什么**只**用 utils/clipboard、不接 onNotify / RenderContext：
// 这个渲染体同时服务编辑器实时预览、笔记阅读态与**公开分享页** ——
// 分享页没有登录态、也没有任何页面注入的上下文，写死「复制失败要弹提示」
// 就变成「分享页一点就报错」。所以失败就静默复原，绝不抛、绝不依赖外部能力。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { copyToClipboard } from "./clipboard";
import { CLIP_CHIP_RESET_MS } from "./markdownClipChip";

/**
 * 胶囊的**版式**（2026-11-06）。
 *
 * ⚠️ `display: inline` 是硬要求，不是笔误：v31 那次用 `inline-block` 做可复制片段，
 *    胶囊把行高顶开、整段版面被打散（用户当场报「版面乱了」），最后改成 inline 才收场。
 *    非替换行内盒的垂直 padding / border **不参与**行盒高度计算（CSS 2.1 §10.6.1：
 *    行盒高度由各内联盒的 line-height 与基线对齐决定），所以上下 2px 内边距 + 1px 虚线
 *    只会把颜色画出去一点，不会推开相邻行。
 *    实测口径：正文默认 16px / line-height 1.7 → 行盒 27.2px；胶囊内容区约
 *    1.2 × 13.6px = 16.3px，加上 2×2 内边距与 2×1 边框 = 22.3px < 27.2px，
 *    连「画出去的那一圈」都碰不到上下两行。
 *
 * 为什么间距用 margin-left 而不是 gap：gap 只对 flex / grid 生效，display:inline 下无效。
 * 为什么不开 white-space:nowrap：超长内容的胶囊宁可跟着正文折行，
 *    也不能因为 nowrap 撑出横向滚动条（那才是真的破坏版面）。
 */
const CHIP_BOX: CSSProperties = {
    display: "inline",
    padding: "2px 9px",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.85em",
    // 继承父级行高：写成固定值会让它自己变成一个更高的行内盒，把行盒顶开
    lineHeight: "inherit",
    borderStyle: "dashed",
    borderWidth: 1,
    borderRadius: 999,
    // 长内容（比如一整条 URL）也只在胶囊内部折行，不外溢
    wordBreak: "break-word",
    cursor: "pointer",
    // 点一下选中整枚胶囊（「这就是一块可复制内容」的直觉），再按 ⌘C / Ctrl+C 也行
    userSelect: "all",
};

/** 静止态：配色见 index.css 的 --md-clip-*（亮/暗各一套），这里都带亮色兜底 */
const CHIP_IDLE: CSSProperties = {
    ...CHIP_BOX,
    color: "var(--md-clip-fg, #4f46e5)",
    background: "var(--md-clip-bg, #eef2ff)",
    borderColor: "var(--md-clip-border, #6366f1)",
};

/** 已复制态（约 1.2s）：底色转绿 + 尾部字形换 ✓ */
const CHIP_DONE: CSSProperties = {
    ...CHIP_BOX,
    color: "var(--md-clip-done-fg, #047857)",
    background: "var(--md-clip-done-bg, #ecfdf5)",
    borderColor: "var(--md-clip-done-border, #059669)",
};

/**
 * 尾部字形。
 * ⚠️ `userSelect: "none"` 是功能性的：浏览器的复制严格按**选区**取文本，
 *    字形留在选区里的话，「全选复制正文」就会带出一堆 ⧉ / ✓。
 *    同时外层 span 带 aria-hidden —— 读屏不该念它（可访问名由 aria-label 提供）。
 */
const CHIP_GLYPH: CSSProperties = {
    marginLeft: 4,
    fontSize: "0.95em",
    userSelect: "none",
    opacity: 0.9,
};

/** 尾部字形的 class：粘贴时 htmlToMarkdown 靠它把字形摘掉（不进正文） */
const GLYPH_CLASS = "md-clip-glyph";

export interface ClipChipNodeProps {
    /** 要复制的内容（token 的原文，已经是纯文本） */
    text: string;
}

/**
 * 行内复制胶囊。
 *
 * 行为契约（QA 会独立复核的那几条）：
 *   - 可访问名 = `复制：<内容>`（aria-label，不是 title）；
 *   - Enter / Space 等价于点击（原生 button 自带，role=button 得自己实现）；
 *   - 复制成功 → 已复制态保持 CLIP_CHIP_RESET_MS 后复原；失败 → 立刻保持静止态；
 *   - **绝不改正文**：这个组件不持有、也不回写任何源码。
 */
export function ClipChipNode({ text }: ClipChipNodeProps) {
    const [copied, setCopied] = useState(false);
    /** 复原定时器：连点时先清掉上一个，免得「第二次点击被第一次的定时器提前复原」 */
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 卸载时清定时器：预览区会随视口反复重建，留着定时器就是在已卸载的组件上 setState
    useEffect(() => {
        return () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = null;
        };
    }, []);

    const trigger = () => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        void copyToClipboard(text).then(ok => {
            if (!ok) {
                // 失败立刻复原：不给「已复制」的假信号（非安全上下文 / 权限被拒都会走这里）
                setCopied(false);
                return;
            }
            setCopied(true);
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                setCopied(false);
            }, CLIP_CHIP_RESET_MS);
        });
    };

    return (
        <span
            role='button'
            tabIndex={0}
            aria-label={`复制：${text}`}
            data-clip-chip='1'
            data-clip-state={copied ? "copied" : "idle"}
            onClick={trigger}
            onKeyDown={event => {
                // Enter / Space 都得能触发（原生 button 自带，role=button 要自己实现）
                if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                event.preventDefault();
                trigger();
            }}
            style={copied ? CHIP_DONE : CHIP_IDLE}
        >
            {text}
            <span aria-hidden='true' className={GLYPH_CLASS} style={CHIP_GLYPH}>
                {copied ? "✓" : "⧉"}
            </span>
        </span>
    );
}
