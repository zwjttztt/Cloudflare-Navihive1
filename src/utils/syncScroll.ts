// src/utils/syncScroll.ts
// 分栏时的**滚动同步**（按源码行锚点定位，对齐 inkstone 的
// features/workspace/sync-scroll.ts）。
//
// 为什么不能按百分比：源码与预览的**总高度不一样**。真机量过一篇
// 「8 个二级标题 + 一个 12 行代码块 + 8 个附录」的笔记：
// 源码内容高 2722px、预览内容高 2174px（差 20%，因为标题在预览里
// 渲染成大号字、代码块带横向内边距）。按百分比映射的话，滚到一半时
// 两边其实停在不同的段落 —— 用户看到的就是「两边一起滚但对不上」。
//
// 按行锚点怎么工作：
//   1. 渲染时每个块级元素带 `data-line`（源码 0 基行号，见
//      markdownToReact.tsx 的 anchorProps）；
//   2. 量一次：把预览里所有 `[data-line]` 元素的 (line, top) 收集成
//      锚点表，按行号 + 屏幕位置排序、去重、单调化；
//   3. 滚动时取「当前视口顶部对应的源码行」，在锚点表里插值出
//      预览该滚到多少像素。
//
// 还有一个容易忽略的点：**防反馈环**。A 滚 → 我们设 B 的 scrollTop →
// B 触发 scroll 事件 → 又去设 A → 无限循环。inkstone 的做法是
// 「driver」：只有最近被 wheel/pointerdown/keydown 碰过的那一侧才算
// 驱动方，另一侧被动跟随后短暂「让位」（DRIVER_IDLE_MS）。
// 这个必须有，否则两栏会互相追着跑，手感非常抖。

export interface PreviewAnchor {
    /** 对应的源码行号（0 基） */
    line: number;
    /** 该块在预览滚动容器里的 top 像素位置 */
    top: number;
}

type ScrollSide = "editor" | "preview";

/** 距离顶/底这么近以内就直接贴边（避免在边缘反复抖动） */
const EDGE_EPSILON = 2;
/** 驱动方让位时间：超过这个毫秒数没动静，就认为可以换人了 */
const DRIVER_IDLE_MS = 160;

const maxScroll = (el: HTMLElement): number => Math.max(0, el.scrollHeight - el.clientHeight);
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * 量出预览里所有锚点。
 * 只取 `[data-preview-content]` 的**直接子元素**里带 `data-line` 的
 * —— 与 inkstone 的 previewSourceAnchors 同口径：嵌套太深的元素
 * （比如列表项里的段落）会让曲线局部抖动。
 */
export function measurePreviewAnchors(preview: HTMLElement): PreviewAnchor[] {
    const previewRect = preview.getBoundingClientRect();
    const content =
        preview.matches("[data-preview-content]") || !preview.querySelector("[data-preview-content]")
            ? preview
            : (preview.querySelector("[data-preview-content]") as HTMLElement);
    const anchors: PreviewAnchor[] = [];
    let prevLine = -1;
    let prevTop = Number.NEGATIVE_INFINITY;
    for (const el of Array.from(content.children)) {
        if (!(el instanceof HTMLElement)) continue;
        if (!el.hasAttribute("data-line")) continue;
        const line = Number(el.getAttribute("data-line"));
        const top = el.getBoundingClientRect().top - previewRect.top + preview.scrollTop;
        if (!Number.isInteger(line) || line < 0 || !Number.isFinite(top)) continue;
        // 必须**行号递增且位置不回头**：否则同一行有两个块（表格单元、引用嵌套）
        // 会让插值曲线出现折返，滚起来一跳一跳。
        if (line <= prevLine || top + 0.5 < prevTop) continue;
        anchors.push({ line, top: Math.max(prevTop, top) });
        prevLine = line;
        prevTop = top;
    }
    return anchors;
}

/**
 * 把稀疏锚点补成覆盖 [0, 末尾行] 的完整曲线。
 * 两端各加一个虚拟锚点（行 0 → 容器 paddingTop；末行 → 容器底部），
 * 这样短文（锚点很少）也能正确插值。
 */
export function buildScrollCurve(
    measured: PreviewAnchor[],
    lineCount: number,
    paddingTop: number,
    previewMaxScroll: number
): PreviewAnchor[] {
    const endLine = Math.max(1, Math.floor(Number.isFinite(lineCount) ? lineCount : 1));
    const startTop = Math.max(0, Number.isFinite(paddingTop) ? paddingTop : 0);
    const endTop = startTop + Math.max(0, Number.isFinite(previewMaxScroll) ? previewMaxScroll : 0);
    const curve: PreviewAnchor[] = [{ line: 0, top: startTop }];
    for (const a of measured) {
        if (a.line <= 0 || a.line >= endLine) continue;
        curve.push(a);
    }
    curve.push({ line: endLine, top: endTop });
    return curve;
}

/** 按行号在曲线里插值：给源码行号，返回预览里的 y 像素 */
export function previewTopForLine(curve: PreviewAnchor[], line: number): number {
    if (!curve.length) return 0;
    const l = Math.max(0, line);
    if (l <= curve[0].line) return curve[0].top;
    const last = curve[curve.length - 1];
    if (l >= last.line) return last.top;
    // 二分找区间
    let lo = 0;
    let hi = curve.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (curve[mid].line <= l) lo = mid;
        else hi = mid;
    }
    const a = curve[lo];
    const b = curve[hi];
    const span = b.line - a.line;
    if (span <= 0) return b.top;
    const t = (l - a.line) / span;
    return a.top + (b.top - a.top) * t;
}

/** 反向：给预览里的 y 像素，返回它对应的源码行号（预览滚 → 源码跟随时用） */
export function sourceLineForPreviewTop(curve: PreviewAnchor[], top: number): number {
    if (!curve.length) return 0;
    if (top <= curve[0].top) return curve[0].line;
    const last = curve[curve.length - 1];
    if (top >= last.top) return last.line;
    let lo = 0;
    let hi = curve.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (curve[mid].top <= top) lo = mid;
        else hi = mid;
    }
    const a = curve[lo];
    const b = curve[hi];
    const span = b.top - a.top;
    if (span <= 0) return b.line;
    const t = (top - a.top) / span;
    return Math.round(a.line + (b.line - a.line) * t);
}

/**
 * 滚动同步控制器。返回一组要绑到元素上的事件处理器。
 *
 * ⚠️ 只有 `enabled` 为真才生效；inkstone 也是 `settings.preview.syncScroll && showSplit`
 * （Workspace.tsx:241）——单栏/编辑模式下不同步。
 */
export function createScrollSync(opts: {
    editorScroller: HTMLElement;
    previewScroller: HTMLElement;
    /** 源码总行数（CodeMirror 的 lineCount） */
    lineCount: () => number;
    /**
     * 取源码当前视口顶部那一行的行号（**0 基**）。
     * ⚠️ 必须是 0 基：`buildScrollCurve` / `previewTopForLine` 这一整套用的都是
     * 「渲染出的 `data-line`」，而那是 markdown-it 的 `token.map[0]`（0 基）。
     * CM 自己的 `topLineNumber()` 是 1 基，**由调用方减 1** —— 以前这里写着
     * 「1 基」，调用方减完 1 传进来、`syncFromEditor` 里又减一次 1，
     * 于是同步总是比实际位置晚一行（慢慢积累成肉眼可见的错位）。
     */
    editorLineAtScroll: (scroller: HTMLElement) => number;
    /** 给定源码行号（**0 基**，与上面同一套口径），返回源码里该滚到的像素 */
    editorScrollForLine?: (line: number) => number;
    enabled: () => boolean;
}): {
    bind: () => () => void;
    /** 预览内容重排后调用：锚点表作废，下次滚动重新量 */
    invalidate: () => void;
} {
    const { editorScroller, previewScroller, lineCount, editorLineAtScroll, enabled } = opts;

    let anchors: PreviewAnchor[] | null = null;
    let driver: ScrollSide | null = null;
    let raf = 0;
    let releaseTimer = 0;

    const getCurve = (): PreviewAnchor[] => {
        if (!anchors) anchors = measurePreviewAnchors(previewScroller);
        const prevMax = maxScroll(previewScroller);
        const pad = parseFloat(getComputedStyle(previewScroller).paddingTop) || 0;
        return buildScrollCurve(anchors, lineCount(), pad, prevMax);
    };

    const setTop = (el: HTMLElement, v: number) => {
        const max = maxScroll(el);
        el.scrollTop = Math.max(0, Math.min(max, v));
    };

    /** 贴边判定：到顶/到底就精确贴边，不做插值（否则边缘会来回抖） */
    const edge = (top: number, scroller: HTMLElement): "top" | "bottom" | null => {
        const max = maxScroll(scroller);
        if (top <= EDGE_EPSILON) return "top";
        if (top >= max - EDGE_EPSILON) return "bottom";
        return null;
    };

    const syncFromEditor = () => {
        const e = edge(editorScroller.scrollTop, editorScroller);
        if (e === "top") return void setTop(previewScroller, 0);
        if (e === "bottom") return void setTop(previewScroller, maxScroll(previewScroller));
        // `editorLineAtScroll` 已经是 0 基，直接用；别再减
        const line = Math.max(0, editorLineAtScroll(editorScroller));
        const pad = parseFloat(getComputedStyle(previewScroller).paddingTop) || 0;
        setTop(previewScroller, previewTopForLine(getCurve(), line) - pad);
    };

    const syncFromPreview = () => {
        const e = edge(previewScroller.scrollTop, previewScroller);
        if (e === "top") return void setTop(editorScroller, 0);
        if (e === "bottom") return void setTop(editorScroller, maxScroll(editorScroller));
        const line = sourceLineForPreviewTop(getCurve(), previewScroller.scrollTop + (parseFloat(getComputedStyle(previewScroller).paddingTop) || 0));
        if (opts.editorScrollForLine) setTop(editorScroller, opts.editorScrollForLine(line));
    };

    const releaseLater = (side: ScrollSide) => {
        window.clearTimeout(releaseTimer);
        releaseTimer = window.setTimeout(() => {
            if (driver === side) driver = null;
        }, DRIVER_IDLE_MS);
    };
    const claim = (side: ScrollSide) => {
        if (driver !== side) cancelAnimationFrame(raf);
        driver = side;
        releaseLater(side);
    };
    const schedule = (side: ScrollSide) => {
        // 只有驱动方才带动另一侧 —— 这就是防反馈环的关键
        if (driver !== side) return;
        window.clearTimeout(releaseTimer);
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            if (driver !== side) return;
            if (!enabled()) return;
            if (side === "editor") syncFromEditor();
            else syncFromPreview();
            releaseLater(side);
        });
    };

    const onWheel = () => claim("editor");
    const onPointerDown = () => claim("editor");
    const onKeyDown = () => claim("editor");
    const onScroll = () => schedule("editor");
    const claimPreview = () => claim("preview");
    const scrollPreview = () => schedule("preview");

    const bind = () => {
        const bound = enabled();
        if (!bound) return () => {};
        editorScroller.addEventListener("wheel", onWheel, { passive: true });
        editorScroller.addEventListener("pointerdown", onPointerDown, { passive: true });
        editorScroller.addEventListener("keydown", onKeyDown, true);
        editorScroller.addEventListener("scroll", onScroll, { passive: true });
        previewScroller.addEventListener("wheel", claimPreview, { passive: true });
        previewScroller.addEventListener("pointerdown", claimPreview, { passive: true });
        previewScroller.addEventListener("keydown", claimPreview, true);
        previewScroller.addEventListener("scroll", scrollPreview, { passive: true });
        // 预览的重新渲染会改高度 → 锚点表作废
        const ro = new ResizeObserver(() => {
            anchors = null;
        });
        ro.observe(previewScroller);
        const content = previewScroller.querySelector("[data-preview-content]");
        if (content) ro.observe(content);
        return () => {
            cancelAnimationFrame(raf);
            window.clearTimeout(releaseTimer);
            driver = null;
            anchors = null;
            ro.disconnect();
            editorScroller.removeEventListener("wheel", onWheel);
            editorScroller.removeEventListener("pointerdown", onPointerDown);
            editorScroller.removeEventListener("keydown", onKeyDown, true);
            editorScroller.removeEventListener("scroll", onScroll);
            previewScroller.removeEventListener("wheel", claimPreview);
            previewScroller.removeEventListener("pointerdown", claimPreview);
            previewScroller.removeEventListener("keydown", claimPreview, true);
            previewScroller.removeEventListener("scroll", scrollPreview);
        };
    };

    return { bind, invalidate: () => { anchors = null; } };
}

export { clamp01 };