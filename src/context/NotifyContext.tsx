// src/context/NotifyContext.tsx
// 把 App 顶部的 Snackbar 提示能力下发到深层子组件（如卡片快捷操作），
// 避免每个子组件各自渲染一个 Snackbar。
import { createContext, useContext } from "react";

export type NotifyFn = (
    message: string,
    severity?: "success" | "error" | "info",
    duration?: number
) => void;

const noop: NotifyFn = () => {};

export const NotifyContext = createContext<NotifyFn>(noop);

/** 子组件取用顶部提示函数；Provider 缺失时退化为静默 no-op，不会崩 */
export const useNotify = (): NotifyFn => useContext(NotifyContext);
