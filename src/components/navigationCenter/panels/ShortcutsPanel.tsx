// src/components/navigationCenter/panels/ShortcutsPanel.tsx
// 中心里的「快捷键与操作帮助」面板（个人与支持）。
//
// 业务本体是 `ShortcutsDialog.tsx` 里那个命名导出的 `ShortcutsPanel`：
// 快捷键说明表 + 安装到桌面入口。这里只做一层转发 —— 面板文件存在是为了
// **懒加载边界**（只有切到这一屏才下载这一块）。
//
// ⚠️ 这个文件是**懒加载面板块**：只能被 NavigationCenterDialog 用 `lazy(() => import(...))`
//    引入，任何静态 import 都会把它焊进首屏（tests/navigationCenterLazyGuard.test.ts 盯着）。
import { ShortcutsPanel as ShortcutsBody } from "../../ShortcutsDialog";
import type { ShortcutsPanelProps } from "../../ShortcutsDialog";

/** 中心里不需要「关闭自己」这一路，业务体本身就不带 Dialog 壳 */
export type ShortcutsCenterPanelProps = ShortcutsPanelProps;

export default function ShortcutsPanel(props: ShortcutsCenterPanelProps) {
    return <ShortcutsBody {...props} />;
}
