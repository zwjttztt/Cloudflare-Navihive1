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
    /** "note" 是阶段三起才进回收站的（记事本删掉的笔记） */
    kind: "site" | "group" | "note";
    name: string;
    deletedAt: number;
}

/** 后端默认保留天数；界面优先用网站设置里配的 retention.days */
const DEFAULT_RETENTION_DAYS = 7;

interface RecycleBinDialogProps {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
    /** 还原后通知外层刷新（bootstrap 重新拉数据） */
    onChanged?: () => void;
    onNotify?: (msg: string, severity?: "success" | "info" | "error") => void;
    /** 网站设置里配的保留天数；没传就用后端默认值，不再把 7 天写死在界面上 */
    retentionDays?: number;
}

function formatTime(tsSeconds: number): string {
    if (!tsSeconds) return "—";
    return new Date(tsSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

export default function RecycleBinDialog({
    open,
    onClose,
    client,
    onChanged,
    onNotify,
    retentionDays,
}: RecycleBinDialogProps) {
    const theme = useTheme();
    const [items, setItems] = useState<RecycleItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    // 读不出来要说明白：空列表和「没读到」在界面上不能长得一样，
    // 否则用户会以为回收站真的是空的，直接关掉窗口走人
    const [loadError, setLoadError] = useState("");
    // 单项永久删除也要过一道确认：列表里还原和彻底删除两个图标挨着，
    // 手指一偏就是不可逆的删除
    const [pendingPurge, setPendingPurge] = useState<RecycleItem | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            const result = await client.getRecycleBin();
            setItems(result.items || []);
        } catch (error) {
            setItems([]);
            setLoadError((error as Error)?.message || "读取回收站失败");
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

    // 清空回收站：失败时抛出去 —— 确认弹窗收到异常就不关闭，
    // 用户可以直接再点一次，不用重新走一遍「打开回收站 → 清空」。
    const handleClearAll = async () => {
        setBusyId(-1);
        let ok = false;
        try {
            const r = await client.emptyRecycleBin();
            ok = Boolean(r.success);
            if (ok) {
                setItems([]);
                onNotify?.("已清空回收站", "success");
            } else {
                onNotify?.("清空失败", "error");
            }
        } catch {
            onNotify?.("清空失败", "error");
        } finally {
            setBusyId(null);
        }
        if (!ok) throw new Error("清空回收站失败");
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <RestoreFromTrashIcon fontSize='small' />
                回收站
                <Typography
                    component='span'
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        ml: "auto"
                    }}>
                    仅保留 {retentionDays ?? DEFAULT_RETENTION_DAYS} 天，超期自动清除
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0, minHeight: 120 }}>
                {loading && items.length === 0 ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : loadError ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <Typography variant='body2' color='error' sx={{ mb: 1.5 }}>
                            没读到回收站内容：{loadError}
                        </Typography>
                        <Button size='small' variant='outlined' onClick={() => void refresh()}>
                            重试
                        </Button>
                    </Box>
                ) : items.length === 0 ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <Typography variant='body2' sx={{
                            color: 'text.secondary'
                        }}>
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
                                    // 还原是这一行的主要动作，做成带文字的按钮；
                                    // 彻底删除不可逆，弱化成一个红色图标并与还原拉开距离，
                                    // 两个动作紧挨着时手指很容易点错
                                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                                        <Button
                                            size='small'
                                            startIcon={<RestoreFromTrashIcon fontSize='small' />}
                                            disabled={busyId !== null}
                                            onClick={() => void handleRestore(item.id)}
                                            sx={{ textTransform: "none" }}
                                        >
                                            还原
                                        </Button>
                                        <Tooltip title='彻底删除'>
                                            <IconButton
                                                size='small'
                                                edge='end'
                                                disabled={busyId !== null}
                                                aria-label={`彻底删除 ${item.name}`}
                                                onClick={() => setPendingPurge(item)}
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
                                                sx={{
                                                    color: 'text.secondary',
                                                    ml: 1
                                                }}>
                                                {item.kind === "group" ? "分组" : item.kind === "note" ? "笔记" : "站点"}
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

            {/* 单项也要确认：这一行旁边就是「还原」，点错了没有第二次机会 */}
            <ConfirmDialog
                open={pendingPurge !== null}
                title='彻底删除'
                danger
                description={
                    pendingPurge
                        ? `「${pendingPurge.name}」将被永久删除，无法恢复。`
                        : ""
                }
                impact={{ object: "回收站条目", count: 1, undoable: false }}
                confirmText='永久删除'
                onClose={() => setPendingPurge(null)}
                onConfirm={async () => {
                    const target = pendingPurge;
                    setPendingPurge(null);
                    if (target) await handlePurge(target.id);
                }}
            />

            <ConfirmDialog
                open={confirmClear}
                title='清空回收站'
                danger
                description='将永久删除回收站里的全部条目，且无法恢复。确定继续吗？'
                impact={{ object: "回收站条目", count: items.length, undoable: false }}
                confirmText='清空'
                busyText='清空中…'
                onClose={() => setConfirmClear(false)}
                onConfirm={handleClearAll}
            />
        </Dialog>
    );
}
