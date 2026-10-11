// src/utils/noteTodoAgenda.ts
// 全库待办聚合（2026-10-11 阶段②）：把散在各篇笔记里的 `- [ ]` 任务收进一个清单。
//
// 为什么值得单独一个文件：聚合是**纯文本扫描**，与 UI 无关 —— 能被单测钉死
// （围栏代码块里的 `- [ ]` 是示例不是任务，绝不能算进去）。

import { parseTaskLine } from "./noteTasks";

export interface TodoAgendaItem {
    noteId: number;
    /** 0 基行号（toggleTaskLine 同一口径） */
    line: number;
    text: string;
    done: boolean;
}

export interface TodoAgendaInput {
    id?: number;
    title?: string;
    content?: string | null;
}

/**
 * 扫一批笔记收集任务项。
 *
 * 围栏代码块（``` / ~~~）里的内容整段跳过：代码示例里的 `- [ ]` 是文档，
 * 不是用户的待办 —— 误报会让面板失信。未闭合的围栏到文末按关闭处理。
 */
export function collectTodos(
    notes: ReadonlyArray<TodoAgendaInput>,
    opts: { includeDone?: boolean } = {}
): TodoAgendaItem[] {
    const out: TodoAgendaItem[] = [];
    for (const note of notes) {
        if (note?.id === undefined || typeof note.content !== "string" || !note.content) continue;
        const lines = note.content.split("\n");
        let fence: string | null = null;
        for (let line = 0; line < lines.length; line++) {
            const raw = lines[line];
            // 围栏状态机：``` 与 ~~~ 都认，缩进 ≤3 空格（CommonMark 口径）
            const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
            if (fenceMatch) {
                if (!fence) fence = fenceMatch[1][0];
                else if (fenceMatch[1][0] === fence) fence = null;
                continue;
            }
            if (fence) continue;
            const parsed = parseTaskLine(raw);
            if (!parsed) continue;
            if (!opts.includeDone && parsed.done) continue;
            out.push({ noteId: note.id, line, text: parsed.text, done: parsed.done });
        }
    }
    return out;
}

/** 面板概览：全库未完成 / 已完成数量（标题栏那两个数字用） */
export function todoCounts(notes: ReadonlyArray<TodoAgendaInput>): { open: number; done: number } {
    let open = 0;
    let done = 0;
    for (const item of collectTodos(notes, { includeDone: true })) {
        if (item.done) done += 1;
        else open += 1;
    }
    return { open, done };
}
