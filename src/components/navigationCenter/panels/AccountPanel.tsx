// src/components/navigationCenter/panels/AccountPanel.tsx
// 「账号与安全」面板（懒加载面板块）：只做一层转发，业务体在 AccountDialog 的 AccountPanel。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
import AccountPanelBody, { type AccountPanelProps } from "../../AccountDialog";
export type AccountCenterPanelProps = AccountPanelProps;
export default AccountPanelBody;
