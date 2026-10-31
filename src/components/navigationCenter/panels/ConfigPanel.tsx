// src/components/navigationCenter/panels/ConfigPanel.tsx
// 「全站设置」面板（懒加载面板块）：只做一层转发，业务体在 SettingsDialog 的 ConfigPanel。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
import ConfigPanelBody, { type ConfigPanelProps } from "../../SettingsDialog";
export type ConfigCenterPanelProps = ConfigPanelProps;
export default ConfigPanelBody;
