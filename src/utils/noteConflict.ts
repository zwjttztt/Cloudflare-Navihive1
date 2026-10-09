// src/utils/noteConflict.ts
// 笔记保存的「乐观并发冲突」—— 前后端共用同一个类。
//
// 为什么单独放一个文件：worker 路由（判断 409）与前端 client（识别 409）
// 都要用它，而 methods/notes.ts 里那些后端方法体会带进 worker-only 的依赖，
// 不能让前端 bundle 去 import 它。这个文件没有任何依赖，两边都能引。

import type { Note } from "../API/types";

export class NoteConflictError extends Error {
    /** 库里当前那版（前端拿它显示「别人的版本」或让用户覆盖） */
    readonly note: Note | null;
    constructor(message: string, note: Note | null = null) {
        super(message);
        this.name = "NoteConflictError";
        this.note = note;
    }
}

/** 类型守卫：catch 到的是 unknown，不能直接 instanceof 之外还读属性 */
export function isNoteConflict(error: unknown): error is NoteConflictError {
    return (
        error instanceof NoteConflictError ||
        (typeof error === "object" &&
            error !== null &&
            (error as { name?: string }).name === "NoteConflictError")
    );
}
