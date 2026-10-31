// src/components/navigationCenter/panels/StatsPanel.tsx
// 中心里的「统计」面板（数据与活动）。
//
// 业务本体是 `StatsHubDialog.tsx` 里那个命名导出的 `StatsHubPanel`：
// 访问统计（本机 localStorage）+ 运营看板（服务端，仅 owner）。这里只做一层
// 转发 —— 面板文件存在是为了**懒加载边界**（只有切到这一屏才下载这一块）。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { StatsHubPanel } from "../../StatsHubDialog";
import type { StatsHubPanelProps } from "../../StatsHubDialog";

export type StatsPanelProps = StatsHubPanelProps;

export default function StatsPanel(props: StatsPanelProps) {
    return <StatsHubPanel {...props} />;
}
