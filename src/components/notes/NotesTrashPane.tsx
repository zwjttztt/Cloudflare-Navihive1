import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import UndoIcon from "@mui/icons-material/Undo";
import { formatRelative, formatWhen } from "../../utils/noteTime";
import ConfirmDialog from "../ConfirmDialog";
import type { NotesPageCtx } from "./notesPageCtx";


/** 待确认的「彻底删除」目标：整站清空 / 单条 */
type PurgeTarget = { kind: "all" } | { kind: "one"; id: number; title: string } | null;

export default function NotesTrashPane(props: Pick<NotesPageCtx, "onEmptyTrash" | "onPurgeTrashed" | "onRestoreTrashed" | "trashedNotes">) {
    const { onEmptyTrash, onPurgeTrashed, onRestoreTrashed, trashedNotes } = props;
    // 2026-10-25：彻底删除的确认从 window.confirm 换成站内 ConfirmDialog。
    // 系统 confirm 的三个硬伤：不能标危险色、不能写「影响几项 / 不可撤销」、
    // 也不受站内主题控制 —— 而「删了就找不回来」正是最需要说清后果的那一次点击。
    const [purgeTarget, setPurgeTarget] = useState<PurgeTarget>(null);
    return (
        <Box sx={{ px: 0.75, pb: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 0.75 }}>
                <Typography variant='caption' color='text.secondary' sx={{ flex: 1 }}>
                    删除的笔记会先放到这里，保留 30 天
                </Typography>
                {trashedNotes.length > 0 && (
                    <Button
                        size='small'
                        color='error'
                        data-action='empty-trash'
                        onClick={() => setPurgeTarget({ kind: "all" })}
                        sx={{ fontSize: 12, py: 0.25 }}
                    >
                        清空
                    </Button>
                )}
            </Box>
            {trashedNotes.length === 0 ? (
                <Typography variant='body2' color='text.secondary' sx={{ p: 2 }}>
                    回收站是空的。
                </Typography>
            ) : (
                trashedNotes.map(item => (
                    <Box
                        key={item.recycleId}
                        data-trash-id={item.recycleId}
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            px: 1.25,
                            py: 0.9,
                            borderRadius: "var(--notes-radius-row, 12px)",
                            "&:hover": { bgcolor: "var(--neutral-wash)" },
                        }}
                    >
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography
                                variant='body2'
                                sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {item.title}
                            </Typography>
                            <Typography
                                variant='caption'
                                color='text.disabled'
                                sx={{ fontSize: 11 }}
                                title={formatWhen(item.deletedAt)}
                            >
                                {/* deletedAt 是毫秒时间戳，同样要走统一的解析入口 */}
                                {formatRelative(item.deletedAt)}
                            </Typography>
                        </Box>
                        <Tooltip title='还原到全部笔记'>
                            <IconButton
                                size='small'
                                aria-label={`还原 ${item.title}`}
                                data-action='restore'
                                onClick={() => void onRestoreTrashed(item.recycleId)}
                            >
                                <UndoIcon fontSize='small' />
                            </IconButton>
                    </Tooltip>
                        <Tooltip title='彻底删除（找不回来）'>
                            <IconButton
                                size='small'
                                color='error'
                                aria-label={`彻底删除 ${item.title}`}
                                data-action='purge'
                                onClick={() => setPurgeTarget({ kind: "one", id: item.recycleId, title: item.title })}
                            >
                                <DeleteForeverIcon fontSize='small' />
                            </IconButton>
                    </Tooltip>
                    </Box>
                ))
            )}
            <ConfirmDialog
                open={purgeTarget !== null}
                title={purgeTarget?.kind === "all" ? "清空回收站" : "彻底删除这篇笔记"}
                description={
                    purgeTarget?.kind === "one"
                        ? `「${purgeTarget.title}」会被永久删除，不再占用存储。`
                        : "回收站里的笔记会被全部永久删除，不再占用存储。"
                }
                impact={{
                    object: "笔记",
                    count: purgeTarget?.kind === "one" ? 1 : trashedNotes.length,
                    undoable: false,
                }}
                confirmText={purgeTarget?.kind === "all" ? "全部删除" : "彻底删除"}
                cancelText='取消'
                danger
                busyText='删除中…'
                onConfirm={async () => {
                    if (!purgeTarget) return;
                    if (purgeTarget.kind === "all") await onEmptyTrash();
                    else await onPurgeTrashed(purgeTarget.id);
                }}
                onClose={() => setPurgeTarget(null)}
            />
        </Box>
    );
}
