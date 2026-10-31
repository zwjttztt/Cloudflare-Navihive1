// src/components/navigationCenter/panels/RecyclePanel.tsx
// 中心里的「回收站」面板（数据与活动）。
//
// 业务本体是 `RecycleBinDialog.tsx` 里那个命名导出的 `RecyclePanel`：
// 站点 / 分组两个页签（带计数）、单项还原、单项彻底删除与「清空回收站」的二次确认。
// 三个确认弹窗都留在面板内部（它们在中心之上开，关掉后回到本屏）。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { RecyclePanel as RecycleBody } from "../../RecycleBinDialog";
import type { RecyclePanelProps } from "../../RecycleBinDialog";

export type RecycleCenterPanelProps = RecyclePanelProps;

export default function RecyclePanel(props: RecycleCenterPanelProps) {
    return <RecycleBody {...props} />;
}
