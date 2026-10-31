// src/components/VisitsPanel.tsx
// 「访问统计」面板（本机访问记录：汇总数字 + 8 周热力图 + 最常访问 Top5）。
//
// 它原先是一个独立弹窗（VisitsDialog）；「设置」菜单瘦身时与「运营看板」合并成
// 带标签页的「统计」入口（StatsHubDialog），内容抽成面板复用，弹窗外壳由 hub 提供。
// 数据记在本机（localStorage）；开了「偏好同步」后会在同一账号下多设备合并，
// 没开就只留在这台机器里 —— 界面上要如实说明是哪一种，别笼统写「不上传」。
import { useMemo, useState } from "react";
import {
    Box,
    Button,
    Stack,
    Typography,
    Divider,
    Tooltip,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { dayKey, useUIPrefsVisits } from "../context/uiPrefsStore";
import ConfirmDialog from "./ConfirmDialog";

export interface VisitsPanelProps {
    /** 站点 id -> 名称，用来把统计里的数字翻译成人看得懂的名字 */
    nameOf: (siteId: string) => string;
    /**
     * 站点是否还存在（可选）。传了就把已删除网站的访问记录从统计里剔除 ——
     * 访问记录记在 localStorage / 偏好同步里，删站不会自动清，不滤的话
     * Top 榜会一直挂着「已删除的网站 #N」（用户 2026-10-17 报告）。
     */
    exists?: (siteId: string) => boolean;
    /** 清空访问记录（可选）；不传则不显示清空按钮 */
    onClear?: () => void;
    /** 是否开了偏好同步（决定「记在哪」这句说明怎么写） */
    syncEnabled?: boolean;
}

const WEEKS = 8;
const DAY_MS = 86400000;

/** 访问次数分档：0 / 少量 / 一般 / 较多 / 很多 */
const levelOf = (count: number): number => {
    if (count <= 0) return 0;
    if (count <= 2) return 1;
    if (count <= 5) return 2;
    if (count <= 9) return 3;
    return 4;
};

export default function VisitsPanel({ nameOf, exists, onClear, syncEnabled = false }: VisitsPanelProps) {
    const { visits } = useUIPrefsVisits();
    // 清空是不可逆的（没有回收站），点一下之前先问一句
    const [confirmClear, setConfirmClear] = useState(false);

    const summary = useMemo(() => {
        const entries = Object.entries(visits).filter(
            ([id, v]) => v && v.count > 0 && (!exists || exists(id))
        );
        const total = entries.reduce((sum, [, v]) => sum + v.count, 0);
        const today = entries.reduce((sum, [, v]) => sum + (v.days?.[dayKey()] ?? 0), 0);
        const top = entries
            .map(([id, v]) => ({ id, count: v.count, last: v.last }))
            .sort((a, b) => b.count - a.count || b.last - a.last)
            .slice(0, 5);
        return { total, sites: entries.length, today, top };
    }, [visits, exists]);

    // 热力图：按「周」为列、周一~周日为行，最后一列是本周
    const weeks = useMemo(() => {
        const today = new Date();
        // getDay(): 0=周日 → 换算成 0=周一
        const weekday = (today.getDay() + 6) % 7;
        const lastMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday);

        // 每天的访问次数：把所有站点的 days 合并成一份「按天总量」（已删站点的同样剔除）
        const perDay: Record<string, number> = {};
        for (const [id, stat] of Object.entries(visits)) {
            if (!stat?.days) continue;
            if (exists && !exists(id)) continue;
            for (const [k, v] of Object.entries(stat.days)) {
                perDay[k] = (perDay[k] ?? 0) + v;
            }
        }

        const cols: { key: string; count: number; label: string; future: boolean }[][] = [];
        const cursor = new Date(lastMonday.getTime() - (WEEKS - 1) * 7 * DAY_MS);
        const todayKey = dayKey();

        for (let w = 0; w < WEEKS; w++) {
            const col: { key: string; count: number; label: string; future: boolean }[] = [];
            for (let d = 0; d < 7; d++) {
                const ts = cursor.getTime() + (w * 7 + d) * DAY_MS;
                const date = new Date(ts);
                const key = dayKey(ts);
                col.push({
                    key,
                    count: perDay[key] ?? 0,
                    label: `${date.getMonth() + 1}月${date.getDate()}日`,
                    future: key > todayKey,
                });
            }
            cols.push(col);
        }
        return cols;
    }, [visits, exists]);

    return (
        <Stack spacing={0}>
            <Typography
                variant='caption'
                sx={{
                    color: 'text.secondary',
                    display: "block",
                    mb: 1.5
                }}>
                {syncEnabled
                    ? "记录记在本机，并已开启偏好同步：同一账号下的其它设备会合并同一份统计。"
                    : "记录只留在这台机器里，不会上传；在「设置 → 全站设置 → 数据同步」里打开偏好同步后才会跨设备合并。"}
            </Typography>
            {summary.total === 0 ? (
                <Typography
                    variant='body2'
                    sx={{
                        color: 'text.secondary',
                        py: 4,
                        textAlign: "center"
                    }}>
                    还没有访问记录。点开任意卡片后，这里会开始累计统计。
                </Typography>
            ) : (
                <Stack spacing={3}>
                    {/* 汇总数字 */}
                    <Stack direction='row' spacing={2}>
                        {[
                            { label: "总访问次数", value: summary.total },
                            { label: "今日访问", value: summary.today },
                            { label: "访问过的网站", value: summary.sites },
                        ].map(item => (
                            <Box
                                key={item.label}
                                sx={{
                                    flex: 1,
                                    p: 1.5,
                                    borderRadius: "14px",
                                    bgcolor: "action.hover",
                                    textAlign: "center",
                                }}
                            >
                                <Typography
                                    className='nav-clock-time'
                                    sx={{ fontSize: 22, lineHeight: 1.2 }}
                                >
                                    {item.value}
                                </Typography>
                                <Typography variant='caption' sx={{
                                    color: 'text.secondary'
                                }}>
                                    {item.label}
                                </Typography>
                            </Box>
                        ))}
                    </Stack>

                    <Divider />

                    {/* 热力图 */}
                    <Box>
                        <Typography variant='subtitle2' sx={{ mb: 1.5 }}>
                            最近 8 周（每天访问次数）
                        </Typography>
                        <Box className='nav-heat-grid' role='img' aria-label='最近 8 周访问热力图'>
                            {weeks.flat().map(cell => (
                                <Tooltip
                                    key={cell.key}
                                    title={
                                        cell.future
                                            ? cell.label
                                            : `${cell.label} · ${cell.count} 次`
                                    }
                                >
                                    <Box
                                        className='nav-heat-cell'
                                        data-level={cell.future ? 0 : levelOf(cell.count)}
                                        data-date={cell.key}
                                        sx={cell.future ? { opacity: 0.35 } : undefined}
                                    />
                                </Tooltip>
                            ))}
                        </Box>
                        <Stack
                            direction='row'
                            spacing={0.75}
                            sx={{
                                alignItems: 'center',
                                mt: 1.5
                            }}>
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
                                少
                            </Typography>
                            {[0, 1, 2, 3, 4].map(lv => (
                                <Box key={lv} className='nav-heat-cell' data-level={lv} />
                            ))}
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
                                多
                            </Typography>
                        </Stack>
                    </Box>

                    <Divider />

                    {/* Top5 */}
                    <Box>
                        <Typography variant='subtitle2' sx={{ mb: 1 }}>
                            最常访问
                        </Typography>
                        <Stack spacing={1}>
                            {summary.top.map((item, idx) => (
                                <Box
                                    key={item.id}
                                    sx={{ display: "flex", alignItems: "center", gap: 1 }}
                                >
                                    <Typography
                                        variant='caption'
                                        sx={{
                                            width: 18,
                                            textAlign: "center",
                                            fontWeight: 700,
                                            color: "text.secondary",
                                        }}
                                    >
                                        {idx + 1}
                                    </Typography>
                                    <Typography
                                        variant='body2'
                                        noWrap
                                        sx={{ flex: 1, minWidth: 0 }}
                                    >
                                        {nameOf(item.id)}
                                    </Typography>
                                    <Typography variant='caption' sx={{
                                        color: 'text.secondary'
                                    }}>
                                        {item.count} 次
                                    </Typography>
                                </Box>
                            ))}
                        </Stack>
                    </Box>
                </Stack>
            )}

            {/* 「清除访问记录」的入口就在统计里：统计和清空本来就是一件事的两面。
                没有记录时按钮置灰但保留 —— 否则用户会以为压根没有这个入口。 */}
            {onClear && (
                <Box sx={{ mt: 2 }}>
                    <Button
                        color='inherit'
                        startIcon={<DeleteOutlineIcon fontSize='small' />}
                        onClick={() => setConfirmClear(true)}
                        disabled={summary.total === 0}
                    >
                        清除访问记录
                    </Button>
                </Box>
            )}

            <ConfirmDialog
                open={confirmClear}
                title='清除访问记录'
                danger
                description='将清空全部访问次数记录，「最近访问」分组也会一并消失，且无法恢复。'
                impact={{ object: "站点的访问记录", count: summary.sites, undoable: false }}
                confirmText='清除'
                onClose={() => setConfirmClear(false)}
                onConfirm={() => {
                    setConfirmClear(false);
                    onClear?.();
                }}
            />
        </Stack>
    );
}
