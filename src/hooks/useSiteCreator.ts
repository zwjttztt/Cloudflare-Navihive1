// src/hooks/useSiteCreator.ts
// 「新建分组 / 新建卡片」这一个域：从 App.tsx 整块搬过来的。
// 和排序域一样分工：纯计算在 src/utils/siteForm.ts（有单测），
// 这里只管状态、发请求、提示、以及「连点只提交一次」这类闸门。
import { useCallback, useRef, useState } from "react";
import type { Group, Site } from "../API/http";
import { applySiteInputChange, emptySiteDraft, nextSiteOrderNum } from "../utils/siteForm";
import { resolveIconApiUrl } from "../utils/iconApi";
import { normalizeFailureText, normalizeUrl } from "../utils/url";
import { reportError } from "../utils/errorReporter";
import { OfflineQueuedError } from "../API/offlineQueue";
import type { GroupWithSites } from "../types";
import type { NotifySeverity } from "./useNotify";

/** 本域用到的三个后端方法，单测里可以塞假实现 */
export type CreatorApi = {
    createGroup(input: Group): Promise<Group | undefined>;
    createSite(input: Site): Promise<Site | undefined>;
};

type UseSiteCreatorParams = {
    api: CreatorApi;
    groupsRef: { current: GroupWithSites[] };
    setGroups: (updater: (prev: GroupWithSites[]) => GroupWithSites[]) => void;
    /** 新建成功后把服务端回显插进本地列表（来自 useSites） */
    upsertSiteLocally: (site: Site) => void;
    /** 重复链接闸门：没重复就直接跑、有重复则弹确认（确认后才会调 run） */
    guardDuplicate: (
        url: string | undefined,
        excludeId: number | undefined,
        run: () => void | Promise<void>
    ) => boolean;
    iconApi: string;
    onError: (message: string) => void;
    onNotify: (message: string, level?: NotifySeverity) => void;
    onMenuClose: () => void;
};

export function useSiteCreator({
    api,
    groupsRef,
    setGroups,
    upsertSiteLocally,
    guardDuplicate,
    iconApi,
    onError,
    onNotify,
    onMenuClose,
}: UseSiteCreatorParams) {
    const [openAddGroup, setOpenAddGroup] = useState(false);
    const [openAddSite, setOpenAddSite] = useState(false);
    const [newSite, setNewSite] = useState<Partial<Site>>(emptySiteDraft);
    // 新增卡片时是否明文显示密码
    const [showNewSitePassword, setShowNewSitePassword] = useState(false);
    // 正在创建：按钮置灰 + 防连点
    const [creatingSite, setCreatingSite] = useState(false);
    // setState 要等下一次渲染才生效，连点两下时用 ref 同步兜住
    const creatingSiteRef = useRef(false);

    // ---- 新建分组 ----

    const handleOpenAddGroup = useCallback(() => {
        onMenuClose();
        setOpenAddGroup(true);
    }, [onMenuClose]);

    const handleCloseAddGroup = useCallback(() => setOpenAddGroup(false), []);

    const handleCreateGroup = useCallback(
        async (name: string) => {
            const groupName = (name || "").trim();
            try {
                if (!groupName) {
                    onError("分组名称不能为空");
                    return;
                }

                const created = await api.createGroup({
                    name: groupName,
                    order_num: groupsRef.current.length,
                } as Group);
                // 服务端返回新建分组，直接追加到本地列表，无需重新加载
                if (created && created.id !== undefined) {
                    setGroups(prev => [...prev, { ...created, id: created.id as number, sites: [] }]);
                }
                setOpenAddGroup(false);
            } catch (error) {
                // 离线：分组已经排队等着联网后创建，但用户此刻就该看得见它 ——
                // 否则「离线新建分组 → 在它下面加站点」这条路根本走不通（没有 id 可挂）。
                // 拿队列给的占位 id 先在本地显示一个空分组，联网重放后自动换成真实 id。
                if (error instanceof OfflineQueuedError && typeof error.tempId === "number") {
                    const tempId = error.tempId;
                    setGroups(prev => [
                        ...prev,
                        { id: tempId, name: groupName, order_num: groupsRef.current.length, sites: [] } as GroupWithSites,
                    ]);
                    setOpenAddGroup(false);
                    onNotify("网络已断开：分组已暂存本地，联网后自动创建", "info");
                    return;
                }
                console.error("创建分组失败:", error);
                reportError(error, { source: "group-create" });
                onError("创建分组失败: " + (error as Error).message);
            }
        },
        [api, groupsRef, onError, onNotify, setGroups]
    );

    // ---- 新建站点 ----

    const handleOpenAddSite = useCallback((groupId: number) => {
        const group = groupsRef.current.find(g => g.id === groupId);
        setNewSite({
            ...emptySiteDraft(),
            group_id: groupId,
            order_num: nextSiteOrderNum(group),
        });
        // 每次打开都从「密码隐藏」状态开始，并清掉上一次的提交锁
        setShowNewSitePassword(false);
        creatingSiteRef.current = false;
        setCreatingSite(false);
        setOpenAddSite(true);
    }, [groupsRef]);

    const handleCloseAddSite = useCallback(() => setOpenAddSite(false), []);

    const handleSiteInputChange = useCallback(
        (e: { target: { name: string; value: string } }) => {
            const { name, value } = e.target;
            setNewSite(prev => applySiteInputChange(prev, iconApi, name, value));
        },
        [iconApi]
    );

    // 新增站点时：按配置的图标 API 一键生成图标 URL
    const handleFetchNewSiteIcon = useCallback(() => {
        const resolved = resolveIconApiUrl(iconApi, newSite.url || "");
        if (!resolved) {
            onError("请先填写有效的站点URL，再获取图标");
            return;
        }
        setNewSite(prev => ({ ...prev, icon: resolved }));
        onNotify("已根据站点链接生成图标URL", "success");
    }, [iconApi, newSite.url, onError, onNotify]);

    const handleCreateSite = useCallback(async () => {
        // 连点「创建」只提交一次，避免创建出多张重复卡片
        if (creatingSiteRef.current) return;
        creatingSiteRef.current = true;
        setCreatingSite(true);

        const release = () => {
            creatingSiteRef.current = false;
            setCreatingSite(false);
        };

        if (!newSite.name || !newSite.url) {
            onError("站点名称和URL不能为空");
            release();
            return;
        }

        // 网址规范化：补上 https://、挡掉 javascript: 这类危险协议。
        // <input type="url"> 拦得住 baidu.com 却放行 javascript:alert(1)（实测 Chrome 行为），
        // 而卡片是 href={site.url} 直出的，所以入库前必须自己过一道。
        const urlCheck = normalizeUrl(newSite.url || "");
        if (!urlCheck.ok) {
            onError(normalizeFailureText(urlCheck.reason));
            release();
            return;
        }
        const siteToCreate = { ...newSite, url: urlCheck.url } as Site;

        const doCreate = async () => {
            try {
                const created = await api.createSite(siteToCreate);
                // 服务端返回新建站点，直接插入本地列表，界面立即出现新卡片（无需刷新页面）
                if (created && created.id !== undefined) {
                    upsertSiteLocally(created);
                }
                setOpenAddSite(false);
                onNotify("卡片已添加", "success");
            } catch (error) {
                // 离线：卡片已经排队，本地先显示出来（占位 id），联网重放后换成真实 id。
                // 分组是离线新建的时候，这里的 group_id 也是占位 id —— 重放时由队列翻译成真实号。
                if (error instanceof OfflineQueuedError && typeof error.tempId === "number") {
                    upsertSiteLocally({ ...siteToCreate, id: error.tempId } as Site);
                    setOpenAddSite(false);
                    onNotify("网络已断开：卡片已暂存本地，联网后自动创建", "info");
                    return;
                }
                console.error("创建站点失败:", error);
                onError("创建站点失败: " + (error as Error).message);
            } finally {
                release();
            }
        };

        // 同一条链接已经加过就先问一句，用户确认「仍然添加」才真的写库
        if (!guardDuplicate(siteToCreate.url, undefined, doCreate)) release();
    }, [api, guardDuplicate, newSite, onError, onNotify, upsertSiteLocally]);

    return {
        openAddGroup,
        openAddSite,
        newSite,
        setNewSite,
        showNewSitePassword,
        setShowNewSitePassword,
        creatingSite,
        handleOpenAddGroup,
        handleCloseAddGroup,
        handleCreateGroup,
        handleOpenAddSite,
        handleCloseAddSite,
        handleSiteInputChange,
        handleFetchNewSiteIcon,
        handleCreateSite,
    };
}
