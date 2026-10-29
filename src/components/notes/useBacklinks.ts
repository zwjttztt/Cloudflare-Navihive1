import { useEffect, useMemo, useState } from "react";
import type {
    Note
} from "../../API/http";
import { buildBacklinks, resolveWikiLinks } from "../../utils/noteWikiLink";
import type { NotesPageProps } from "./notesPageCtx";

export interface NotesBacklinksDeps {
    /** 当前笔记（用于取 id / title / content 算反链） */
    active: Note | null;
    /** 编辑器草稿（有草稿时按草稿算，避免库里那份盖住正在写的内容） */
    draft: { title: string; content: string } | null;
    /** 全部笔记（扫它算反链 / 出链） */
    notes: Note[];
    /** 摘要档补全全文 */
    onLoadFullNotes?: NotesPageProps["onLoadFullNotes"];
}


export function useBacklinks(deps: NotesBacklinksDeps) {
    const { active, draft, notes, onLoadFullNotes } = deps;

    const [graphOpen, setGraphOpen] = useState(false);

    const [backlinksOpen, setBacklinksOpen] = useState(false);

    const [backlinkAnchor, setBacklinkAnchor] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!backlinkAnchor && !backlinksOpen && !graphOpen) return;
        if (!onLoadFullNotes || !notes.some(n => n.content_truncated)) return;
        void onLoadFullNotes();
    }, [backlinkAnchor, backlinksOpen, graphOpen, notes, onLoadFullNotes]);

    const backlinks = useMemo(() => {
        if (!active || active.id === undefined) return [];
        return buildBacklinks(notes, {
            id: active.id,
            title: active.title,
            content: draft?.content ?? active.content ?? "",
        });
    }, [active, draft?.content, notes]);

    const outgoingLinks = useMemo(() => {
        if (!active || active.id === undefined) return [];
        return resolveWikiLinks(notes, {
            id: active.id,
            title: active.title,
            content: draft?.content ?? active.content ?? "",
        });
    }, [active, draft?.content, notes]);

    return { backlinkAnchor, setBacklinkAnchor, backlinksOpen, setBacklinksOpen, graphOpen, setGraphOpen, backlinks, outgoingLinks };
}
