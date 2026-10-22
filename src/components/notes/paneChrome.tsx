// src/components/notes/paneChrome.tsx
// 记事本的「页面 chrome」区块（第二批拆分，从 NotesPage.tsx 原文搬出，逻辑零改动）：
// 左两列宽度（useColumnResize）、列间拖拽缝（ColResizeHandle）、
// 保存状态点（SaveDot）、栏头/状态栏高度与分栏比例的持久化工具。
//
// 全是纯工具与小组件，留在主文件只会撑行数 —— 拆出后 NotesPage 少约 320 行。

import { useCallback, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { formatRelative } from "../../utils/noteTime";
/**
 * 左栏两列的宽度（阶段三收尾：左栏从单列改成 inkstone 那样两列）。
 *
 * 导航列刻意做窄（128）：它只有名字 + 一个条数，宽了就是浪费；
 * 笔记列表列给 208，比原来的 300 整列窄一些 —— 但换来的是「导航归导航、列表归列表」，
 * 月份分组标题不会再被挤到换行。两列加起来 336，只比原来宽 36px，
 * 编辑区在 1360 的窗口下仍有 1000 出头。
 */
export const NAV_COL_W = 128;
export const LIST_COL_W = 208;

/**
 * 每个笔记栏头部（标题行）的统一高度。
 * ⚠️ 主栏与侧栏必须用同一个值：之前主栏靠 `pt:1.5` 自然撑高、侧栏多了两个
 * 按钮也各自撑高，两栏并排时高度差 5~8px，标题与工具栏整排错位（2026-10-07 用户报）。
 * ⚠️ 2026-10-07 从 52 收到 44（inkstone 的 `h-11`）：52 是「标题 18px + 上下留白」
 * 猜出来的值，比 inkstone 高一截，三栏并排时上下就显空。44 正好放下 28px 的
 * 按键行 + 标题基线，且和 36px 的工具栏、26px 的状态栏成一套比例。
 */
export const PANE_HEADER_H = 44;

/** 状态栏统一高度（inkstone 的 `--statusbar-h`），主栏与侧栏必须一致 */
export const STATUSBAR_H = 26;

/** 分栏比例的持久化键。按账号分桶：换账号后各用各的宽度习惯。 */
export const SPLIT_KEY = "notes.splitRatio";
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

// ---------- 左两列的宽度（2026-10-06：用户报「太窄了，要能拖」） ----------
//
// 128 / 208 是当初照着「1360 宽窗口下编辑区还剩 1000 出头」定的死值，
// 但用户自己的窗口大小、想给文件夹名多少空间，各人不同 —— 固定值就必然有人嫌窄。
// 两个键都按账号分桶（与 UI 偏好同一套 scopedKey），换账号后各用各的习惯。
const NAV_W_KEY = "notes.navColW";
const LIST_W_KEY = "notes.listColW";
const NAV_W_MIN = 104;
const NAV_W_MAX = 260;
const LIST_W_MIN = 150;
const LIST_W_MAX = 460;

/** 读一个宽度；越界或读不到就用默认值（手改过 localStorage / 老版本的值都在这儿兜住） */
function readColW(key: string, fallback: number, min: number, max: number): number {
    try {
        const n = Number(globalThis.localStorage?.getItem(key));
        return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    } catch {
        return fallback;
    }
}

function writeColW(key: string, value: number): void {
    try {
        globalThis.localStorage?.setItem(key, String(value));
    } catch {
        /* 隐私模式下写不了，忽略 */
    }
}

/**
 * 拖动两列之间的那条缝。
 *
 * ⚠️ 两个必须这么写的理由（都是这仓库踩过的）：
 *   1. 事件处理函数是 mousedown 那一刻挂上 window 的闭包，拖动中的 setState
 *      **改不到它读到的 state**。最新宽度只能靠 ref 跟住（分隔条那次同类问题）。
 *   2. 松手时别调「从 localStorage 读」的那个函数 —— 读回来必然是拖动前的旧值。
 */
export function useColumnResize() {
    const [navW, setNavW] = useState(() => readColW(NAV_W_KEY, NAV_COL_W, NAV_W_MIN, NAV_W_MAX));
    const [listW, setListW] = useState(() =>
        readColW(LIST_W_KEY, LIST_COL_W, LIST_W_MIN, LIST_W_MAX)
    );
    const navRef = useRef(navW);
    const listRef = useRef(listW);

    /** 拖动哪一列。nav 的起点是它的左边缘，list 的起点是「导航列右边缘」。 */
    const startDrag = useCallback((which: "nav" | "list") => (e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startNav = navRef.current;
        const startList = listRef.current;

        const onMove = (ev: PointerEvent) => {
            const d = ev.clientX - startX;
            if (which === "nav") {
                // 导航列不能吃掉整个左栏：给列表列留至少 LIST_W_MIN
                const next = Math.round(
                    Math.min(NAV_W_MAX, Math.max(NAV_W_MIN, startNav + d))
                );
                navRef.current = next;
                setNavW(next);
            } else {
                // 列表列拖太宽会把编辑区挤没，这里再卡一道「左栏最多占窗口 45%」
                const room = Math.max(LIST_W_MIN, Math.floor(window.innerWidth * 0.45) - startNav);
                const next = Math.round(
                    Math.min(Math.min(LIST_W_MAX, room), Math.max(LIST_W_MIN, startList + d))
                );
                listRef.current = next;
                setListW(next);
            }
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            if (which === "nav") writeColW(NAV_W_KEY, navRef.current);
            else writeColW(LIST_W_KEY, listRef.current);
        };
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, []);

    /** 双击那条缝 = 回默认宽度（与分隔条双击回对半同一套手势） */
    const reset = useCallback((which: "nav" | "list") => () => {
        if (which === "nav") {
            navRef.current = NAV_COL_W;
            setNavW(NAV_COL_W);
            writeColW(NAV_W_KEY, NAV_COL_W);
        } else {
            listRef.current = LIST_COL_W;
            setListW(LIST_COL_W);
            writeColW(LIST_W_KEY, LIST_COL_W);
        }
    }, []);

    return { navW, listW, startDrag, reset };
}

/**
 * 两条列之间的可拖分隔条。
 *
 * 做法照抄 inkstone 的 `src/client/features/shell/Resizer.tsx`：
 * **命中区 9px + 负外边距 −4px**（实际可点 ≈17px）、静止 1px 发丝线、
 * hover/拖动时 2px 并变强调色，过渡 220ms `cubic-bezier(.22,1,.36,1)`。
 * 没有发光也没有阴影 —— inkstone 那种「只有一根细线」反而比描一圈更好看，
 * 之前我们给两栏都加了完整 border + 圆角 + 淡底色，看着像两张卡片拼起来，很脏。
 *
 * ⚠️ 键盘可达（Tab 聚焦后 ←/→ 调、Home/End 到头、双击复位）：
 * 这是 a11y 基线要求，不是装饰。
 */
export function ColResizeHandle({
    label,
    onDrag,
    onReset,
    onNudge,
    ratio,
}: {
    label: string;
    onDrag: (e: React.PointerEvent) => void;
    onReset: () => void;
    /** 键盘左右微调（比例）。不传就没有方向键支持。 */
    onNudge?: (delta: number) => void;
    /** 当前比例，仅用于 aria-valuenow。 */
    ratio?: number;
}) {
    return (
        <Box
            role='separator'
            aria-orientation='vertical'
            aria-label={label}
            aria-valuenow={ratio === undefined ? undefined : Math.round(ratio * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            tabIndex={0}
            title={`${label}（双击回到默认宽度）`}
            onPointerDown={onDrag}
            onDoubleClick={onReset}
            onKeyDown={e => {
                if (!onNudge) return;
                // ←/→ 各 2%，Home/End 到两端。跟 inkstone 的 keyboardStep 一致。
                if (e.key === "ArrowLeft") onNudge(-0.02);
                else if (e.key === "ArrowRight") onNudge(0.02);
                else if (e.key === "Home") onNudge(-1);
                else if (e.key === "End") onNudge(1);
                else return;
                e.preventDefault();
            }}
            sx={{
                // 命中区 9px，向两侧各溢出 4px（inkstone 的 -mx-[4px]）
                width: 9,
                mx: "-4px",
                flexShrink: 0,
                cursor: "col-resize",
                bgcolor: "transparent",
                position: "relative",
                zIndex: 1,
                // 下面两条是「拖得动」的关键，不是装饰：
                //   - `alignSelf: stretch` + `minHeight`：父容器是 flex，
                //     不显式拉伸的话这条会**塌成 0 高度**（2026-10-06 的真机 bug：
                //     真机量到 h=0，鼠标点不中；而合成事件绕过命中测试，单测全绿）。
                //   - `touchAction: none`：触屏上浏览器会把手势当成滚动，
                //     拖动直接被滚动手势吃掉。
                alignSelf: "stretch",
                minHeight: 120,
                touchAction: "none",
                userSelect: "none",
                outline: "none",
                "&:focus-visible": { outline: "none" },
                // 常驻一条发丝线：用 span 而不是 ::after —— ::after 是伪元素，
                // 自动化测试量不到它的宽度（Chrome 会把 width 回退成宿主宽度）。
                "& > span": {
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: "50%",
                    // ⚠️ 必须写 '1px'，**不能**写 1 ——
                    // MUI 的 sizing transform 把 `width: 1` 当成 `100%`，
                    // 于是这条「发丝线」被拉满整个 9px 命中区，看着就是一条粗带子
                    // （真机量到 width=9px；单测/jsdom 量不到，一直是绿的）。
                    width: "1px",
                    transform: "translateX(-50%)",
                    bgcolor: "var(--card-border)",
                    transition:
                        "background-color var(--dur-base, 220ms) var(--ease-out, ease), width var(--dur-base, 220ms) var(--ease-out, ease)",
                    pointerEvents: "none",
                },
                // hover / 键盘聚焦 / 拖动中：线加粗并变强调色（inkstone 同款）
                "&:hover > span, &:focus-visible > span, &[data-dragging='1'] > span": {
                    width: "2px",
                    bgcolor: "var(--accent)",
                },
            }}
        >
            <span aria-hidden="true" />
        </Box>
    );
}

/**
 * 保存状态指示（inkstone 的 `SaveIndicator`，只是从它的 SVG 圆环简化来的）。
 *
 * ⚠️ 为什么搬到这里：inkstone 的 footer（状态栏）只放「这篇多长、它是谁」，
 * 保存状态挂在**头部**。我们之前把「已保存 · 3分钟前」写在状态栏右端，
 * 于是那一行既想报长度又想报状态，26px 根本塞不下 —— 搬上来之后状态栏才干净。
 *
 * 三态与 inkstone 一一对应：
 *   saving → 强调色圆环转圈 / pending（有改动）→ 灰点 / saved → 绿勾
 */
export function SaveDot({
    state,
    dirty,
    savedAt,
    now,
}: {
    state: "idle" | "pending" | "saving" | "saved";
    dirty: boolean;
    savedAt: number | null;
    now: number;
}) {
    const label =
        state === "saving"
            ? "正在保存…"
            : dirty || state === "pending"
              ? "有改动，即将保存…"
              : savedAt
                ? `已保存 · ${formatRelative(savedAt, new Date(now))}`
                : "已保存";
    const tone =
        state === "saving"
            ? "var(--accent)"
            : dirty || state === "pending"
              ? "text.disabled"
              : "var(--success)";
    return (
        <Tooltip title={label}>
            <Box
                role='img'
                aria-label={label}
                data-save-dot={state}
                data-dirty={dirty ? "1" : "0"}
                sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    color: tone,
                }}
            >
                <Box
                    aria-hidden="true"
                    sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        border: "1.6px solid currentColor",
                        opacity: state === "saving" ? 0.35 : 1,
                        ...(state === "saving"
                            ? {
                                  borderTopColor: "transparent",
                                  animation: "note-save-spin .72s linear infinite",
                              }
                            : dirty || state === "pending"
                              ? { bgcolor: "currentColor", border: "none", opacity: 0.45 }
                              : { bgcolor: "currentColor", border: "none" }),
                    }}
                />
            </Box>
        </Tooltip>
    );
}

/**
 * 自动保存的防抖间隔**默认值**（阶段四第 14 条）。
 *
 * 5 秒是「打字不被打断」和「关掉不至于丢太多」之间的折中：1 秒太勤（每个停顿都发一次
 * 请求，离线队列里会攒一堆无用 PATCH），10 秒太长（关窗口就丢几秒的字）。
 * 真关窗口还有卸载前那次 flush 兜底，所以不会真丢东西。
 *
 * ⚠️ 2026-10-12 由 3 秒改成 5 秒：这条链路上**每个请求要付 1~3 秒的固定往返**
 * （实测 10 字节的接口 TTFB 3.85 秒），写请求虽然不阻塞界面，但每次停顿都发一个
 * 是实打实的往返与写入配额。放宽到 5 秒能少掉三到五成中间保存。
 * 配套的补偿是「失焦立即落盘」（见 NotesPage 里那两个 autosave effect）：
 * 切走标签页 / 点到别的窗口时立刻存，于是延长防抖窗口并不会增加丢内容的风险。
 *
 * ⚠️ 2026-10-07：真正生效的值是设置面板里的「自动保存延迟」
 * （notes.uiSettings.autosaveMs），这里只作为它的默认/兜底值。
 */
export const AUTO_SAVE_MS = 5000;

/** 主栏↔侧栏比例的持久化（与列宽同一套思路：越界回落默认值） */
const PANE_RATIO_KEY = "notes.paneRatio";
export function readPaneRatio(): number {
    try {
        const n = Number(globalThis.localStorage?.getItem(PANE_RATIO_KEY));
        return Number.isFinite(n) && n >= 0.2 && n <= 0.8 ? n : 0.5;
    } catch {
        return 0.5;
    }
}
export function writePaneRatio(value: number): void {
    try {
        globalThis.localStorage?.setItem(PANE_RATIO_KEY, String(value));
    } catch {
        /* 隐私模式写不了，忽略 */
    }
}

export function readSplitRatio(): number {
    try {
        const raw = globalThis.localStorage?.getItem(SPLIT_KEY);
        const n = Number(raw);
        return Number.isFinite(n) && n >= MIN_RATIO && n <= MAX_RATIO ? n : 0.5;
    } catch {
        return 0.5;
    }
}
