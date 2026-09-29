// src/components/AuditDialog.tsx
// 审计日志只读查看（仅站点所有者可见）。谁在何时从哪个 IP 做了什么，事后能溯源。
import { useCallback, useEffect, useState } from "react";
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Box,
    TextField,
    Typography,
    List,
    ListItem,
    ListItemText,
    Divider,
    Chip,
    CircularProgress,
} from "@mui/material";
import HistoryIcon from "@mui/icons-material/History";
import { NavigationClient } from "../API/client";

interface AuditEntry {
    id: number;
    action: string;
    actor: string;
    ip: string;
    detail: string;
    created_at: string;
}

interface AuditDialogProps {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
}

// 常见动作的中文名，其余原样展示
const ACTION_LABELS: Record<string, string> = {
    "login.success": "登录成功",
    "login.failed": "登录失败",
    "auth.recover": "密钥找回密码",
    "auth.recover.failed": "找回密码失败",
    "auth.register": "注册账号",
    "auth.register.failed": "注册失败",
    "auth.credentials": "修改凭据",
    "auth.credentials.failed": "修改凭据失败",
    "auth.recoveryKey": "更新恢复密钥",
    "auth.invite": "生成邀请码",
    "site.delete": "删除站点",
    "auth.deleteAccount": "注销账号",
    "recycle.restore": "回收站还原",
    "recycle.purge": "回收站彻底删除",
    "recycle.empty": "清空回收站",
};

function formatTime(iso: string): string {
    // D1 返回形如 2024-01-01 12:00:00（本地时区）
    const t = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : ""));
    if (Number.isNaN(t.getTime())) return iso;
    return t.toLocaleString("zh-CN", { hour12: false });
}

export default function AuditDialog({ open, onClose, client }: AuditDialogProps) {
    const [rows, setRows] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [actor, setActor] = useState("");
    const [hasMore, setHasMore] = useState(false);

    const load = useCallback(
        async (reset: boolean) => {
            setLoading(true);
            try {
                const result = await client.getAuditLog({
                    limit: 50,
                    offset: reset ? 0 : rows.length,
                    actor: actor.trim() || undefined,
                });
                const incoming = result.log || [];
                setRows(prev => (reset ? incoming : [...prev, ...incoming]));
                setHasMore(result.hasMore);
            } catch {
                // 读取失败静默：审计不是关键路径
            } finally {
                setLoading(false);
            }
        },
        [client, actor, rows.length]
    );

    useEffect(() => {
        if (open) void load(true);
    }, [open, load]);

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <HistoryIcon fontSize='small' />
                审计日志
                <Typography component='span' variant='caption' color='text.secondary' sx={{ ml: "auto" }}>
                    仅站点所有者可见
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0 }}>
                <Box sx={{ p: 2, display: "flex", gap: 1, alignItems: "center" }}>
                    <TextField
                        size='small'
                        label='按操作者筛选'
                        value={actor}
                        onChange={e => setActor(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter") void load(true);
                        }}
                        placeholder='账号名，留空看全部'
                        sx={{ flex: 1 }}
                    />
                    <Button variant='outlined' size='small' onClick={() => void load(true)} disabled={loading}>
                        筛选
                    </Button>
                </Box>
                <Divider />
                {loading && rows.length === 0 ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : rows.length === 0 ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <Typography variant='body2' color='text.secondary'>
                            暂无审计记录
                        </Typography>
                    </Box>
                ) : (
                    <List dense sx={{ py: 0 }}>
                        {rows.map(row => (
                            <ListItem
                                key={row.id}
                                divider
                                secondaryAction={
                                    <Chip
                                        size='small'
                                        variant='outlined'
                                        label={row.ip || "—"}
                                        sx={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}
                                    />
                                }
                            >
                                <ListItemText
                                    primary={
                                        <span>
                                            <b>{ACTION_LABELS[row.action] || row.action}</b>
                                            {row.actor ? ` · ${row.actor}` : ""}
                                        </span>
                                    }
                                    secondary={
                                        <span>
                                            {row.detail ? `${row.detail} · ` : ""}
                                            {formatTime(row.created_at)}
                                        </span>
                                    }
                                />
                            </ListItem>
                        ))}
                    </List>
                )}
                {hasMore && (
                    <Box sx={{ p: 1.5, textAlign: "center" }}>
                        <Button size='small' onClick={() => void load(false)} disabled={loading}>
                            加载更多
                        </Button>
                    </Box>
                )}
            </DialogContent>
            <DialogActions sx={{ px: 2, py: 1.5 }}>
                <Button onClick={onClose} variant='contained' disableElevation size='small'>
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
