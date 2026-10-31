// src/components/settingsWorkspace/SettingsWorkspaceDialog.tsx
// **共享的设置工作区外壳**：左栏分组导航 + 右栏面板 + 底部操作区。
//
// 为什么要抽它（2026-10-29 导航页「更多选项」统一弹窗）：导航页原来把十个动作
// 摊在一个下拉菜单里，点开各自是一个独立弹窗 —— 尺寸、标题栏、底部按钮文案
// 全都各不相同（宽度 xs/sm/md 三种、正文 padding px:3 / p:0 两种、完成按钮
// contained / outlined / text 三种）。现在统一成「一个中心弹窗 + 左栏换面板」，
// 外壳就是那个「所有中心共用的一份」：宽高、材质、滚动分区、关闭出口、
// 窄屏两步式导航都只在这里写一遍。
//
// 三条硬规则：
//   1. **关闭只有一个出口** `requestClose`：右上角 × / Esc / 点遮罩 / 底栏
//      「完成」全部走它，有未保存草稿时它先弹站内确认（不用 window.confirm ——
//      tests/dialogConsistency.test.ts 盯着这个）。
//   2. **aria-labelledby 只能写在 slotProps.paper 上**：MUI 把 role=dialog /
//      aria-modal 放在 **paper 插槽**，写在 <Dialog> 顶层的 aria-* 会随
//      `{...other}` 落到父级 Modal 根，读屏拿不到弹窗名字
//      （components/StatsHubDialog.tsx 那处是需要避免的反例）。
//   3. **滚动分区**：外框 / 总标题 / 面板标题 / 底栏固定，左栏与右栏正文
//      各自 overflowY:auto —— 整个 paper 不滚，换面板时标题不会跟着跑。
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DialogCloseButton from "../DialogCloseButton";
import ConfirmDialogGate from "../ConfirmDialogGate";
import { dialogPaperTokens } from "../dialogShell";
import { WorkspaceNavSignalContext } from "./SettingsWorkspaceNav";

/**
 * 窄屏（<600px）走 MUI `Dialog fullScreen`，不是底部抽屉。
 *
 * 理由：这里的面板里有长表单、列表、备份恢复与账号管理，底部抽屉那 86~92dvh
 * 会被软键盘与二级确认弹窗持续挤压；fullScreen 仍保留 MUI Dialog 的
 * focus trap 与焦点归还，只是把纸面铺满一屏。
 */
const FULL_SCREEN_QUERY = "(max-width: 599.95px)";

export interface SettingsWorkspaceDialogProps {
    open: boolean;
    /** 统一关闭出口（× / Esc / 遮罩 / 底栏完成都调它） */
    onClose: () => void;
    /** 弹窗总标题。它同时是 aria-labelledby 指向的那个节点 */
    title: string;
    /** 左栏导航节点（SettingsWorkspaceNav） */
    nav: ReactNode;
    /** 右栏面板节点（SettingsWorkspacePanel） */
    children: ReactNode;
    /** 底部操作区节点。危险动作要带 `sx={{ mr: "auto" }}` 才会靠左 */
    actions?: ReactNode;
    /**
     * 有未保存的草稿：关闭前先弹站内确认。
     * 由面板（或中心弹窗）按自己的编辑状态传，外壳不猜。
     */
    dirty?: boolean;
    /** 确认弹窗里那句「要丢掉什么」的说明 */
    dirtyHint?: string;
    /** 左栏宽度（桌面，px）。底部危险区条目多的中心可以调宽一点 */
    navWidth?: number;
    /** 桌面纸面高度（CSS 长度字符串） */
    height?: string;
}

export default function SettingsWorkspaceDialog({
    open,
    onClose,
    title,
    nav,
    children,
    actions,
    dirty = false,
    dirtyHint = "这个面板里有改动还没保存，现在关闭会丢掉它们。",
    navWidth = 208,
    height = "min(720px, calc(100dvh - 48px))",
}: SettingsWorkspaceDialogProps) {
    // useId 而不是写死字符串：同一个中心可能被同时挂两份（桌面 / 移动入口），
    // 写死 id 会让两个 dialog 的 aria-labelledby 指向同一个节点。
    const titleId = useId();
    const fullScreen = useMediaQuery(FULL_SCREEN_QUERY, { noSsr: true });
    /** 窄屏两步式：先给完整分组列表，点中条目才进面板 */
    const [mobileStep, setMobileStep] = useState<"list" | "panel">("list");
    const [confirmClose, setConfirmClose] = useState(false);

    // 每次重新打开都从「分组列表」那一步起：上次停在哪个面板不该被记住 ——
    // 用户第二次打开多半是找另一件事，直接落进上次那个面板等于替他做了决定。
    useEffect(() => {
        if (open) setMobileStep("list");
    }, [open]);

    const requestClose = () => {
        if (dirty) {
            setConfirmClose(true);
            return;
        }
        onClose();
    };

    const showNav = !fullScreen || mobileStep === "list";
    const showPanel = !fullScreen || mobileStep === "panel";
    const showActions = Boolean(actions) && showPanel;

    return (
        <Dialog
            open={open}
            onClose={requestClose}
            fullWidth
            maxWidth='md'
            fullScreen={fullScreen}
            slotProps={{
                // ⚠️ 无障碍：role=dialog / aria-modal 在 **paper** 上，
                // aria-labelledby 必须跟着写在这儿（写在 <Dialog> 顶层会落到 Modal 根）。
                paper: {
                    "aria-labelledby": titleId,
                    sx: {
                        // 纸面材质走全站唯一真源（圆角 / 底色 / 描边 / 阴影 / 模糊）
                        ...dialogPaperTokens,
                        // DialogCloseButton 是 absolute 定位，基准必须是纸面本身
                        position: "relative",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        // 外框自己不滚：滚动交给左栏与右栏正文（见上注第 3 条）
                        overflow: "hidden",
                        ...(fullScreen
                            ? {
                                  m: 0,
                                  width: "100%",
                                  maxWidth: "100%",
                                  height: "100%",
                                  maxHeight: "100%",
                                  borderRadius: 0,
                              }
                            : { height, maxHeight: height }),
                    },
                },
            }}
        >
            {/* 总标题：固定，不随面板滚动 */}
            <Box
                sx={{
                    position: "relative",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minHeight: 56,
                    py: 1.5,
                    pl: fullScreen ? 2 : 3,
                    // 右侧给关闭按钮留位（它 absolute 在 right:12，宽约 30）
                    pr: 7,
                }}
            >
                {fullScreen && mobileStep === "panel" && (
                    <Button
                        size='small'
                        startIcon={<ArrowBackIcon fontSize='small' />}
                        onClick={() => setMobileStep("list")}
                        data-workspace-back='1'
                        sx={{ minHeight: 44, flexShrink: 0 }}
                    >
                        全部选项
                    </Button>
                )}
                <Typography
                    id={titleId}
                    component='h2'
                    noWrap
                    sx={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600 }}
                >
                    {title}
                </Typography>
                {/* 位置固定纸面右上；label 走中文（读屏会念出来） */}
                <DialogCloseButton onClose={requestClose} label='关闭' />
            </Box>

            {/* 主体：左栏导航 + 右栏面板 */}
            <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
                {showNav && (
                    <Box
                        sx={{
                            width: fullScreen ? "100%" : navWidth,
                            flexShrink: 0,
                            minHeight: 0,
                            overflowY: "auto",
                            overflowX: "hidden",
                            py: 2,
                            px: 1,
                            bgcolor: "var(--neutral-wash)",
                            borderRight: fullScreen
                                ? "none"
                                : "1px solid var(--neutral-hover)",
                        }}
                    >
                        <WorkspaceNavSignalContext.Provider
                            value={{ onNavigate: () => setMobileStep("panel") }}
                        >
                            {nav}
                        </WorkspaceNavSignalContext.Provider>
                    </Box>
                )}
                {showPanel && (
                    <Box
                        sx={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                        }}
                    >
                        {children}
                    </Box>
                )}
            </Box>

            {/* 底栏：固定。窄屏让开 iPhone 底部那道横条，软键盘弹起时仍可达 */}
            {showActions && (
                <Box
                    sx={{
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 1,
                        px: fullScreen ? 2 : 3,
                        pt: 1.5,
                        pb: fullScreen ? "calc(12px + env(safe-area-inset-bottom, 0px))" : 1.5,
                        borderTop: "1px solid var(--neutral-hover)",
                    }}
                >
                    {actions}
                </Box>
            )}

            {/* 未保存草稿的关闭确认：站内弹窗，不用 window.confirm */}
            <ConfirmDialogGate
                open={confirmClose}
                title='放弃未保存的改动？'
                description={dirtyHint}
                confirmText='放弃并关闭'
                cancelText='继续编辑'
                danger
                onConfirm={() => {
                    setConfirmClose(false);
                    onClose();
                }}
                onClose={() => setConfirmClose(false)}
            />
        </Dialog>
    );
}
