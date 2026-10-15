// src/components/SnackbarHost.tsx
// 顶部提示条（视觉部分）。读屏播报区已拆去 AriaLiveRegion.tsx ——
// 它必须常驻（live region 要先于内容存在），而本组件为了首屏字节改成
// 懒加载 + 有提示才挂载（2026-10-15 审计 P1，见 docs/site-audit-2026-10-15.md）。
import { Snackbar, Alert, Button, IconButton } from "@mui/material";
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
    onClose: () => void;
}

export default function SnackbarHost({
    open,
    message,
    severity,
    duration,
    action,
    onClose,
}: SnackbarHostProps) {
    return (
        <>
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
