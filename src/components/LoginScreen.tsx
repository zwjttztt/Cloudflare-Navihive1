// 未登录时那一整屏：认证检查中的转圈，或登录表单。
//
// 从 App.tsx 搬来的纯搬迁。原先是两处各 20 行的 early-return 分支，都套着同一个
// ThemeProvider + CssBaseline，中间夹着一个 renderLoginForm。合成一个组件之后
// App 里这两个分支各剩一行，「没登录时显示什么」这件事有了个名字。
//
// 顺带把 ThemeProvider 收进来：这两屏是**整页替换**（不复用主界面的任何布局），
// 主题壳本来就该跟着这一屏走，没必要让 App 在两处重复搭一遍。

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider, type Theme } from "@mui/material/styles";
import { lazy, Suspense } from "react";

// 登录页必须 lazy：它是首屏唯一的大组件（732 行），同步引入会把它整份拖进首屏包
// （实测 index chunk 227 KB → 237 KB，直接顶到预算边上）。
// 但登录页本身又是首屏 —— 所以 App 里另有「预热」：趁认证检查那次请求还在飞
// 就把 chunk 拉下来，两边并行，用户感觉不到多等一次。
const LoginForm = lazy(() => import("./LoginForm"));

export interface LoginScreenProps {
    theme: Theme;
    /** 正在确认「这次要不要登录」：先给个转圈，别闪一下登录框再切走 */
    checking?: boolean;
    // ---- 登录表单需要的 ----
    brandName?: string;
    onLogin?: (username: string, password: string, remember: boolean) => void;
    loading?: boolean;
    error?: string | null;
    /** 与 LoginForm 的签名保持一致：它要靠返回的 success 决定要不要收起找回表单 */
    onRecover?: (token: string) => Promise<{ success: boolean; message?: string }>;
    recoverConfigured?: boolean;
    onRegister?: (
        username: string,
        password: string,
        inviteCode: string
    ) => Promise<{ success: boolean; message?: string }>;
}

export default function LoginScreen({
    theme,
    checking = false,
    brandName = "",
    onLogin,
    loading = false,
    error,
    onRecover,
    recoverConfigured,
    onRegister,
}: LoginScreenProps) {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {checking ? (
                <Box
                    sx={{
                        minHeight: "100vh",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: "background.default",
                    }}
                >
                    <CircularProgress size={60} thickness={4} />
                </Box>
            ) : (
                <Box
                    sx={{
                        minHeight: "100vh",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: "background.default",
                    }}
                >
                    {/* 登录页是 lazy chunk：没登录的人不该为主界面的代码付流量 */}
                    <Suspense fallback={<CircularProgress size={60} thickness={4} />}>
                        <LoginForm
                            brandName={brandName}
                            onLogin={onLogin ?? (() => {})}
                            loading={loading}
                            error={error}
                            onRecover={onRecover}
                            recoverConfigured={recoverConfigured}
                            onRegister={onRegister}
                        />
                    </Suspense>
                </Box>
            )}
        </ThemeProvider>
    );
}
