// src/utils/importSummary.ts
// 把服务端数出来的「新增 / 复用 / 跳过」账目说成人话。
//
// 放在这里而不是组件里：这条文案要在恢复成功提示、以后的数据页都用它，
// 挪出去才能被单独测到 —— 「重复导入必须显示为新增 0」是幂等性唯一的可见证据，
// 写错或者漏写 , assertEquals 也不好改的时候才会被发现。
import type { ImportStats } from "../API/types";

/**
 * @returns 一句可以直接弹给用户的话；拿不到统计时返回 null（调用方回落到原提示）
 */
export function summarizeImportStats(stats?: ImportStats | null): string | null {
    if (!stats) return null;
    const {
        groupsCreated,
        groupsMatched,
        sitesCreated,
        sitesUpdated,
        sitesSkipped,
        groupsRemoved,
        sitesRemoved,
    } = stats;
    const removed = groupsRemoved ?? 0;
    const removedSites = sitesRemoved ?? 0;
    if (
        groupsCreated === 0 &&
        sitesCreated === 0 &&
        sitesUpdated === 0 &&
        groupsMatched === 0 &&
        sitesSkipped === 0 &&
        removed === 0 &&
        removedSites === 0
    ) {
        // 一次都没动：多半是这份备份里没有任何分组 / 卡片
        return "导入完成：没有需要新增的内容";
    }
    const parts: string[] = [];
    if (groupsCreated > 0 || sitesCreated > 0) {
        parts.push(`新增 ${groupsCreated} 个分组、${sitesCreated} 张卡片`);
    }
    if (sitesUpdated > 0) parts.push(`更新 ${sitesUpdated} 张`);
    if (sitesSkipped > 0 || groupsMatched > 0) {
        parts.push(`${groupsMatched} 个分组与 ${sitesSkipped} 张卡片已存在，原样保留`);
    }
    // 覆盖导入删掉的条目必须给个数：删了多少要说在前头，不能只报「导入完成」
    if (removed > 0 || removedSites > 0) {
        parts.push(`删除 ${removed} 个分组、${removedSites} 张卡片`);
    }
    if (parts.length === 0) return null;
    return `导入完成：${parts.join("，")}`;
}
