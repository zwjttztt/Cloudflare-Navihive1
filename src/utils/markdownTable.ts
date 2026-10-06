// src/utils/markdownTable.ts
// Markdown 表格的**纯文本**操作（阶段四第 12 条）。
//
// 为什么单独成文件（和 noteTime.ts 一个道理）：
//   1. 纯函数能直接单测 —— 增删行列这种「差一个管道符就整表错位」的活儿，
//      不单测只能靠肉眼点，点错一次就写坏用户的表；
//   2. 组件文件只导出组件时才吃得下 react-refresh 快刷。
//
// ── 边界（这些是刻意定的，改之前先想清楚）──────────────────────
//   - 「表格行」= trim 之后以 | 开头**且**以 | 结尾。只以 | 开头的不算
//     （那是列表里的转义管道，硬当表格处理会把列表改坏）。
//   - 一块里必须含分隔行（`|---|---|`）才算真表格，否则只是碰巧带管道的文字。
//   - 删行只删**正文行**：表头和分隔行删了整表就废了，宁可什么都不做。
//   - 删列同理，剩最后一列时不动（一列的表没有意义，但删成空列更糟）。

/** 这行像不像表格的一行（首尾都是管道） */
export function isTableLine(line: string): boolean {
    const s = line.trim();
    return s.length > 1 && s.startsWith("|") && s.endsWith("|");
}

/** 这行是不是分隔行 `| --- | :---: |` */
export function isSeparatorLine(line: string): boolean {
    const s = line.trim();
    if (!s.startsWith("|") || !s.endsWith("|")) return false;
    const inner = s.slice(1, -1);
    if (!inner.includes("-")) return false;
    return inner
        .split("|")
        .every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

/** 拆出单元格（去掉首尾管道，按管道切，各自 trim） */
export function parseRow(line: string): string[] {
    return line
        .trim()
        .slice(1, -1)
        .split("|")
        .map(cell => cell.trim());
}

/** 把单元格拼回一行，按各列最宽对齐（对齐后源码看着才像一张表） */
export function renderRow(cells: string[], widths: number[]): string {
    const padded = cells.map((cell, i) => cell.padEnd(widths[i] ?? Math.max(3, cell.length)));
    return "| " + padded.join(" | ") + " |";
}

/** 算出各列宽度：分隔行的 `---` 至少给 3 格，否则会被撑变形 */
function columnWidths(rows: string[][]): number[] {
    const cols = Math.max(0, ...rows.map(r => r.length));
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
        let w = 3;
        for (const row of rows) {
            const cell = row[c] ?? "";
            // 分隔行的 --- 不参与撑宽（它就是 3）
            if (/^:?-{3,}:?$/.test(cell)) continue;
            w = Math.max(w, cell.length);
        }
        widths.push(w);
    }
    return widths;
}

/** 把整块重排一遍（增删列之后对齐会乱，统一重排最省事也最好看） */
function rerender(rows: string[][]): string[] {
    // 第 1 行之后那行是分隔行：它的内容要跟着列数重新生成，不能当普通单元格对齐
    const widths = columnWidths(rows);
    return rows.map((cells, i) => {
        if (i === 1 && cells.every(c => /^:?-{3,}:?$/.test(c))) {
            return "| " + widths.map(w => "-".repeat(w)).join(" | ") + " |";
        }
        return renderRow(cells, widths);
    });
}

export interface TableBlock {
    /** 表头行下标 */
    start: number;
    /** 最后一行下标（含） */
    end: number;
}

/**
 * 找光标所在的那块表格。不在表格里返回 null。
 *
 * ⚠️ 分隔行是**必要条件**：只靠「连续几行都以 | 开头」会把下面这种文字也当成表：
 *     | 这不是表
 *     | 只是两行竖线
 */
export function findTableBlock(lines: string[], cursorLine: number): TableBlock | null {
    if (cursorLine < 0 || cursorLine >= lines.length) return null;
    if (!isTableLine(lines[cursorLine])) return null;

    let start = cursorLine;
    while (start - 1 >= 0 && isTableLine(lines[start - 1])) start--;
    let end = cursorLine;
    while (end + 1 < lines.length && isTableLine(lines[end + 1])) end++;

    let hasSeparator = false;
    for (let i = start; i <= end; i++) {
        if (isSeparatorLine(lines[i])) {
            hasSeparator = true;
            break;
        }
    }
    return hasSeparator ? { start, end } : null;
}

/** 光标落在第几列（0 起）。按光标前的管道数算 */
export function columnAtCursor(line: string, cursorCol: number): number {
    const upto = line.slice(0, Math.max(0, cursorCol));
    const pipes = (upto.match(/\|/g) || []).length;
    return Math.max(0, pipes - 1);
}


/** 把 [start..end] 这段整体换成新的几行（四个操作都要用，抽出来免得各处 splice 写歪） */
function replaceBlock(lines: string[], block: TableBlock, rebuilt: string[]): string[] {
    return [...lines.slice(0, block.start), ...rebuilt, ...lines.slice(block.end + 1)];
}

/** 生成一张空表：rows 是**正文行数**（不含表头和分隔行） */
export function buildTable(rows: number, cols: number): string[] {
    const bodyRows = Math.max(1, rows);
    const colCount = Math.max(1, cols);
    const header = Array.from({ length: colCount }, (_, i) => `列${i + 1}`);
    const sep = Array.from({ length: colCount }, () => "---");
    const body = Array.from({ length: bodyRows }, () =>
        Array.from({ length: colCount }, () => "")
    );
    return rerender([header, sep, ...body]);
}

/**
 * 在光标行下面加一行。返回新行数组；不在表格里原样返回。
 * 列数取表头的（表头是列的唯一权威 —— 正文行可能少写几个格子）。
 *
 * ⚠️ 光标在**表头或分隔行**上时，新行要落到整表末尾（rows.length），不能照
 * `cursorLine` 插 —— 那会把空行夹在表头与分隔行之间，分隔行一走位整张表就散了
 * （浏览器实测撞过：加行之后源码变成「表头 / 空行 / 分隔行 / 正文」）。
 */
export function addRowBelow(lines: string[], cursorLine: number): string[] {
    const block = findTableBlock(lines, cursorLine);
    if (!block) return lines;
    const rows = lines.slice(block.start, block.end + 1).map(parseRow);
    // 列数取表头的：正文行可能少写几个格子，以它为准会加出一列残缺的行
    const empty = Array.from({ length: rows[0].length }, () => "");
    const idx = cursorLine - block.start;
    const insertAt = idx <= 1 ? rows.length : idx + 1;
    const rebuilt = rerender([...rows.slice(0, insertAt), empty, ...rows.slice(insertAt)]);
    return replaceBlock(lines, block, rebuilt);
}

/** 删掉光标所在的正文行。表头 / 分隔行不动（删了整表就废了） */
export function removeRow(lines: string[], cursorLine: number): string[] {
    const block = findTableBlock(lines, cursorLine);
    if (!block) return lines;
    // 表头是 block.start，分隔行是 block.start + 1
    if (cursorLine <= block.start + 1) return lines;
    const rows = lines.slice(block.start, block.end + 1).map(parseRow);
    const idx = cursorLine - block.start;
    const rebuilt = rerender([...rows.slice(0, idx), ...rows.slice(idx + 1)]);
    return replaceBlock(lines, block, rebuilt);
}

/** 在光标所在列**右边**加一列（表头给「新列」，分隔行给 ---） */
export function addColumnRight(lines: string[], cursorLine: number, cursorCol: number): string[] {
    const block = findTableBlock(lines, cursorLine);
    if (!block) return lines;
    const rows = lines.slice(block.start, block.end + 1).map(parseRow);
    const at = columnAtCursor(lines[cursorLine], cursorCol);
    const target = Math.min(at + 1, rows[0].length);
    const next = rows.map((cells, i) => {
        const copy = [...cells];
        copy.splice(target, 0, i === 1 ? "---" : i === 0 ? "新列" : "");
        return copy;
    });
    return replaceBlock(lines, block, rerender(next));
}

/** 删掉光标所在列。只剩一列时不动 */
export function removeColumn(lines: string[], cursorLine: number, cursorCol: number): string[] {
    const block = findTableBlock(lines, cursorLine);
    if (!block) return lines;
    const rows = lines.slice(block.start, block.end + 1).map(parseRow);
    if (rows[0].length <= 1) return lines;
    const at = Math.min(columnAtCursor(lines[cursorLine], cursorCol), rows[0].length - 1);
    const rebuilt = rerender(rows.map(cells => cells.filter((_, i) => i !== at)));
    return replaceBlock(lines, block, rebuilt);
}
