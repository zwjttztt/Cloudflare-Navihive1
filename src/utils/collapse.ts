// src/utils/collapse.ts
// 分组收起状态：GroupCard 与「全部折叠/展开」共用同一份 localStorage + 广播事件。
// 单独放一个文件，避免两个组件各自维护 key 而写歪。
export const COLLAPSED_GROUPS_KEY = "navihive:collapsedGroups";
/** 批量改变收起状态后广播，让所有 GroupCard 立刻同步（storage 事件在同页面不触发） */
export const COLLAPSED_EVENT = "navihive:collapsed-changed";

export const readCollapsedGroupIds = (): string[] => {
    try {
        const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
};

export const writeCollapsedGroupIds = (ids: string[]) => {
    try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(ids));
    } catch {
        // 隐私模式等场景下写入失败，忽略即可
    }
    window.dispatchEvent(new Event(COLLAPSED_EVENT));
};

/** 一次性把所有分组设为收起 / 展开 */
export const setAllCollapsed = (ids: (number | string)[], collapsed: boolean) => {
    writeCollapsedGroupIds(collapsed ? ids.map(String) : []);
};
