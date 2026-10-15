// src/components/StatsHubDialog.tsx
// 「统计」入口：一个弹窗、两个标签页 ——
//   访问统计：本机访问记录（所有登录用户都有，数据在 localStorage）
//   运营看板：审计流水 / 分享浏览 / 链接健康（仅站点所有者，数据在服务端）
//
// 为什么合并：这两块原先在「更多选项」里各占一项（访问统计、统计看板），
// 名字都叫「统计」却分成两个入口，用户得逐个点开才知道哪个是哪个。
// 合并后菜单少一项，按标签页切换也比回菜单再点一次近。
// 非 owner 看不到运营看板：标签栏直接不渲染，也不会去拉 /api/stats
// （未选中的面板不挂载，请求只发生在真的切过去时）。
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

export interface StatsHubDialogProps {
    open: boolean;
    onClose: () => void;
    client: NavigationClient;
    /** 当前登录者是否为站点所有者（决定「运营看板」标签页是否出现） */
    isSiteOwner: boolean;
    /** 站点 id -> 名称（访问统计的 Top 榜要把 id 翻译成名字） */
    nameOf: (siteId: string) => string;
    /** 清空访问记录（可选）；不传则不显示清空按钮 */
    onClear?: () => void;
    /** 是否开了偏好同步（决定访问统计里「记在哪」那句说明怎么写） */
    syncEnabled?: boolean;
}

export default function StatsHubDialog({
    open,
    onClose,
    client,
    isSiteOwner,
    nameOf,
    onClear,
    syncEnabled = false,
}: StatsHubDialogProps) {
    // 0 = 访问统计，1 = 运营看板（仅 owner 可达）
    const [tab, setTab] = useState(0);

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth className='nav-dialog' aria-label='统计'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 1 }}>
                <InsightsIcon fontSize='small' />
                统计
                <Box sx={{ flex: 1 }} />
                <IconButton size='small' onClick={onClose} aria-label='关闭统计'>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>

            {/* 只有一个标签页（非 owner）时不渲染标签栏：一个 Tab 的 Tab 栏纯属噪音 */}
            {isSiteOwner && (
                <Tabs
                    value={tab}
                    onChange={(_, v: number) => setTab(v)}
                    sx={{ px: 3, minHeight: 40 }}
                >
                    <Tab label="访问统计" sx={{ minHeight: 40 }} />
                    <Tab label="运营看板" sx={{ minHeight: 40 }} />
                </Tabs>
            )}

            <DialogContent dividers sx={{ pt: isSiteOwner ? 2 : "12px !important" }}>
                {/* 未选中的面板不挂载：运营看板的 /api/stats 只会在切过去时才发 */}
                {tab === 0 || !isSiteOwner ? (
                    <Box role='tabpanel' aria-label='访问统计'>
                        <VisitsPanel
                            nameOf={nameOf}
                            onClear={onClear}
                            syncEnabled={syncEnabled}
                        />
                    </Box>
                ) : (
                    <Box role='tabpanel' aria-label='运营看板'>
                        <StatsPanel client={client} />
                    </Box>
                )}
            </DialogContent>

            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={onClose} size='small'>
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
