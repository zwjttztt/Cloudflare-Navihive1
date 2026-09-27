// src/components/SnackbarHost.tsx
// 顶部提示条 + 读屏播报区。原来内联在 App.tsx 里 121 行。
//
// 抽出来的理由很单纯：这两块只依赖 7 个值，全是「提示状态 + 一个关闭回调」，
// 不碰任何业务状态。留在 App 里纯粹是占地方。
import { Box, Snackbar, Alert, Button, IconButton } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import InfoRoundedIcon from "@mui/icons-material/InfoRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import CloseIcon from "@mui/icons-material/Close";
import type { NotifyAction } from "../context/NotifyContext";

export type SnackbarSeverity = "success" | "error" | "info";

export interface SnackbarHostProps {
    open: boolean;
    message: string;
    severity: SnackbarSeverity;
    duration: number;
    /** 提示上挂的操作按钮（目前用于「删除后撤销」） */
    action?: NotifyAction | null;
    /** 同步给读屏的那一份文案（页面上有 sr-only 的 aria-live 区） */
    liveMessage: string;
    onClose: () => void;
}

export default function SnackbarHost({
    open,
    message,
    severity,
    duration,
    action,
    liveMessage,
    onClose,
}: SnackbarHostProps) {
    return (
        <>
            {/* 读屏播报区：视觉上不可见，但每次提示都会同步到这里（aria-live） */}
            <Box
                role='status'
                aria-live='polite'
                aria-atomic='true'
                sx={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    m: -1,
                    p: 0,
                    border: 0,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    clip: "rect(0 0 0 0)",
                }}
            >
                {liveMessage}
            </Box>

            {/* 错误/成功提示 Snackbar：顶部居中，成功类短暂停留、错误类停留更久 */}
            <Snackbar
                open={open}
                autoHideDuration={duration}
                onClose={onClose}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
                key={message + severity + duration}
            >
                <Alert
                    onClose={onClose}
                    severity={severity}
                    variant='filled'
                    className='nav-snackbar'
                    data-severity={severity}
                    iconMapping={{
                        success: <CheckCircleRoundedIcon fontSize='inherit' />,
                        info: <InfoRoundedIcon fontSize='inherit' />,
                        error: <ErrorOutlineRoundedIcon fontSize='inherit' />,
                    }}
                    sx={theme => {
                        // 按严重度取一个「有颜色但不刺眼」的强调色，用于图标与图标底色
                        const tone =
                            severity === "success"
                                ? theme.palette.success.main
                                : severity === "error"
                                  ? theme.palette.error.main
                                  : theme.palette.info.main;

                        return {
                            width: "100%",
                            alignItems: "center",
                            // 和卡片/确认弹窗同一套「毛玻璃 + 圆角 + 细边框 + 柔和投影」，
                            // 不再用 MUI 默认的实心饱和色块（和整站风格不搭）
                            minWidth: 260,
                            px: 1.5,
                            py: 0.75,
                            borderRadius: "var(--card-radius)",
                            color: "text.primary",
                            backgroundColor:
                                theme.palette.mode === "dark"
                                    ? "rgba(23,27,38,0.92)"
                                    : "rgba(255,255,255,0.92)",
                            backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                            WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                            border: "1px solid var(--glass-panel-border)",
                            boxShadow: "var(--glass-shadow-hover)",
                            // 图标做成染色小方块，和确认弹窗标题前的图标同一种观感
                            "& .MuiAlert-icon": {
                                width: 28,
                                height: 28,
                                mr: 1.25,
                                p: 0,
                                borderRadius: "9px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 18,
                                opacity: 1,
                                color: tone,
                                backgroundColor: alpha(
                                    tone,
                                    theme.palette.mode === "dark" ? 0.22 : 0.13
                                ),
                            },
                            "& .MuiAlert-message": {
                                fontWeight: 500,
                                fontSize: 14,
                                lineHeight: 1.5,
                                py: 0.5,
                            },
                            "& .MuiAlert-action": { color: "text.secondary" },
                        };
                    }}
                    action={
                        action ? (
                            <>
                                <Button
                                    className='nav-snackbar-action'
                                    color='inherit'
                                    size='small'
                                    onClick={() => {
                                        const run = action.onClick;
                                        onClose();
                                        run();
                                    }}
                                    sx={{ fontWeight: 700, whiteSpace: "nowrap" }}
                                >
                                    {action.label}
                                </Button>
                                <IconButton
                                    size='small'
                                    color='inherit'
                                    aria-label='关闭提示'
                                    onClick={onClose}
                                >
                                    <CloseIcon fontSize='small' />
                                </IconButton>
                            </>
                        ) : undefined
                    }
                >
                    {message}
                </Alert>
            </Snackbar>
        </>
    );
}
