// src/components/StatsPanel.tsx
// 「运营看板」面板（仅站点所有者）：把已有的审计流水、分享浏览计数与链接健康快照
// 拼成一块可读的仪表盘 —— 数据都在服务端聚好（GET /api/stats），这里只画图。
//
// 它原先是一个独立弹窗（StatsDashboardDialog）；「设置」菜单瘦身时与「访问统计」
// 合并成带标签页的「统计」入口（StatsHubDialog），内容抽成面板复用，弹窗外壳由 hub 提供。
// 面板只在被渲染（owner 切到对应标签页）时才发请求，普通账号看不到也就不会白跑一趟。
//
// 图表零依赖：30 天柱状图是手写 SVG，Top 榜是普通 div 条形。不为几张图引入
// 图表库 —— 首屏 304KB gzip 预算只剩 5% 余量，任何图表库都能把它吃穿。
import { useEffect, useState } from "react";
import {
    Box,
    Chip,
    CircularProgress,
    Divider,
    Typography,
} from "@mui/material";
import { NavigationClient } from "../API/client";
import type { OpsStats } from "../API/methods/audit";
import { actionLabel } from "../utils/auditActionLabels";
import { dailySummary, deltaText, shareOf, weekOverWeek } from "../utils/statsInsights";
import { fmtBytes } from "../utils/format";

/** UTC 时间戳 -> YYYY-MM-DD（健康快照里的 at 是毫秒时间戳，不用 Intl，CI small-icu 也稳） */
function dayOf(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
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

export default function StatsPanel({ client }: { client: NavigationClient }) {
    const [stats, setStats] = useState<OpsStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // 面板挂载即拉数：hub 的标签页默认不渲染未选中的面板（keepMounted 关着），
    // 所以只有 owner 真的切到「运营看板」才会走到这里 —— 普通账号不会白发一趟请求。
    useEffect(() => {
        let alive = true;
        setLoading(true);
        setError("");
        client
            .getOpsStats()
            .then(r => {
                if (!alive) return;
                // ⚠️ 老部署的 worker 还没这条路由时，兜底会回 `{success:true}`，
                // stats 是 undefined —— 不拦的话界面就是一个空面板，既没数据也没报错，
                // 用户只会以为「这功能坏了」。这里显式说清楚。
                if (r?.stats) {
                    setStats(r.stats);
                } else {
                    setError("当前部署还没有统计接口，请更新服务端后再试");
                }
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
    }, [client]);

    const actionMax = Math.max(1, ...(stats?.auditTopActions.map(a => a.count) ?? [1]));
    const shareMax = Math.max(1, ...(stats?.shareTop.map(s => s.views) ?? [1]));

    // B9 看板增强（2026-10-22）：下面三个视角全部由已有数据派生，不动服务端接口。
    // 原始计数只回答「有多少」，回答不了「是变好还是变差」——
    // 环比看趋势、占比看结构、活跃度看使用强度，三者互补。
    const wow = stats ? weekOverWeek(stats.auditDaily) : null;
    const daily = stats ? dailySummary(stats.auditDaily) : null;
    const actionShares = stats
        ? shareOf(stats.auditTopActions.map(a => ({ key: a.action, count: a.count })))
        : [];

    return (
        <Box aria-label='运营看板'>
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
                            label={`附件 ${stats.counts.attachments}（${fmtBytes(stats.counts.attachmentBytes)}）`}
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

                    {/* 趋势与强度：柱子给的是「每天多少」，这里补「整体往哪走」 */}
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 1 }}>
                        {wow && (
                            <Chip
                                size='small'
                                variant='outlined'
                                label={`近 7 天 ${wow.last7} 次 · ${deltaText(wow)}`}
                                color={
                                    wow.deltaPct === null || wow.deltaPct === 0
                                        ? "default"
                                        : wow.deltaPct > 0
                                          ? "success"
                                          : "warning"
                                }
                            />
                        )}
                        {daily && (
                            <>
                                <Chip size='small' variant='outlined' label={`活跃 ${daily.activeDays} 天`} />
                                <Chip size='small' variant='outlined' label={`日均 ${daily.avgOnActiveDays} 次`} />
                                {daily.peak && (
                                    <Chip
                                        size='small'
                                        variant='outlined'
                                        label={`峰值 ${daily.peak.count} 次 · ${daily.peak.day}`}
                                    />
                                )}
                            </>
                        )}
                    </Box>
                    {wow && !wow.enough && (
                        <Typography variant='caption' color='text.secondary'>
                            数据不足 14 天，环比只作参考
                        </Typography>
                    )}

                    <SectionTitle>高频动作（右侧为该动作占比）</SectionTitle>
                    {stats.auditTopActions.length > 0 ? (
                        stats.auditTopActions.map(a => (
                            <BarRow
                                key={a.action}
                                label={actionLabel(a.action)}
                                value={a.count}
                                max={actionMax}
                                hint={`${a.count} · ${actionShares.find(x => x.key === a.action)?.pct ?? 0}%`}
                            />
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
        </Box>
    );
}
