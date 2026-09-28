import React, { useEffect, useRef, useState } from "react";
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
    Stack,
    Chip,
} from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { readRememberedLogin } from "../utils/rememberedLogin";
import { validatePasswordStrength } from "../API/crypto";
import {
    algLabel,
    parseRecoveryKeyFile,
    signRecoveryToken,
    type RecoveryAlg,
} from "../utils/recoveryKey";

interface LoginFormProps {
    /** 提交登录；remember 为是否勾选「记住账号密码」 */
    onLogin: (username: string, password: string, remember: boolean) => void;
    loading?: boolean;
    error?: string | null;
    /** 提交恢复令牌（由私钥本地签名得到），返回结果由父组件弹提示 */
    onRecover?: (token: string) => Promise<{ success: boolean; message?: string }>;
    recoverConfigured?: boolean;
}

/** 已载入的私钥：只留在内存里，既不上传也不进 localStorage */
interface LoadedKey {
    alg: RecoveryAlg;
    privateKey: string;
    fileName: string;
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
    // 恢复方式：上传私钥文件（默认，不用命令行）/ 粘贴令牌（给脚本生成的令牌用）
    const [recoverWay, setRecoverWay] = useState<"keyfile" | "token">("keyfile");
    const [token, setToken] = useState("");
    const [loadedKey, setLoadedKey] = useState<LoadedKey | null>(null);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [recoverLoading, setRecoverLoading] = useState(false);
    const [localRecoverError, setLocalRecoverError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

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

    // 选择私钥文件：只在本机读取并解析，文件内容不会发往服务器
    const handlePickKeyFile = async (file: File | undefined) => {
        if (!file) return;
        setLocalRecoverError(null);
        try {
            const text = await file.text();
            const parsed = parseRecoveryKeyFile(text);
            setLoadedKey({
                alg: parsed.alg,
                privateKey: parsed.privateKey,
                fileName: file.name,
            });
        } catch (err) {
            setLoadedKey(null);
            setLocalRecoverError(
                "私钥文件读不出来：" + (err instanceof Error ? err.message : "格式不正确")
            );
        }
    };

    // 上传私钥 → 本地签名 → 提交令牌
    const handleKeyFileSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!loadedKey) {
            setLocalRecoverError("请先选择私钥文件");
            return;
        }
        if (newPassword !== confirmPassword) {
            setLocalRecoverError("两次输入的新密码不一致");
            return;
        }
        const strength = validatePasswordStrength(newPassword);
        if (!strength.ok) {
            setLocalRecoverError(`密码强度不足：${strength.message}`);
            return;
        }

        setLocalRecoverError(null);
        setRecoverLoading(true);
        try {
            // 新密码在本地算成 PBKDF2 哈希后才进令牌，明文不出浏览器
            const signed = await signRecoveryToken({
                alg: loadedKey.alg,
                privateKey: loadedKey.privateKey,
                username: newUsername.trim(),
                password: newPassword,
                expHours: 1,
            });
            const result = await onRecover?.(signed);
            if (result?.success) {
                resetRecoverForm();
                setMode("login");
            } else {
                setLocalRecoverError(result?.message || "恢复失败，请重试");
            }
        } catch (err) {
            setLocalRecoverError(
                "本地签名失败：" +
                    (err instanceof Error ? err.message : "浏览器可能不支持该算法")
            );
        } finally {
            setRecoverLoading(false);
        }
    };

    const handleTokenSubmit = async (e: React.FormEvent) => {
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
                resetRecoverForm();
                setMode("login");
            } else {
                setLocalRecoverError(result?.message || "恢复失败，请重试");
            }
        } catch (err) {
            setLocalRecoverError("恢复请求失败：" + (err instanceof Error ? err.message : "未知错误"));
        } finally {
            setRecoverLoading(false);
        }
    };

    const resetRecoverForm = () => {
        setLoadedKey(null);
        setNewUsername("");
        setNewPassword("");
        setConfirmPassword("");
        setToken("");
        if (fileInputRef.current) fileInputRef.current.value = "";
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
                        上传在「网站设置 → 账户安全」里下载的恢复私钥，再填新密码即可重置。
                        私钥只在你的浏览器里用来签名，不会上传。
                        {!recoverConfigured && " 当前站点尚未配置恢复公钥。"}
                    </Alert>
                )}

                {mode === "recover" && (
                    <Box
                        component='form'
                        onSubmit={recoverWay === "keyfile" ? handleKeyFileSubmit : handleTokenSubmit}
                        sx={{ mt: 1 }}
                    >
                        {localRecoverError && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {localRecoverError}
                            </Alert>
                        )}

                        {recoverWay === "keyfile" ? (
                            <Stack spacing={2}>
                                <Box>
                                    <input
                                        ref={fileInputRef}
                                        type='file'
                                        accept='.json,application/json'
                                        style={{ display: "none" }}
                                        onChange={e => void handlePickKeyFile(e.target.files?.[0])}
                                    />
                                    <Button
                                        fullWidth
                                        variant='outlined'
                                        startIcon={<UploadFileIcon />}
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={recoverLoading}
                                    >
                                        {loadedKey ? "重新选择私钥文件" : "选择私钥文件"}
                                    </Button>
                                    {loadedKey ? (
                                        <Chip
                                            sx={{ mt: 1, maxWidth: "100%" }}
                                            size='small'
                                            color='success'
                                            label={`已载入：${loadedKey.fileName}（${algLabel(loadedKey.alg)}）`}
                                        />
                                    ) : (
                                        <Typography
                                            variant='caption'
                                            color='text.secondary'
                                            sx={{ display: "block", mt: 0.5 }}
                                        >
                                            文件名形如 navihive-recovery-key-日期.json
                                        </Typography>
                                    )}
                                </Box>

                                <TextField
                                    fullWidth
                                    size='small'
                                    label='新管理员账号'
                                    value={newUsername}
                                    onChange={e => setNewUsername(e.target.value)}
                                    disabled={recoverLoading}
                                    placeholder='留空则只重置密码，不改账号'
                                />
                                <TextField
                                    fullWidth
                                    required
                                    size='small'
                                    type='password'
                                    label='新密码'
                                    autoComplete='new-password'
                                    value={newPassword}
                                    onChange={e => setNewPassword(e.target.value)}
                                    disabled={recoverLoading}
                                    helperText='至少 12 位'
                                />
                                <TextField
                                    fullWidth
                                    required
                                    size='small'
                                    type='password'
                                    label='确认新密码'
                                    autoComplete='new-password'
                                    value={confirmPassword}
                                    onChange={e => setConfirmPassword(e.target.value)}
                                    disabled={recoverLoading}
                                />
                            </Stack>
                        ) : (
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
                                placeholder='粘贴恢复令牌（JWS）'
                                sx={{ mb: 2 }}
                            />
                        )}

                        <Button
                            type='submit'
                            fullWidth
                            variant='contained'
                            color='primary'
                            disabled={
                                recoverLoading ||
                                (recoverWay === "keyfile"
                                    ? !loadedKey || !newPassword || !confirmPassword
                                    : !token.trim())
                            }
                            size='large'
                            sx={{ py: 1.5, borderRadius: 2, mt: 2 }}
                        >
                            {recoverLoading ? <CircularProgress size={24} color='inherit' /> : "重置密码"}
                        </Button>

                        <Box sx={{ mt: 2, textAlign: "center" }}>
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={() => {
                                    setRecoverWay(recoverWay === "keyfile" ? "token" : "keyfile");
                                    setLocalRecoverError(null);
                                }}
                                disabled={recoverLoading}
                                sx={{ display: "block", mb: 1 }}
                            >
                                {recoverWay === "keyfile"
                                    ? "改为粘贴恢复令牌"
                                    : "改为上传私钥文件"}
                            </Link>
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
