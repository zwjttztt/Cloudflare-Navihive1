// src/components/ConfirmDialog.tsx
// 站内统一的确认弹窗：替代 window.confirm，风格与整站毛玻璃卡片保持一致
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
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    /** 正文说明，可传字符串或任意节点 */
    description?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    /** true 时确认按钮用错误色（删除类操作） */
    danger?: boolean;
    /** 第三个按钮（放在「取消」左边），用于「跳到那张卡片」这类辅助动作 */
    extraAction?: { label: string; onClick: () => void };
    onConfirm: () => void;
    onClose: () => void;
}

export default function ConfirmDialog({
    open,
    title,
    description,
    confirmText = "确定",
    cancelText = "取消",
    danger = false,
    extraAction,
    onConfirm,
    onClose,
}: ConfirmDialogProps) {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth='xs'
            fullWidth
            className='nav-confirm'
            slotProps={{
                paper: {
                    className: "nav-confirm-dialog",
                    sx: {
                        borderRadius: "var(--card-radius)",
                        p: 0.5,
                        backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                        WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                        border: "1px solid var(--glass-panel-border)",
                        boxShadow: "var(--glass-shadow-hover)",
                        // 毛玻璃面板本身是半透明的，铺一层高不透明度底色保证文字对比度
                        backgroundColor: theme =>
                            theme.palette.mode === "dark"
                                ? "rgba(23,27,38,0.94)"
                                : "rgba(255,255,255,0.94)",
                    },
                },
            }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    pr: 5,
                    py: 1.75,
                    fontSize: 17,
                    fontWeight: 600,
                }}
            >
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
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        onClick={onClose}
                        aria-label='关闭确认弹窗'
                        sx={{ position: "absolute", right: 10, top: 10 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>

            <DialogContent sx={{ pt: 0, pb: 1.5 }}>
                <Typography variant='body2' color='text.secondary' sx={{ lineHeight: 1.7 }}>
                    {description}
                </Typography>
            </DialogContent>

            <DialogActions sx={{ px: 2, pb: 2, pt: 0.5, gap: 1 }}>
                {extraAction && (
                    <Button onClick={extraAction.onClick} variant='text' size='small'>
                        {extraAction.label}
                    </Button>
                )}
                <Button onClick={onClose} variant='outlined' color='inherit' size='small'>
                    {cancelText}
                </Button>
                <Button
                    onClick={onConfirm}
                    variant='contained'
                    size='small'
                    color={danger ? "error" : "primary"}
                    disableElevation
                >
                    {confirmText}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
