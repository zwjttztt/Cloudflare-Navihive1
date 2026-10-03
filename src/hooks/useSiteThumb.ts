// src/hooks/useSiteThumb.ts
// 卡片缩略图：仅在「网站设置」里配了模板时才启用，避免默认就去请求第三方截图服务。
//
// 从 SiteCard 里搬出来的。这里唯一非平凡的是那条**超时兜底**：
// 截图服务被限流 / 被网络挡掉时，请求可能既不成功也不失败，onError 一直不触发，
// 卡片上就会永远留一块灰骨架。8 秒后主动当失败处理，回到只有图标的版式。

import { useEffect, useState } from "react";
import { resolveIconApiUrl } from "../utils/iconApi";

/** 缩略图多久还没加载出来就算失败（毫秒） */
export const THUMB_TIMEOUT_MS = 8000;

export interface UseSiteThumbParams {
    /** 缩略图 API 模板，来自应用配置；空串表示没配，直接不启用 */
    thumbApi: string;
    siteUrl?: string;
    /** 列表 / 墙式版式不显示缩略图 */
    enabled?: boolean;
    /** 隐私模式：截图服务拿走的是完整链接，同样不发 */
    privacy?: boolean;
}

export interface SiteThumbState {
    /** 最终要不要渲染缩略图 */
    useThumb: boolean;
    /** 解析出来的缩略图地址（未启用时为空串） */
    thumbUrl: string;
    thumbLoaded: boolean;
    onLoad: () => void;
    onError: () => void;
}

export function useSiteThumb({
    thumbApi,
    siteUrl,
    enabled = true,
    privacy,
}: UseSiteThumbParams): SiteThumbState {
    const thumbUrl = thumbApi.trim() ? resolveIconApiUrl(thumbApi, siteUrl || "") : "";
    const [thumbError, setThumbError] = useState(false);
    const [thumbLoaded, setThumbLoaded] = useState(false);

    const useThumb = Boolean(thumbUrl) && !thumbError && enabled && !privacy;

    // 缩略图地址变化时重置加载状态
    useEffect(() => {
        setThumbError(false);
        setThumbLoaded(false);
    }, [thumbUrl]);

    useEffect(() => {
        if (!useThumb || thumbLoaded) return;
        const timer = window.setTimeout(() => setThumbError(true), THUMB_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [useThumb, thumbLoaded, thumbUrl]);

    return {
        useThumb,
        thumbUrl,
        thumbLoaded,
        onLoad: () => setThumbLoaded(true),
        onError: () => setThumbError(true),
    };
}
