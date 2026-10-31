// src/components/navigationCenter/panels/VaultPanel.tsx
// 中心里的「密码保险库」面板（系统与工具）。
//
// 业务本体是 `VaultDialog.tsx` 里那个命名导出的 `VaultPanel`：建库 / 解锁 / 找回 / 条目管理。
// 这里只做一层转发 —— 面板文件存在是为了**懒加载边界**（只有切到这一屏才下载这一块）。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { VaultPanel as VaultBody } from "../../VaultDialog";
import type { VaultPanelProps } from "../../VaultDialog";

/** 中心里不需要「关闭自己」这一路，业务体本身就不带 Dialog 壳（withDialog=false） */
export type VaultCenterPanelProps = VaultPanelProps;

export default function VaultPanel(props: VaultCenterPanelProps) {
    return <VaultBody {...props} />;
}
