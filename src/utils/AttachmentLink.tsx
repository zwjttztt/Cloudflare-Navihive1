// src/utils/AttachmentLink.tsx
//
// 正文里「本站附件链接」的渲染组件（2026-10-19 用户需求：点 txt / json 链接
// 改成在弹窗里打开，而不是整页跳走）。
//
// 为什么单独一个文件、而不是塞在 markdownToReact.tsx 里：
// 那是个纯函数模块（导出 renderMarkdownToReact 等一堆非组件），再往里加组件会
// 触发 react-refresh/only-export-components 警告，热更新边界也会变糊。
//
// 为什么必须做成组件：markdown 的 token → 元素树是在**渲染之外**完成的
// （renderMarkdownToReact 是 async 的），在那条路径上调用 useContext 会踩
// 「hooks 只能在组件渲染期调用」。这里只创建元素，读 context 留给组件自己。
import type { ReactNode } from "react";
import { useAttachmentPreview } from "./attachmentPreview";

/**
 * 把 ReactNode 拍平成纯文本（只用来取链接文字当附件的显示名）。
 * 链接文字可能是 `<strong>report</strong>.txt` 这种带内联标记的，拍平后照样能读。
 * 不导出：只想给本文件用，顺带避免 react-refresh 那条「非组件导出」警告。
 */
function flattenText(node: ReactNode): string {
    if (node === null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(flattenText).join("");
    if (typeof node === "object" && "props" in (node as { props?: unknown })) {
        return flattenText((node as { props?: { children?: ReactNode } }).props?.children);
    }
    return "";
}

/**
 * ⚠️ 没有 Provider 时**退回原来的 `<a>`**：分享页（PublicNotePage）就是这种情况 ——
 * 那边的附件走 `/api/public/...` 免鉴权通道，弹窗侧取不到字节，整页打开才对。
 */
export default function AttachmentLink({
    id,
    href,
    children,
}: {
    /** 附件 id（从 URL 里截出来的） */
    id: string;
    href: string;
    children: ReactNode;
}) {
    const preview = useAttachmentPreview();
    if (!preview) {
        return (
            <a href={href} data-attachment-link={id}>
                {children}
            </a>
        );
    }
    return (
        <a
            href={href}
            data-attachment-link={id}
            onClick={event => {
                // 不 preventDefault 的话浏览器会整页跳到 /api/...，记事本直接被顶掉
                event.preventDefault();
                preview.open({ id, filename: flattenText(children) });
            }}
        >
            {children}
        </a>
    );
}
