// src/context/AppConfigContext.tsx
// 把「网站设置」里的全局配置（图标 API、背景图等）透传给深层组件，
// 避免 App -> GroupCard -> SiteCard -> SiteSettingsModal 一层层往下传 props
import { createContext, useContext } from "react";

export interface AppConfigContextValue {
    /** 图标 API 模板，含 {domain} 占位符 */
    iconApi: string;
    /** 背景图片 URL，空字符串表示不使用 */
    backgroundImage: string;
    /** 背景蒙版透明度 0~1 */
    backgroundMaskOpacity: string;
}

const defaultValue: AppConfigContextValue = {
    iconApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

const AppConfigContext = createContext<AppConfigContextValue>(defaultValue);

export const AppConfigProvider = AppConfigContext.Provider;

export const useAppConfig = () => useContext(AppConfigContext);

export default AppConfigContext;
