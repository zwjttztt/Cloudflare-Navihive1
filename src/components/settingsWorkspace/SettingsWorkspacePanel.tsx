// src/components/settingsWorkspace/SettingsWorkspacePanel.tsx
// 设置工作区的**右栏面板容器**：标题 + 可选说明 + 正文 + 可选操作行。
//
// 分区与外壳（SettingsWorkspaceDialog）约定好的滚动边界：
//   面板标题与说明**固定**，只有正文那一段滚 ——
//   滚长表单时「我现在改的是哪一项」这几个字得一直在视野里。
//
// 尺寸（2026-10-31 视觉收敛后）：标题 **17/600**、说明 12 / 行高 1.5 /
// text.secondary、正文桌面 24px、窄屏 16px。
//
// 外壳那个「设置」已经从 17 降到 13 + text.secondary（它是窗口标签），
// 所以这一行现在是整屏**唯一的主标题**，不再有「两层同级标题打架」的问题 ——
// 面板内也不要再出现与它同字号（17）的行。
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export interface SettingsWorkspacePanelProps {
    /** 面板标题（与左栏条目同名，用户才知道自己点到了哪） */
    title: string;
    /** 一句话说明这屏是干什么的；没有就不渲染那一行 */
    description?: string;
    /** 面板正文 */
    children: ReactNode;
    /** 面板自己的操作行（面板级，非全弹窗级）。没有就不渲染 */
    actions?: ReactNode;
}

export default function SettingsWorkspacePanel({
    title,
    description,
    children,
    actions,
}: SettingsWorkspacePanelProps) {
    return (
        <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {/* 头部内边距压紧（2026-10-31）：外层顶栏从 56 降到 48、左栏少了三个
                分组标题，正文的起点还能再往上提 8px —— 省下来的高度直接给正文 */}
            <Box sx={{ flexShrink: 0, px: { xs: 2, sm: 3 }, pt: { xs: 1.5, sm: 1.5 }, pb: 0.5 }}>
                <Typography component='h3' sx={{ fontSize: 17, fontWeight: 600 }}>
                    {title}
                </Typography>
                {description && (
                    <Typography
                        sx={{ mt: 0.5, fontSize: 12, lineHeight: 1.5 }}
                        color='text.secondary'
                    >
                        {description}
                    </Typography>
                )}
            </Box>
            <Box
                sx={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    px: { xs: 2, sm: 3 },
                    pb: 2,
                    // 切面板时整块淡入：时长走 --dur-base，不做位移
                    // （左右两栏并排，位移会让标题跟着晃）
                    animation: "navPanelFade var(--dur-base) var(--ease-out)",
                }}
                data-workspace-panel-body='1'
            >
                {children}
            </Box>
            {actions && (
                <Box
                    sx={{
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 1,
                        px: { xs: 2, sm: 3 },
                        py: 1.5,
                        // 上描边去掉（2026-10-31）：这一行与正文之间已经有 12px 留白，
                        // 再加一条线就是「面板里第 5 种分隔手段」——
                        // 与 SettingsWorkspaceDialog 底栏同一处改动
                    }}
                >
                    {actions}
                </Box>
            )}
        </Box>
    );
}
