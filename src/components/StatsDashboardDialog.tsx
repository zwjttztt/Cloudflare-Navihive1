// src/components/StatsDashboardDialog.tsx
// 运维统计看板（仅站点所有者）：把已有的审计流水、分享浏览计数与链接健康快照
// 拼成一块可读的仪表盘 —— 数据都在服务端聚好（GET /api/stats），这里只画图。
//
// 图表零依赖：30 天柱状图是手写 SVG，Top 榜是普通 div 条形。不为几张图引入
// 图表库 —— 首屏 304KB gzip 预算只剩 5% 余量，任何图表库都能把它吃穿。
import { useEffect, useState } from "react";
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    Typography,
} from "@mui/material";
import QueryStatsIcon from "@mui/icons-material/QueryStats";
import { NavigationClient } from "../API/client";
import type { OpsStats } from "../API/methods/audit";

/** UTC 时间戳 -> YYYY-MM-DD（健康快照里的 at 是毫秒时间戳，不用 Intl，CI small-icu 也稳） */
function dayOf(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}

function humanBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

/** 近 30 天柱状图：一根柱一天，悬停出「日期：次数」提示 */
function DailyBars({ data }: { data: OpsStats["auditDaily"] }) {
    const max = Math.max(1, ...data.map(d => d.count));
    const W = 620;
    const H = 120;
    const top = 6;
    const bottom = 16;
    const bw = (W - 8) / Math.max(1, data.length);
    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            role='img'
            aria-label='近 30 天审计活跃柱状图'
            style={{ width: "100%", height: "auto", display: "block" }}
        >
            {data.map((d, i) => {
                const h = Math.round((d.count / max) * (H - top - bottom));
                return (
                    <rect
                        key={d.day}
                        x={4 + i * bw}
                        y={H - bottom - h}
                        width={Math.max(1, bw - 2)}
                        height={Math.max(d.count > 0 ? 2 : 0, h)}
                        fill='var(--accent)'
                        opacity={d.count > 0 ? 1 : 0.15}
                    >
                        <title>{`${d.day}：${d.count} 次`}</title>
                    </rect>
                );
            })}
            <text x={4} y={H - 4} fontSize={10} fill='var(--text-secondary, #888)'>
                {data[0]?.day ?? ""}
            </text>
            <text x={W - 4} y={H - 4} fontSize={10} fill='var(--text-secondary, #888)' textAnchor='end'>
                {data[data.length - 1]?.day ?? ""}
            </text>
        </svg>
    );
}

/** Top 榜一行：名称 + 条形 + 数值（max<=0 表示不画条形，纯「名称 + 备注」行） */
function BarRow({ label, value, max, hint }: { label: string; value: number; max: number; hint?: string }) {
    const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: "3px" }}>
            <Typography variant='body2' noWrap sx={{ width: "38%", flexShrink: 0 }} title={label}>
                {label}
            </Typography>
            <Box sx={{ flex: 1, bgcolor: max > 0 ? "action.hover" : "transparent", height: "8px", borderRadius: "4px", overflow: "hidden" }}>
                {max > 0 && <Box sx={{ width: `${pct}%`, bgcolor: "var(--accent)", height: "8px" }} />}
            </Box>
            <Typography variant='caption' color='text.secondary' sx={{ flexShrink: 0, minWidth: "32px", textAlign: "right" }}>
                {hint ?? value}
            </Typography>
        </Box>
    );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <Typography variant='subtitle2' sx={{ mt: 2, mb: 1 }}>
            {children}
        </Typography>
    );
}

export default function StatsDashboardDialog({
    open,
    onClose,
    client,
}: {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
}) {
    const [stats, setStats] = useState<OpsStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        let alive = true;
        setLoading(true);
        setError("");
        client
            .getOpsStats()
            .then(r => {
                if (alive) setStats(r.stats);
            })
            .catch(e => {
                if (alive) setError(String((e as Error)?.message || e));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [open, client]);

    const actionMax = Math.max(1, ...(stats?.auditTopActions.map(a => a.count) ?? [1]));
    const shareMax = Math.max(1, ...(stats?.shareTop.map(s => s.views) ?? [1]));

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog' aria-label='统计看板'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <QueryStatsIcon fontSize='small' />
                统计看板
                <Typography component='span' variant='caption' sx={{ color: "text.secondary", ml: "auto" }}>
                    近 30 天 · 实时聚合
                </Typography>
            </DialogTitle>
            <DialogContent dividers>
                {loading && (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress size={28} />
                    </Box>
                )}
                {!loading && error && (
                    <Typography variant='body2' color='error' sx={{ py: 2 }}>
                        {error}
                    </Typography>
                )}
                {!loading && !error && stats && (
                    <>
                        <SectionTitle>内容概览</SectionTitle>
                        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                            <Chip size='small' label={`站点 ${stats.counts.sites}`} />
                            <Chip size='small' label={`分组 ${stats.counts.groups}`} />
                            <Chip size='small' label={`笔记 ${stats.counts.notes}`} />
                            <Chip
                                size='small'
                                label={`附件 ${stats.counts.attachments}（${humanBytes(stats.counts.attachmentBytes)}）`}
                            />
                        </Box>

                        <SectionTitle>审计活跃（近 30 天）</SectionTitle>
                        {stats.auditDaily.some(d => d.count > 0) ? (
                            <DailyBars data={stats.auditDaily} />
                        ) : (
                            <Typography variant='body2' color='text.secondary'>
                                近 30 天没有审计记录
                            </Typography>
                        )}

                        <SectionTitle>高频动作</SectionTitle>
                        {stats.auditTopActions.length > 0 ? (
                            stats.auditTopActions.map(a => (
                                <BarRow key={a.action} label={a.action} value={a.count} max={actionMax} />
                            ))
                        ) : (
                            <Typography variant='body2' color='text.secondary'>
                                暂无数据
                            </Typography>
                        )}

                        <Divider sx={{ mt: 2 }} />
                        <SectionTitle>分享浏览 Top</SectionTitle>
                        {stats.shareTop.length > 0 ? (
                            stats.shareTop.map((s, i) => (
                                <BarRow
                                    key={`${s.kind}-${i}`}
                                    label={`${s.kind === "note" ? "笔记" : "分组"} · ${s.title}`}
                                    value={s.views}
                                    max={shareMax}
                                />
                            ))
                        ) : (
                            <Typography variant='body2' color='text.secondary'>
                                还没有产生浏览的分享
                            </Typography>
                        )}

                        <Divider sx={{ mt: 2 }} />
                        <SectionTitle>链接健康</SectionTitle>
                        {stats.health.total > 0 ? (
                            <>
                                <Box sx={{ display: "flex", gap: 1, mb: 1 }}>
                                    <Chip
                                        size='small'
                                        color={stats.health.deadCount > 0 ? "warning" : "success"}
                                        label={`疑似失效 ${stats.health.deadCount}`}
                                    />
                                    <Chip size='small' label={`已探测 ${stats.health.total}`} />
                                </Box>
                                {stats.health.deadLatest.slice(0, 10).map(d => (
                                    <BarRow key={d.url} label={d.url} value={d.at} max={0} hint={dayOf(d.at)} />
                                ))}
                            </>
                        ) : (
                            <Typography variant='body2' color='text.secondary'>
                                尚未开启链接健康同步（设置里打开后这里显示探测结果）
                            </Typography>
                        )}
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
