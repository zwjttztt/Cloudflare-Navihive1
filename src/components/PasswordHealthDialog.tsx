// src/components/PasswordHealthDialog.tsx
// 「密码健康」分析面板（方案 A「收纳增强」，2026-10-25）。
//
// 纯展示组件：把当前账号所有站点的登录凭据（前端此时已持有解密后的明文，
// 与卡片「显示密码」同一份数据）喂给 utils/passwordHealth 做分析，呈现三组报告：
//   ① 重复密码（同一个密码用在多个站点）
//   ② 弱口令（强度评分低 + 具体原因）
//   ③ 久未改（超过一年没动过）
// 外加一个「按站点名 / 用户名检索凭据」的搜索框。
//
// 不碰 API、不碰存储 —— 所有计算都在客户端对已持有的数据做，密文/明文口径与
// 卡片显示完全一致。这正是不需要 schema / 迁移 / 服务端改动的原因（方案 A 的定义）。
//
// 2026-10-26：从「设置」里的独立弹窗，挪进「账号与安全」(AccountDialog) 内嵌面板。
// 这里只导出 PasswordHealthPanel，不再自带 Dialog 外壳，避免「弹窗里再弹一个弹窗」。
import { useMemo, useState } from "react";
import {
    Box,
    Chip,
    InputAdornment,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import type { Site } from "../API/types";
import { Section } from "./dialogSection";
import { analyzeCredentials, type CredentialEntry, type HealthReport } from "../utils/passwordHealth";

export interface PasswordHealthPanelProps {
    /** 当前账号全部站点（含解密后的 password） */
    sites: Site[];
}

function toEntries(sites: Site[]): CredentialEntry[] {
    return sites
        .filter((s): s is Site & { id: number } => typeof s.id === "number")
        .map(s => ({
            id: s.id,
            name: s.name || "(未命名)",
            username: s.username,
            password: s.password,
            updated_at: s.updated_at,
        }));
}

/** 强度评分 → 颜色（0/1 告警，2 注意，3/4 良好） */
function scoreColor(score: number): "error" | "warning" | "success" {
    if (score <= 1) return "error";
    if (score === 2) return "warning";
    return "success";
}

/**
 * 密码健康分析面板：重复 / 弱口令 / 久未改 + 检索。
 * 不自带 Dialog 外壳 —— 由 AccountDialog 承载，避免「弹窗里再弹一个弹窗」。
 */
export default function PasswordHealthPanel({ sites }: PasswordHealthPanelProps) {
    const [q, setQ] = useState("");
    const entries = useMemo(() => toEntries(sites), [sites]);
    const report: HealthReport = useMemo(() => analyzeCredentials(entries), [entries]);

    const query = q.trim().toLowerCase();
    const hits = useMemo(() => {
        if (!query) return [];
        return entries.filter(
            e =>
                e.name.toLowerCase().includes(query) ||
                (e.username ?? "").toLowerCase().includes(query)
        );
    }, [entries, query]);

    const issues = report.duplicates.length + report.weak.length + report.stale.length;

    return (
        <Stack spacing={2.5} sx={{ pt: 1 }}>
            {/* 概览 */}
            <Typography variant='body2' color='text.secondary'>
                共 <b>{report.total}</b> 个站点存了登录凭据
                {report.usernameOnly > 0 && `，${report.usernameOnly} 个只填了用户名没填密码`}。
                {issues === 0
                    ? "没有发现重复 / 弱口令 / 久未改问题。"
                    : `发现 ${report.duplicates.length} 组重复、${report.weak.length} 个弱口令、${report.stale.length} 个久未改。`}
            </Typography>

            {/* 检索 */}
            <TextField
                fullWidth
                size='small'
                placeholder='按站点名 / 用户名检索凭据'
                value={q}
                onChange={e => setQ(e.target.value)}
                slotProps={{
                    input: {
                        startAdornment: (
                            <InputAdornment position='start'>
                                <SearchIcon fontSize='small' />
                            </InputAdornment>
                        ),
                    },
                }}
            />
            {query && (
                <Box>
                    {hits.length === 0 ? (
                        <Typography variant='body2' color='text.secondary'>
                            没有匹配的站点。
                        </Typography>
                    ) : (
                        <Stack spacing={0.5}>
                            {hits.map(e => (
                                <Stack
                                    key={e.id}
                                    direction='row'
                                    spacing={1}
                                    sx={{ py: 0.25, alignItems: "center" }}
                                >
                                    <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                        {e.name}
                                    </Typography>
                                    {e.username && (
                                        <Typography variant='body2' color='text.secondary'>
                                            · {e.username}
                                        </Typography>
                                    )}
                                    {!e.password && (
                                        <Chip size='small' label='未设密码' variant='outlined' />
                                    )}
                                </Stack>
                            ))}
                        </Stack>
                    )}
                </Box>
            )}

            {/* ① 重复密码 */}
            <Section title='重复密码' icon={<ContentCopyIcon fontSize='small' color='action' />}>
                {report.duplicates.length === 0 ? (
                    <Typography variant='body2' color='text.secondary'>
                        没有一码多用，很好。
                    </Typography>
                ) : (
                    <Stack spacing={1}>
                        {report.duplicates.map((g, i) => (
                            <Box key={i} sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
                                <Stack direction='row' spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                                    <Chip
                                        size='small'
                                        color='error'
                                        label={`${g.count} 个站点共用`}
                                    />
                                    <Typography
                                        variant='body2'
                                        sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                                    >
                                        {g.password}
                                    </Typography>
                                </Stack>
                                <Typography variant='caption' color='text.secondary'>
                                    {g.sites.map(s => s.name).join("、")}
                                </Typography>
                            </Box>
                        ))}
                    </Stack>
                )}
            </Section>

            {/* ② 弱口令 */}
            <Section title='弱口令' icon={<WarningAmberIcon fontSize='small' color='action' />}>
                {report.weak.length === 0 ? (
                    <Typography variant='body2' color='text.secondary'>
                        没有检测到弱口令。
                    </Typography>
                ) : (
                    <Stack spacing={0.75}>
                        {report.weak.map(w => (
                            <Stack key={w.id} spacing={0.25}>
                                <Stack direction='row' spacing={1} sx={{ alignItems: "center" }}>
                                    <Chip
                                        size='small'
                                        color={scoreColor(w.score)}
                                        label={["很弱", "弱", "中", "强", "很强"][w.score]}
                                    />
                                    <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                        {w.name}
                                    </Typography>
                                </Stack>
                                {w.reasons.length > 0 && (
                                    <Typography variant='caption' color='text.secondary'>
                                        {w.reasons.join("；")}
                                    </Typography>
                                )}
                            </Stack>
                        ))}
                    </Stack>
                )}
            </Section>

            {/* ③ 久未改 */}
            <Section title={`久未改（超过 ${report.staleDays} 天）`}>
                {report.stale.length === 0 ? (
                    <Typography variant='body2' color='text.secondary'>
                        没有长期未改动的密码。
                    </Typography>
                ) : (
                    <Stack spacing={0.5}>
                        {report.stale.map(s => (
                            <Stack key={s.id} direction='row' spacing={1} sx={{ alignItems: "center" }}>
                                <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                    {s.name}
                                </Typography>
                                <Chip size='small' variant='outlined' label={`${s.daysSince} 天前`} />
                            </Stack>
                        ))}
                    </Stack>
                )}
            </Section>

            <Typography variant='caption' color='text.secondary'>
                提示：改密码请进对应卡片的「网站设置」；新设密码可顺手点输入框里的
                <Tooltip title='生成随机强密码'>
                    <Chip size='small' icon={<VpnKeyIcon />} label='生成' sx={{ mx: 0.5 }} />
                </Tooltip>
                按钮。
            </Typography>
        </Stack>
    );
}
