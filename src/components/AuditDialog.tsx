// src/components/AuditDialog.tsx
// 审计日志只读查看（仅站点所有者可见）。谁在何时从哪个 IP 做了什么，事后能溯源。
//
// 两个视图：
//   1. 操作日志 —— 逐条流水，可按操作者筛选
//   2. 前端错误 —— 前端崩过什么，按「来源 + 错误信息」归并后看次数与最近发生时间
//      上报落库时是一小段 JSON，直接在流水里翻没人看得懂，所以单开一个视图。
import { useCallback, useEffect, useRef, useState } from "react";
import { actionLabel } from "../utils/auditActionLabels";
import { fmtDateTime } from "../utils/format";
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
    Chip,
    CircularProgress,
    ToggleButton,
    ToggleButtonGroup,
} from "@mui/material";
import HistoryIcon from "@mui/icons-material/History";
import BugReportIcon from "@mui/icons-material/BugReport";
import { NavigationClient } from "../API/client";
import DialogCloseButton from "./DialogCloseButton";
import { DialogEmptyState, DialogListRow } from "./DialogListRow";
import { dialogActionsSx, dialogTitleSx } from "./dialogShell";

// 2026-10-29：业务抽成命名导出的 `AuditPanel`。弹窗关闭时 MUI 本来就不渲染子树，
// 所以面板里的 `open` 判断等价于「挂载了」，抽出去后直接用挂载时机即可 ——
// 中心里切走再切回来等于重开一次，行为与原来一致。

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

/** 面板输入：与弹窗共享 */
export interface AuditPanelProps {
    client: NavigationClient;
    /** 网站设置里配的保留天数；没传就用后端默认值，不把 7 天写死在界面上 */
    retentionDays?: number;
}

interface AuditDialogProps extends AuditPanelProps {
    open: boolean;
    onClose: () => void;
}

/** 后端默认保留天数；界面优先用网站设置里的 retention.days */
const DEFAULT_RETENTION_DAYS = 7;
const PAGE_SIZE = 50;

type AuditTab = "log" | "errors";

/**
 * 审计日志面板本体：视图切换 + 筛选 + 列表 + 加载更多。
 * 只 owner 看得到（入口层已过滤，后端同样会挡）。
 */
export function AuditPanel({ client, retentionDays }: AuditPanelProps) {
    const [tab, setTab] = useState<AuditTab>("log");
    const [rows, setRows] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    // 拉不到日志要说出来：空白列表和「没读到」长得一样的话，
    // 用户会以为真的没有记录，而不是自己的权限或网络出了问题
    const [loadError, setLoadError] = useState("");
    const [moreError, setMoreError] = useState("");
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
        if (tab !== "log") return;
        let cancelled = false;
        setLoading(true);
        setLoadError("");
        void (async () => {
            try {
                const result = await fetchPage(0, query);
                if (cancelled) return;
                const incoming = result.log || [];
                offsetRef.current = incoming.length;
                setRows(incoming);
                setHasMore(result.hasMore);
            } catch (error) {
                if (cancelled) return;
                setRows([]);
                setHasMore(false);
                setLoadError((error as Error)?.message || "读取审计日志失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [query, tab, fetchPage]);

    // 切到「前端错误」时才拉：平时不占这一份查询
    useEffect(() => {
        if (tab !== "errors") return;
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
    }, [tab, client]);

    const loadMore = useCallback(async () => {
        if (loading || loadingMore) return;
        setLoadingMore(true);
        setMoreError("");
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
        } catch (error) {
            setMoreError((error as Error)?.message || "加载更多失败");
        } finally {
            setLoadingMore(false);
        }
    }, [fetchPage, query, loading, loadingMore]);

    const applyFilter = useCallback(() => {
        setQuery(actorInput.trim());
    }, [actorInput]);

    const totalErrors = errorGroups.reduce((sum, g) => sum + g.count, 0);

    return (
        <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
            {/* 视图切换与「保留 N 天」钉在顶部：列表自己滚，切视图不用先往回滚。
                保留天数原来挂在弹窗标题右侧 —— 中心的标题由共享外壳给，
                这里挪进正文第一行，两处都只出现一次。 */}
            <Box
                sx={{
                    flexShrink: 0,
                    pb: 1.5,
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    flexWrap: "wrap",
                }}
            >
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
                <Typography component='span' variant='caption' sx={{ color: 'text.secondary' }}>
                    仅保留 {retentionDays ?? DEFAULT_RETENTION_DAYS} 天
                </Typography>
            </Box>

            {tab === "log" && (
                <Box sx={{ flexShrink: 0, pb: 1.5, display: "flex", gap: 1, alignItems: "center" }}>
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
            )}

            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {tab === "log" ? (
                    <>
                        {loading && rows.length === 0 ? (
                            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                                <CircularProgress size={28} />
                            </Box>
                        ) : loadError ? (
                            <Box sx={{ p: 4, textAlign: "center" }}>
                                <Typography variant='body2' color='error' sx={{ mb: 1.5 }}>
                                    没读到审计日志：{loadError}
                                </Typography>
                                <Button
                                    size='small'
                                    variant='outlined'
                                    onClick={() => setQuery(actorInput.trim())}
                                >
                                    重试
                                </Button>
                            </Box>
                        ) : rows.length === 0 ? (
                            <DialogEmptyState
                                title='暂无审计记录'
                                hint='有人改动分组 / 卡片 / 配置之后，这里会按时间倒序留下一条'
                            />
                        ) : (
                            <List dense sx={{ py: 0 }}>
                                {rows.map(row => (
                                    <DialogListRow
                                        key={row.id}
                                        alignItems='flex-start'
                                        primary={
                                            <span>
                                                <b>{actionLabel(row.action)}</b>
                                                {row.actor ? ` · ${row.actor}` : ""}
                                            </span>
                                        }
                                        secondary={
                                            <span>
                                                {row.detail ? `${row.detail} · ` : ""}
                                                {fmtDateTime(row.created_at)}
                                            </span>
                                        }
                                        actions={
                                            <Chip
                                                size='small'
                                                variant='outlined'
                                                label={row.ip || "—"}
                                                sx={{ maxWidth: 132 }}
                                            />
                                        }
                                        actionsWidth={144}
                                    />
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
                        {moreError && (
                            <Box sx={{ pb: 1.5 }}>
                                <Typography variant='caption' color='error'>
                                    {moreError}
                                </Typography>
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
                        <Typography variant='body2' sx={{
                            color: 'text.secondary'
                        }}>
                            最近没有收到前端错误上报
                        </Typography>
                    </Box>
                ) : (
                    <>
                        <Box sx={{ pb: 1 }}>
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
                                共 {totalErrors} 次上报，归为 {errorGroups.length} 类（按次数排序）
                            </Typography>
                        </Box>
                        <List dense sx={{ py: 0 }}>
                            {errorGroups.map(group => (
                                <DialogListRow
                                    key={group.key}
                                    alignItems='flex-start'
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
                                            {group.message} · 最近 {fmtDateTime(group.lastAt)}
                                        </span>
                                    }
                                    actions={
                                        <Chip
                                            size='small'
                                            color={group.count > 5 ? "warning" : "default"}
                                            variant={group.count > 5 ? "filled" : "outlined"}
                                            label={`${group.count} 次`}
                                        />
                                    }
                                    actionsWidth={64}
                                />
                            ))}
                        </List>
                    </>
                )}
            </Box>
        </Box>
    );
}

export default function AuditDialog({
    open,
    onClose,
    client,
    retentionDays,
}: AuditDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
            <DialogTitle sx={dialogTitleSx}>
                <HistoryIcon fontSize='small' />
                审计日志
                <DialogCloseButton onClose={onClose} label='关闭审计日志' />
            </DialogTitle>
            <DialogContent dividers sx={{ p: 2, minHeight: 240 }}>
                <AuditPanel client={client} retentionDays={retentionDays} />
            </DialogContent>
            <DialogActions sx={dialogActionsSx}>
                <Button onClick={onClose} variant='contained' disableElevation size='small'>
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
