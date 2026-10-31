// src/components/navigationCenter/panels/AuditPanel.tsx
// 中心里的「审计日志」面板（数据与活动）。仅站点所有者可见。
//
// 业务本体是 `AuditDialog.tsx` 里那个命名导出的 `AuditPanel`：
// 操作日志（按操作者筛选 + 分页加载更多）与前端错误聚合两个视图。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { AuditPanel as AuditBody } from "../../AuditDialog";
import type { AuditPanelProps } from "../../AuditDialog";

export type AuditCenterPanelProps = AuditPanelProps;

export default function AuditPanel(props: AuditCenterPanelProps) {
    return <AuditBody {...props} />;
}
