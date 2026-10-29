import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { NotesPageProps, NoteView } from "./notesPageCtx";
import type { NamePromptState, RemoveTarget } from "./useNotesRowActions";

export type FolderTagApi = NonNullable<NotesPageProps["folderTags"]>;

export interface NotesTaxonomyDeps {
    folderTags: FolderTagApi | undefined;
    setActiveFolder: Dispatch<SetStateAction<number | null>>;
    setView: Dispatch<SetStateAction<NoteView>>;
    setActiveTag: Dispatch<SetStateAction<number | null>>;
    namePrompt: NamePromptState | null;
    setNamePrompt: (state: NamePromptState | null) => void;
    removeTarget: RemoveTarget | null;
    setRemoveTarget: (target: RemoveTarget | null) => void;
}


export function useNotesTaxonomy(deps: NotesTaxonomyDeps) {
    const { folderTags, setActiveFolder, setView, setActiveTag, namePrompt, setNamePrompt, removeTarget, setRemoveTarget } = deps;

    const askName = useCallback(
        (
            kind: "folder" | "tag",
            options: {
                parentId?: number | null;
                defaultValue?: string;
                title?: string;
                description?: string;
                renameId?: number;
            } = {}
        ) => {
            const parentId = options.parentId ?? null;
            setNamePrompt({
                kind,
                parentId,
                renameId: options.renameId,
                title:
                    options.title ??
                    (kind === "folder"
                        ? parentId
                            ? "新建子文件夹"
                            : "新建文件夹"
                        : "新建标签"),
                description: options.description,
                defaultValue: options.defaultValue,
                confirmText: options.renameId !== undefined ? "保存" : kind === "folder" ? "新建文件夹" : "新建标签",
            });
        },
        [setNamePrompt]
    );

    const closeNamePrompt = useCallback(() => setNamePrompt(null), [setNamePrompt]);

    const createFolder = useCallback(
        async (name: string, parentId: number | null = null) => {
            const created = await folderTags?.onCreateFolder(name, parentId);
            // 只在建的是**根目录**文件夹时才自动切过去：新建子文件夹就把左栏
            // 跳到那个子文件夹，会让「我只是想加一个子项」变成视图被抢走。
            if (created?.id !== undefined && parentId === null) {
                setActiveFolder(created.id);
                // 切过去就连视图一起切（同点文件夹：否则「全部 N」行还高亮着，
                // 中栏却只剩这一个空文件夹 —— 2026-10-18 用户报的同类困惑）
                setView("folder");
            }
        },
        [folderTags, setActiveFolder, setView]
    );

    const renameFolder = useCallback(
        async (id: number, name: string) => {
            await folderTags?.onRenameFolder(id, name);
        },
        [folderTags]
    );

    const removeFolder = useCallback(
        async (id: number) => {
            await folderTags?.onRemoveFolder(id);
            // 删掉的是当前选中的那个，就得跟着回到「全部」，否则左栏停在一个空视图上
            setActiveFolder(cur => (cur === id ? null : cur));
            setView(cur => (cur === "folder" ? "all" : cur));
        },
        [folderTags, setActiveFolder, setView]
    );

    const createTag = useCallback(
        async (name: string) => {
            const created = await folderTags?.onCreateTag(name);
            if (created?.id !== undefined) setActiveTag(created.id);
        },
        [folderTags, setActiveTag]
    );

    const renameTag = useCallback(
        async (id: number, name: string) => {
            await folderTags?.onRenameTag(id, name);
        },
        [folderTags]
    );

    const removeTag = useCallback(
        async (id: number) => {
            await folderTags?.onRemoveTag(id);
            setActiveTag(cur => (cur === id ? null : cur));
        },
        [folderTags, setActiveTag]
    );

    const submitNamePrompt = useCallback(
        async (name: string) => {
            const ask = namePrompt;
            if (!ask) return;
            if (ask.renameId !== undefined) {
                if (ask.kind === "folder") await renameFolder(ask.renameId, name);
                else await renameTag(ask.renameId, name);
            } else if (ask.kind === "folder") {
                await createFolder(name, ask.parentId);
            } else {
                await createTag(name);
            }
            setNamePrompt(null);
        },
        [namePrompt, setNamePrompt, renameFolder, renameTag, createFolder, createTag]
    );

    const submitRemove = useCallback(async () => {
        const target = removeTarget;
        if (!target) return;
        if (target.kind === "folder") await removeFolder(target.id);
        else await removeTag(target.id);
        setRemoveTarget(null);
    }, [removeTarget, removeFolder, removeTag, setRemoveTarget]);

    return { askName, closeNamePrompt, createFolder, renameFolder, removeFolder, createTag, renameTag, removeTag, submitNamePrompt, submitRemove };
}
