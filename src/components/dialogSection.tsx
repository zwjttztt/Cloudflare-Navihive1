// src/components/dialogSection.tsx
// 弹窗里的「小节」与「开关行」两个排版件。
//
// 原先只住在 SettingsDialog 里，AI 助手弹窗要用同一套视觉（左侧主色竖条 + 组标题、
// 说明统一缩进到标签下方），从 SettingsDialog 直接导入会把那一整个懒加载代码块
// 一起拖进来 —— 抽出来之后两边各自 import，互不牵连。

import { Box, FormControlLabel, Stack, Switch, Typography } from "@mui/material";

/** 分组：左侧一小段主色竖条 + 组标题，可选一行组说明；组内字段纵向排布 */
export function Section({
    title,
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                    sx={{
                        width: 3,
                        height: 14,
                        borderRadius: 0.5,
                        bgcolor: "primary.main",
                        opacity: 0.75,
                        flex: "none",
                    }}
                />
                <Typography variant='subtitle2' fontWeight='600'>
                    {title}
                </Typography>
            </Box>
            {hint ? (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", mt: 0.25, ml: "11px" }}
                >
                    {hint}
                </Typography>
            ) : null}
            <Stack spacing={1.25} sx={{ mt: 1.25 }}>
                {children}
            </Stack>
        </Box>
    );
}

/** 开关 + 说明的固定组合：说明统一缩进到标签文字下方，视觉上归成一类 */
export function SwitchRow({
    checked,
    onChange,
    label,
    ariaLabel,
    caption,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    ariaLabel: string;
    caption?: string;
}) {
    return (
        <Box>
            <FormControlLabel
                sx={{ display: "flex", m: 0, minHeight: 26 }}
                control={
                    <Switch
                        checked={checked}
                        size='small'
                        onChange={e => onChange(e.target.checked)}
                        slotProps={{ input: { "aria-label": ariaLabel } }}
                    />
                }
                label={<Typography variant='body2'>{label}</Typography>}
            />
            {caption ? (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", ml: "42px", mt: -0.25 }}
                >
                    {caption}
                </Typography>
            ) : null}
        </Box>
    );
}
