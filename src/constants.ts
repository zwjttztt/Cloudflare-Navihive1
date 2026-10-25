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

/**
 * 顶栏里所有「一块玻璃」的圆角。
 *
 * 2026-10-25：从写死的 "14px" 改成派生 token —— 用户在「外观 → 圆角风格」里
 * 切到直角档时，卡片会变 6px，顶栏却还是 14px，同一屏两种风格。
 * 现在跟 `--card-radius` 一起走（22 → 14.1，与改造前基本一致）；
 * fallback 保留 14px，供导出/独立页面等没有这份 CSS 的上下文使用。
 */
export const HEADER_RADIUS = "var(--header-radius, 14px)";

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

/**
 * 顶栏工具行里搜索框占的那一格：
 * 窄屏（<900px）整行独占，宽屏跟着剩余空间伸缩，但有上限，
 * 免得 4K 下搜索框被拉成一条空的跑道。
 */
export const headerSearchSlotSx: SxProps<Theme> = {
    flexGrow: { md: 1 },
    flexShrink: { md: 1 },
    flexBasis: { xs: "100%", md: 280 },
    maxWidth: { md: 520 },
    minWidth: 0,
};
