// src/utils/attachmentPreview.ts
//
// 「点正文里的附件链接 → 打开预览弹窗」这条链路的中转站（2026-10-19）。
//
// 为什么用 context 而不是给 markdownToReact 加个参数：
//   渲染层是**纯函数**（renderMarkdownToReact(source, ctx)），它的调用方有三处
//   （NotesPage 预览、侧栏预览、分享页），其中分享页根本不该有弹窗。给它加
//   「点链接怎么办」的回调参数，等于让每个调用点都往 ctx 里塞一个可能为 null
//   的函数，还要保证 ctx 的引用稳定（那边有 memo 缓存，回调一变就整段重渲染）。
//   context 的语义正好：**谁提供了谁有弹窗**，没提供就退回默认的 <a> 行为。
//
// ⚠️ 这里只放 context 与类型，不放 JSX —— 免得 util 反过来依赖组件目录
//   （markdownToReact 是 util，被组件引，不能再引回去）。
import { createContext, useContext } from "react";

/** 打开预览时能提供的全部信息。正文链接只有 id + 显示名，管理器还有 mime */
export interface AttachmentPreviewRequest {
    id: string;
    /** 显示名。正文链接取链接文字，管理器取 filename；拿不到就先空着 */
    filename?: string;
    /** 已知道的类型（管理器有）。缺了也不影响 —— 弹窗按响应的 Content-Type 判 */
    mime?: string;
}

export interface AttachmentPreviewController {
    open(request: AttachmentPreviewRequest): void;
}

const AttachmentPreviewContext = createContext<AttachmentPreviewController | null>(null);

export const AttachmentPreviewProvider = AttachmentPreviewContext.Provider;

/**
 * 拿预览控制器。**返回 null 是正常情况**（分享页 / 没接弹窗的渲染场景），
 * 调用方要退回「普通链接」而不是报错。
 */
export function useAttachmentPreview(): AttachmentPreviewController | null {
    return useContext(AttachmentPreviewContext);
}
