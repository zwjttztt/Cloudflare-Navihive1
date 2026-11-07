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
//
// ⚠️ 根因边界（别把「重渲染」写成「重挂载」）：
//   `setGroups(全量新数组)` / `applyConfigs` 的无条件替换**只造成重渲染，不是重挂载**。
//   App.tsx 的 NotesOverlay 那层 ChunkBoundary（未传 when 时 mounted 恒为 true）与
//   ThemeProvider 的 theme（只依赖 [darkMode, accent]）都是同位置同类型复用同一实例，
//   useRef / useState 不会因为一次刷新被清空。
//   所以下面的「请求序号 / in-flight 去重 / 结构共享」目的只是**减少重渲染次数**，
//   不是「靠重挂载重置状态」；本链路上任何隐藏状态都不该靠卸载 / 换 key 来甩掉。
//   全量替换本身只造成重渲染；白块 / 灰点 / 卡片空白是它下游的条件分支切换
//   （sitesMounted 三元换分支、when 翻转后 320ms 真卸载、key 混用）与层级错位造成的。
import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapData, Site } from "../API/http";
import type { GroupWithSites } from "../types";
import { hasSessionCookie } from "../API/transport";
import { isAuthError } from "../API/apiError";
import { readBootstrapCache, writeBootstrapCache } from "../utils/firstPaintCache";
import {
    mergeGroupsPreservingRefs,
    removeSite,
    removeSites,
    upsertSite,
} from "../utils/siteMutations";

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

    // 请求序号：每次**真正发起**一次 bootstrap 就 +1。响应回来时只有序号仍等于
    // 当前值才允许落地 —— 挂载期 ≥4 条自动刷新源（缓存快照 / 首次 bootstrap /
    // 两次 900ms silent 重试 / 离线重放 / online 重放 / 墓碑轮询）交错落地时，
    // 晚到的旧快照不会再覆盖先到的新快照（用户实测的「分组计数 9↔10 反复跳」）。
    // 与下面的 in-flight 去重、applyRemoteData 的结构共享合起来只做一件事：把交错落地
    // 收敛成尽量少的一次**有效重渲染**。它不改变任何组件的挂载身份，也不清空任何
    // ref / state —— 不是靠重挂载把状态重置掉。
    const requestSeqRef = useRef(0);
    // 同一时刻只保留一个 in-flight bootstrap：并发调用复用同一个 Promise，
    // 不再各发各的请求。首个调用的参数决定 loading / silent 行为，后续调用者只拿结果。
    // token 只用来在 finally 里判断「当前这一份是不是我」：IIFE 内部不能引用
    // 外层那个还没赋值的 task（TS2454），用独立的小对象就绕开了自引用。
    const inflightRef = useRef<{ promise: Promise<boolean>; token: object } | null>(null);

    // 最新 deps 的 ref（P2-13）：让 applyRemoteData / fetchData 保持**稳定引用**
    // （空依赖 useCallback），又总能读到最新的 api 与回调。否则每次渲染都生成新的
    // fetchData，下游把它放进 useMemo/useCallback 依赖时全部失效。
    const depsRef = useRef(deps);
    useEffect(() => {
        depsRef.current = deps;
    });

    // 把一次 bootstrap 数据合并进本地分组状态；配置 / 偏好等交给 onRemoteExtras。
    // 空依赖 useCallback + depsRef：引用稳定，下游 memo 不再因它每次重建而失效（P2-13）。
    const applyRemoteData = useCallback((data: BootstrapData) => {
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

        // 结构共享：内容没变就原样返回 prev（连数组引用都不换），
        // 被 memo 的 GroupCard / SiteCard 因此**少一次重渲染**（不是重挂载，实例与
        // useRef/useState 都还在）。少这一次重渲染，下游那条「条件分支切换」的链就
        // 不会被推着走：sitesMounted 三元真换分支才会卸载 SiteCard、图标 state 才会丢、
        // 才会退回升骨架灰点；入场动画也只在组件真重新挂载时才可能重播。
        // 以前这里是无条件 setGroups(nextGroups)：新数组 + 每个分组都是新对象。
        setGroups(prev => mergeGroupsPreservingRefs(prev, nextGroups));
        depsRef.current.onRemoteExtras(data);
    }, []);

    /**
     * 取一次 bootstrap。
     *
     * `error` 只有**一个**语义：真的加载失败了（见下面 catch）。以前它恒为 null，
     * 于是 App 里 `!loading && !error` 这道守卫变成死条件 —— bootstrap 失败后
     * groups 为空，用户看到的是「还没有任何分组」，会以为自己几百个网站没了。
     * 现在失败就写 error，由 App 渲染错误面板（带重试）。
     *
     * 反向的坑也一并堵上：别的流程提示（注销 / 登出 / 改密码）**不再往这里写**
     * （原来 App 把 setError 当 onDataError 传给两个 hook，那些提示会让整个站点列表
     * 消失且页面上一个字都没有）。流程提示走 notify。
     */
    // 刻意**不写成 async**：async 函数会把 `return inflightRef.current` 再包一层新 Promise，
    // 并发调用者拿到的就不是同一个对象了。这里直接返回 task / inflight 本身。
    const fetchData = useCallback(
        (
            { silent = false, force = false }: { silent?: boolean; force?: boolean } = {}
        ): Promise<boolean> => {
            // 已有在途 bootstrap：复用同一个 Promise（并发不各发各的请求）。
            // `force` 只给「确实要拿一份全新快照」的调用方（以及定向用例）留一条缝：
            // 它会新发一个请求并取得最新序号，旧请求的响应随之被序号闸门丢弃。
            // 复用时**不读** paintedFromCacheRef / 不改 loading：首个调用的参数决定
            // 这一次请求的行为，后续调用者只拿结果，silent / fromCache 语义不会被破坏。
            if (!force && inflightRef.current) return inflightRef.current.promise;

            // 若本次是「缓存已垫底后的首次取数」，自动静默：骨架屏保持隐藏，不被重新举起。
            const fromCache = paintedFromCacheRef.current;
            paintedFromCacheRef.current = false;
            const effectiveSilent = silent || fromCache;

            if (!effectiveSilent) {
                setLoading(true);
                setError(null);
            }

            const seq = ++requestSeqRef.current;
            const token: object = {};
            const task = (async (): Promise<boolean> => {
                try {
                    const data = await depsRef.current.api.bootstrap();
                    // 只接受最新响应：期间若又发起了新的 bootstrap，这份旧快照整个丢弃 ——
                    // 不落地分组、不写缓存、不回调 onRemoteExtras（那会重建 appConfigValue），
                    // 也不碰 setError，免得迟到的旧请求把新请求刚收拾好的状态改坏。
                    if (seq !== requestSeqRef.current) return false;
                    applyRemoteData(data);
                    // 留一份快照，下次打开先用它渲染，不等这个请求回来
                    writeBootstrapCache(data);
                    // 成功即清掉上一次的失败：重试成功后错误面板必须自己退场，
                    // 否则用户会盯着「加载失败」看一份刷好的数据
                    setError(null);
                    return true;
                } catch (err) {
                    // 旧请求的失败同样整个丢弃：不能让一份过期快照的 401 把人踢回登录页，
                    // 也不能让它在页面上弹一条与当前状态无关的「加载数据失败」。
                    if (seq !== requestSeqRef.current) return false;
                    const message = err instanceof Error ? err.message : "未知错误";
                    if (!effectiveSilent) {
                        depsRef.current.onError("加载数据失败: " + message);
                        // 整页错误：让 App 渲染错误面板（而不是空数据）。
                        // silent（缓存已垫底后的静默刷新）**不吃这条** —— 那时页面上
                        // 有旧数据可看，把整页换成错误面板是倒退，只弹 toast 就够。
                        setError(message);
                    }
                    // 如果因为认证问题导致加载失败，处理认证状态。
                    // 判据用 ApiError 的 code / HTTP 401，不再拿 message 去 includes —— 这条
                    // 原来是「界面永不回登录页」的根源：文案一改（或服务端回了非 JSON 的 401），
                    // 这里就静默不触发 onAuthFail，用户点什么都只弹同一句 toast。
                    if (isAuthError(err)) {
                        depsRef.current.onAuthFail();
                    }
                    return false;
                } finally {
                    // loading 是本请求自己举起来的，无论结果是否被采用都必须收掉，
                    // 否则一个被丢弃的旧请求会把骨架屏永久留在屏幕上。
                    if (!effectiveSilent) setLoading(false);
                    // 只清掉自己那一份：force 并发时别把刚建立的新 promise 抹掉。
                    if (inflightRef.current?.token === token) inflightRef.current = null;
                }
            })();
            inflightRef.current = { promise: task, token };
            return task;
        },
        [applyRemoteData]
    );

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
        // 仅在挂载跑一次：applyRemoteData 现在是稳定引用（空依赖 useCallback），进 deps 不会重跑
    }, [applyRemoteData]);

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
