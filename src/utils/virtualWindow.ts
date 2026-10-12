// src/utils/virtualWindow.ts
// 列表虚拟化的可见区间计算（纯函数，不碰 DOM）。
//
// 为什么需要：站点 / 笔记列表目前是**全量建 DOM**，靠 `content-visibility` 省布局与
// 绘制成本 —— 但 React 元素和 DOM 节点照样是全量建的。几百条以上时，
// 内存与首次渲染时间都随条数线性涨（inkstone 同样没有虚拟化，两边打平）。
//
// 刻意做成纯函数：虚拟列表最容易错的是边界（滚到顶 / 滚到底 / 条数为 0 / 行高算错），
// 而这些全都可以不碰 DOM 地验证 —— 组件里只负责把它接上。
//
// ⚠️ 只在**行高固定**时准确。本站两处列表（站点卡片 / 笔记行）都是定高行，
// 所以够用；哪天要支持自适应行高，得换成「量完再算」的那一套（复杂度上一个量级）。

export interface VirtualWindow {
    /** 第一个可见下标（含） */
    start: number;
    /** 最后一个可见下标（不含） */
    end: number;
    /** 上面被跳过的行占的高度（用一个空 div 撑出来，保持滚动条正确） */
    padTop: number;
    /** 全部行的总高度（撑滚动条用） */
    totalHeight: number;
}

export interface WindowInput {
    /** 总行数 */
    count: number;
    /** 每行高度（px）。必须 > 0，否则算不出区间 */
    rowHeight: number;
    /** 当前滚动位置（px）。负值按 0 算 */
    scrollTop: number;
    /** 视口高度（px） */
    viewportHeight: number;
    /** 上下各多渲染几行，避免快速滚动时露白。默认 4 */
    overscan?: number;
}

/** 脏输入一律退化成「安全值」，不能抛出 NaN 让界面挂掉 */
export function computeWindow(input: WindowInput): VirtualWindow {
    const count = Math.max(0, Math.floor(input.count || 0));
    const rowHeight = input.rowHeight > 0 ? input.rowHeight : 0;
    const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
    const scrollTop = Math.max(0, input.scrollTop || 0);
    const viewportHeight = Math.max(0, input.viewportHeight || 0);

    const totalHeight = count * rowHeight;
    // 行高算不出来（0）或没有行：整窗空，交给调用方走「不虚拟化」的老路
    if (count === 0 || rowHeight === 0) {
        return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
    }

    const first = Math.floor(scrollTop / rowHeight);
    const visible = Math.ceil(viewportHeight / rowHeight);
    const rawStart = Math.max(0, Math.min(count - 1, first - overscan));
    const rawEnd = Math.min(count, first + visible + overscan);

    // 滚到底部时 rawEnd 被 count 夹住，rawStart 却还在按 overscan 前移 —— 那样底部会
    // 多渲染半个 overscan 的行。把 start 往前收一圈，保证**任何位置**渲染的条数
    // 都不超过 visible + 2*overscan（底部本来就没必要多看那几行）。
    const maxRendered = visible + overscan * 2;
    const start = rawEnd - rawStart > maxRendered ? Math.max(0, rawEnd - maxRendered) : rawStart;
    const end = rawEnd;

    return { start, end, padTop: start * rowHeight, totalHeight };
}

/** 低于这个条数就不虚拟化：全量渲染更简单，也不会因为包一层定位容器而改变 DOM 结构 */
export const VIRTUALIZE_THRESHOLD = 60;

/** 这个条数要不要走虚拟化 */
export function shouldVirtualize(count: number): boolean {
    return count >= VIRTUALIZE_THRESHOLD;
}
