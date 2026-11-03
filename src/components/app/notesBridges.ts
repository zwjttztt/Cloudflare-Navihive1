// src/components/app/notesBridges.ts
// App ↔ 记事本之间的两座桥（D2 双向绑定 / #477 反查）。
//
// 两座桥原来都以内联字面量的形式写在 App.tsx 的 return 上方：一座给**站点侧**用
// （context 下发，见 context/appConfigStore.ts 的 notesBridge），一座给**笔记侧**用
// （作为 prop 透传给 NotesOverlay）。加起来约 100 行，中间夹着 App 的其它派生逻辑，
// 谁读都得先跳过它们 —— 所以整块搬到这个文件（2026-11 D6）。
//
// 这里只做「组装」：所有副作用（打开记事本、跳卡片、重取数据）都由宿主传进来，
// 于是这两座桥可以脱离 App 单独读。**没有任何行为变化**：每个字段的实现、
// 出错时的兜底（老部署没有 notes/search 端点 → 返回空数组而不是弹错）都原样保留。

import type { AppConfigContextValue } from "../../context/appConfigStore";
import type { NotesSiteLinkApi } from "../notes/notesPageCtx";
import type { GroupWithSites } from "../../types";
import type { NavigationClient } from "../../API/client";
import type { MockNavigationClient } from "../../API/mock";

/** 站点侧那座桥的形状（定义在 context/appConfigStore.ts，那边是可选字段） */
export type NotesBridge = NonNullable<AppConfigContextValue["notesBridge"]>;

/** App 里那个模块级 api 单例的类型（真客户端或 mock，见 App.tsx 顶部） */
type AppApi = NavigationClient | MockNavigationClient;

export interface NotesBridgeHost {
    api: AppApi;
    /** 打开记事本并跳到这条笔记（App 里是 setNotesFocusId + setNotesOpen） */
    onOpenNote: (noteId: number) => void;
    /** 重取一次卡片数据（静默）。写入落库后卡片上的 note_id / note_title 要跟着变 */
    refetchSites: () => void;
}

/**
 * 造「站点侧」那座桥：搜笔记 / 跳过去 / 列全部 / 绑定 / 新建并绑定 / 取正文。
 */
export function createNotesBridge({
    api,
    onOpenNote,
    refetchSites,
}: NotesBridgeHost): NotesBridge {
    return {
        search: async (query: string, limit = 50) => {
            try {
                const res = await api.notesSearch(query, limit);
                // ⚠️ 搜索端点只回**片段**（snippet），不回全文 ——
                // 站点那边拿它做「有没有提到这个站」的判据足够
                // （片段是围着命中位置截的，站名/网址就在里面），
                // 换来的是不用把所有笔记正文拉一遍。
                return (res?.results ?? []).map(hit => ({
                    id: hit.id,
                    title: hit.title || "",
                    content: hit.snippet || "",
                }));
            } catch {
                // 老部署没有 notes/search 端点（404/500）：返回空，
                // 站点设置里那小节显示「还没有笔记提到它」，不弹错
                return [];
            }
        },
        open: (noteId: number) => {
            onOpenNote(noteId);
        },
        // ---- #477 站点↔笔记绑定的三条写操作 ----
        // 绑定关系存在笔记侧（notes.site_id），站点那边的 note_id / note_title
        // 是查出来的，所以每次落库后都得重取一次卡片。
        list: async () => {
            try {
                // summary 模式：正文只取开头一小段，这里只用到 id / 标题 / 绑定站点
                const rows = await api.listNotes({ summary: true });
                return rows.map(n => ({
                    id: n.id,
                    title: n.title || "",
                    site_id: n.site_id ?? null,
                }));
            } catch {
                return [];
            }
        },
        bind: async (noteId: number, siteId: number | null) => {
            await api.updateNote(noteId, { site_id: siteId });
            refetchSites();
        },
        createAndBind: async (siteId: number, title: string) => {
            // createNote 已经认 site_id，且服务端会在插入前把该站点上
            // 原来那篇解绑 —— 一步到位，不需要「先建再绑」两次往返
            const created = await api.createNote({ title, content: "", site_id: siteId });
            refetchSites();
            return { id: created.id, title: created.title || title };
        },
        // 卡片上点「笔记」先弹预览（2026-10-23 用户要求）：预览要正文，
        // 而站点列表里带的是标题，正文得按 id 单独取一次。
        get: async (noteId: number) => {
            try {
                const note = await api.getNote(noteId);
                if (!note) return null;
                return { title: note.title || "", content: note.content || "" };
            } catch {
                return null;
            }
        },
    };
}

export interface NotesSiteLinkHost {
    groups: GroupWithSites[];
    /** 关掉记事本层（它盖在页面上，先滚也看不见） */
    closeNotes: () => void;
    /** 滚到某张卡片并闪一下轮廓（App 的 jumpToSite） */
    jumpToSite: (siteId: number) => void;
    /** 重取一次卡片数据（静默） */
    refetchSites: () => void;
}

/**
 * 造「笔记侧」那座桥：这篇笔记属于哪个站点、点一下跳回卡片、绑定清单、刷新。
 *
 * 站名直接从内存里的分组树查（几十张卡的一次线性扫），不额外发请求 ——
 * 为了显示一个名字去拉一遍 /api/sites 不值当。
 *
 * 跳转复用 jumpToSite：先关掉记事本层（它盖在页面上，先滚也看不见），
 * 隔一小段再滚 —— 等那一层卸载、布局稳定下来，滚到的位置才是对的。
 */
export function createNotesSiteLinkApi({
    groups,
    closeNotes,
    jumpToSite,
    refetchSites,
}: NotesSiteLinkHost): NotesSiteLinkApi {
    return {
        resolve: (siteId: number) => {
            for (const group of groups) {
                const hit = group.sites?.find(s => s.id === siteId);
                if (hit) return { id: hit.id, name: hit.name };
            }
            // 查不到 = 那张卡片已经被删了。悬空引用是刻意的（笔记要留下），
            // 记事本那边会显示成「站点已删除」。
            return null;
        },
        open: (siteId: number) => {
            closeNotes();
            window.setTimeout(() => jumpToSite(siteId), 60);
        },
        /**
         * 笔记右键「绑定网站」的选择器要用这份清单（2026-10-23）。
         * 直接从内存的分组树摊平，不发请求；带上 note_id / note_title 是为了
         * 在选择器里提醒「这个站已经绑了『X』，绑上会把它换下来」。
         */
        list: () =>
            groups.flatMap(group =>
                (group.sites ?? []).map(site => ({
                    id: site.id,
                    name: site.name,
                    note_id: site.note_id ?? null,
                    note_title: site.note_title ?? null,
                }))
            ),
        /**
         * 绑定关系变了 → 重取卡片。写入本身在记事本那边（`onUpdate`），
         * 这里只负责让卡片上的 note_id / note_title 跟上，别留旧状态。
         */
        refresh: () => {
            refetchSites();
        },
    };
}
