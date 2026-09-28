import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { PasswordField } from "./PasswordField";
import {
    algLabel,
    checkWebCryptoSupport,
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
    /** 用邀请码注册新账号；不传则不显示注册入口 */
    onRegister?: (
        username: string,
        password: string,
        inviteCode: string
    ) => Promise<{ success: boolean; message?: string }>;
}

/** 已载入的私钥：只留在内存里，既不上传也不进 localStorage */
interface LoadedKey {
    alg: RecoveryAlg;
    privateKey: string;
    fileName: string;
}

/**
 * 登录页顶上居中的品牌名。
 * 站点标题存在服务端配置里，而配置接口要登录后才能取，所以这里用部署时的品牌名兜底
 * （index.html / manifest 里也是同一个名字）。
 */
const BRAND_NAME = "Navihive";

/** 图标候选的等待上限：图标 API 卡住时不能让图标一直空着 */
const ICON_FALLBACK_MS = 3000;

/**
 * 站点图标候选，按序回落：
 *   1. 本站自带的 favicon.svg / favicon.ico —— 换域名部署图标自动跟着换，不用改代码；
 *   2. 默认图标 API 按当前域名抓一份（本地开发时 hostname 是 localhost，抓不到，跳过）；
 *   3. 都拿不到才回到锁图标。
 */
function buildIconCandidates(): string[] {
    if (typeof window === "undefined") return [];
    const list = ["/favicon.svg", "/favicon.ico"];
    const host = window.location.hostname;
    if (host && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) {
        list.push(`https://www.faviconextractor.com/favicon/${host}?larger=true`);
    }
    return list;
}

/** 顶部居中的站点图标：自动取 favicon，取不到逐级回落，最后才是锁图标 */
const BrandMark: React.FC = () => {
    const candidates = useMemo(buildIconCandidates, []);
    const [index, setIndex] = useState(0);
    const [loaded, setLoaded] = useState(false);

    // 超时或加载失败都换下一个候选；加载成功就撤掉计时器，别把好图标换掉
    useEffect(() => {
        if (loaded || index >= candidates.length) return;
        const timer = window.setTimeout(() => {
            setLoaded(false);
            setIndex(i => i + 1);
        }, ICON_FALLBACK_MS);
        return () => window.clearTimeout(timer);
    }, [index, loaded, candidates.length]);

    const src = candidates[index];

    if (!src) {
        return (
            <Box
                sx={{
                    width: 64,
                    height: 64,
                    borderRadius: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "primary.main",
                    color: "common.white",
                }}
            >
                <LockOutlinedIcon fontSize='large' />
            </Box>
        );
    }

    return (
        <Box
            component='img'
            src={src}
            alt=''
            onLoad={() => setLoaded(true)}
            onError={() => {
                setLoaded(false);
                setIndex(i => i + 1);
            }}
            sx={{
                width: 64,
                height: 64,
                borderRadius: 2,
                objectFit: "contain",
                p: 0.5,
                bgcolor: "background.paper",
                border: "1px solid",
                borderColor: "divider",
            }}
        />
    );
};

const LoginForm: React.FC<LoginFormProps> = ({
    onLogin,
    loading = false,
    error = null,
    onRecover,
    recoverConfigured = false,
    onRegister,
}) => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(false);

    // 登录 / 注册 / 恢复账号 三个视图
    const [mode, setMode] = useState<"login" | "register" | "recover">("login");
    const [loadedKey, setLoadedKey] = useState<LoadedKey | null>(null);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [recoverLoading, setRecoverLoading] = useState(false);
    const [localRecoverError, setLocalRecoverError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // 注册表单：账号 + 密码 + 邀请码（邀请码由已登录用户在设置里生成，30 分钟有效）
    const [regUsername, setRegUsername] = useState("");
    const [regPassword, setRegPassword] = useState("");
    const [regConfirm, setRegConfirm] = useState("");
    const [regInvite, setRegInvite] = useState("");
    const [regLoading, setRegLoading] = useState(false);
    const [regError, setRegError] = useState<string | null>(null);
    const [regNotice, setRegNotice] = useState<string | null>(null);

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
        if (!newPassword) {
            setLocalRecoverError("请输入新密码");
            return;
        }
        // 这里不做 12 位强度校验：能用私钥签出合法令牌，本身就已证明持有者身份，
        // 再卡长度只会让人在找回密码时被自己挡在门外。服务端收到的也已经是哈希值。

        setLocalRecoverError(null);
        const notSupported = checkWebCryptoSupport();
        if (notSupported) {
            setLocalRecoverError(notSupported);
            return;
        }

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

    const resetRecoverForm = () => {
        setLoadedKey(null);
        setNewUsername("");
        setNewPassword("");
        setConfirmPassword("");
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const switchToRecover = () => {
        setMode("recover");
        setLocalRecoverError(null);
    };

    const switchToLogin = () => {
        setMode("login");
        setLocalRecoverError(null);
        setRegError(null);
    };

    const switchToRegister = () => {
        setMode("register");
        setRegError(null);
        setRegNotice(null);
    };

    // 注册：邀请码在服务端校验（是否过期 / 是否用过），前端只做基本完整性检查
    const handleRegisterSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setRegError(null);
        setRegNotice(null);

        const username = regUsername.trim();
        if (username.length < 2) {
            setRegError("账号名至少 2 个字符");
            return;
        }
        if (!regPassword) {
            setRegError("请设置密码");
            return;
        }
        if (regPassword !== regConfirm) {
            setRegError("两次输入的密码不一致");
            return;
        }
        if (!regInvite.trim()) {
            setRegError("请填写邀请码");
            return;
        }

        setRegLoading(true);
        try {
            const result = await onRegister?.(username, regPassword, regInvite.trim());
            if (result?.success) {
                // 注册成功后父组件会直接进入应用，这里把表单清空即可
                setRegUsername("");
                setRegPassword("");
                setRegConfirm("");
                setRegInvite("");
                setMode("login");
            } else {
                setRegError(result?.message || "注册失败，请重试");
            }
        } catch (err) {
            setRegError("注册请求失败：" + (err instanceof Error ? err.message : "未知错误"));
        } finally {
            setRegLoading(false);
        }
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
            {/* 品牌区：图标 + 名字一律居中，三个视图共用 */}
            <Stack spacing={1} alignItems='center' sx={{ mb: 3, textAlign: "center" }}>
                <BrandMark />
                <Typography component='h1' variant='h4' fontWeight='800' letterSpacing={0.5}>
                    {BRAND_NAME}
                </Typography>
                <Typography variant='body2' color='text.secondary'>
                    {mode === "login"
                        ? "登录以继续使用导航站"
                        : mode === "register"
                          ? "用邀请码注册新账号"
                          : "用恢复密钥找回账号"}
                </Typography>
            </Stack>

            <Paper
                elevation={3}
                sx={{
                    p: { xs: 3, sm: 4 },
                    borderRadius: 2,
                    width: "100%",
                    maxWidth: { xs: "90%", sm: 400 },
                }}
            >
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

                {mode === "register" && (
                    <Alert severity='info' sx={{ mb: 3 }}>
                        注册需要一枚邀请码。请让已登录的用户在「网站设置 → 账户安全」里生成，
                        邀请码 30 分钟内有效、只能用一次。
                    </Alert>
                )}

                {mode === "register" && (
                    <Box component='form' onSubmit={handleRegisterSubmit} sx={{ mt: 1 }}>
                        {regError && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {regError}
                            </Alert>
                        )}
                        {regNotice && (
                            <Alert severity='info' sx={{ mb: 2 }}>
                                {regNotice}
                            </Alert>
                        )}

                        <Stack spacing={2}>
                            <TextField
                                fullWidth
                                required
                                size='small'
                                label='账号名'
                                autoComplete='off'
                                value={regUsername}
                                onChange={e => setRegUsername(e.target.value)}
                                disabled={regLoading}
                                placeholder='2 - 32 个字符'
                            />
                            <PasswordField
                                id='register-password'
                                label='密码'
                                value={regPassword}
                                onChange={e => setRegPassword(e.target.value)}
                                disabled={regLoading}
                                placeholder='至少 6 位'
                            />
                            <PasswordField
                                id='register-password-confirm'
                                label='确认密码'
                                value={regConfirm}
                                onChange={e => setRegConfirm(e.target.value)}
                                disabled={regLoading}
                            />
                            <TextField
                                fullWidth
                                required
                                size='small'
                                label='邀请码'
                                value={regInvite}
                                onChange={e => setRegInvite(e.target.value.toUpperCase())}
                                disabled={regLoading}
                                placeholder='例如 A2BC3DEF'
                                helperText='大小写均可，提交时会自动转成大写'
                            />
                        </Stack>

                        <Button
                            type='submit'
                            fullWidth
                            variant='contained'
                            color='primary'
                            disabled={
                                regLoading ||
                                !regUsername.trim() ||
                                !regPassword ||
                                !regConfirm ||
                                !regInvite.trim()
                            }
                            size='large'
                            sx={{ py: 1.5, borderRadius: 2, mt: 2 }}
                        >
                            {regLoading ? <CircularProgress size={24} color='inherit' /> : "注册并登录"}
                        </Button>

                        <Box sx={{ mt: 2, textAlign: "center" }}>
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToLogin}
                                disabled={regLoading}
                            >
                                已有账号？返回登录
                            </Link>
                        </Box>
                    </Box>
                )}

                {mode === "recover" && (
                    <Box component='form' onSubmit={handleKeyFileSubmit} sx={{ mt: 1 }}>
                        {localRecoverError && (
                            <Alert severity='error' sx={{ mb: 2 }}>
                                {localRecoverError}
                            </Alert>
                        )}

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
                            <PasswordField
                                id='recover-new-password'
                                label='新密码'
                                value={newPassword}
                                onChange={e => setNewPassword(e.target.value)}
                                disabled={recoverLoading}
                            />
                            <PasswordField
                                id='recover-confirm-password'
                                label='确认新密码'
                                value={confirmPassword}
                                onChange={e => setConfirmPassword(e.target.value)}
                                disabled={recoverLoading}
                            />
                        </Stack>

                        <Button
                            type='submit'
                            fullWidth
                            variant='contained'
                            color='primary'
                            disabled={
                                recoverLoading || !loadedKey || !newPassword || !confirmPassword
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
                    <PasswordField
                        id='password'
                        label='密码'
                        // 登录页就是要让浏览器填已保存的密码，这里必须是 current-password
                        autoComplete='current-password'
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        disabled={loading}
                        helperText=' '
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

                    <Box sx={{ mt: 2, textAlign: "center" }}>
                        {onRegister && (
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToRegister}
                                disabled={loading}
                                sx={{ display: "block", mb: 1 }}
                            >
                                没有账号？用邀请码注册
                            </Link>
                        )}
                        {recoverConfigured && (
                            <Link
                                component='button'
                                type='button'
                                variant='body2'
                                onClick={switchToRecover}
                                disabled={loading}
                            >
                                用恢复密钥找回账号
                            </Link>
                        )}
                    </Box>
                </Box>
                )}
            </Paper>
        </Box>
    );
};

export default LoginForm;
