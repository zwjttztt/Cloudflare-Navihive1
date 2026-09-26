// src/constants.ts
// 顶栏拆成独立组件后，排序模式枚举与顶栏尺寸常量要被 App 和顶栏子组件同时用到。
// 放在单独的模块里，两边都 import，避免 App → 子组件 → App 的循环引用。
import type { SxProps, Theme } from "@mui/material";

/** 排序模式：不排序 / 拖分组 / 拖卡片 */
export enum SortMode {
    None, // 不排序
    GroupSort, // 分组排序
    SiteSort, // 站点排序
}

/** 顶栏里搜索框、按钮、胶囊的统一高度 */
export const HEADER_CONTROL_H = 36;

/** 顶栏里所有「一块玻璃」的圆角 */
export const HEADER_RADIUS = "14px";

/** 搜索框 / 按钮 / 胶囊共用：高度对齐 + 圆角一致 */
export const headerControlSx: SxProps<Theme> = {
    minWidth: "auto",
    height: HEADER_CONTROL_H,
    borderRadius: HEADER_RADIUS,
    fontSize: { xs: "0.75rem", sm: "0.875rem" },
};

/** 逻辑分组之间的竖向分隔线（搜索 | 操作 | 显示 | 时钟） */
export const headerDividerSx: SxProps<Theme> = {
    width: "1px",
    alignSelf: "stretch",
    my: 0.75,
    bgcolor: "var(--glass-border)",
    flexShrink: 0,
};
