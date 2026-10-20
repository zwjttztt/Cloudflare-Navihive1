import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import UndoIcon from "@mui/icons-material/Undo";
import { formatRelative, formatWhen } from "../../utils/noteTime";
import type { NotesPageCtx } from "./notesPageCtx";


export default function NotesTrashPane(props: Pick<NotesPageCtx, "onEmptyTrash" | "onPurgeTrashed" | "onRestoreTrashed" | "trashedNotes">) {
    const { onEmptyTrash, onPurgeTrashed, onRestoreTrashed, trashedNotes } = props;
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
                        onClick={() => {
                            if (window.confirm(`彻底删除这 ${trashedNotes.length} 条笔记？删了就找不回来了。`)) {
                                void onEmptyTrash();
                            }
                        }}
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
                            borderRadius: 1.5,
                            "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
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
                                onClick={() => {
                                    if (window.confirm(`彻底删除「${item.title}」？删了就找不回来了。`)) {
                                        void onPurgeTrashed(item.recycleId);
                                    }
                                }}
                            >
                                <DeleteForeverIcon fontSize='small' />
                            </IconButton>
                    </Tooltip>
                    </Box>
                ))
            )}
        </Box>
    );
}
