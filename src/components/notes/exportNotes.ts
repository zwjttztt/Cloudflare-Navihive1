// src/components/notes/exportNotes.ts
//
// 记事本的「整库导出」两条路（2026-10-23 从 NotesPage.tsx 搬出来）：JSON 一份、
// ZIP 一份（含附件字节）。**逐字搬**，只把四个外部依赖改成入参。
//
// 为什么值得单独成文件：这两件事跟 React 一点关系都没有 —— 拼 payload、
// 取附件、打 zip、造 Blob、触发下载。留在组件里时，"导出"与"面板怎么排"
// 混在一起，改任何一边都得先读懂另一边。
//
// ⚠️ 两处的行为刻意保留，别顺手"优化"：
//   1. 下载后 setTimeout(4000) 才 revokeObjectURL —— 立刻回收在部分浏览器会打断下载；
//   2. ZIP 里的附件名是 `${id}__${filename}` —— 导入要靠前缀把正文里的旧 id 换成新 id。
import type { Note, NoteFolder, NoteTag } from "../../API/types";
import { createZip, type ZipEntry } from "../../utils/zip";

/** 一起打进包里的分类数据。这里只做 JSON 序列化，不参与任何计算 */
export interface ExportFolderTags {
    folders?: NoteFolder[];
    tags?: NoteTag[];
    noteTags?: Record<number, number[]>;
}

export interface ExportNotesDeps {
    notes: Note[];
    folderTags?: ExportFolderTags;
    /** 附件清单（取不到就只导 ZIP 里的 notes.json，不失败） */
    uploadApi?: {
        listAttachments?(): Promise<{ id: string; size: number; filename: string; mime: string }[]>;
    };
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

/** 导出全部笔记（2026-10-08 设置→数据，照 inkstone 的导出）：JSON 一份
 *  （笔记 + 文件夹 + 标签 + 关联），不含附件二进制。前端直接从内存生成，
 *  不需要新端点；导入等后续批次再做。 */
export function exportAllNotesJson(deps: ExportNotesDeps): void {
    try {
        const payload = {
            kind: "navihive-notes-export",
            exported_at: new Date().toISOString(),
            notes: deps.notes,
            folders: deps.folderTags?.folders ?? [],
            tags: deps.folderTags?.tags ?? [],
            noteTags: deps.folderTags?.noteTags ?? {},
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `notes-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 下载已触发后再回收；立刻 revoke 在部分浏览器会打断下载
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        deps.onNotify?.(`已导出 ${deps.notes.length} 条笔记（JSON，不含附件）`, "success");
    } catch (error) {
        deps.onNotify?.(
            "导出失败：" + (error instanceof Error ? error.message : "未知错误"),
            "error"
        );
    }
}

/**
 * 导出 zip（含图片附件，2026-10-09）。
 *
 * 之前只有 JSON：笔记正文里的图片是 `/api/notes/attachments/<id>` 这种引用，
 * JSON 里不带字节 —— 一旦删站或迁移，正文还在、图全没了。inkstone 的
 * 「导出 zip」把笔记 + 附件一起打包，UI 上直接写「用于完整恢复」。
 * zip 是我们自己实现的（utils/zip.ts，零依赖），打包不压缩（图片本来就是压过的）。
 */
export async function exportAllNotesZip(deps: ExportNotesDeps): Promise<void> {
    try {
        const payload = {
            kind: "navihive-notes-export",
            exported_at: new Date().toISOString(),
            notes: deps.notes,
            folders: deps.folderTags?.folders ?? [],
            tags: deps.folderTags?.tags ?? [],
            noteTags: deps.folderTags?.noteTags ?? {},
        };
        const entries: ZipEntry[] = [
            {
                path: "notes.json",
                data: new TextEncoder().encode(JSON.stringify(payload, null, 2)),
            },
        ];
        const list = deps.uploadApi?.listAttachments ? await deps.uploadApi.listAttachments() : [];
        let failed = 0;
        for (const att of list) {
            try {
                const res = await fetch(
                    `/api/notes/attachments/${encodeURIComponent(att.id)}`,
                    { credentials: "same-origin" }
                );
                if (!res.ok) {
                    failed += 1;
                    continue;
                }
                entries.push({
                    // ⚠️ 文件名里带原始 id：导入时要靠它把正文里的旧引用换成新 id
                    path: `attachments/${att.id}__${att.filename || "file"}`,
                    data: new Uint8Array(await res.arrayBuffer()),
                });
            } catch {
                failed += 1;
            }
        }
        const packed = createZip(entries);
        // ⚠️ 直接把 Uint8Array 交给 Blob 在 TS 5.7+ 会挑 ArrayBufferLike/SharedArrayBuffer，
        // 显式拷一份 ArrayBuffer 绕开（浏览器端 Blob 本来就只接受这一支）。
        const out = new Uint8Array(packed.byteLength);
        out.set(packed);
        const blob = new Blob([out.buffer], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `notes-backup-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        deps.onNotify?.(
            failed === 0
                ? `已导出 ${deps.notes.length} 条笔记 + ${list.length} 个附件（ZIP）`
                : `已导出，但有 ${failed} 个附件没取到（ZIP）`,
            failed === 0 ? "success" : "warning" as never
        );
    } catch (error) {
        deps.onNotify?.(
            "导出失败：" + (error instanceof Error ? error.message : "未知错误"),
            "error"
        );
    }
}
