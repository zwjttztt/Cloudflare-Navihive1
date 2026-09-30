// src/components/AuditDialog.tsx
// 审计日志只读查看（仅站点所有者可见）。谁在何时从哪个 IP 做了什么，事后能溯源。
//
// 两个视图：
//   1. 操作日志 —— 逐条流水，可按操作者筛选
//   2. 前端错误 —— 前端崩过什么，按「来源 + 错误信息」归并后看次数与最近发生时间
//      上报落库时是一小段 JSON，直接在流水里翻没人看得懂，所以单开一个视图。
import { useCallback, useEffect, useRef, useState } from "react";
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
    ToggleButton,
    ToggleButtonGroup,
} from "@mui/material";
import HistoryIcon from "@mui/icons-material/History";
import BugReportIcon from "@mui/icons-material/BugReport";
import { NavigationClient } from "../API/client";

interface AuditEntry {
    id: number;
    action: string;
    actor: string;
    ip: string;
    detail: string;
    created_at: string;
}

/** 前端错误聚合后的一组（与后端 ClientErrorGroup 对齐） */
interface ClientErrorGroup {
    key: string;
    source: string;
    message: string;
    count: number;
    lastAt: string;
    paths: string[];
}

interface AuditDialogProps {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
}

/** 与后端 RETENTION_DAYS 保持一致：审计日志只留这些天，超期自动清除 */
const AUDIT_RETENTION_DAYS = 7;
const PAGE_SIZE = 50;

type AuditTab = "log" | "errors";

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
    "site.batchDelete": "批量删除站点",
    "auth.deleteAccount": "注销账号",
    "recycle.restore": "回收站还原",
    "recycle.purge": "回收站彻底删除",
    "recycle.empty": "清空回收站",
    "data-export": "导出数据",
    "data-import": "导入数据",
    "client-error": "前端错误上报",
};

function formatTime(iso: string): string {
    // D1 返回形如 2024-01-01 12:00:00（本地时区）
    const t = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : ""));
    if (Number.isNaN(t.getTime())) return iso;
    return t.toLocaleString("zh-CN", { hour12: false });
}

export default function AuditDialog({ open, onClose, client }: AuditDialogProps) {
    const [tab, setTab] = useState<AuditTab>("log");
    const [rows, setRows] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    // 输入框里的值和「已提交的筛选条件」分开：否则每敲一个字都会重新拉一次列表
    const [actorInput, setActorInput] = useState("");
    const [query, setQuery] = useState("");
    const [hasMore, setHasMore] = useState(false);
    // 下一页的起点。放在 ref 里而不是 state：它变化不该触发重新拉取
    const offsetRef = useRef(0);

    // ---- 前端错误聚合视图 ----
    const [errorGroups, setErrorGroups] = useState<ClientErrorGroup[]>([]);
    const [errorsLoading, setErrorsLoading] = useState(false);
    const [errorsError, setErrorsError] = useState("");

    const fetchPage = useCallback(
        async (offset: number, actor: string) =>
            await client.getAuditLog({ limit: PAGE_SIZE, offset, actor: actor || undefined }),
        [client]
    );

    // 首屏 / 换筛选条件：从头拉第一页。
    // 只依赖 open 与 query —— 依赖 rows.length 的话，加载更多会让这个 effect 再次触发，
    // 把刚翻出来的下一页又重置回第一页（表现就是「加载更多点了没反应」）。
    useEffect(() => {
        if (!open || tab !== "log") return;
        let cancelled = false;
        setLoading(true);
        void (async () => {
            try {
                const result = await fetchPage(0, query);
                if (cancelled) return;
                const incoming = result.log || [];
                offsetRef.current = incoming.length;
                setRows(incoming);
                setHasMore(result.hasMore);
            } catch {
                // 读取失败静默：审计不是关键路径
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, query, tab, fetchPage]);

    // 切到「前端错误」时才拉：平时不占这一份查询
    useEffect(() => {
        if (!open || tab !== "errors") return;
        let cancelled = false;
        setErrorsLoading(true);
        setErrorsError("");
        void (async () => {
            try {
                const result = await client.getClientErrors();
                if (cancelled) return;
                setErrorGroups(result.groups || []);
            } catch {
                if (!cancelled) setErrorsError("读取失败（仅站点所有者可查看）");
            } finally {
                if (!cancelled) setErrorsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, tab, client]);

    const loadMore = useCallback(async () => {
        if (loading || loadingMore) return;
        setLoadingMore(true);
        try {
            const result = await fetchPage(offsetRef.current, query);
            const incoming = result.log || [];
            offsetRef.current += incoming.length;
            // 期间若有新日志写入，下一页会和已加载的重合，按 id 去重后再接上
            setRows(prev => {
                const seen = new Set(prev.map(r => r.id));
                return [...prev, ...incoming.filter(r => !seen.has(r.id))];
            });
            setHasMore(result.hasMore);
        } catch {
            // 同上，静默
        } finally {
            setLoadingMore(false);
        }
    }, [fetchPage, query, loading, loadingMore]);

    const applyFilter = useCallback(() => {
        setQuery(actorInput.trim());
    }, [actorInput]);

    const totalErrors = errorGroups.reduce((sum, g) => sum + g.count, 0);

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <HistoryIcon fontSize='small' />
                审计日志
                <Typography component='span' variant='caption' color='text.secondary' sx={{ ml: "auto" }}>
                    仅保留 {AUDIT_RETENTION_DAYS} 天
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0 }}>
                <Box sx={{ p: 2, pb: 1.5 }}>
                    <ToggleButtonGroup
                        size='small'
                        exclusive
                        value={tab}
                        onChange={(_, next: AuditTab | null) => {
                            if (next) setTab(next);
                        }}
                        aria-label='审计日志视图'
                    >
                        <ToggleButton value='log' aria-label='操作日志'>
                            操作日志
                        </ToggleButton>
                        <ToggleButton value='errors' aria-label='前端错误'>
                            前端错误
                        </ToggleButton>
                    </ToggleButtonGroup>
                </Box>

                {tab === "log" ? (
                    <>
                        <Box sx={{ px: 2, pb: 2, display: "flex", gap: 1, alignItems: "center" }}>
                            <TextField
                                size='small'
                                label='按操作者筛选'
                                value={actorInput}
                                onChange={e => setActorInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        applyFilter();
                                    }
                                }}
                                placeholder='账号名，留空看全部'
                                sx={{ flex: 1 }}
                            />
                            <Button
                                variant='outlined'
                                size='small'
                                onClick={applyFilter}
                                disabled={loading}
                            >
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
                                        // 右侧的 IP 是 secondaryAction，MUI 不会自动给它腾地方，
                                        // 正文不预留这段宽度就会被压在它下面（看起来像重叠）。
                                        sx={{ pr: 19, alignItems: "flex-start" }}
                                        secondaryAction={
                                            <Chip
                                                size='small'
                                                variant='outlined'
                                                label={row.ip || "—"}
                                                sx={{ maxWidth: 132 }}
                                            />
                                        }
                                    >
                                        <ListItemText
                                            sx={{ m: 0 }}
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
                                            primaryTypographyProps={{
                                                sx: { display: "block", wordBreak: "break-word" },
                                            }}
                                            secondaryTypographyProps={{
                                                sx: { display: "block", wordBreak: "break-word" },
                                            }}
                                        />
                                    </ListItem>
                                ))}
                            </List>
                        )}
                        {hasMore && (
                            <Box sx={{ p: 1.5, textAlign: "center" }}>
                                <Button
                                    size='small'
                                    onClick={() => void loadMore()}
                                    disabled={loading || loadingMore}
                                >
                                    {loadingMore ? "加载中…" : "加载更多"}
                                </Button>
                            </Box>
                        )}
                    </>
                ) : errorsLoading ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : errorsError ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <Typography variant='body2' color='error'>
                            {errorsError}
                        </Typography>
                    </Box>
                ) : errorGroups.length === 0 ? (
                    <Box sx={{ p: 4, textAlign: "center" }}>
                        <BugReportIcon sx={{ fontSize: 40, opacity: 0.4, mb: 1 }} />
                        <Typography variant='body2' color='text.secondary'>
                            最近没有收到前端错误上报
                        </Typography>
                    </Box>
                ) : (
                    <>
                        <Box sx={{ px: 2, pb: 1 }}>
                            <Typography variant='caption' color='text.secondary'>
                                共 {totalErrors} 次上报，归为 {errorGroups.length} 类（按次数排序）
                            </Typography>
                        </Box>
                        <Divider />
                        <List dense sx={{ py: 0 }}>
                            {errorGroups.map(group => (
                                <ListItem
                                    key={group.key}
                                    divider
                                    sx={{ pr: 8, alignItems: "flex-start" }}
                                    secondaryAction={
                                        <Chip
                                            size='small'
                                            color={group.count > 5 ? "warning" : "default"}
                                            variant={group.count > 5 ? "filled" : "outlined"}
                                            label={`${group.count} 次`}
                                        />
                                    }
                                >
                                    <ListItemText
                                        sx={{ m: 0 }}
                                        primary={
                                            <span>
                                                <b>{group.source}</b>
                                                {group.paths.length > 0
                                                    ? ` · ${group.paths.join("、")}`
                                                    : ""}
                                            </span>
                                        }
                                        secondary={
                                            <span>
                                                {group.message} · 最近 {formatTime(group.lastAt)}
                                            </span>
                                        }
                                        primaryTypographyProps={{
                                            sx: { display: "block", wordBreak: "break-word" },
                                        }}
                                        secondaryTypographyProps={{
                                            sx: { display: "block", wordBreak: "break-word" },
                                        }}
                                    />
                                </ListItem>
                            ))}
                        </List>
                    </>
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
