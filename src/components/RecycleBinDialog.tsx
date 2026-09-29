// src/components/RecycleBinDialog.tsx
// 回收站：站点 / 分组被「删除」后先软删除到这里，可在此还原或彻底删除（不可恢复）。
import { useCallback, useEffect, useState } from "react";
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Box,
    Typography,
    List,
    ListItem,
    ListItemText,
    IconButton,
    CircularProgress,
    Tooltip,
    useTheme,
} from "@mui/material";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import { NavigationClient } from "../API/client";
import ConfirmDialog from "./ConfirmDialog";

interface RecycleItem {
    id: number;
    kind: "site" | "group";
    name: string;
    deletedAt: number;
}

interface RecycleBinDialogProps {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
    /** 还原后通知外层刷新（bootstrap 重新拉数据） */
    onChanged?: () => void;
    onNotify?: (msg: string, severity?: "success" | "info" | "error") => void;
}

function formatTime(tsSeconds: number): string {
    if (!tsSeconds) return "—";
    return new Date(tsSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

export default function RecycleBinDialog({ open, onClose, client, onChanged, onNotify }: RecycleBinDialogProps) {
    const theme = useTheme();
    const [items, setItems] = useState<RecycleItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await client.getRecycleBin();
            setItems(result.items || []);
        } catch {
            // 读取失败静默处理
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        if (open) void refresh();
    }, [open, refresh]);

    const handleRestore = async (id: number) => {
        setBusyId(id);
        try {
            const r = await client.restoreRecycleItem(id);
            if (r.success) {
                onNotify?.("已还原", "success");
                onChanged?.();
                await refresh();
            } else {
                onNotify?.("还原失败", "error");
            }
        } catch {
            onNotify?.("还原失败", "error");
        } finally {
            setBusyId(null);
        }
    };

    const handlePurge = async (id: number) => {
        setBusyId(id);
        try {
            const r = await client.purgeRecycleItem(id);
            if (r.success) await refresh();
            else onNotify?.("删除失败", "error");
        } catch {
            onNotify?.("删除失败", "error");
        } finally {
            setBusyId(null);
        }
    };

    const handleClearAll = async () => {
        setBusyId(-1);
        try {
            const r = await client.emptyRecycleBin();
            if (r.success) {
                setItems([]);
                onNotify?.("已清空回收站", "success");
            } else {
                onNotify?.("清空失败", "error");
            }
        } catch {
            onNotify?.("清空失败", "error");
        } finally {
            setBusyId(null);
            setConfirmClear(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <RestoreFromTrashIcon fontSize='small' />
                回收站
                <Typography component='span' variant='caption' color='text.secondary' sx={{ ml: "auto" }}>
                    删除的站点 / 分组会先到这里
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0, minHeight: 120 }}>
                {loading && items.length === 0 ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : items.length === 0 ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <Typography variant='body2' color='text.secondary'>
                            回收站是空的
                        </Typography>
                    </Box>
                ) : (
                    <List dense sx={{ py: 0 }}>
                        {items.map(item => (
                            <ListItem
                                key={item.id}
                                divider
                                secondaryAction={
                                    <Box sx={{ display: "flex", gap: 0.5 }}>
                                        <Tooltip title='还原'>
                                            <IconButton
                                                size='small'
                                                edge='end'
                                                disabled={busyId !== null}
                                                onClick={() => void handleRestore(item.id)}
                                                sx={{ color: theme.palette.primary.main }}
                                            >
                                                <RestoreFromTrashIcon fontSize='small' />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title='彻底删除'>
                                            <IconButton
                                                size='small'
                                                edge='end'
                                                disabled={busyId !== null}
                                                onClick={() => void handlePurge(item.id)}
                                                sx={{ color: theme.palette.error.main }}
                                            >
                                                <DeleteForeverIcon fontSize='small' />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <span>
                                            <b>{item.name}</b>
                                            <Typography
                                                component='span'
                                                variant='caption'
                                                color='text.secondary'
                                                sx={{ ml: 1 }}
                                            >
                                                {item.kind === "group" ? "分组" : "站点"}
                                            </Typography>
                                        </span>
                                    }
                                    secondary={`删除于 ${formatTime(item.deletedAt)}`}
                                />
                            </ListItem>
                        ))}
                    </List>
                )}
            </DialogContent>
            <DialogActions sx={{ px: 2, py: 1.5, gap: 1 }}>
                <Button
                    color='error'
                    startIcon={<DeleteSweepIcon />}
                    size='small'
                    disabled={items.length === 0 || busyId !== null}
                    onClick={() => setConfirmClear(true)}
                >
                    清空回收站
                </Button>
                <Box sx={{ flex: 1 }} />
                <Button onClick={onClose} variant='contained' disableElevation size='small'>
                    关闭
                </Button>
            </DialogActions>

            <ConfirmDialog
                open={confirmClear}
                title='清空回收站'
                danger
                description='将永久删除回收站里的全部条目，且无法恢复。确定继续吗？'
                confirmText='清空'
                onClose={() => setConfirmClear(false)}
                onConfirm={() => void handleClearAll()}
            />
        </Dialog>
    );
}
