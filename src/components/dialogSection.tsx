// src/components/dialogSection.tsx
// 弹窗里的「小节」与「开关行」两个排版件。
//
// 原先只住在 SettingsDialog 里，AI 助手弹窗要用同一套视觉（左侧主色竖条 + 组标题、
// 说明统一缩进到标签下方），从 SettingsDialog 直接导入会把那一整个懒加载代码块
// 一起拖进来 —— 抽出来之后两边各自 import，互不牵连。
//
// ⚠️ **这里是全仓唯一的小节排版件**（2026-10-31 收敛）。
// 收敛前有四套并行实现：本文件的 Section、AccountDialog 里逐字重复的一份、
// StatsPanel 的 SectionTitle（无竖条）、PasswordHealthDialog 的 SectionTitle（带 icon）。
// 四套的差距只在「有没有竖条 / 有没有 icon / 上下留白多少」，用户看到的就是
// 「同一个设置中心里，几屏的小标题长得都不一样」—— 统一感就是这么碎的。
// 现在只剩两个出口，且**共用同一个 SectionHeading**：
//   · Section        —— 标题 + 可选说明 + 可选正文（正文自动包一层纵向 Stack）
//   · SectionHeading —— 只有标题行（有些屏的正文是多块并列的，包不进一个 Stack）
// 守卫：tests/dialogSectionUniqueness.test.ts（除本文件外，任何文件再定义
// `function Section` / `SectionTitle` / `const Section` 都算回归）。

import { Box, FormControlLabel, Stack, Switch, Typography } from "@mui/material";

/** 竖条宽 3、与标题之间 8px —— 说明文字要靠这个偏移对齐到标题文字的左沿 */
const BAR_WIDTH = 3;
const BAR_GAP = 8;
/** SvgIcon size='small' 的实际盒子边长，用于 icon 在场时把说明再往右推一截 */
const ICON_SIZE = 20;

/**
 * 小节标题行：左侧一小段主色竖条 + 可选图标 + 组标题，可选一行组说明。
 *
 * 单独抽出来是因为有些屏（统计、密码健康）的正文是**多块并列**的
 * （一堆 Chip、几条 BarRow、条件分支里的不同文案），包进一个 Stack 会改变
 * 它们之间的既有间距；那些地方只需要这一行标题。视觉仍与 Section 完全一致 ——
 * 因为它们本来就是同一个函数渲染的。
 *
 * `sx` 只用于给个别屏补上下文留白（比如统计屏各小节之间靠 mt:2 拉开），
 * 不要在里面改颜色 / 字号 / 竖条 —— 那会让「统一」重新碎掉。
 */
export function SectionHeading({
    title,
    hint,
    icon,
    sx,
}: {
    title: string;
    hint?: string;
    /** 标题前的图标（密码健康那三节在用）；不传就不占位 */
    icon?: React.ReactNode;
    sx?: React.ComponentProps<typeof Box>["sx"];
}) {
    return (
        <Box sx={sx}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                    sx={{
                        width: BAR_WIDTH,
                        height: 14,
                        borderRadius: 0.5,
                        bgcolor: "primary.main",
                        opacity: 0.75,
                        flex: "none",
                    }}
                />
                {icon}
                <Typography
                    variant='subtitle2'
                    sx={{
                        fontWeight: '600'
                    }}>
                    {title}
                </Typography>
            </Box>
            {hint ? (
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mt: 0.25,
                        // 对齐到标题文字左沿：竖条 + 间距（有图标时再加图标宽度 + 间距）
                        ml: `${BAR_WIDTH + BAR_GAP + (icon ? ICON_SIZE + BAR_GAP : 0)}px`,
                    }}>
                    {hint}
                </Typography>
            ) : null}
        </Box>
    );
}

/** 分组：标题行 + 可选组说明 + 组内字段纵向排布 */
export function Section({
    title,
    hint,
    icon,
    children,
}: {
    title: string;
    hint?: string;
    icon?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <Box>
            <SectionHeading title={title} hint={hint} icon={icon} />
            {/* children 可能为空（纯标题小节）：`== null` 判 null/undefined，
                不能用真值判断 —— 0 与空串都是合法的子节点 */}
            {children == null ? null : (
                <Stack spacing={1.25} sx={{ mt: 1.25 }}>
                    {children}
                </Stack>
            )}
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
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        ml: "42px",
                        mt: -0.25
                    }}>
                    {caption}
                </Typography>
            ) : null}
        </Box>
    );
}
