// 键盘方向键在卡片网格里移动焦点。
//
// 从 App.tsx 搬过来 —— 它跟业务状态一点关系都没有，只吃「一堆矩形 + 当前焦点」，
// 抽出来之后可以直接拿假矩形做单测（这在 3731 行的 App 里是做不到的：那边一测就要
// 起整个 React 树）。方向是「看排得齐不齐」判的：同一行的判定用 Y 轴中心差 16px，
// 同一列用 X 轴中心差 24px —— 卡片有内边距和高度差，要求像素级对齐会一个都选不上。

/** 所有可被方向键导航的卡片。和 App 里的 querySelectorAll 共用同一个选择器，别各写一份 */
export const NAV_CARD_SELECTOR = '[data-nav-card="true"]';

export type FocusDirection = "left" | "right" | "up" | "down";

/** 只需要这三个能力，HTMLElement 天然符合；单测里可以用假对象代替 */
export interface NavCard {
    getAttribute(name: string): string | null;
    getBoundingClientRect(): CardRect;
    focus(): void;
}

export interface CardRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface CardFocusEnv {
    /** 页面上所有卡片，按文档顺序 */
    cards: readonly NavCard[];
    /** 当前聚焦的元素；null 表示没有卡片被聚焦 */
    active: NavCard | null;
}

/** 同一行的容差：卡片标题换行会让高度差上十像素，判太严会整行走不动 */
const ROW_TOLERANCE = 16;
/** 同一列的容差：卡片宽度随栅格变化，X 中心差比行高更容易飘 */
const COLUMN_TOLERANCE = 24;

function centerX(rect: CardRect): number {
    return (rect.left + rect.right) / 2;
}

function centerY(rect: CardRect): number {
    return (rect.top + rect.bottom) / 2;
}

/** 选同方向、离当前最近的那个；一个都没有就原地不动（返回 null 表示「保持原焦点」） */
function pickNearest(
    cards: readonly NavCard[],
    axis: "x" | "y",
    dir: FocusDirection,
    cx: number,
    cy: number
): NavCard | null {
    const forward = dir === "right" || dir === "down";
    const near = axis === "x" ? centerY : centerX;
    const tolerance = axis === "x" ? ROW_TOLERANCE : COLUMN_TOLERANCE;
    const base = axis === "x" ? cy : cx;

    const candidates = cards
        .filter(card => {
            const rect = card.getBoundingClientRect();
            return Math.abs(near(rect) - base) < tolerance;
        })
        .filter(card => {
            const rect = card.getBoundingClientRect();
            return forward
                ? (axis === "x" ? rect.left : rect.top) > (axis === "x" ? cx : cy)
                : (axis === "x" ? rect.right : rect.bottom) < (axis === "x" ? cx : cy);
        });

    if (candidates.length === 0) return null;
    return candidates
        .slice()
        .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const da = forward
                ? (axis === "x" ? ra.left : ra.top)
                : -(axis === "x" ? ra.right : ra.bottom);
            const db = forward
                ? (axis === "x" ? rb.left : rb.top)
                : -(axis === "x" ? rb.right : rb.bottom);
            return da - db;
        })[0];
}

/**
 * 把焦点挪到目标卡片上。
 *
 * - 没有卡片 / 当前没有聚焦的卡片：聚焦第一个（或保持不动）
 * - 同方向上没有候选：保持当前焦点（`current.focus()` 是幂等的，不必特殊处理）
 */
export function focusCardByDirection(dir: FocusDirection, env: CardFocusEnv): void {
    const { cards, active } = env;
    if (cards.length === 0) return;

    const current = active && active.getAttribute("data-nav-card") === "true" ? active : null;
    if (!current) {
        cards[0].focus();
        return;
    }

    const rect = current.getBoundingClientRect();
    const cx = centerX(rect);
    const cy = centerY(rect);

    if (dir === "left" || dir === "right") {
        const target = pickNearest(
            cards.filter(card => card !== current),
            "x",
            dir,
            cx,
            cy
        );
        (target || current).focus();
        return;
    }

    const target = pickNearest(
        cards.filter(card => card !== current),
        "y",
        dir,
        cx,
        cy
    );
    (target || current).focus();
}

/** 浏览器环境里的默认取值：文档顺序的全部卡片 + 当前焦点 */
export function domCardEnv(doc: Document = document): CardFocusEnv {
    return {
        cards: Array.from(doc.querySelectorAll<HTMLElement>(NAV_CARD_SELECTOR)),
        active: doc.activeElement as HTMLElement | null,
    };
}
