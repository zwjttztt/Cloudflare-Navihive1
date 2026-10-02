// src/context/AiContext.tsx
// AI 助手的「能不能用」沿组件树往下传。
//
// 为什么是 context 而不是 prop：要用它的那个组件（站点设置弹窗）挂在卡片下面，
// 而卡片是 memo 的、一屏有几百张 —— 把助手当 prop 从 App 一路传下去，
// 每次引用变化都会让所有卡片重渲染一遍。context 只在「AI 状态真的变了」时才通知订阅者，
// 而这里传的还是只含三个字段的稳定对象。
import { createContext, useContext } from "react";
import type { AiAssistant } from "../hooks/useAiAssistant";

/** 站点弹窗需要的四个字段：够用，且引用稳定。
 *  enabled 用来决定「AI 补全」入口出不出现 —— 没启用 AI 时连按钮都不该有。
 *  它不在 AiAssistant 上（enabled 在 status 里），所以显式列出而非 Pick。 */
export interface SiteAi {
    enabled: boolean;
    ready: boolean;
    reason: string | null;
    siteMeta: AiAssistant["siteMeta"];
}

/** null 表示「这台机器上没有可用的 AI」，界面上就不显示相关入口 */
export const AiContext = createContext<SiteAi | null>(null);

export function useSiteAi(): SiteAi | null {
    return useContext(AiContext);
}
