// src/components/ConfirmDialog.tsx
// 站内统一的确认弹窗：替代 window.confirm，风格与整站毛玻璃卡片保持一致。
//
// 三条硬规则（都是为了「点下去之前知道会发生什么」）：
//   1. 危险操作必须说清影响对象与数量 —— 传 impact，别让正文去猜；
//   2. 提交中禁重复点击：确认按钮禁用 + 关闭按钮/Esc 一起锁住，async 确认期间不会二次触发；
//   3. 失败不关闭表单：async 确认抛错时弹窗留在原地，用户改完可以再点一次。
//      成功才关 —— 调用方不必再手写 try/finally。
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Typography,
    Box,
    IconButton,
    Tooltip,
    CircularProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "./dialogShell";

/** 影响面：说清「动的是什么、有多少、能不能撤回」 */
export interface ConfirmImpact {
    /** 影响对象，如「网站」「分组」「标签」 */
    object: string;
    /** 影响数量；不传表示「这一项」，不显示数量 */
    count?: number;
    /** 能否撤销。false 时明确写出「无法撤销」，不用「进回收站」这种含糊说法 */
    undoable?: boolean;
}

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    /** 正文说明，可传字符串或任意节点 */
    description?: React.ReactNode;
    /**
     * 影响面。危险操作（danger）建议都传：
     * 只写「确定删除吗」不够，用户不知道删的是 1 条还是 37 条、还能不能撤回。
     */
    impact?: ConfirmImpact;
    confirmText?: string;
    cancelText?: string;
    /** true 时确认按钮用错误色（删除类操作） */
    danger?: boolean;
    /** 第三个按钮（放在「取消」左边），用于「跳到那张卡片」这类辅助动作 */
    extraAction?: { label: string; onClick: () => void };
    /**
     * 点击确认。可以返回 Promise：期间按钮禁用，resolve 后自动关闭，
     * reject 则保持打开（由调用方决定怎么提示）。
     */
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
    /** 提交中文案，如「删除中…」 */
    busyText?: string;
}

export default function ConfirmDialog({
    open,
    title,
    description,
    impact,
    confirmText = "确定",
    cancelText = "取消",
    danger = false,
    extraAction,
    onConfirm,
    onClose,
    busyText = "处理中…",
}: ConfirmDialogProps) {
    const [busy, setBusy] = useState(false);
    // 同步守卫：async 期间即使双击、或键盘连按 Enter，也只会真正执行一次
    const busyRef = useRef(false);

    // 弹窗每次打开都是一次全新的确认，不要把上次的「提交中」带过来
    useEffect(() => {
        if (!open) {
            busyRef.current = false;
            setBusy(false);
        }
    }, [open]);

    const handleConfirm = useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        try {
            await onConfirm();
            // 只有成功走到这里才关——失败（抛错）时弹窗留在原地，表单内容不丢
            busyRef.current = false;
            setBusy(false);
            onClose();
        } catch {
            busyRef.current = false;
            setBusy(false);
            // 错误提示由调用方负责（它才知道该说什么），这里只保证「不关闭」
        }
    }, [onConfirm, onClose]);

    const handleClose = useCallback(() => {
        // 提交中不允许关闭：否则一边跑着请求一边把弹窗收掉，用户不知道有没有生效
        if (busyRef.current) return;
        onClose();
    }, [onClose]);

    return (
        <Dialog
            open={open}
            // 提交中连 Esc / 点遮罩都不放行
            onClose={(event, reason) => {
                if (busyRef.current) return;
                if (reason === "backdropClick" || reason === "escapeKeyDown") {
                    onClose();
                    return;
                }
                void event;
                onClose();
            }}
            maxWidth='xs'
            fullWidth
            className='nav-confirm'
            slotProps={{
                paper: {
                    className: "nav-confirm-dialog",
                    sx: dialogPaperSx,
                },
            }}
        >
            <DialogTitle sx={dialogTitleSx} component='h2'>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Box
                        sx={{
                            width: 30,
                            height: 30,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: "10px",
                            color: danger ? "error.main" : "primary.main",
                            bgcolor: theme =>
                                theme.palette.mode === "dark"
                                    ? "rgba(255,255,255,0.08)"
                                    : "rgba(15,23,42,0.05)",
                        }}
                    >
                        <WarningAmberRoundedIcon fontSize='small' />
                    </Box>
                    {title}
                </Box>
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        onClick={handleClose}
                        disabled={busy}
                        aria-label='关闭确认弹窗'
                        sx={{ position: "absolute", right: 10, top: 10 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>

            <DialogContent sx={dialogContentSx}>
                <Typography variant='body2' color='text.secondary' sx={{ lineHeight: 1.7 }}>
                    {description}
                </Typography>
                {/* 影响面：对象 + 数量 + 可撤销性，一行说清 */}
                {impact && (
                    <Typography
                        variant='body2'
                        component='div'
                        data-impact-object={impact.object}
                        data-impact-count={impact.count ?? 1}
                        sx={{
                            mt: 1.25,
                            lineHeight: 1.6,
                            color: danger ? "error.main" : "text.primary",
                            fontWeight: 500,
                        }}
                    >
                        影响范围：{impact.object}
                        {typeof impact.count === "number" && impact.count > 0
                            ? ` ${impact.count} 项`
                            : ""}
                        {impact.undoable === undefined
                            ? ""
                            : impact.undoable
                              ? " · 可撤销"
                              : " · 不可撤销"}
                    </Typography>
                )}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                {extraAction && (
                    <Button
                        onClick={extraAction.onClick}
                        variant='text'
                        size='small'
                        disabled={busy}
                    >
                        {extraAction.label}
                    </Button>
                )}
                <Button
                    onClick={handleClose}
                    variant='outlined'
                    color='inherit'
                    size='small'
                    disabled={busy}
                >
                    {cancelText}
                </Button>
                <Button
                    onClick={() => void handleConfirm()}
                    variant='contained'
                    size='small'
                    color={danger ? "error" : "primary"}
                    disableElevation
                    disabled={busy}
                    startIcon={busy ? <CircularProgress size={14} color='inherit' /> : undefined}
                >
                    {busy ? busyText : confirmText}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
