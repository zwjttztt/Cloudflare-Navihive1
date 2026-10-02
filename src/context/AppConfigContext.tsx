// src/context/AppConfigContext.tsx
// 「网站设置」全局配置的 Provider：把配置透传给深层组件，
// 避免 App -> GroupCard -> SiteCard -> SiteSettingsModal 一层层往下传 props。
//
// 这个文件**只导出组件**。Context 对象、默认值、useAppConfig 都在 ./appConfigStore.ts，
// 要取配置的组件请从那边引（连带拉进 Provider 组件会绕开这次拆分，也会让热更新降级）。
import { AppConfigContext } from "./appConfigStore";

export const AppConfigProvider = AppConfigContext.Provider;

export default AppConfigContext;
