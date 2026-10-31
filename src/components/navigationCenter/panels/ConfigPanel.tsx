// src/components/navigationCenter/panels/ConfigPanel.tsx
// 「全站设置」三个面板（懒加载面板块）：只做一层转发，业务体在 SettingsDialog 的 ConfigPanel。
// 强制 withDialog={false}：中心自带 Dialog 外壳，这里绝不能再套一层。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
//
// ⚠️ 必须拿**具名**导出（业务本体），不能拿默认导出：
// SettingsDialog 的默认导出是 `<ConfigPanel {...props} withDialog />`，
// 它把 withDialog 硬写成 true，再传 false 也压不住 —— 那正是「中心里又弹一层」的病根。
//
// 为什么三个面板挤在同一个文件：它们共用同一份业务体（SettingsDialog 的
// ConfigPanelBody），只在 `section` 上分叉。三个 lazy 入口指向**同一个模块**，
// 打包器只会出**一个** chunk —— 拆成三个文件会把这个大块复制三份进三个 chunk，
// 首屏预算经不起这种手滑。
import { ConfigPanel as ConfigPanelBody, type ConfigPanelProps } from "../../SettingsDialog";
export type ConfigCenterPanelProps = ConfigPanelProps;

/** 外观与搜索（原「全站设置」第一张 Tab） */
export function ConfigAppearancePanel(props: ConfigPanelProps) {
    return <ConfigPanelBody {...props} section='appearance' withDialog={false} />;
}

/** 数据与同步（原第二张 Tab：离线 / 同步 / 维护 / 保留） */
export function ConfigDataPanel(props: ConfigPanelProps) {
    return <ConfigPanelBody {...props} section='data' withDialog={false} />;
}

/** 高级（原第三张 Tab：自定义 CSS / 版本升级） */
export function ConfigAdvancedPanel(props: ConfigPanelProps) {
    return <ConfigPanelBody {...props} section='advanced' withDialog={false} />;
}
