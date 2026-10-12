// src/hooks/useSiteIcon.ts
// 卡片图标的「候选源状态机」：自带图标 → 图标 API → 根目录 favicon → 公共图标服务。
//
// 从 SiteCard（1186 行）里搬出来的。搬的是**状态机**而不是 JSX：卡片要用几个候选、
// 哪个候选以前失败过要跳过、主源全挂了才补兜底源 —— 这些判断错了不报错，
// 只会表现为「图标一直显示首字母块」或者「每张卡片多打两个请求」，
// 在列表里滚一遍根本看不出来。搬出来才能给它建测试网。
//
// 依赖只列 site.icon / site.url：写成 [site] 的话改个备注也会把候选重算一遍。

import { useEffect, useMemo, useState } from "react";
import { iconCandidates, iconFallbackCandidates } from "../utils/iconCache";
import {
    readIconObjectUrl,
    releaseIconObjectUrl,
    readIconRecord,
    writeIconRecord,
    cacheIconBlob,
} from "../utils/iconCache";
import { awaitWarmup, pendingWarmup, queueIconWarmup } from "../utils/iconBatch";

export interface UseSiteIconParams {
    /** 站点自带图标地址 */
    icon?: string;
    /** 站点网址（用于推导 favicon / 缩略图服务） */
    url?: string;
    /** 图标 API 模板，来自应用配置 */
    iconApi: string;
    /**
     * 隐私模式：一个候选都不给。
     * 取图标这件事本身就在告诉对方（以及公共图标服务）「有人在访问这个域名」，
     * 开了这个开关就彻底不发。
     */
    privacy?: boolean;
}

export interface SiteIconState {
    /** 当前该显示的候选地址（空串表示没有候选，走首字母块） */
    currentIcon: string;
    /** 全部候选都试过了 → 交给首字母块 */
    iconError: boolean;
    imageLoaded: boolean;
    /** 命中本地 blob 缓存时的 objectURL；没有则直接用 currentIcon */
    iconObjectUrl: string | null;
    /**
     * 「批量取图标」正在路上，且本地还没有这一张 —— 这时 <img> 的 src 要留空等着，
     * 否则卡片自己先发一个 /api/icon，和批量那一次撞车（同一张图下两遍）。
     * 批量失败 / 超时都会回到 false，src 照常用 currentIcon。
     */
    iconWaiting: boolean;
    handleIconError: () => void;
    handleImageLoad: () => void;
}

export function useSiteIcon({ icon, url, iconApi, privacy }: UseSiteIconParams): SiteIconState {
    const primaryIcons = useMemo(
        () => (privacy ? [] : iconCandidates({ icon, url }, iconApi)),
        [icon, url, iconApi, privacy]
    );
    // 兜底源只在主源全失败后才追加：平时每张卡片最多 2 个请求，
    // 几百张卡片也不会一上来就排出上千个
    const [fallbackAdded, setFallbackAdded] = useState(false);
    const iconSources = useMemo(
        () =>
            fallbackAdded && !privacy
                ? [...primaryIcons, ...iconFallbackCandidates({ url })]
                : primaryIcons,
        [primaryIcons, fallbackAdded, url, privacy]
    );

    // 批量取图标：**渲染期**登记。
    // ⚠️ 不能放到 useEffect 里 —— effect 跑的时候 <img> 已经带着 src 进了 DOM，
    // 浏览器随即发请求，再想去等批量就晚了，结果同一批图标下两遍。
    // 这里只登记（同步占住「在途」 + 进队列），真正的请求在微任务里合成**一个**发出去。
    // 幂等：已在途 / 已排队的会跳过，所以严格模式下的双渲染也只发一次。
    queueIconWarmup(primaryIcons);

    const [iconIdx, setIconIdx] = useState(0);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [iconObjectUrl, setIconObjectUrl] = useState<string | null>(null);
    /** 这一趟「等批量」已经见分晓（拿到或超时） */
    const [waitedOut, setWaitedOut] = useState(false);

    const iconError = iconIdx >= iconSources.length;
    const currentIcon = iconSources[iconIdx] ?? "";
    // 渲染期同步判断：本地没有 + 批量在路上 → src 留空等它
    const iconWaiting =
        Boolean(currentIcon) && !iconObjectUrl && pendingWarmup(currentIcon) !== null && !waitedOut;

    // 图标本体缓存：命中本地 blob 时直接用 objectURL，弱网 / 离线重开也能立刻显示
    useEffect(() => {
        let cancelled = false;
        // 记下这次借到的 URL：objectURL 占着 blob 不放，卸载时必须还回去，
        // 否则卡片切来切去会把内存里的图标副本越堆越多
        let borrowed = false;
        setIconObjectUrl(null);
        setWaitedOut(false); // 换源了，这一趟重新等
        if (!currentIcon) return;
        void (async () => {
            let cached = await readIconObjectUrl(currentIcon);

            // 本地没有 → 先看看「批量取图标」那一次是不是正在路上（见 utils/iconBatch）。
            // 是的话等它一会儿再读一次，而不是自己立刻发一个请求 ——
            // 否则同一批图标会被下两遍（批量一份 + 卡片一份），请求数根本没降。
            // 批量失败 / 到上限都退化成「没拿到」，下面照常走原地址。
            if (!cached && !cancelled) {
                await awaitWarmup(currentIcon);
                if (!cancelled) {
                    cached = await readIconObjectUrl(currentIcon);
                    // ⚠️ 不管拿没拿到都要放行：不放行的话 src 会一直留空等这一批，
                    // 图标永远不显示（批量失败时尤其致命 —— 那时没人会再唤醒它）。
                    setWaitedOut(true);
                }
            }

            if (!cached) return;
            // 结果晚到（组件已经换了源 / 已卸载）：立刻还，别占着
            if (cancelled) {
                releaseIconObjectUrl(currentIcon);
                return;
            }
            borrowed = true;
            setIconObjectUrl(cached);
        })();
        return () => {
            cancelled = true;
            if (borrowed) releaseIconObjectUrl(currentIcon);
        };
    }, [currentIcon]);

    // 图标地址变化时重置加载状态：
    // 免刷新即时更新后，若图标由空改为有值，需要重新尝试加载，否则会一直显示首字母占位。
    // 同时查一遍本地缓存，把已知加载不出来的源直接跳过去。
    useEffect(() => {
        let cancelled = false;
        setImageLoaded(false);
        setFallbackAdded(false);
        setIconIdx(0);

        (async () => {
            for (let i = 0; i < primaryIcons.length; i++) {
                const record = await readIconRecord(primaryIcons[i]);
                if (record && !record.ok) continue; // 这个源以前失败过，跳过
                if (!cancelled) setIconIdx(i);
                return;
            }
            // 主源都失败过，等加载时再补兜底源
            if (!cancelled) setIconIdx(primaryIcons.length);
        })();

        return () => {
            cancelled = true;
        };
    }, [primaryIcons]);

    // 某个源加载失败：记下它不可用，换下一个候选
    const handleIconError = () => {
        if (currentIcon) void writeIconRecord(currentIcon, false);
        setImageLoaded(false);
        const next = iconIdx + 1;
        // 主源全部失败：这时才把兜底源接上来，继续从第一个兜底源开始试
        if (next >= iconSources.length && !fallbackAdded) setFallbackAdded(true);
        setIconIdx(next);
    };

    // 加载成功：记下这个源可用，并把图标本体存一份到本地（弱网/离线时直接命中）
    const handleImageLoad = () => {
        if (currentIcon) {
            void writeIconRecord(currentIcon, true);
            void cacheIconBlob(currentIcon);
        }
        setImageLoaded(true);
    };

    return {
        currentIcon,
        iconError,
        imageLoaded,
        iconObjectUrl,
        iconWaiting,
        handleIconError,
        handleImageLoad,
    };
}
