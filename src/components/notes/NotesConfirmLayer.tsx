// src/components/notes/NotesConfirmLayer.tsx
// 命名弹窗与两个确认弹窗（批量删除、删除文件夹/标签）。
//
// 从 NotesPage.tsx 主 return 里整段搬过来，JSX 与表达式逐字未改。
// 这些浮层（Dialog / Menu / Drawer）都是 MUI 的 portal，挂在哪一层 DOM 上不影响
// 视觉层级，所以搬出去**不改变任何可见行为** —— 只是让主文件不再是「一屏装不下」。

import ConfirmDialog from "../ConfirmDialog";
import NamePromptDialog from "../NamePromptDialog";
import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesConfirmLayer(props: Pick<NotesPageCtx, "bulkDelete" | "bulkDeleteOpen" | "checkedNotes" | "closeNamePrompt" | "closeRemove" | "namePrompt" | "onClose" | "removeTarget" | "setBulkDeleteOpen" | "submitNamePrompt" | "submitRemove">) {
    const { bulkDelete, bulkDeleteOpen, checkedNotes, closeNamePrompt, closeRemove, namePrompt, removeTarget, setBulkDeleteOpen, submitNamePrompt, submitRemove } = props;
    return (
        <>
            <NamePromptDialog
                open={namePrompt !== null}
                title={namePrompt?.title ?? ''}
                description={namePrompt?.description}
                defaultValue={namePrompt?.defaultValue ?? ''}
                confirmText={namePrompt?.confirmText ?? '确定'}
                placeholder={namePrompt?.kind === 'folder' ? '文件夹名字' : '标签名字'}
                onConfirm={submitNamePrompt}
                onClose={closeNamePrompt}
            />
            <ConfirmDialog
                open={removeTarget !== null}
                title={`删除${removeTarget?.kind === 'folder' ? '文件夹' : '标签'}`}
                description={
                    removeTarget?.kind === 'folder' ? (
                        <>
                            真的要删除「{removeTarget?.name}」吗？
                            <br />
                            里面的笔记**不会被删**，只是回到「未归类」；直接挂在它下面的子文件夹会升到根目录。
                        </>
                    ) : (
                        <>
                            真的要删除标签「{removeTarget?.name}」吗？笔记本身不会动，只是不再带这个标签。
                        </>
                    )
                }
                impact={{
                    object: removeTarget?.kind === 'folder' ? '文件夹' : '标签',
                    undoable: false,
                }}
                danger
                confirmText='删除'
                onConfirm={submitRemove}
                onClose={closeRemove}
            />

            {/* 批量删除的二次确认（2026-10-09）：删的是用户勾的那批，
                数量必须写在弹框里 —— 「确定删除吗」四个字看不出是 1 条还是 37 条 */}
            <ConfirmDialog
                open={bulkDeleteOpen}
                title={`删除选中的 ${checkedNotes.length} 条笔记`}
                description={
                    <>
                        它们会进回收站，之后还能还原回来。
                        <br />
                        {checkedNotes.slice(0, 3).map(n => n.title || "无标题").join("、")}
                        {checkedNotes.length > 3 ? ` 等 ${checkedNotes.length} 条` : ""}
                    </>
                }
                impact={{ object: "笔记", count: checkedNotes.length, undoable: true }}
                danger
                confirmText='删除'
                busyText='删除中…'
                onConfirm={() => void bulkDelete()}
                onClose={() => setBulkDeleteOpen(false)}
            />
        </>
    );
}
