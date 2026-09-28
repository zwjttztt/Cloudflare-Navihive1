import React, { useEffect, useState } from "react";
import {
    TextField,
    Button,
    Typography,
    Box,
    CircularProgress,
    Alert,
    Paper,
    FormControlLabel,
    Checkbox,
    Link,
} from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { readRememberedLogin } from "../utils/rememberedLogin";

interface LoginFormProps {
    /** 提交登录；remember 为是否勾选「记住账号密码」 */
    onLogin: (username: string, password: string, remember: boolean) => void;
    loading?: boolean;
    error?: string | null;
    /** 用恢复令牌（私钥签名）重置管理员密码，返回结果由父组件调用接口 */
    onRecover?: (token: string) => Promise<{ success: boolean; message?: string }>;
    recoverConfigured?: boolean;
}

const LoginForm: React.FC<LoginFormProps> = ({
    onLogin,
    loading = false,
    error = null,
    onRecover,
    recoverConfigured = false,
}) => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(false);

    // 登录 / 恢复账号 两个视图
    const [mode, setMode] = useState<"login" | "recover">("login");
    const [token, setToken] = useState("");
    const [recoverLoading, setRecoverLoading] = useState(false);
    const [localRecoverError, setLocalRecoverError] = useState<string | null>(null);

    // 打开登录页时回填上次记住的账号密码
    useEffect(() => {
        const saved = readRememberedLogin();
        if (saved) {
            setUsername(saved.username);
            setPassword(saved.password);
            setRemember(true);
        }
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onLogin(username, password, remember);
    };

    const handleRecoverSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!token.trim()) {
            setLocalRecoverError("请粘贴恢复令牌");
            return;
        }
        setLocalRecoverError(null);
        setRecoverLoading(true);
        try {
            const result = await onRecover?.(token.trim());
            if (result?.success) {
                // 成功后切回登录页（父组件会弹通知）
                setMode("login");
                setToken("");
            } else {
                setLocalRecoverError(result?.message || "恢复失败，请重试");
            }
        } catch (err) {
            setLocalRecoverError("恢复请求失败：" + (err instanceof Error ? err.message : "未知错误"));
        } finally {
            setRecoverLoading(false);
        }
    };

    const switchToRecover = () => {
        setMode("recover");
        setLocalRecoverError(null);
    };

    const switchToLogin = () => {
        setMode("login");
        setLocalRecoverError(null);
    };

    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                maxWidth: "100%",
                p: { xs: 2, sm: 4 },
            }}
        >
            <Paper
                elevation={3}
                sx={{
                    p: { xs: 3, sm: 4 },
                    borderRadius: 2,
                    width: "100%",
                    maxWidth: { xs: "90%", sm: 400 },
                }}
            >
                <Box
                    sx={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        mb: 3,
                    }}
                >
                    <Box
                        sx={{
                            mb: 2,
                            width: 56,
                            height: 56,
                            borderRadius: "50%",
                            display: "flex",
                            justifyContent: "center",
                            alignItems: "center",
                            backgroundColor: "primary.main",
                            color: "white",
                        }}
                    >
                        <LockOutlinedIcon fontSize='large' />
                    </Box>
                    <Typography component='h1' variant='h5' fontWeight='bold' textAlign='center'>
                        {mode === "login" ? "导航站登录" : "用恢复密钥找回账号"}
                    </Typography>
                </Box>

                {mode === "login" && error && (
                    <Alert severity='error' sx={{ mb: 3 }}>
                        {error}
                    </Alert>
                )}

                {mode === "recover" && (
                    <Alert severity='info' sx={{ mb: 3 }}>
                        用部署时生成的恢复私钥，本地签名得到的恢复令牌（JWS）粘贴到下面即可重置管理员密码。
                        {!recoverConfigured && " 当前站点尚未配置恢复公钥。"}
                    </Alert>
                )}

                {mode === "recover" && (
                    <Box component='form' onSubmit={handleRecoverSubmit} sx={{ mt: 1 }}>
                        {localRecoverError && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {localRecoverError}
                            </Alert>
                        )}
                        <TextField
                            margin='normal'
                            required
                            fullWidth
                            id='recovery-token'
                            label='恢复令牌'
                            name='token'
                            value={token}
                            onChange={e => setToken(e.target.value)}
                            disabled={recoverLoading}
                            multiline
                            minRows={3}
                            placeholder='粘贴 node scripts/recovery-token.mjs sign 生成的令牌'
                            sx={{ mb: 2 }}
                        />
                        <Button
                            type='submit'
                            fullWidth
                            variant='contained'
                            color='primary'
                            disabled={recoverLoading || !token.trim()}
                            size='large'
                            sx={{ py: 1.5, borderRadius: 2 }}
                        >
                            {recoverLoading ? <CircularProgress size={24} color='inherit' /> : "重置密码"}
                        </Button>
                        <Box sx={{ mt: 2, textAlign: "center" }}>
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToLogin}
                                disabled={recoverLoading}
                            >
                                返回登录
                            </Link>
                        </Box>
                    </Box>
                )}

                {mode === "login" && (
                <Box component='form' onSubmit={handleSubmit} sx={{ mt: 1 }}>
                    <TextField
                        margin='normal'
                        required
                        fullWidth
                        id='username'
                        label='用户名'
                        name='username'
                        autoComplete='username'
                        autoFocus
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        disabled={loading}
                        sx={{ mb: 2 }}
                    />
                    <TextField
                        margin='normal'
                        required
                        fullWidth
                        name='password'
                        label='密码'
                        type='password'
                        id='password'
                        autoComplete='current-password'
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        disabled={loading}
                        sx={{ mb: 1 }}
                    />

                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={remember}
                                onChange={e => setRemember(e.target.checked)}
                                disabled={loading}
                                slotProps={{ input: { "aria-label": "记住账号密码" } }}
                            />
                        }
                        label='记住账号密码（一个月内免登录）'
                        sx={{ mb: 2, "& .MuiFormControlLabel-label": { fontSize: "0.875rem" } }}
                    />

                    <Button
                        type='submit'
                        fullWidth
                        variant='contained'
                        color='primary'
                        disabled={loading || !username || !password}
                        size='large'
                        sx={{
                            py: 1.5,
                            mt: 1,
                            borderRadius: 2,
                        }}
                    >
                        {loading ? <CircularProgress size={24} color='inherit' /> : "登录"}
                    </Button>

                    {recoverConfigured && (
                        <Box sx={{ mt: 2, textAlign: "center" }}>
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToRecover}
                                disabled={loading}
                            >
                                用恢复密钥找回账号
                            </Link>
                        </Box>
                    )}
                </Box>
                )}
            </Paper>
        </Box>
    );
};

export default LoginForm;
