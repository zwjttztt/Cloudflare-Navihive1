// src/components/DialogListRow.tsx
// 列表类弹窗（审计日志 / 回收站 / 版本历史）共用的「行」与「空态」。
//
// 起因（docs/dialogs-audit-2026-10-23.md 2-4）：三个弹窗各写一份 ListItem，
// 行高、时间列位置、右侧动作区留白全都不一样 —— 审计里写了 `pr: 19`（MUI 的
// secondaryAction 不占流，正文得自己让位），回收站里干脆没写（条目名一长就被压在
// 按钮下面）。抽出来之后这些细节只有一处。
import { Box, ListItem, ListItemText, Typography } from "@mui/material";

export interface DialogListRowProps {
    /** 行主内容（加粗的名字 / 动作名） */
    primary: React.ReactNode;
    /** 行次内容（时间、详情） */
    secondary?: React.ReactNode;
    /** 右侧动作区（按钮 / 图标钮 / Chip）。不传就不渲染 */
    actions?: React.ReactNode;
    /**
     * 右侧动作区**预留宽度（px）**。MUI 的 secondaryAction 是绝对定位的，
     * 不占流，正文不会自动让位 —— 不预留就会被压在它下面（看起来像重叠）。
     */
    actionsWidth?: number;
    /** 两行内容的垂直对齐：正文可能换行时用 flex-start */
    alignItems?: "center" | "flex-start";
}

export function DialogListRow({
    primary,
    secondary,
    actions,
    actionsWidth,
    alignItems = "center",
}: DialogListRowProps) {
    return (
        <ListItem
            divider
            alignItems={alignItems}
            sx={{
                // 统一行高下限：dense 列表在触屏上手指点不准，给到 44px 的舒适区
                minHeight: 44,
                ...(actionsWidth ? { pr: `${actionsWidth + 8}px` } : null),
            }}
            secondaryAction={
                actions ? (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>{actions}</Box>
                ) : undefined
            }
        >
            <ListItemText
                sx={{ m: 0 }}
                primary={primary}
                secondary={secondary}
                slotProps={{
                    // 正文里常有长 URL / 长详情，默认只在空白处换行 → 窄屏会伸出弹窗
                    primary: { sx: { display: "block", wordBreak: "break-word" } },
                    secondary: { sx: { display: "block", wordBreak: "break-word" } },
                }}
            />
        </ListItem>
    );
}

/**
 * 列表类弹窗的空态。
 *
 * 统一成「一句结论 + 一句怎么办」：只写「暂无审计记录」的话，用户不知道是
 * 「真的没有」还是「没读出来」；只写「回收站是空的」又不知道东西哪来的。
 */
export function DialogEmptyState({ title, hint }: { title: string; hint?: string }) {
    return (
        <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
            <Typography variant='body2' sx={{ color: 'text.secondary' }}>
                {title}
            </Typography>
            {hint ? (
                <Typography variant='caption' sx={{ color: 'text.secondary', display: "block", mt: 0.5 }}>
                    {hint}
                </Typography>
            ) : null}
        </Box>
    );
}
