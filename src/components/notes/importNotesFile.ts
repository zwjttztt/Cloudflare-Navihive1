// src/components/notes/importNotesFile.ts
//
// 记事本的「导入」全过程（2026-10-23 从 NotesPage.tsx 搬出来，近 200 行）。
//
// 搬的理由不是「文件太长」，而是这块**根本没有 React 状态**：它是一次纯过程 ——
// 认文件类型（zip / 纯 JSON）→ 解包 → 附件并发回传 → 改写正文里的附件链接 →
// 写库 → 让当前页重拉。全是输入输出的确定性映射，留在组件里只会挡着主干
// （组件那边该看的是「面板怎么排、状态怎么窜」，不是 zip 条目怎么过滤）。
//
// 外部依赖刻意收窄成四件：**别在这儿 import api 单例**，
// 也别忘了 importNotes 是类方法 —— 调用方必须把它包成箭头函数传进来，
// 直接甩一个裸函数引用会把 this 丢掉（this.request 就炸）。
import type { Note, NoteFolder, NoteImportProgress, NoteImportStats, NotesImportPayload, NoteTag } from "../../API/types";
import { extractNoteTags } from "../../utils/markdownNoteTags";
import { readZip } from "../../utils/zip";

export interface ImportNotesDeps {
    /** 服务端导入能力。老部署没有 → 直接给一句人话错误，不是静默不干活 */
    importNotes?: (payload: NotesImportPayload) => Promise<NoteImportStats>;
    /** 附件回传能力（ZIP 里有附件时必须，否则只能提示「需先配置存储」） */
    uploadApi?: {
        uploadAttachment(
            file: File,
            noteId?: number | null
        ): Promise<{ id: string; url: string; filename: string; mime: string; size: number }>;
    };
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
    /** 导入完必须让当前页重拉（只广播给别的标签页会造成「提示弹了但列表没变」的空窗） */
    onDatasetChanged?: () => void | Promise<void>;
}

/**
 * 导入一份笔记文件（ZIP / JSON）。
 *
 * `onProgress` 的 phase 文案会被直接显示给用户，改文案要连同上层的测试一起看。
 */
export async function importNotesFile(
    deps: ImportNotesDeps,
    file: File,
    onProgress?: (p: NoteImportProgress) => void
): Promise<NoteImportStats> {
    if (!deps.importNotes) throw new Error("当前部署不支持导入笔记");

    const isZip =
        /\.zip$/i.test(file.name) ||
        file.type === "application/zip" ||
        file.type === "application/x-zip-compressed";

    if (!isZip) {
        const parsed = JSON.parse(await file.text()) as NotesImportPayload;
        onProgress?.({ phase: "写入笔记", current: 0, total: 0 });
        const stats = await deps.importNotes(parsed);
        // 当前标签页必须自己重拉（2026-10-17：此前只广播给其它标签页，
        // 本页要等跨设备轮询的下个周期才看见恢复结果 —— 用户报「提示弹了
        // 还要很久才恢复完」就是这个空窗）。等重拉完才让上层弹成功提示。
        onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
        await deps.onDatasetChanged?.();
        return stats;
    }

    const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
    const notesEntry = entries.find(e => e.path === "notes.json");
    if (!notesEntry) {
        const visibleEntries = entries.filter(e => !e.path.split("/").some(part => part.startsWith(".") || part === "__MACOSX"));
        const markdownEntries = visibleEntries.filter(e => /\.md$/i.test(e.path));
        if (!markdownEntries.length) throw new Error("ZIP 中没有 notes.json 或 Markdown 笔记");
        const folders: NoteFolder[] = [];
        const folderIds = new Map<string, number>();
        const ensureFolder = (path: string): number | null => {
            if (!path) return null;
            if (folderIds.has(path)) return folderIds.get(path)!;
            const parts = path.split("/");
            const name = parts.pop()!;
            const parent_id = ensureFolder(parts.join("/"));
            const id = folders.length + 1;
            folderIds.set(path, id);
            folders.push({ id, name, parent_id });
            return id;
        };
        const attachments = new Map<string, string>();
        const paths = new Set<string>();
        for (const entry of entries) {
            if (entry.path.split("/").some(p => p === ".." || p === ".") || entry.path.startsWith("/") || entry.path.includes("\\")) throw new Error("不安全的文件路径");
            if (paths.has(entry.path)) throw new Error("ZIP 中存在重复文件路径");
            paths.add(entry.path);
        }
        const attachmentEntries = visibleEntries.filter(e => !/\.md$/i.test(e.path) && e.data.length);
        onProgress?.({ phase: "解包备份", current: 0, total: 0 });
        if (attachmentEntries.length && !deps.uploadApi) throw new Error("ZIP 含附件，需先配置附件上传能力");
        // 附件之间互不依赖（路径→url 各写各的），并发回传比串行快数倍 ——
        // 附件一多时这正是「恢复太慢」的大头。并发 6：再多对单线用户带宽没增益。
        let uploadedCount = 0;
        let next = 0;
        const uploadWorker = async () => {
            while (next < attachmentEntries.length) {
                const entry = attachmentEntries[next++];
                const uploaded = await deps.uploadApi!.uploadAttachment(new File([entry.data.slice().buffer], entry.path.split("/").pop()!));
                if (!uploaded?.url) throw new Error("附件上传失败：" + entry.path);
                attachments.set(entry.path, uploaded.url);
                uploadedCount += 1;
                onProgress?.({ phase: "上传附件", current: uploadedCount, total: attachmentEntries.length });
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, attachmentEntries.length) }, uploadWorker));
        const tags: NoteTag[] = [];
        const tagIds = new Map<string, number>();
        const noteTags: Record<string, number[]> = {};
        const imported: Note[] = [];
        for (const entry of markdownEntries) {
            if (entry.path.split("/").some(p => p === ".." || p === ".")) throw new Error("不安全的文件路径");
            const parts = entry.path.split("/");
            const title = parts.pop()!.replace(/\.md$/i, "");
            let content = new TextDecoder().decode(entry.data);
            const resolveAsset = (target: string): string | undefined => {
                let decoded: string;
                try { decoded = decodeURIComponent(target); } catch { return undefined; }
                const stack = parts.slice();
                for (const p of decoded.split("/")) {
                    if (p === "..") stack.pop();
                    else if (p !== "." && p) stack.push(p);
                }
                const direct = attachments.get(stack.join("/")) ?? attachments.get(decoded);
                if (direct) return direct;
                const basename = decoded.split("/").pop()?.toLowerCase();
                const matches = [...attachments].filter(([path]) => path.split("/").pop()?.toLowerCase() === basename);
                // 同名附件有歧义时不猜，保留原引用给用户修正。
                return matches.length === 1 ? matches[0][1] : undefined;
            };
            content = content.replace(/!\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
                const path = target.split("|")[0];
                const url = resolveAsset(path);
                return url ? `![${path.split("/").pop()}](${url})` : whole;
            }).replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (whole, lead: string, target: string, end: string) => {
                const url = resolveAsset(target);
                return url ? lead + url + end : whole;
            });
            const id = imported.length + 1;
            const names = extractNoteTags(content);
            const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
            if (frontMatter) {
                const tagField = /^tags:\s*(.*(?:\r?\n[ \t]+-[^\n]*)*)/m.exec(frontMatter)?.[1];
                if (tagField) {
                    for (const name of tagField.replace(/[[\]"']/g, "").split(/[,\r\n]/).map(tag => tag.trim().replace(/^-\s*/, "").replace(/^#/, ""))) {
                        if (/^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,79}$/u.test(name)) names.push(name);
                    }
                }
            }
            for (const name of new Set(names)) {
                if (!tagIds.has(name)) { const tagId = tags.length + 1; tagIds.set(name, tagId); tags.push({ id: tagId, name }); }
            }
            noteTags[String(id)] = [...new Set(names)].map(name => tagIds.get(name)!);
            imported.push({ id, title, content, folder_id: ensureFolder(parts.join("/")) });
        }
        onProgress?.({ phase: "写入笔记", current: attachmentEntries.length, total: attachmentEntries.length });
        const stats = await deps.importNotes({ notes: imported, folders, tags, noteTags });
        // 同上：等当前页重拉完再返回，成功提示弹出时列表已经是新的
        onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
        await deps.onDatasetChanged?.();
        return stats;
    }
    const payload = JSON.parse(
        new TextDecoder().decode(notesEntry.data)
    ) as NotesImportPayload;

    // 1) 附件回传，记下 id 变化
    const idMap = new Map<string, string>();
    let skipped = 0;
    const attachmentEntries = entries.filter(e => {
        if (!e.path.startsWith("attachments/")) return false;
        const name = e.path.slice("attachments/".length);
        return name.indexOf("__") > 0;
    });
    let done = 0;
    let next = 0;
    onProgress?.({ phase: "解包备份", current: 0, total: 0 });
    // 同上：附件回传并发 6（idMap 各写各的键，无顺序依赖）
    const uploadWorker = async () => {
        while (next < attachmentEntries.length) {
            const entry = attachmentEntries[next++];
            const name = entry.path.slice("attachments/".length);
            const sep = name.indexOf("__");
            if (sep <= 0) { done += 1; continue; }
            const oldId = name.slice(0, sep);
            const filename = name.slice(sep + 2);
            if (!deps.uploadApi) {
                skipped += 1;
            } else {
                try {
                    const uploaded = await deps.uploadApi.uploadAttachment(
                        new File([entry.data.slice().buffer], filename || "file")
                    );
                    if (uploaded?.id && uploaded.id !== oldId) idMap.set(oldId, uploaded.id);
                } catch {
                    skipped += 1;
                }
            }
            done += 1;
            onProgress?.({ phase: "上传附件", current: done, total: attachmentEntries.length });
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, attachmentEntries.length) }, uploadWorker));

    // 2) 正文里的旧 id 换成新 id（只换真发生变化的那些）
    if (idMap.size > 0 && Array.isArray(payload.notes)) {
        payload.notes = payload.notes.map((n: Note) =>
            n && typeof n.content === "string"
                ? {
                      ...n,
                      content: n.content.replace(
                          /\/api\/notes\/attachments\/([A-Za-z0-9_-]+)/g,
                          (whole: string, id: string) =>
                              idMap.has(id)
                                  ? `/api/notes/attachments/${idMap.get(id)}`
                                  : whole
                      ),
                  }
                : n
        );
    }

    onProgress?.({ phase: "写入笔记", current: attachmentEntries.length, total: attachmentEntries.length });
    const stats = await deps.importNotes(payload);
    if (skipped > 0) {
        deps.onNotify?.(`有 ${skipped} 个附件没能回传（正文里的引用可能还是旧的）`, "warning" as never);
    }
    // 导入是一次数据集级变更：广播给其它标签页 + 当前页立刻重拉
    // （此前只广播，本页要等轮询下个周期才看见 —— 同 2026-10-17 的空窗问题）
    onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
    await deps.onDatasetChanged?.();
    return stats;
}
