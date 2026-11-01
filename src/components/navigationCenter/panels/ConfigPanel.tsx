// src/components/navigationCenter/panels/ConfigPanel.tsx
// 「全站设置」两个面板（懒加载面板块）：只做一层转发，业务体在 ConfigPanelBody。
// ⚠️ 只允许被 NavigationCenterDialog 用 lazy import 引入，静态 import 会把它焊进首屏。
//
// 业务本体现在**只做内嵌面板**（section 必填、无自带 Dialog 外壳），所以这里只按
// section 分叉即可 —— 独立弹窗那条路径已删除，不再需要 withDialog 压制。
//
// 为什么两个面板挤在同一个文件：它们共用同一份业务体（ConfigPanelBody 的
// ConfigPanel），只在 `section` 上分叉。两个 lazy 入口指向**同一个模块**，
// 打包器只会出**一个** chunk —— 拆成两个文件会把这个大块复制两份进两个 chunk，
// 首屏预算经不起这种手滑。
import { ConfigPanel as ConfigPanelBody, type ConfigPanelProps } from "../../ConfigPanelBody";
/** 中心侧传入的 props：section 由下面两个转发件各自补上，所以这里去掉它 */
export type ConfigCenterPanelProps = Omit<ConfigPanelProps, "section">;

/** 外观与搜索（原「全站设置」第一张 Tab） */
export function ConfigAppearancePanel(props: ConfigCenterPanelProps) {
    return <ConfigPanelBody {...props} section='appearance' />;
}

/** 数据与维护（原第二张 Tab：离线 / 同步 / 维护 + 版本升级；数据保留已迁「数据安全」） */
export function ConfigDataPanel(props: ConfigCenterPanelProps) {
    return <ConfigPanelBody {...props} section='data' />;
}
