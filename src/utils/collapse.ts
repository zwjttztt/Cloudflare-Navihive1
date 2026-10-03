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

/**
 * 「全部折叠」开关当前该显示折叠还是展开。
 *
 * 注意空列表返回 false（没有分组时不该显示成「已全部折叠」，
 * 否则开关按下去什么都不会发生）。id 一律按字符串比 —— localStorage 里存的是字符串，
 * 直接 `includes(g.id)` 拿数字去比会永远匹配不上。
 */
export function isAllCollapsed(
    groups: { id?: number | string }[] | null | undefined,
    collapsedIds: string[] | null | undefined
): boolean {
    const ids = (groups || []).filter(g => typeof g.id === "number" && g.id > 0);
    if (ids.length === 0) return false;
    const set = new Set((collapsedIds || []).map(String));
    return ids.every(g => set.has(String(g.id)));
}
