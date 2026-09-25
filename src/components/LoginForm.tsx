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
} from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { readRememberedLogin } from "../utils/rememberedLogin";

interface LoginFormProps {
    /** 提交登录；remember 为是否勾选「记住账号密码」 */
    onLogin: (username: string, password: string, remember: boolean) => void;
    loading?: boolean;
    error?: string | null;
}

const LoginForm: React.FC<LoginFormProps> = ({ onLogin, loading = false, error = null }) => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(false);

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
                        导航站登录
                    </Typography>
                </Box>

                {error && (
                    <Alert severity='error' sx={{ mb: 3 }}>
                        {error}
                    </Alert>
                )}

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
                </Box>
            </Paper>
        </Box>
    );
};

export default LoginForm;
