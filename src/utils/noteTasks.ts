// src/utils/noteTasks.ts
// 预览里的任务复选框 ↔ 源码 `- [ ]` / `- [x]` 的互改。
//
// 为什么单独一个文件：两处要用同一套判据 ——
//   ① 预览层的 `onChange`（点一下就把勾打回去写进正文）
//   ② 未来的任何「批量勾选」入口
// 判据只有一条句子，写两遍迟早分手（比如一边认 `*`、`+`，另一边只认 `-`）。
//
// ⚠️ **行号是 0 基**：markdown-it 的 `token.map[0]` 就是 0 基的行号，
// 和本文件处理的数组下标天然一致。别再手工 ±1 —— 上一轮在 syncScroll 上
// 就因为「注释写 1 基、代码用 0 基」差了一整行。

/** 一条源码文本里的任务项：`- [ ] 待办`（无序三种标记 / 有序列表都认） */
const TASK_LINE = /^(\s*(?:[-*+]\s+|\d+[.)]\s+))\[([ xX])\]/;

/**
 * 把某一行的任务勾选状态改成 `checked`。
 *
 * @returns 改完的整篇源码；**那一行不是任务项时返回 null**（调用方据此放弃写回，
 *          而不是把错乱的文本塞回去 —— 宁可什么都不做）
 */
export function toggleTaskLine(source: string, line: number, checked: boolean): string | null {
    const lines = source.split("\n");
    if (line < 0 || line >= lines.length) return null;
    const current = lines[line];
    const m = TASK_LINE.exec(current);
    if (!m) return null;
    // 只替换方括号里那一个字符，行首的缩进与列表标记原样保留
    const mark = checked ? "x" : " ";
    if (m[2] === mark) return null; // 已经是目标状态了，没有改动可写
    const at = m[0].lastIndexOf("[") + 1;
    lines[line] = current.slice(0, at) + mark + current.slice(at + 1);
    return lines.join("\n");
}

/** 这一行是不是任务项（预览层判断要不要给可点勾选框时用） */
export function isTaskLine(source: string, line: number): boolean {
    const target = source.split("\n")[line];
    return typeof target === "string" && TASK_LINE.test(target);
}
