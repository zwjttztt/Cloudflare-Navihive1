// src/utils/densityMetrics.ts
// 卡片密度三档的**唯一数值来源**（2026-10-21 加第三档「超紧凑」）。
//
// 加这一档时踩到的形状问题值得记一笔：原来各处的写法是 `isCompact ? A : B`
// （SiteCard 的头像尺寸、描述要不要显示、内边距、图标墙尺寸；GroupCard 的分组高度
// 估算、网格间距、单元格内边距），散在十来处。加第三档时每处都要从二元判断改成
// 三元嵌套 —— 那是「每加一档都要改 N 处」的结构，迟早漏改一处，然后出现
// 「某个角落还是紧凑档」的怪样子（静态守卫也盯不住，因为它长得完全合法）。
//
// 所以把三档的差别收进这张表：调用方只问「这一档给我的数值是多少」。
// **判断「是不是紧凑」的地方请改用这里的字段**，别再写 `density === "compact"`。
// 加第四档只需要在这里加一行 + DisplayControls 加一项。
import type { Density } from "../context/uiPrefsStore";

export interface DensityMetrics {
    /** 列表模式：左侧头像尺寸（px） */
    listAvatar: number;
    /** 列表模式：纵向内边距（theme spacing 单位） */
    listPaddingY: number;
    /** 列表模式：是否显示描述 */
    showListDescription: boolean;

    /** 卡片模式：CardContent 内边距（保留响应式：移动端比桌面窄一档） */
    cardContentPadding: { xs: number; sm: number };
    /** 卡片模式：头像与标题之间、标题与描述之间的间距（theme spacing 单位） */
    cardTitleGap: number;
    /** 卡片模式：描述文字是否按紧凑样式渲染（单行、更小字号） */
    compactDescription: boolean;

    /** 图标墙模式：头像尺寸（px） */
    wallAvatar: number;
    /** 图标墙模式：内边距（theme spacing 单位） */
    wallPadding: number;
    /** 图标墙模式：站点名字号（px） */
    wallFontSize: number;

    /** 卡片网格：整块列表的 Stack 间距（theme spacing 单位） */
    listSpacing: number;
    /** 分组卡片：单元格内边距（theme spacing 单位） */
    cellPadding: number;
    /** 分组卡片：网格间距（theme spacing 单位；负数是原本就有的重叠收紧） */
    gridGap: number;
    /** 分组卡片：高度估算（px），占位与懒挂载用，不精确也没关系 */
    groupCardHeight: number;
}

const METRICS: Record<Density, DensityMetrics> = {
    comfortable: {
        listAvatar: 36,
        listPaddingY: 1,
        showListDescription: true,
        cardContentPadding: { xs: 1.5, sm: 2 },
        cardTitleGap: 1,
        compactDescription: false,
        wallAvatar: 48,
        wallPadding: 1.5,
        wallFontSize: 12,
        listSpacing: 5,
        cellPadding: 1,
        gridGap: -1,
        groupCardHeight: 150,
    },
    // 紧凑：数值与 2026-10-21 之前**完全一致** —— 老用户切回来应该看到一模一样的东西
    compact: {
        listAvatar: 28,
        listPaddingY: 0.5,
        showListDescription: false,
        cardContentPadding: { xs: 1.25, sm: 1.25 },
        cardTitleGap: 0.5,
        compactDescription: true,
        wallAvatar: 40,
        wallPadding: 1,
        wallFontSize: 10,
        listSpacing: 3,
        cellPadding: 0.5,
        gridGap: -0.5,
        groupCardHeight: 120,
    },
    // 超紧凑：大屏「一屏看全部」用。缩略图与名字都还在，只是更小更挤
    ultra: {
        listAvatar: 22,
        listPaddingY: 0.25,
        showListDescription: false,
        cardContentPadding: { xs: 1, sm: 1 },
        cardTitleGap: 0.25,
        compactDescription: true,
        wallAvatar: 34,
        wallPadding: 0.75,
        wallFontSize: 10,
        listSpacing: 2,
        cellPadding: 0.5,
        gridGap: -0.25,
        groupCardHeight: 96,
    },
};

/** 取某一档的数值（认不出来的按舒适档处理，不让脏数据把卡片压扁） */
export function densityMetrics(density: Density | string | null | undefined): DensityMetrics {
    if (density === "compact" || density === "ultra") return METRICS[density];
    return METRICS.comfortable;
}

/** 把任意存储值归一成合法档位（localStorage / 跨页签事件都会把字符串塞进来） */
export function normalizeDensity(raw: unknown): Density {
    if (raw === "compact" || raw === "ultra" || raw === "comfortable") return raw;
    return "comfortable";
}
