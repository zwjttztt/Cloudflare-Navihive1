// src/components/navigationCenter/panels/ConfigPanel.tsx
// 「全站设置」面板（懒加载面板块）：只做一层转发，业务体在 SettingsDialog 的 ConfigPanel。
// 强制 withDialog={false}：中心自带 Dialog 外壳，这里绝不能再套一层。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
//
// ⚠️ 必须拿**具名**导出 `ConfigPanel`（业务本体），不能拿默认导出：
// SettingsDialog 的默认导出是 `<ConfigPanel {...props} withDialog />`，
// 它把 withDialog 硬写成 true，再传 false 也压不住 —— 那正是「中心里又弹一层」的病根。
import { ConfigPanel as ConfigPanelBody, type ConfigPanelProps } from "../../SettingsDialog";
export type ConfigCenterPanelProps = ConfigPanelProps;
export default function ConfigPanel(props: ConfigPanelProps) {
    return <ConfigPanelBody {...props} withDialog={false} />;
}
