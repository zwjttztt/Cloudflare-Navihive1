// 数据层（useSites）：把「分组 / 加载中 / 错误」这三块状态、bootstrap 数据的落地逻辑
// （分组构建 + fetch 编排），以及**本地写**（写回 / 移除卡片）从 App.tsx 搬到这里。
//
// 为什么只到这一步：App 的 mutation 还各自牵着别的子系统——handleSiteDelete 要碰
// 标签 / 星标 / 历史栈 / 撤销提示，bulkMove 要碰多选态。把它们整体吞进来只会得到一个
// 需要注入十来个回调的「上帝 hook」，等于把耦合换个地方放。所以这里的边界划在
// 「只依赖 groups 自身」的操作上；真正复杂的编排仍留在 App，由它调用本 hook 的原子操作。
//
// 纯计算部分（数组怎么变）进一步下沉到 utils/siteMutations.ts，那里可以脱离 React 单测。
//
// 配置落地、链接健康 / 偏好合并等需要触碰其它 App 层状态的步骤，通过 onRemoteExtras 回调交还给 App，
// 这样本 hook 只管「本机分组状态」，不与 configs / deadLinks / 认证态纠缠。
import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapData, Site } from "../API/http";
import type { GroupWithSites } from "../types";
import { hasSessionCookie } from "../API/transport";
import { isAuthError } from "../API/apiError";
import { readBootstrapCache, writeBootstrapCache } from "../utils/firstPaintCache";
import { removeSite, removeSites, upsertSite } from "../utils/siteMutations";

export interface UseSitesDeps {
    /** bootstrap 抓取（与 App 共用同一个 api 实例，保证 mutation 包裹一致） */
    api: { bootstrap: () => Promise<BootstrapData> };
    /** 配置落地 + 偏好 / 链接健康合并等需要其它 App 层状态的步骤 */
    onRemoteExtras: (data: BootstrapData) => void;
    /** 加载失败时的错误提示（通常传 handleError） */
    onError: (message: string) => void;
    /** 认证失败时把登录态置为「需要登录」 */
    onAuthFail: () => void;
}

export function useSites(deps: UseSitesDeps) {
    const [groups, setGroups] = useState<GroupWithSites[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // 首屏「先画后取」：上次打开的 bootstrap 快照留在 sessionStorage，挂载时先画出来，
    // 真正的请求照常发（在 useAccountSession 里），回来后再覆盖。paintedFromCacheRef
    // 用来告诉那次初始 fetchData「已经有缓存垫底，别再举骨架屏」——否则下面的非静默
    // fetch 会把骨架屏重新举起来，把缓存优化的效果抵消掉（这是此前每次打开都白屏的根因）。
    const paintedFromCacheRef = useRef(false);

    // 把一次 bootstrap 数据合并进本地分组状态；配置 / 偏好等交给 onRemoteExtras
    const applyRemoteData = (data: BootstrapData) => {
        const sitesByGroup = new Map<number, Site[]>();
        for (const site of data.sites || []) {
            const list = sitesByGroup.get(site.group_id);
            if (list) {
                list.push(site);
            } else {
                sitesByGroup.set(site.group_id, [site]);
            }
        }

        const nextGroups: GroupWithSites[] = (data.groups || [])
            .filter(group => group.id !== undefined)
            .map(group => ({
                ...group,
                id: group.id as number,
                sites: (sitesByGroup.get(group.id as number) || []).sort(
                    (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                ),
            }));

        setGroups(nextGroups);
        deps.onRemoteExtras(data);
    };

    const fetchData = async ({ silent = false }: { silent?: boolean } = {}): Promise<boolean> => {
        // 若本次是「缓存已垫底后的首次取数」，自动静默：骨架屏保持隐藏，不被重新举起。
        const fromCache = paintedFromCacheRef.current;
        paintedFromCacheRef.current = false;
        const effectiveSilent = silent || fromCache;

        if (!effectiveSilent) {
            setLoading(true);
            setError(null);
        }

        try {
            const data = await deps.api.bootstrap();
            applyRemoteData(data);
            // 留一份快照，下次打开先用它渲染，不等这个请求回来
            writeBootstrapCache(data);
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : "未知错误";
            if (!effectiveSilent) {
                deps.onError("加载数据失败: " + message);
            }
            // 如果因为认证问题导致加载失败，处理认证状态。
            // 判据用 ApiError 的 code / HTTP 401，不再拿 message 去 includes —— 这条
            // 原来是「界面永不回登录页」的根源：文案一改（或服务端回了非 JSON 的 401），
            // 这里就静默不触发 onAuthFail，用户点什么都只弹同一句 toast。
            if (isAuthError(err)) {
                deps.onAuthFail();
            }
            return false;
        } finally {
            if (!effectiveSilent) {
                setLoading(false);
            }
        }
    };

    // ---- 本地写：只动本机分组状态，网络部分由调用方负责（乐观更新 + 失败回滚都在 App） ----
    // 用 functional update 保证并发调用不会互相覆盖；纯计算在 utils/siteMutations.ts，
    // 没有实际变化时那里会原样返回入参，避免带动 memo 的卡片重渲染。
    const upsertSiteLocally = useCallback((site: Site) => {
        setGroups(prev => upsertSite(prev, site));
    }, []);

    const removeSiteLocally = useCallback((siteId: number) => {
        setGroups(prev => removeSite(prev, siteId));
    }, []);

    /** 批量移除：多选删除时用一个 state 更新代替 N 次，少触发 N-1 轮渲染 */
    const removeSitesLocally = useCallback((siteIds: number[]) => {
        setGroups(prev => removeSites(prev, siteIds));
    }, []);

    /**
     * 批量写回：撤销多选删除时一次把还原出来的卡片全插回去。
     * 一个 state 更新搞定（逐个 upsert 就算 React 帮忙批处理，也要跑 N 遍纯计算）。
     */
    const upsertSitesLocally = useCallback((sites: Site[]) => {
        if (sites.length === 0) return;
        setGroups(prev => sites.reduce((acc, site) => upsertSite(acc, site), prev));
    }, []);

    // 挂载即把可用缓存画出来（仅已登录时），并标记「已垫底」让初始 fetch 走静默。
    useEffect(() => {
        if (!hasSessionCookie()) return;
        const cached = readBootstrapCache();
        if (!cached) return;
        paintedFromCacheRef.current = true;
        applyRemoteData(cached);
        setLoading(false);
        // 仅在挂载跑一次；applyRemoteData 每渲染都是新函数，进 deps 会每渲染重跑
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        groups,
        setGroups,
        loading,
        setLoading,
        error,
        setError,
        fetchData,
        applyRemoteData,
        upsertSiteLocally,
        upsertSitesLocally,
        removeSiteLocally,
        removeSitesLocally,
    };
}
