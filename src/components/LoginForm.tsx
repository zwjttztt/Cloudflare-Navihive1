import React, { useEffect, useState } from "react";
import {
    TextField,
    Button,
    Typography,
    Box,
    CircularProgress,
    Alert,
    Paper,
    Link,
    FormControlLabel,
    Checkbox,
} from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { readRememberedLogin } from "../utils/rememberedLogin";

interface LoginFormProps {
    /** 提交登录；remember 为是否勾选「记住账号密码」 */
    onLogin: (username: string, password: string, remember: boolean) => void;
    loading?: boolean;
    error?: string | null;
    /** 用应急重置码重设密码 */
    onResetPassword?: (code: string, newPassword: string) => void;
    resetLoading?: boolean;
    resetError?: string | null;
    /** 服务端是否已配置应急重置码，未配置时给出对应提示 */
    resetConfigured?: boolean;
}

const LoginForm: React.FC<LoginFormProps> = ({
    onLogin,
    loading = false,
    error = null,
    onResetPassword,
    resetLoading = false,
    resetError = null,
    resetConfigured = true,
}) => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(false);

    // 「登录」与「忘记密码（应急重置码）」两个视图
    const [mode, setMode] = useState<"login" | "reset">("login");
    const [resetCode, setResetCode] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [localResetError, setLocalResetError] = useState<string | null>(null);

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

    const handleResetSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword !== confirmPassword) {
            setLocalResetError("两次输入的新密码不一致");
            return;
        }
        setLocalResetError(null);
        onResetPassword?.(resetCode, newPassword);
    };

    const switchToReset = () => {
        setMode("reset");
        setLocalResetError(null);
    };

    const switchToLogin = () => {
        setMode("login");
        setLocalResetError(null);
    };

    const resetMessage = localResetError || resetError;

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
                        {mode === "login" ? "导航站登录" : "找回账号密码"}
                    </Typography>
                </Box>

                {mode === "login" && error && (
                    <Alert severity='error' sx={{ mb: 3 }}>
                        {error}
                    </Alert>
                )}

                {mode === "reset" && (
                    <Alert severity='info' sx={{ mb: 3 }}>
                        输入部署时配置的应急重置码，即可直接重设管理员密码。
                        {!resetConfigured && " 当前站点尚未配置应急重置码。"}
                    </Alert>
                )}

                {mode === "reset" && (
                    <Box component='form' onSubmit={handleResetSubmit} sx={{ mt: 1 }}>
                        {resetMessage && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {resetMessage}
                            </Alert>
                        )}
                        <TextField
                            margin='normal'
                            required
                            fullWidth
                            id='reset-code'
                            label='应急重置码'
                            name='resetCode'
                            value={resetCode}
                            onChange={e => setResetCode(e.target.value)}
                            disabled={resetLoading}
                            helperText='不区分大小写'
                            sx={{ mb: 2 }}
                        />
                        <TextField
                            margin='normal'
                            required
                            fullWidth
                            name='newPassword'
                            label='新密码'
                            type='password'
                            id='new-password'
                            autoComplete='new-password'
                            value={newPassword}
                            onChange={e => setNewPassword(e.target.value)}
                            disabled={resetLoading}
                            sx={{ mb: 2 }}
                        />
                        <TextField
                            margin='normal'
                            required
                            fullWidth
                            name='confirmPassword'
                            label='确认新密码'
                            type='password'
                            id='confirm-password'
                            autoComplete='new-password'
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            disabled={resetLoading}
                            sx={{ mb: 2 }}
                        />
                        <Button
                            type='submit'
                            fullWidth
                            variant='contained'
                            color='primary'
                            disabled={resetLoading || !resetCode || !newPassword || !confirmPassword}
                            size='large'
                            sx={{ py: 1.5, borderRadius: 2 }}
                        >
                            {resetLoading ? (
                                <CircularProgress size={24} color='inherit' />
                            ) : (
                                "重设密码"
                            )}
                        </Button>
                        <Box sx={{ mt: 2, textAlign: "center" }}>
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToLogin}
                                disabled={resetLoading}
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
                                inputProps={{ "aria-label": "记住账号密码" }}
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

                    <Box sx={{ mt: 2, textAlign: "center" }}>
                        <Link
                            component='button'
                            type='button'
                            variant='body2'
                            onClick={switchToReset}
                            disabled={loading}
                        >
                            忘记密码？用应急重置码找回
                        </Link>
                    </Box>
                </Box>
                )}
            </Paper>
        </Box>
    );
};

export default LoginForm;
