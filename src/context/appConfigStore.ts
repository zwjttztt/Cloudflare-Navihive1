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
    /**
     * 与**记事本**打交道的桥（D2 站点↔笔记双向绑定）。
     *
     * 站点卡片要显示「关于它的笔记」，需要两件记事本的能力：搜一下、跳过去。
     * 这里走 context 而不是 props：链路是 App → GroupCard → SiteListBody →
     * SiteCard → SiteSettingsModal，五层 props 只为传两个函数不划算
     * （这个文件本身存在的理由就是「别一层层往下传」）。
     *
     * ⚠️ 刻意**可选**：没接上时站点设置里那小节直接不渲染，而不是渲染出一个
     * 点了没反应的空壳 —— 「没有这个功能」比「有个坏掉的功能」好。
     */
    notesBridge?: {
        /** 按关键词搜笔记（服务端 FTS / like，取不到时返回空数组） */
        search: (query: string, limit?: number) => Promise<
            { id?: number; title: string; content: string }[]
        >;
        /** 打开记事本并跳到这条笔记 */
        open: (noteId: number) => void;
    };
}

export const APP_CONFIG_DEFAULT: AppConfigContextValue = {
    iconApi: "",
    thumbApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

export const AppConfigContext = createContext<AppConfigContextValue>(APP_CONFIG_DEFAULT);

export const useAppConfig = () => useContext(AppConfigContext);
