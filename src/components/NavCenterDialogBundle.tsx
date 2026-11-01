/**
 * 「设置」统一中心的懒加载包装：把「prop 组装 + 中心外壳」整体挪出首屏包。
 *
 * 背景（2026-11-01，A1 拆分）：原先 NavigationCenterDialog 的九面板 props 是一大坨
 * 内联对象摊在 App.tsx 的 return 里。抽成 navCenterDialogProps.ts 纯函数后，
 * 该模块（约 2.9 KB）进了首屏包，把首屏预算的 gzip 余量从 3.0% 压到 2.8%（棘轮红线 3%）。
 * 按预算用例自己给的方向（「把只在触发后才出现的组件改成 lazy」），这里再包一层
 * lazy 组件：App 只传 args，组装函数与外壳一起「打开中心才下载」。
 *
 * ⚠️ 必须经 ChunkBoundary when={navCenterOpen} 挂载 —— 关着时不下载任何一块。
 */
import NavigationCenterDialog from "./NavigationCenterDialog";
import {
    buildNavCenterDialogProps,
    type NavCenterDialogArgs,
} from "./navCenterDialogProps";

export default function NavCenterDialogBundle({ args }: { args: NavCenterDialogArgs }) {
    return <NavigationCenterDialog {...buildNavCenterDialogProps(args)} />;
}
