// src/components/StatsHubDialog.tsx
// 「统计」入口：一个弹窗、两个标签页 ——
//   访问统计：本机访问记录（所有登录用户都有，数据在 localStorage）
//   运营看板：审计流水 / 分享浏览 / 链接健康（仅站点所有者，数据在服务端）
//
// 为什么合并：这两块原先在「设置」里各占一项（访问统计、统计看板），
// 名字都叫「统计」却分成两个入口，用户得逐个点开才知道哪个是哪个。
// 合并后菜单少一项，按标签页切换也比回菜单再点一次近。
// 非 owner 看不到运营看板：标签栏直接不渲染，也不会去拉 /api/stats
// （未选中的面板不挂载，请求只发生在真的切过去时）。
//
// 2026-10-29：业务抽成命名导出的 `StatsHubPanel`，弹窗外壳只留一层包装 ——
// 「设置」统一中心（NavigationCenterDialog）直接复用同一份面板，
// 尺寸 / 标题 / 关闭按钮交给共享外壳（settingsWorkspace/），这里一行都不写。
import { useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    IconButton,
    Tabs,
    Tab,
    Box,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import InsightsIcon from "@mui/icons-material/Insights";
import type { NavigationClient } from "../API/client";
import VisitsPanel from "./VisitsPanel";
import StatsPanel from "./StatsPanel";
import { dialogActionsSx, dialogTitleSx } from "./dialogShell";

/** 面板输入：与弹窗共享，尺寸与外壳由调用方负责 */
export interface StatsHubPanelProps {
    client: NavigationClient;
    /** 当前登录者是否为站点所有者（决定「运营看板」标签页是否出现） */
    isSiteOwner: boolean;
    /** 站点 id -> 名称（访问统计的 Top 榜要把 id 翻译成名字） */
    nameOf: (siteId: string) => string;
    /** 站点是否还存在（访问统计要把已删站点的记录剔除） */
    exists?: (siteId: string) => boolean;
    /** 清空访问记录（可选）；不传则不显示清空按钮 */
    onClear?: () => void;
    /** 是否开了偏好同步（决定访问统计里「记在哪」那句说明怎么写） */
    syncEnabled?: boolean;
}

/**
 * 统计面板本体：两个标签页 + 各自的列表。
 *
 * 自己持一条滚动区（标签栏固定、正文滚）—— 外壳的正文区是「整块滚」，
 * 标签栏跟着内容一起滚走的话，切页签要先往回滚，那一步是白走的。
 */
export function StatsHubPanel({
    client,
    isSiteOwner,
    nameOf,
    exists,
    onClear,
    syncEnabled = false,
}: StatsHubPanelProps) {
    // 0 = 访问统计，1 = 运营看板（仅 owner 可达）
    const [tab, setTab] = useState(0);

    return (
        <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
            {/* 只有一个标签页（非 owner）时不渲染标签栏：一个 Tab 的 Tab 栏纯属噪音 */}
            {isSiteOwner && (
                <Tabs
                    value={tab}
                    onChange={(_, v: number) => setTab(v)}
                    sx={{ flexShrink: 0, minHeight: 40 }}
                >
                    <Tab label="访问统计" sx={{ minHeight: 40 }} />
                    <Tab label="运营看板" sx={{ minHeight: 40 }} />
                </Tabs>
            )}

            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pt: isSiteOwner ? 2 : 1 }}>
                {/* 未选中的面板不挂载：运营看板的 /api/stats 只会在切过去时才发 */}
                {tab === 0 || !isSiteOwner ? (
                    <Box role='tabpanel' aria-label='访问统计'>
                        <VisitsPanel
                            nameOf={nameOf}
                            exists={exists}
                            onClear={onClear}
                            syncEnabled={syncEnabled}
                        />
                    </Box>
                ) : (
                    <Box role='tabpanel' aria-label='运营看板'>
                        <StatsPanel client={client} />
                    </Box>
                )}
            </Box>
        </Box>
    );
}

export interface StatsHubDialogProps extends StatsHubPanelProps {
    open: boolean;
    onClose: () => void;
}

export default function StatsHubDialog({
    open,
    onClose,
    ...panel
}: StatsHubDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth aria-label='统计'>
            <DialogTitle sx={dialogTitleSx}>
                <InsightsIcon fontSize='small' />
                统计
                <Box sx={{ flex: 1 }} />
                <IconButton size='small' onClick={onClose} aria-label='关闭统计'>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>

            <DialogContent dividers sx={{ pt: 0, minHeight: 240 }}>
                <StatsHubPanel {...panel} />
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button onClick={onClose} size='small'>
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
