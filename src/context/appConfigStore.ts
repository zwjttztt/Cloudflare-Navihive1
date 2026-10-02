// src/context/appConfigStore.ts
// 「网站设置」全局配置（图标 API、背景图等）的 Context 与取值 hook —— **不含组件**。
//
// 从 AppConfigContext.tsx 拆出来，跟 uiPrefsStore 同一个道理：Provider 那边
// 现在只导出组件，热更新不会因为「文件里混着 hook 导出」而降级成整页刷新。
import { createContext, useContext } from "react";

export interface AppConfigContextValue {
    /** 图标 API 模板，含 {domain} 占位符 */
    iconApi: string;
    /** 站点缩略图 API 模板，留空表示不启用缩略图 */
    thumbApi: string;
    /** 背景图片 URL，空字符串表示不使用 */
    backgroundImage: string;
    /** 背景蒙版透明度 0~1 */
    backgroundMaskOpacity: string;
}

export const APP_CONFIG_DEFAULT: AppConfigContextValue = {
    iconApi: "",
    thumbApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

export const AppConfigContext = createContext<AppConfigContextValue>(APP_CONFIG_DEFAULT);

export const useAppConfig = () => useContext(AppConfigContext);
