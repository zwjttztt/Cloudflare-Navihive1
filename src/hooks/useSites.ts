// 只读数据层（useSites 的第一片安全切片）：把「分组 / 加载中 / 错误」这三块状态，以及
// bootstrap 数据的落地逻辑（分组构建 + fetch 编排），从 App.tsx 搬到这里。
//
// 为什么不全搬：App 的 fetchData 还耦合 handleError / 认证态 / 偏好合并等闭包，整块搬走风险高
// （见项目记忆「useSites 单独一轮」）。这一片是文档里规划的「先抽只读数据层」首步——把不再
// 依赖其它 App 层状态的部分隔离出来，完整数据层（mutation 迁移）留到后续轮次。
//
// 配置落地、链接健康 / 偏好合并等需要触碰其它 App 层状态的步骤，通过 onRemoteExtras 回调交还给 App，
// 这样本 hook 只管「本机分组状态」，不与 configs / deadLinks / 认证态纠缠。
import { useState } from "react";
import type { BootstrapData, Site } from "../API/http";
import type { GroupWithSites } from "../types";
import { writeBootstrapCache } from "../utils/firstPaintCache";

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
        if (!silent) {
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
            if (!silent) {
                deps.onError("加载数据失败: " + message);
            }
            // 如果因为认证问题导致加载失败，处理认证状态
            if (message.includes("认证") || message.includes("401")) {
                deps.onAuthFail();
            }
            return false;
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    };

    return { groups, setGroups, loading, setLoading, error, setError, fetchData, applyRemoteData };
}
