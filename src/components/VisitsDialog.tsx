// src/components/VisitsDialog.tsx
// 访问统计：汇总数字 + 最近 8 周热力图 + 最常访问 Top5。
// 数据全部来自本机 localStorage 的访问统计，不上传服务器。
import { useMemo } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    Typography,
    Stack,
    Divider,
    Tooltip,
    IconButton,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { dayKey, useUIPrefs } from "../context/UIPrefsContext";

interface VisitsDialogProps {
    open: boolean;
    onClose: () => void;
    /** 站点 id -> 名称，用来把统计里的数字翻译成人看得懂的名字 */
    nameOf: (siteId: string) => string;
    /** 清空访问记录（可选）；不传则不显示清空按钮 */
    onClear?: () => void;
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

export default function VisitsDialog({ open, onClose, nameOf, onClear }: VisitsDialogProps) {
    const { visits } = useUIPrefs();

    const summary = useMemo(() => {
        const entries = Object.entries(visits).filter(([, v]) => v && v.count > 0);
        const total = entries.reduce((sum, [, v]) => sum + v.count, 0);
        const today = entries.reduce((sum, [, v]) => sum + (v.days?.[dayKey()] ?? 0), 0);
        const top = entries
            .map(([id, v]) => ({ id, count: v.count, last: v.last }))
            .sort((a, b) => b.count - a.count || b.last - a.last)
            .slice(0, 5);
        return { total, sites: entries.length, today, top };
    }, [visits]);

    // 热力图：按「周」为列、周一~周日为行，最后一列是本周
    const weeks = useMemo(() => {
        const today = new Date();
        // getDay(): 0=周日 → 换算成 0=周一
        const weekday = (today.getDay() + 6) % 7;
        const lastMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday);

        // 每天的访问次数：把所有站点的 days 合并成一份「按天总量」
        const perDay: Record<string, number> = {};
        for (const stat of Object.values(visits)) {
            if (!stat?.days) continue;
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
    }, [visits]);

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
            <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
                <Box sx={{ flex: 1 }}>访问统计</Box>
                <IconButton size='small' onClick={onClose} aria-label='关闭访问统计'>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>
            <DialogContent dividers>
                {summary.total === 0 ? (
                    <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: "center" }}>
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
                                    <Typography variant='caption' color='text.secondary'>
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
                                alignItems='center'
                                spacing={0.75}
                                sx={{ mt: 1.5 }}
                            >
                                <Typography variant='caption' color='text.secondary'>
                                    少
                                </Typography>
                                {[0, 1, 2, 3, 4].map(lv => (
                                    <Box key={lv} className='nav-heat-cell' data-level={lv} />
                                ))}
                                <Typography variant='caption' color='text.secondary'>
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
                                        <Typography variant='caption' color='text.secondary'>
                                            {item.count} 次
                                        </Typography>
                                    </Box>
                                ))}
                            </Stack>
                        </Box>
                    </Stack>
                )}
            </DialogContent>
            <DialogActions>
                {onClear && summary.total > 0 && (
                    <Button
                        color='inherit'
                        startIcon={<DeleteOutlineIcon fontSize='small' />}
                        onClick={onClear}
                        sx={{ mr: "auto" }}
                    >
                        清空记录
                    </Button>
                )}
                <Button onClick={onClose}>关闭</Button>
            </DialogActions>
        </Dialog>
    );
}
