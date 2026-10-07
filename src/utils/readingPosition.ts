// 阅读位置记忆（inkstone 的 `features/workspace/reading-position.ts`）。
//
// 记住每篇笔记的阅读滚动位置，重开时恢复。长笔记重开不用再滚半天找回位置。
//
// ⚠️ 两个设计决定：
//   1. **按「账号 + 笔记」分桶**。用同一个 key 的话切换账号会串味 ——
//      A 账号滚到第 80 段，切到 B 账号打开同一篇，位置也变了。
//   2. **记的是滚动比例（0~1）不是像素**。窗口大小、面板宽度、是否分屏都会变，
//      像素在不同环境下指的根本不是同一段内容。

const PREFIX = "notes.readPos";

/** 取分桶 key。account 传空串表示未登录场景。 */
function keyFor(account: string, noteId: number): string {
    return `${PREFIX}:${account || "-"}:${noteId}`;
}

/**
 * 读回记忆的滚动比例；没有记录或记录非法时返回 null（调用方就别恢复）。
 */
export function readReadingPosition(account: string, noteId: number): number | null {
    try {
        const raw = globalThis.localStorage?.getItem(keyFor(account, noteId));
        if (raw == null) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
    } catch {
        // 隐私模式 / 配额满：读不了就当作没记录，不该因此报错
        return null;
    }
}

/** 记住滚动比例。比例非法时顺手把旧记录清掉（否则脏数据会一直留着）。 */
export function writeReadingPosition(account: string, noteId: number, ratio: number): void {
    try {
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
            globalThis.localStorage?.removeItem(keyFor(account, noteId));
            return;
        }
        // 存三位小数：1/1000 的精度对「找回位置」足够，
        // 而且 localStorage 攒几十万条也不会撑爆配额。
        globalThis.localStorage?.setItem(keyFor(account, noteId), ratio.toFixed(3));
    } catch {
        /* 隐私模式写不了，忽略 */
    }
}

/** 清掉某篇的记忆（删除 / 回收站清空时调，避免留垃圾数据）。 */
export function clearReadingPosition(account: string, noteId: number): void {
    try {
        globalThis.localStorage?.removeItem(keyFor(account, noteId));
    } catch {
        /* 隐私模式写不了，忽略 */
    }
}
