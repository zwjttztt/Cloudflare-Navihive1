// src/components/navigationCenter/panels/BackupPanel.tsx
// 中心里的「备份与恢复」面板（数据与活动）。
//
// 业务本体是 `BackupDialog.tsx` 里那个命名导出的 `BackupPanel`：备份到本地 / WebDAV、
// 从本地文件或远端恢复、导入差异预览、导入进度、定时任务失败留痕。
// 这里只做一层转发 —— 面板文件存在是为了**懒加载边界**。
//
// 两个与弹窗不同的地方（都是刻意的）：
//   · 不传 `onRestored`：恢复成功后**不关中心**，只弹提示条。中心装了九屏，
//     因为一次恢复成功就把整中心关掉，比留着更让人意外；
//   · 「导入浏览器书签」改成在中心**之上**打开（见 App 的 onOpenBookmark），
//     关掉之后回到本面板，而不是把中心一起关掉。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { BackupPanel as BackupBody } from "../../BackupDialog";
import type { BackupPanelProps } from "../../BackupDialog";

/** 中心里不需要「恢复成功后关掉自己」这一路，故 Omit */
export type BackupCenterPanelProps = Omit<BackupPanelProps, "onRestored">;

export default function BackupPanel(props: BackupCenterPanelProps) {
    return <BackupBody {...props} />;
}
