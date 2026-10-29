import { useCallback, useEffect } from "react";
import type {
    Note
} from "../../API/http";
import { type EditorDraft } from "../../hooks/useEditorTools";
import { reportError } from "../../utils/errorReporter";
import type { CompletionSources } from "../../utils/noteCompletion";
import { exportNoteAsMarkdown } from "../../utils/noteExport";
import { exportNoteAsHtml, printNoteAsPdf } from "../../utils/noteHtmlExport";
import { toggleTaskLine } from "../../utils/noteTasks";
import { noteTemplateDraft, type NoteTemplateId } from "../../utils/noteTemplates";
import { getSiteIndex } from "../../utils/siteIndex";
import type { NoteEmbedTarget } from "../NoteEmbedNode";
import { noteExcerpt } from "./markdownToolbar";
import type { NotesPageProps } from "./notesPageCtx";
import type { RowMenuState } from "./useNotesRowActions";

export interface NotesRowMenuActionsDeps {
    notes: Note[];
    activeId: number | null;
    active: Note | null;
    draft: { title: string; content: string } | null;
    sideId: number | null;
    sideDraft: EditorDraft | null;
    notesByFolder: ReadonlyMap<number, { id: number; title: string }[]>;
    tags: NonNullable<NotesPageProps["folderTags"]>["tags"];
    tagCounts: ReadonlyMap<number, number>;
    noteTags: Record<number, number[]>;
    templatePick: { folderId: number | null; el: HTMLElement | null } | null;
    dirty: boolean;
    save: () => Promise<boolean>;
    setChecked: (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
    setDraft: (updater: { title: string; content: string } | null | ((prev: { title: string; content: string } | null) => { title: string; content: string } | null)) => void;
    setSideId: (id: number | null) => void;
    setSideMode: (mode: "edit" | "split" | "preview") => void;
    setSideDraft: (updater: EditorDraft | null | ((prev: EditorDraft | null) => EditorDraft | null)) => void;
    setActiveId: (id: number | null) => void;
    setMobileDetail: (v: boolean) => void;
    setRowMenu: (state: RowMenuState | null) => void;
    setRowActionsSuppressed: (id: number | null) => void;
    setMenuClosing: (v: boolean) => void;
    rowMenu: RowMenuState | null;
    onCreate: NotesPageProps["onCreate"];
    onUpdate: NotesPageProps["onUpdate"];
    onDelete: NotesPageProps["onDelete"];
    onNotify?: NotesPageProps["onNotify"];
    onEnsureFullNote?: NotesPageProps["onEnsureFullNote"];
    onLoadFullNotes?: NotesPageProps["onLoadFullNotes"];
    siteLinkApi?: NotesPageProps["siteLinkApi"];
    accountName?: string;
}

const EMPTY_NOTE_LINKS: { id: number; title: string }[] = [];

export function useNotesRowMenuActions(deps: Pick<NotesRowMenuActionsDeps, "notes" | "activeId" | "active" | "draft" | "sideId" | "sideDraft" | "tags" | "tagCounts" | "setChecked" | "setDraft" | "setSideId" | "setSideMode" | "setSideDraft" | "setActiveId" | "setMobileDetail" | "setRowMenu" | "setRowActionsSuppressed" | "setMenuClosing" | "rowMenu" | "onUpdate" | "onNotify" | "onEnsureFullNote" | "siteLinkApi">) {
    const { notes, activeId, active, draft, sideId, sideDraft, tags, tagCounts, setChecked, setDraft, setSideId, setSideMode, setSideDraft, setActiveId, setMobileDetail, setRowMenu, setRowActionsSuppressed, setMenuClosing, rowMenu, onUpdate, onNotify, onEnsureFullNote, siteLinkApi } = deps;
    const toggleChecked = useCallback((id: number) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, [setChecked]);

    const closeRowMenu = useCallback(() => {
        setRowActionsSuppressed(rowMenu?.noteId ?? null);
        setRowMenu(null);
        setMenuClosing(true);
    }, [rowMenu, setMenuClosing, setRowActionsSuppressed, setRowMenu]);

    const boundSiteId = active?.site_id ?? null;

    const boundSite = boundSiteId != null ? (siteLinkApi?.resolve(boundSiteId) ?? null) : null;

    const boundSiteMissing = boundSiteId != null && Boolean(siteLinkApi) && boundSite === null;

    const onOpenBoundSite = useCallback(() => {
        if (boundSiteId != null) siteLinkApi?.open(boundSiteId);
    }, [boundSiteId, siteLinkApi]);

    const exportTarget = useCallback(
        (): { title: string; content: string } => {
            if (
                active &&
                draft &&
                (draft.title !== (active.title || "") || draft.content !== (active.content || ""))
            ) {
                return { title: draft.title, content: draft.content };
            }
            return { title: active?.title || "", content: active?.content || "" };
        },
        [active, draft]
    );

    const completionSources = useCallback((): CompletionSources => {
        return {
            notes: () =>
                notes
                    .filter(n => !n.archived)
                    .map(n => ({
                        id: n.id,
                        title: n.title || "",
                        excerpt: noteExcerpt(n.content || ""),
                    })),
            tags: () => tags.map(t => ({ name: t.name, count: tagCounts.get(t.id!) ?? 0 })),
            // 站点（D2 双向绑定）：`[[站名]]` 写完点了会打开那个站点。
            // 读模块级索引（导航站加载站点时写进去的），读不到就是空数组 ——
            // 少一种补全而已，不报错、也不影响笔记双链。
            sites: () => getSiteIndex().map(s => ({ name: s.name, url: s.url })),
        };
    }, [notes, tags, tagCounts]);

    const handleToggleTask = useCallback((line: number, checked: boolean) => {
        setDraft(d => {
            if (!d) return d;
            const next = toggleTaskLine(d.content, line, checked);
            return next === null ? d : { ...d, content: next };
        });
    }, [setDraft]);

    const handleSideToggleTask = useCallback((line: number, checked: boolean) => {
        setSideDraft(d => {
            if (!d) return d;
            const next = toggleTaskLine(d.content, line, checked);
            return next === null ? d : { ...d, content: next };
        });
    }, [setSideDraft]);

    const exportOne = useCallback(
        async (note: Note) => {
            try {
                // 摘要档下 note.content 只有前 200 字：先补全文再导，否则导出的是残篇。
                // 补不到（接口失败 / 没接这个能力）就退回入参，宁可导残篇也不能什么都不给。
                const full = (note.content_truncated && typeof note.id === "number"
                    ? await onEnsureFullNote?.(note.id)
                    : null) ?? note;
                const name = exportNoteAsMarkdown(full.title, full.content);
                onNotify?.(`已导出「${name}」`, "success");
            } catch (error) {
                reportError(error, { source: "note-export" });
                onNotify?.("导出失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            }
        },
        [onNotify, onEnsureFullNote]
    );

    const copyText = useCallback(
        async (text: string, okMsg: string) => {
            try {
                await navigator.clipboard.writeText(text);
                onNotify?.(okMsg, "success");
            } catch {
                onNotify?.("复制失败（浏览器拒绝了剪贴板访问）", "error");
            }
        },
        [onNotify]
    );

    useEffect(() => {
        if (!onEnsureFullNote) return;
        for (const id of [activeId, sideId]) {
            if (typeof id !== "number") continue;
            if (notes.find(n => n.id === id)?.content_truncated) {
                void onEnsureFullNote(id);
            }
        }
    }, [activeId, sideId, notes, onEnsureFullNote]);

    const noteLink = useCallback((note: Note): string => {
        if (note.id === undefined) return "";
        return `${globalThis.location.origin}${globalThis.location.pathname}${globalThis.location.search}#note=${note.id}`;
    }, []);

    useEffect(() => {
        const m = /^#note=(\d+)$/.exec(globalThis.location.hash || "");
        if (!m) return;
        const id = Number(m[1]);
        if (notes.some(n => n.id === id)) {
            setActiveId(id);
            setMobileDetail(true);
        }
        // 只在笔记列表首次到位时读一次 hash
    }, [notes.length]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在列表长度变化时读取深链接，避免保存刷新抢回用户选择

    const openInSide = useCallback(
        (note: Note) => {
            if (note.id === undefined) return;
            if (note.id === activeId) {
                onNotify?.("这条笔记已经在主编辑区打开了", "info");
                return;
            }
            setSideId(note.id);
            setSideMode("edit"); // 每次新开一篇都回到编辑态，别把上一次的预览态带过来
            setSideDraft({ title: note.title || "", content: note.content || "" });
            onNotify?.(`已在侧边打开「${note.title || "无标题"}」`, "success");
        },
        [activeId, onNotify, setSideDraft, setSideId, setSideMode]
    );

    const closeSide = useCallback(() => {
        const note = sideId !== null ? notes.find(n => n.id === sideId) : null;
        if (note && sideDraft) {
            const dirtySide =
                sideDraft.title !== (note.title || "") ||
                sideDraft.content !== (note.content || "");
            if (dirtySide) {
                void onUpdate(note.id!, {
                    title: sideDraft.title,
                    content: sideDraft.content,
                });
            }
        }
        setSideId(null);
        setSideDraft(null);
    }, [sideId, notes, sideDraft, setSideId, setSideDraft, onUpdate]);

    useEffect(() => {
        if (sideId === null) return;
        if (!notes.some(n => n.id === sideId)) {
            setSideId(null);
            setSideDraft(null);
        }
    }, [sideId, notes, setSideId, setSideDraft]);

    const exportHtmlOne = useCallback(
        async (note: Note) => {
            try {
                // 同 exportOne：摘要态先补全文，否则导出的单文件只有 200 字
                const full = (note.content_truncated && typeof note.id === "number"
                    ? await onEnsureFullNote?.(note.id)
                    : null) ?? note;
                const name = await exportNoteAsHtml(full.title, full.content);
                onNotify?.(`已导出「${name}」`, "success");
            } catch (error) {
                reportError(error, { source: "note-export-html" });
                onNotify?.("导出失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            }
        },
        [onNotify, onEnsureFullNote]
    );

    const exportPdfOne = useCallback(
        async (note: Note) => {
            try {
                // 同 exportOne：打印的是摘要态的话，PDF 里就只有开头 200 字
                const full = (note.content_truncated && typeof note.id === "number"
                    ? await onEnsureFullNote?.(note.id)
                    : null) ?? note;
                await printNoteAsPdf(full.title, full.content);
            } catch (error) {
                reportError(error, { source: "note-export-pdf" });
                onNotify?.("打印失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            }
        },
        [onNotify, onEnsureFullNote]
    );
    return { toggleChecked, closeRowMenu, boundSite, boundSiteMissing, onOpenBoundSite, exportTarget, completionSources, handleToggleTask, handleSideToggleTask, exportOne, copyText, noteLink, openInSide, closeSide, exportHtmlOne, exportPdfOne };
}

export function useNotesNavigation(deps: Pick<NotesRowMenuActionsDeps, "notes" | "notesByFolder" | "dirty" | "save" | "templatePick" | "setActiveId" | "setMobileDetail" | "setDraft" | "onCreate">) {
    const { notes, notesByFolder, dirty, save, templatePick, setActiveId, setMobileDetail, setDraft, onCreate } = deps;
    const openNote = useCallback((note: Note) => {
        setActiveId(note.id ?? null);
        setMobileDetail(true);
    }, [setActiveId, setMobileDetail]);

    const startCreateInFolder = useCallback(
        async (folderId: number | null) => {
            const created = await onCreate(
                folderId === null
                    ? { title: "", content: "" }
                    : { title: "", content: "", folder_id: folderId }
            );
            if (created?.id) {
                setActiveId(created.id);
                // folder_id 已经在 onCreate 里落库了，草稿只带正文两字段
                // （自动保存也只提交这两个，见 save）
                setDraft({ title: "", content: "" });
                setMobileDetail(true);
            }
        },
        [onCreate, setActiveId, setDraft, setMobileDetail]
    );

    const createFromTemplate = useCallback(
        async (templateId: NoteTemplateId | null) => {
            const folderId = templatePick?.folderId ?? null;
            const seeded = templateId ? noteTemplateDraft(templateId) : { title: "", content: "" };
            const created = await onCreate(
                folderId === null
                    ? { title: seeded.title, content: seeded.content }
                    : { title: seeded.title, content: seeded.content, folder_id: folderId }
            );
            if (created?.id) {
                setActiveId(created.id);
                setDraft({ title: seeded.title, content: seeded.content });
                setMobileDetail(true);
            }
        },
        [onCreate, templatePick, setActiveId, setDraft, setMobileDetail]
    );

    const notesInFolder = useCallback(
        (folderId: number) => notesByFolder.get(folderId) ?? EMPTY_NOTE_LINKS,
        [notesByFolder]
    );

    const switchTo = useCallback(
        async (id: number | null) => {
            if (dirty && !(await save())) return false;
            setActiveId(id);
            return true;
        },
        [dirty, save, setActiveId]
    );

    const jumpToNote = useCallback(
        async (id: number) => {
            if (!(await switchTo(id))) return false;
            setMobileDetail(true);
            return true;
        },
        [setMobileDetail, switchTo]
    );

    const resolveNote = useCallback(
        (title: string): NoteEmbedTarget | null => {
            const key = title.trim().toLowerCase();
            if (!key) return null;
            const hit = notes.find(n => (n.title ?? "").trim().toLowerCase() === key);
            return hit ? { title: hit.title ?? "", content: hit.content ?? "" } : null;
        },
        [notes]
    );

    const handleOpenEmbedNote = useCallback(
        (title: string) => {
            const key = title.trim().toLowerCase();
            const hit = notes.find(n => (n.title ?? "").trim().toLowerCase() === key);
            if (hit?.id != null) void jumpToNote(hit.id);
        },
        [notes, jumpToNote]
    );
    return { openNote, startCreateInFolder, createFromTemplate, notesInFolder, switchTo, jumpToNote, resolveNote, handleOpenEmbedNote };
}
