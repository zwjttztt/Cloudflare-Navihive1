// src/hooks/useNavSceneEffects.ts
// 首页场景的最后一段内联逻辑（2026-10-11，#85 继续拆）：
// 分组渐显、锚点跳转、分组强调色、失效链接巡检。
//
// 之前这四块散在 App.tsx 里：都是「有明确输入输出的小单元」，与 App 的
// 渲染树无关 —— 抽出来后既能独立阅读，也能被单独测到（巡检的提示文案
// 与增量跳过参数原来藏在 26 行回调里，现在签名一眼可见）。

import { useCallback, useEffect } from "react";
import { SortMode } from "../constants";
import type { NavigationClient } from "../API/client";
import type { GroupWithSites } from "../types";
import type { NotifyAction } from "../context/NotifyContext";
import {
    collectCheckUrls,
    describeLinkCheck,
    FRESH_WINDOW_MS,
    probeLinks,
    type DeadLinks,
} from "../utils/linkHealth";

/** App/useNotify 里的提示函数形状（ms 在 action 之前，别把参数顺序写反） */
type NotifyFnLike = (
    text: string,
    level?: "success" | "error" | "info",
    ms?: number,
    act?: NotifyAction
) => void;

/**
 * 分组面板滚进视口时播一次「渐显上浮」（只播一次，来回滚动不会反复闪）。
 * 元素默认就是正常显示，动画靠 JS 加 class 触发，IntersectionObserver 不可用时完全不受影响。
 */
export function useGroupReveal(
    loading: boolean,
    sortMode: SortMode,
    displayedCount: number
): void {
    useEffect(() => {
        if (loading || sortMode !== SortMode.None) return;
        if (typeof IntersectionObserver === "undefined") return;

        const io = new IntersectionObserver(
            entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const target = entry.target as HTMLElement;
                    target.classList.add("nav-reveal-in");
                    // 播完就把 class 摘掉：面板带毛玻璃，只要还挂着动画，浏览器就会
                    // 一直把它当独立合成层处理（边缘容易渗出暗边），也会压住 :hover。
                    target.addEventListener(
                        "animationend",
                        () => target.classList.remove("nav-reveal-in"),
                        { once: true }
                    );
                    io.unobserve(target);
                });
            },
            { rootMargin: "0px 0px -32px 0px" }
        );

        document
            .querySelectorAll<HTMLElement>(".nav-group-panel")
            .forEach(node => io.observe(node));

        return () => io.disconnect();
    }, [loading, sortMode, displayedCount]);
}

/**
 * 分组锚点跳转：左侧导航条与移动端「分组」菜单共用。
 */
export function useGroupAnchorNav(
    setMobileGroupsAnchor: (value: null) => void
): (groupId: number) => void {
    return useCallback(
        (groupId: number) => {
            setMobileGroupsAnchor(null);
            const node = document.getElementById(`group-anchor-${groupId}`);
            if (!node) return;
            const top = node.getBoundingClientRect().top + window.scrollY - 96;
            window.scrollTo({ top, behavior: "smooth" });
            // setMobileGroupsAnchor 来自 useViewportUi，和 useState 的 setter 一样引用恒定，
            // 列进依赖只是让 lint 说得清（见 useSiteSearch 里同样的一处说明）
        },
        [setMobileGroupsAnchor]
    );
}

/**
 * 分组强调色：存成 group.color.<id> 配置，不动数据表结构。
 * 先乐观改本机（界面立即变色），服务端保存失败再提示。
 */
export function useGroupAccent(
    api: Pick<NavigationClient, "setConfig">,
    setConfigs: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    notify: NotifyFnLike
): (groupId: number, color: string) => Promise<void> {
    return useCallback(
        async (groupId: number, color: string) => {
            const key = `group.color.${groupId}`;
            setConfigs(prev => ({ ...prev, [key]: color }));
            try {
                await api.setConfig(key, color);
                notify(color ? "分组颜色已更新" : "已恢复为全局主色", "success");
            } catch {
                notify("分组颜色保存失败", "error");
            }
        },
        [api, notify, setConfigs]
    );
}

/**
 * 失效链接检测：结果存本机，卡片上标灰点。
 */
export function useLinkCheck(
    groups: GroupWithSites[],
    notify: NotifyFnLike,
    setDeadLinks: (dead: DeadLinks) => void,
    setDeadOnly: (value: boolean) => void
): () => Promise<void> {
    return useCallback(async () => {
        const urls = collectCheckUrls(groups);
        if (urls.length === 0) {
            notify("还没有可以检测的链接", "info");
            return;
        }
        notify(`开始检测 ${urls.length} 个链接…`, "info");
        // 增量检测：7 天内探测过、或用户手动标记过「能访问」的链接直接跳过，
        // 同一域名也只探一次，避免每次都得等上几分钟
        const result = await probeLinks(urls, { concurrency: 5, skipFreshMs: FRESH_WINDOW_MS });
        setDeadLinks(result.dead);
        // 第三个参数是「这次第一次失败、只记了疑似」的数量 —— 分两次才标失效之后，
        // 第一次检测完界面上什么都不标，不说明白用户只会以为检测坏了
        const { text, severity, offerFilter } = describeLinkCheck(
            Object.keys(result.dead).length,
            result.skipped,
            result.suspect
        );
        notify(
            text,
            severity,
            undefined,
            // 有可疑链接时给个快捷入口，省得自己一张张翻
            offerFilter ? { label: "只看失效", onClick: () => setDeadOnly(true) } : undefined
        );
    }, [groups, notify, setDeadLinks, setDeadOnly]);
}
