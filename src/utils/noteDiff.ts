// src/utils/noteDiff.ts
// 行级 diff：版本历史要跟「当前正文」比出 +/- 行。
//
// 照 inkstone 的 `VersionsPanel.computeLineDiff`（src/client/features/workspace/VersionsPanel.tsx）
// 搬过来的，三个参数也照它：
//   MAX_LCS_CELLS = 600000      中间段超过这么多格就不跑 LCS，直接「整段删 + 整段加」
//   MAX_RENDERED_DIFF_LINES    渲染上限，超了在中间插一行「N 行未改动已隐藏」
//
// 为什么需要这两道闸：LCS 的表是 (a+1)×(b+1)。一篇 3000 行的笔记和另一篇 3000 行的
// 笔记全不一样，表就是 900 万个格子 —— 算要几秒、渲染出来也没人看。先剥掉首尾相同的
// 部分（绝大多数版本之间只改中间一小段），剩下的才进 LCS；剩下的还是太大就降级。

export type DiffLineKind = "same" | "add" | "remove";

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
}

export interface DiffResult {
    lines: DiffLine[];
    /** 相对 before 新增的行数 */
    added: number;
    /** 相对 before 删掉的行数 */
    removed: number;
    /** true = 中间段太大，用了「整段删 + 整段加」的降级算法 */
    simplified: boolean;
}

const MAX_LCS_CELLS = 600000;
const MAX_RENDERED_DIFF_LINES = 4000;

/** 空输入也要给一个确定的结果（面板要判「有没有 diff」）。 */
export const EMPTY_DIFF: DiffResult = { lines: [], added: 0, removed: 0, simplified: false };

export function computeLineDiff(before: string, after: string): DiffResult {
    const a = before.split("\n");
    const b = after.split("\n");

    // 1) 剥掉前后缀：版本之间通常只有中间一小段不一样。
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
        suffix++;
    }

    const head: DiffLine[] = a.slice(0, prefix).map(text => ({ kind: "same", text }));
    const tail: DiffLine[] = suffix
        ? a.slice(a.length - suffix).map(text => ({ kind: "same", text }))
        : [];

    const beforeMiddle = a.slice(prefix, a.length - suffix);
    const afterMiddle = b.slice(prefix, b.length - suffix);

    // 2) 中间段太大就降级（不跑 LCS），否则跑 LCS。
    const cells = beforeMiddle.length * afterMiddle.length;
    const simplified = cells > MAX_LCS_CELLS;
    const middle = simplified
        ? [
              ...beforeMiddle.map((text): DiffLine => ({ kind: "remove", text })),
              ...afterMiddle.map((text): DiffLine => ({ kind: "add", text })),
          ]
        : lcsDiff(beforeMiddle, afterMiddle);

    const added = middle.reduce((n, line) => n + (line.kind === "add" ? 1 : 0), 0);
    const removed = middle.reduce((n, line) => n + (line.kind === "remove" ? 1 : 0), 0);

    return { lines: limitDiffLines([...head, ...middle, ...tail]), added, removed, simplified };
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
    const width = b.length + 1;
    // ⚠️ 用 Uint32Array 而不是 inkstone 的 Uint16Array：Uint16 的上限是 65535，
    // 理论上两篇都超过 65535 行（且 MAX_LCS_CELLS 刚好没挡住，比如 700×700）
    // 就会溢出回绕、diff 结果直接错。Uint32 多一倍内存（有格子数上限挡着，最多几 MB）。
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        const row = i * width;
        const nextRow = (i + 1) * width;
        for (let j = b.length - 1; j >= 0; j--) {
            table[row + j] =
                a[i] === b[j]
                    ? table[nextRow + j + 1] + 1
                    : Math.max(table[nextRow + j], table[row + j + 1]);
        }
    }

    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            lines.push({ kind: "same", text: a[i] });
            i++;
            j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            lines.push({ kind: "remove", text: a[i] });
            i++;
        } else {
            lines.push({ kind: "add", text: b[j] });
            j++;
        }
    }
    while (i < a.length) lines.push({ kind: "remove", text: a[i++] });
    while (j < b.length) lines.push({ kind: "add", text: b[j++] });
    return lines;
}

/** 超过上限就在中间插一行提示，头尾各留一半 —— 两头都比只留一头有用。 */
function limitDiffLines(lines: DiffLine[]): DiffLine[] {
    if (lines.length <= MAX_RENDERED_DIFF_LINES) return lines;
    const before = Math.floor((MAX_RENDERED_DIFF_LINES - 1) / 2);
    const after = MAX_RENDERED_DIFF_LINES - before - 1;
    const hidden = lines.length - before - after;
    return [
        ...lines.slice(0, before),
        { kind: "same", text: `${hidden} 行未改动，已省略` },
        ...lines.slice(lines.length - after),
    ];
}
