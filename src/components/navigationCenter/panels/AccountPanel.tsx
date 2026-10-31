// src/components/navigationCenter/panels/AccountPanel.tsx
// 「账号与安全」面板（懒加载面板块）：只做一层转发，业务体在 AccountDialog 的 AccountPanel。
// 强制 withDialog={false}：AccountPanel 的默认值是 true，不压住就会在中心里再弹一层 Dialog。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
//
// ⚠️ 必须拿**具名**导出 `AccountPanel`（业务本体），不能拿默认导出：
// AccountDialog 的默认导出是 `<AccountPanel {...props} withDialog />`，
// 它把 withDialog 硬写成 true，再传 false 也压不住。
import {
    AccountPanel as AccountPanelBody,
    type AccountPanelProps,
} from "../../AccountDialog";
export type AccountCenterPanelProps = AccountPanelProps;
export default function AccountPanel(props: AccountPanelProps) {
    return <AccountPanelBody {...props} withDialog={false} />;
}
