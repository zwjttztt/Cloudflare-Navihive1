// src/API/clientMethods/sites.ts
// NavigationClient 的「sites」域方法体：分组与站点 CRUD + 排序 + 分组分享 —— 导航站那一整块。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: ClientThis` 让 TS 认得 this，再由 client.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationClient，也别在模块顶层读它的状态。
//
// 拆分的理由（P2-10）：client.ts 一个文件里塞了传输层与 90 个业务方法，
// 想改「笔记附件怎么传」要在 1500 行里翻。按域分开之后，每个域自己长得清楚，
// 传输层的改动（超时 / 幂等头 / 错误翻译）也不会再和业务方法混在一处。
// 范式照抄 src/API/http.ts + methods/*.ts —— 那套已经跑了很久，
// 并且有 tests/clientSurface.test.ts 盯着「域没混回原型」这类静默失效。

import {
    Group,
    Site,
    GroupShareConfig,
    SiteOrderUpdateResult,
    SiteBatchDeleteResult,
} from "../http";
import type {
    GroupListResponse,
    GroupOrdersResponse,
    SiteBatchDeleteResponse,
    SiteListResponse,
    SiteOrdersResponse,
    SoftDeleteResponse,
} from "../responses";
import { markLocalSiteDeletes } from "../../utils/siteSync";
import type { ClientThis } from "../transport";

export const sitesImpl = {
    async getGroups(this: ClientThis): Promise<Group[]> {
        return this.request<GroupListResponse>("groups");
    },
    /**
     * ⚠️ 返回类型带 null：服务端 `NavigationAPI.getGroup` 的签名就是 `Group | null`
     * （见 methods/data.ts），分组不存在时它给 null，不给 404。
     * 以前这里写 `Promise<Group>` 是在替一个可能为空的响应做担保 ——
     * 调用方拿到 null 却被告知「一定有」，接下来的 `group.name` 就是 TypeError。
     * （没有调用点，所以这个谎言一直没被撞破。）
     */
    async getGroup(this: ClientThis, id: number): Promise<Group | null> {
        return this.request<Group | null>(`groups/${id}`);
    },
    async createGroup(this: ClientThis, group: Group): Promise<Group> {
        return this.request<Group>("groups", {
            method: "POST",
            body: JSON.stringify(group),
        });
    },
    async updateGroup(this: ClientThis, id: number, group: Partial<Group>): Promise<Group> {
        return this.request<Group>(`groups/${id}`, {
            method: "PUT",
            body: JSON.stringify(group),
        });
    },
    async deleteGroup(this: ClientThis, id: number): Promise<{ success: boolean; recycleId?: number }> {
        const res = await this.request<SoftDeleteResponse>(`groups/${id}`, {
            method: "DELETE",
        });
        // HTTP 200 就说明删掉了；recycleId 是老服务端不一定给的「撤销」凭据
        return { success: res?.success !== false, recycleId: res?.recycleId };
    },
    async getSites(this: ClientThis, groupId?: number): Promise<Site[]> {
        const endpoint = groupId ? `sites?groupId=${groupId}` : "sites";
        return this.request<SiteListResponse>(endpoint);
    },
    async getSite(this: ClientThis, id: number): Promise<Site> {
        return this.request<Site>(`sites/${id}`);
    },
    async siteChanges(this: ClientThis, since?: string): Promise<{ deleted: number[]; since: string }> {
        const endpoint = since
            ? `sites/changes?since=${encodeURIComponent(since)}`
            : "sites/changes";
        return this.request<{ deleted: number[]; since: string }>(endpoint);
    },
    async createSite(this: ClientThis, site: Site): Promise<Site> {
        return this.request<Site>("sites", {
            method: "POST",
            body: JSON.stringify(site),
        });
    },
    async updateSite(this: ClientThis, id: number, site: Partial<Site>): Promise<Site> {
        return this.request<Site>(`sites/${id}`, {
            method: "PUT",
            body: JSON.stringify(site),
        });
    },
    async deleteSite(this: ClientThis, id: number): Promise<{ success: boolean; recycleId?: number }> {
        const res = await this.request<SoftDeleteResponse>(`sites/${id}`, {
            method: "DELETE",
        });
        if (res?.success !== false) {
            // 记下「这是本设备删的」：轮询同步过滤掉，不弹「其它设备删除了 N 张卡片」
            markLocalSiteDeletes([id]);
        }
        return { success: res?.success !== false, recycleId: res?.recycleId };
    },
    async deleteSites(this: ClientThis, ids: number[]): Promise<SiteBatchDeleteResult> {
        const result = await this.request<SiteBatchDeleteResponse>("sites/batch-delete", {
            method: "POST",
            body: JSON.stringify({ ids }),
        });
        // 同单删：本设备删的不让同步轮询误报成「其它设备删的」。
        // 只记 items 里真删掉的；failed 的本来就没删，不该记。
        if (Array.isArray(result?.items) && result.items.length > 0) {
            markLocalSiteDeletes(result.items.map(i => i.id));
        }
        return result;
    },
    async updateGroupOrder(this: ClientThis, groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        const response = await this.request<GroupOrdersResponse>("group-orders", {
            method: "PUT",
            body: JSON.stringify(groupOrders),
        });
        return response?.success !== false;
    },
    async updateSiteOrder(this: ClientThis, 
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<SiteOrderUpdateResult> {
        const response = await this.request<SiteOrdersResponse>("site-orders", {
            method: "PUT",
            body: JSON.stringify(siteOrders),
        });

        // 兼容还在跑的老服务端（只回 { success: boolean }）：拿不到明细就当「成功的是全部 /
        // 失败的为零」，行为和以前一致 —— 前端不会因为它少给两个字段就走不通
        const allIds = siteOrders.map(item => item.id);
        const updated = Array.isArray(response?.updated) ? response.updated : allIds;
        const failed = Array.isArray(response?.failed) ? response.failed : [];

        return {
            success: failed.length === 0 && response?.success !== false,
            updated,
            failed,
        };
    },
    async createGroupShare(this: ClientThis, id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null> {
        return this.request<GroupShareConfig | null>(`groups/${id}/share`, {
            method: "POST",
            body: JSON.stringify({ days, password: password ?? null }),
        });
    },
    async updateGroupShare(this: ClientThis, id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null> {
        return this.request<GroupShareConfig | null>(`groups/${id}/share`, {
            method: "PUT",
            body: JSON.stringify({ days, password }),
        });
    },
    async revokeGroupShare(this: ClientThis, id: number): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>(`groups/${id}/share`, { method: "DELETE" });
    },
    async getGroupShareConfig(this: ClientThis, id: number): Promise<GroupShareConfig | null> {
        return this.request<GroupShareConfig | null>(`groups/${id}/share`);
    },
};
