// src/utils/notesBackupAdapter.ts
// 把后端 `webdav/notes/download` 的返回值换算成 NotesPage 要的形状。
//
// 为什么抽成独立模块（2026-10-16）：这段原本是 NotesOverlay 里手写的对象字面量，
// 手抄字段时**漏了 zipBase64** —— 服务端对 ZIP 备份（2026-10-11 起默认格式，
// 含附件）不解包，回的就是 `zipBase64`；漏了它前端 `payload` / `zipBase64` 双空，
// 设置弹窗只能把 `message`（服务端那里放的是文件名）当错误亮出来，
// 表现就是用户报的「笔记 WebDAV 恢复失败」。抽出来才有一个能直接喂真实返回值的
// 地方写单测（对着组件源码做静态断言守不住新增字段）。
//
// ⚠️ 后端返回是**顶层**字段（`request()` 不包 data 层），别写成 `r.data?.xxx`。
// ⚠️ 加密备份缺口令时回 code 为 encrypted / badPassword，前端据此弹口令框，必须原样带过去。
import type { NotesImportPayload, WebDavErrorCode } from "../API/types";

export interface NotesBackupDownloadShape {
    success: boolean;
    code?: WebDavErrorCode;
    message?: string;
    payload?: NotesImportPayload;
    zipBase64?: string;
}

export interface NotesBackupFetchResult {
    success: boolean;
    message: string;
    payload?: NotesImportPayload;
    zipBase64?: string;
    code?: WebDavErrorCode;
}

export function notesBackupFetchResult(r: NotesBackupDownloadShape): NotesBackupFetchResult {
    return {
        success: r.success,
        message: r.message ?? "",
        payload: r.payload,
        zipBase64: r.zipBase64,
        code: r.code,
    };
}
