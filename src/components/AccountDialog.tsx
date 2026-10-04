// src/components/AccountDialog.tsx
// 「更多选项 → 账号管理」：把和「我是谁 / 我的凭据」有关的东西集中在这里 ——
// 改账号密码、恢复密钥、邀请码、注销账号。
//
// 这几项原本散在「网站设置 → 账户安全」和「更多选项 → 注销账号」里：
// 网站设置管的是「站点长什么样」，账号凭据混在里面既不好找，
// 也容易让人以为「保存设置」会顺带改密码（其实两回事）。
//
// 组件本身不碰 API：改密提交、生成私钥、生成邀请码、注销都通过回调交给父组件。
import type { ChangeEvent } from "react";
import { useState } from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Divider,
    IconButton,
    Stack,
    TextField,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import PersonRemoveIcon from "@mui/icons-material/PersonRemove";
import { PasswordField } from "./PasswordField";
import type { AccountInfo, SessionInfo } from "../API/http";
import {
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../API/http";

/** 距某个时间点还有几天（向上取整；null = 服务端没给推算依据） */
function daysUntil(ts: number | null): number | null {
    if (ts === null) return null;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, Math.ceil((ts - now) / (24 * 60 * 60)));
}

/** 「最后活跃」的可读描述 */
function formatLastActive(ts: number | null): string {
    if (ts === null) return "从未登录";
    const days = Math.floor((Math.floor(Date.now() / 1000) - ts) / (24 * 60 * 60));
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 30) return `${days} 天前`;
    return `${Math.floor(days / 30)} 个月前`;
}

/**
 * UA → 「浏览器 · 系统」的可读短名。
 * 认不出来就退回原始 UA（截断），总比显示一长串谁也看不懂的字符串强。
 * 判定顺序要紧：Edge 的 UA 里也含 "Chrome"、Chrome 的里面也含 "Safari"。
 */
function describeUserAgent(ua: string): string {
    if (!ua) return "未知设备";
    const browser = /Edg\//.test(ua)
        ? "Edge"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /Chrome\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "";
    const os = /Windows NT/.test(ua)
        ? "Windows"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Android/.test(ua)
            ? "Android"
            : /Macintosh/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
    if (browser && os) return `${browser} · ${os}`;
    return (browser || os || ua).slice(0, 60);
}

/** 改账号 / 改密码的输入草稿：留空表示「不改这一项」 */
export interface AccountAuthDraft {
    username: string;
    currentPassword: string;
    newPassword: string;
}

interface AccountDialogProps {
    open: boolean;
    onClose: () => void;
    auth: AccountAuthDraft;
    onAuthChange: (field: keyof AccountAuthDraft, value: string) => void;
    /** 提交改账号 / 改密码（父组件负责调接口与改密后强制登出） */
    onSaveAuth: () => void;
    saving?: boolean;
    /** 当前登录账号（多账号后界面上要能看出「我是谁」） */
    currentUser?: { username: string; role: "owner" | "user" } | null;
    /** 当前账号是否已配置恢复公钥（每个账号各自一份） */
    recoveryKeyConfigured?: boolean;
    /**
     * 生成恢复密钥对：公钥交给服务器保存，私钥触发浏览器下载。
     * 需传当前密码（服务端校验），由父组件负责调用接口，这里只渲染与反馈。
     */
    onGenerateRecoveryKey?: (currentPassword: string) => Promise<{
        success: boolean;
        message?: string;
    }>;
    /** 本次会话生成的邀请码（只留在内存，刷新页面后不再显示） */
    invite?: { code: string; expiresAt: number } | null;
    /** 生成邀请码：父组件负责调接口，这里只展示结果 */
    onCreateInvite?: () => Promise<{
        success: boolean;
        message?: string;
        code?: string;
        expiresAt?: number;
    }>;
    /** 注销账号：这里只负责触发，二次确认弹窗由父组件接管 */
    onDeleteAccount?: () => void;
    /** 账号清单（仅站点所有者能拿到）：每个账号的沉睡治理状态 */
    accounts?: AccountInfo[];
    /** 重新启用某个被停用的账号 = 豁免沉睡治理（服务端会顺带刷新活跃时间） */
    onExemptUser?: (uid: number) => void;
    /** 沉睡治理阈值（天）：没配就按服务端默认 180 / 30 显示 */
    inactivePolicy?: { disableDays: number; graceDays: number };
    /** 保存阈值：父组件负责调接口，这里只做输入与反馈 */
    onSaveInactivePolicy?: (policy: {
        disableDays: number;
        graceDays: number;
    }) => Promise<{ success: boolean; message?: string }>;
    /**
     * 手动跑一次沉睡扫描：等不及每周 cron 时用（刚调完阈值、或想立刻看清谁会被清）。
     * 父组件负责调接口，这里只做反馈；回传的停用/清除条数直接显示出来。
     */
    onSweepInactive?: () => Promise<{
        success: boolean;
        message?: string;
        disabled?: number;
        deleted?: number;
    }>;
    /** 当前账号登录过的设备（会话列表）；空数组表示还没拿到或站点没启用登录 */
    sessions?: SessionInfo[];
    /** 把某一台设备踢下线（父组件负责调接口并刷新列表） */
    onRevokeSession?: (jti: string) => void;
    /** 退出其它设备：除当前这台之外全部吊销 */
    onRevokeOthers?: () => void;
}

/** 分组：左侧一小段主色竖条 + 组标题，可选一行组说明 */
function Section({
    title,
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                    sx={{
                        width: 3,
                        height: 14,
                        borderRadius: 0.5,
                        bgcolor: "primary.main",
                        opacity: 0.75,
                        flex: "none",
                    }}
                />
                <Typography variant='subtitle2' sx={{
                    fontWeight: '600'
                }}>
                    {title}
                </Typography>
            </Box>
            {hint ? (
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mt: 0.25,
                        ml: "11px"
                    }}>
                    {hint}
                </Typography>
            ) : null}
            <Stack spacing={1.25} sx={{ mt: 1.25 }}>
                {children}
            </Stack>
        </Box>
    );
}

/** 窄屏堆叠、宽屏并排的两列栅格 */
function TwoCol({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{
                display: "grid",
                gap: 1.25,
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            }}
        >
            {children}
        </Box>
    );
}

export default function AccountDialog({
    open,
    onClose,
    auth,
    onAuthChange,
    onSaveAuth,
    saving = false,
    currentUser,
    recoveryKeyConfigured = false,
    onGenerateRecoveryKey,
    invite,
    onCreateInvite,
    onDeleteAccount,
    accounts,
    onExemptUser,
    inactivePolicy,
    onSaveInactivePolicy,
    onSweepInactive,
    sessions,
    onRevokeSession,
    onRevokeOthers,
}: AccountDialogProps) {
    // 恢复密钥的生成结果提示（成功/失败都就地反馈，私钥由浏览器直接下载）
    const [recoveryBusy, setRecoveryBusy] = useState(false);
    const [recoveryMsg, setRecoveryMsg] = useState<{
        type: "success" | "error";
        text: string;
    } | null>(null);

    // 邀请码：生成按钮的忙碌态与失败提示（码本身由父组件持有，避免弹窗关掉就丢）
    const [inviteBusy, setInviteBusy] = useState(false);
    const [inviteMsg, setInviteMsg] = useState<string | null>(null);

    // 生成私钥要单独弹窗输入当前密码：不复用「账号与密码」那组输入框。
    // 否则只是想下载私钥的人被迫先填「当前密码」，再点保存会被判成「没填新密码」。
    const [recoveryPwdOpen, setRecoveryPwdOpen] = useState(false);
    const [recoveryPwd, setRecoveryPwd] = useState("");

    // 沉睡治理阈值在这里只读展示：改它的入口统一放在「网站设置 → 数据保留」，
    // 两处读写的是同一份全站配置，开两个编辑框只会让人不知道该信哪一个
    // 手动扫描：与「保存阈值」分开 —— 它是一次性动作，结果要把停用/清除的条数报出来
    const [sweepBusy, setSweepBusy] = useState(false);
    const [sweepMsg, setSweepMsg] = useState<{
        type: "success" | "error";
        text: string;
    } | null>(null);

    const handleSweep = async () => {
        setSweepBusy(true);
        setSweepMsg(null);
        try {
            const result = await onSweepInactive?.();
            if (result?.success === false) {
                setSweepMsg({ type: "error", text: result.message || "扫描失败" });
                return;
            }
            const disabled = result?.disabled ?? 0;
            const deleted = result?.deleted ?? 0;
            setSweepMsg({
                type: "success",
                text:
                    disabled === 0 && deleted === 0
                        ? "扫描完成，暂无需要停用或清除的账号"
                        : `扫描完成：停用 ${disabled} 个、清除 ${deleted} 个`,
            });
        } catch (error) {
            setSweepMsg({
                type: "error",
                text: "扫描失败：" + (error instanceof Error ? error.message : "未知错误"),
            });
        } finally {
            setSweepBusy(false);
        }
    };

    const authDirty = Boolean(auth.username.trim() || auth.newPassword);

    const handleCreateInvite = async () => {
        setInviteBusy(true);
        setInviteMsg(null);
        try {
            const result = await onCreateInvite?.();
            if (!result?.success) {
                setInviteMsg(result?.message || "生成邀请码失败");
            }
        } catch (error) {
            setInviteMsg(
                "生成邀请码失败：" + (error instanceof Error ? error.message : "未知错误")
            );
        } finally {
            setInviteBusy(false);
        }
    };

    const openRecoveryPwdDialog = () => {
        setRecoveryPwd("");
        setRecoveryMsg(null);
        setRecoveryPwdOpen(true);
    };

    const submitRecoveryPwd = async () => {
        if (!recoveryPwd) {
            setRecoveryMsg({ type: "error", text: "请输入当前账号密码" });
            return;
        }
        setRecoveryBusy(true);
        setRecoveryMsg(null);
        try {
            const result = await onGenerateRecoveryKey?.(recoveryPwd);
            setRecoveryMsg(
                result?.success
                    ? {
                          type: "success",
                          text: result.message || "私钥文件已下载，请离线妥善保管",
                      }
                    : { type: "error", text: result?.message || "生成恢复密钥失败" }
            );
            if (result?.success) {
                setRecoveryPwd("");
                setRecoveryPwdOpen(false);
            }
        } catch (error) {
            setRecoveryMsg({
                type: "error",
                text: "生成恢复密钥失败：" + (error instanceof Error ? error.message : "未知错误"),
            });
        } finally {
            setRecoveryBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                maxWidth='sm'
                fullWidth
                slotProps={{
                    paper: {
                        sx: {
                            m: { xs: 2, sm: "auto" },
                            width: { xs: "calc(100% - 32px)", sm: "auto" },
                        },
                    }
                }}
            >
                <DialogTitle sx={{ px: 3, pt: 2, pb: 0.5 }}>
                    账号与安全
                    <IconButton
                        aria-label='close'
                        onClick={onClose}
                        sx={{ position: "absolute", right: 8, top: 8 }}
                    >
                        <CloseIcon />
                    </IconButton>
                </DialogTitle>
                <DialogContent
                    sx={{
                        px: 3,
                        pt: 1,
                        pb: 2,
                        "& .MuiFormHelperText-root": { mt: 0.5, fontSize: 11.5, lineHeight: 1.5 },
                    }}
                >
                    {currentUser ? (
                        <DialogContentText sx={{ mb: 1.5, fontSize: 13.5 }}>
                            当前账号：
                            <Box component='span' sx={{ fontWeight: 600 }}>
                                {currentUser.username}
                            </Box>
                            {currentUser.role === "owner" ? "（站点所有者）" : ""}
                            。每个账号只看到自己的分组、卡片与备份配置。
                            <Box
                                component='span'
                                sx={{ display: "block", mt: 0.5, color: "text.secondary" }}
                            >
                                上面几段是「我自己」的安全设置（账号密码 / 恢复密钥 / 登录设备 / 注销）；
                                再往下是站点治理，只有站点所有者才看得到。
                            </Box>
                        </DialogContentText>
                    ) : (
                        <DialogContentText sx={{ mb: 1.5, fontSize: 13.5 }}>
                            管理当前账号的登录凭据与找回方式。
                        </DialogContentText>
                    )}

                    <Stack spacing={2} divider={<Divider />}>
                        {/* 1. 账号与密码 */}
                        <Section
                            title='账号与密码'
                            hint='留空表示不修改。修改前必须先填当前密码；改完会立即退出登录，需要用新凭据重新登录。'
                        >
                            <TextField
                                margin='dense'
                                size='small'
                                id='account-username'
                                label='账号名'
                                type='text'
                                fullWidth
                                variant='outlined'
                                value={auth.username}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                    onAuthChange("username", e.target.value)
                                }
                                placeholder='留空则不修改账号'
                                // 关掉自动填充：否则浏览器会把登录时保存的账号直接带进来，
                                // 让人误以为「账号已经填好了」，保存时其实是在改账号
                                autoComplete='off'
                                name='account-username-field'
                            />
                            <TwoCol>
                                <PasswordField
                                    id='account-current-password'
                                    label='当前密码'
                                    value={auth.currentPassword}
                                    onChange={e => onAuthChange("currentPassword", e.target.value)}
                                    placeholder='修改账号或密码时必填'
                                />
                                <PasswordField
                                    id='account-new-password'
                                    label='新密码'
                                    value={auth.newPassword}
                                    onChange={e => onAuthChange("newPassword", e.target.value)}
                                    placeholder='留空则不修改密码'
                                />
                            </TwoCol>
                            <Box>
                                <Button
                                    variant='contained'
                                    size='small'
                                    onClick={onSaveAuth}
                                    disabled={saving || !authDirty}
                                >
                                    {saving ? "保存中…" : "保存账号与密码"}
                                </Button>
                                {!authDirty ? (
                                    <Typography
                                        variant='caption'
                                        sx={{
                                            color: 'text.secondary',
                                            display: "block",
                                            mt: 0.5
                                        }}>
                                        填写新账号或新密码后才能保存。
                                    </Typography>
                                ) : null}
                            </Box>
                        </Section>

                        {/* 2. 恢复密钥：忘记密码时用它重置。私钥只在本地生成并下载 */}
                        <Section
                            title='恢复密钥'
                            hint='每个账号一份：谁生成的私钥只能重置谁的密码，别的账号看不到、也用不上。'
                        >
                            <Stack
                                direction={{ xs: "column", sm: "row" }}
                                spacing={1}
                                sx={{
                                    alignItems: { xs: "stretch", sm: "center" },
                                    justifyContent: 'space-between'
                                }}>
                                <Box>
                                    <Typography variant='body2' sx={{
                                        fontWeight: '600'
                                    }}>
                                        {recoveryKeyConfigured ? "已配置" : "未配置"}
                                    </Typography>
                                    <Typography variant='caption' sx={{
                                        color: 'text.secondary'
                                    }}>
                                        私钥只在你本机生成并下载，服务器只保存公钥；忘记密码时上传私钥即可重置。
                                    </Typography>
                                </Box>
                                <Button
                                    variant='outlined'
                                    size='small'
                                    startIcon={<VpnKeyIcon fontSize='small' />}
                                    onClick={openRecoveryPwdDialog}
                                    disabled={recoveryBusy}
                                    sx={{ flex: "none", whiteSpace: "nowrap" }}
                                >
                                    {recoveryBusy
                                        ? "生成中…"
                                        : recoveryKeyConfigured
                                          ? "重新生成并下载私钥"
                                          : "生成并下载私钥"}
                                </Button>
                            </Stack>
                            {recoveryMsg ? (
                                <Typography
                                    variant='caption'
                                    sx={{ display: "block", mt: 0.5 }}
                                    color={
                                        recoveryMsg.type === "success"
                                            ? "success.main"
                                            : "error.main"
                                    }
                                >
                                    {recoveryMsg.text}
                                </Typography>
                            ) : (
                                <Typography
                                    variant='caption'
                                    sx={{
                                        color: 'text.secondary',
                                        display: "block",
                                        mt: 0.5
                                    }}>
                                    点击后会单独弹窗验证当前密码；重新生成会让此前下载的私钥立即失效。
                                </Typography>
                            )}
                        </Section>

                        {/* 2.5 登录设备：哪几台设备登着，可以只踢某一台。
                            以前「改密 / 注销」只能把账号的令牌整体作废 —— 电脑丢了只能
                            连自己的手机一起踢掉。现在按会话精确吊销，别的设备不受影响。 */}
                        {sessions && sessions.length > 0 ? (
                            <Section
                                title='登录设备'
                                hint='列出当前账号登录过的设备。怀疑某台设备被人用过，可以只把它踢下线，其它设备不受影响。'
                            >
                                <Stack spacing={1}>
                                    {sessions.map(item => (
                                        <Stack
                                            key={item.jti}
                                            direction={{ xs: "column", sm: "row" }}
                                            spacing={1}
                                            sx={{
                                                alignItems: { xs: "stretch", sm: "center" },
                                                justifyContent: 'space-between',
                                                px: 1.25,
                                                py: 1,
                                                borderRadius: 1,
                                                bgcolor: "action.hover"
                                            }}>
                                            <Box sx={{ minWidth: 0 }}>
                                                <Typography variant='body2' sx={{
                                                    fontWeight: '600'
                                                }}>
                                                    {describeUserAgent(item.userAgent)}
                                                    {item.current ? "（当前设备）" : ""}
                                                </Typography>
                                                <Typography
                                                    variant='caption'
                                                    sx={{
                                                        color: 'text.secondary'
                                                    }}
                                                >
                                                    {item.ip ? `${item.ip} · ` : ""}
                                                    {item.current
                                                        ? "正在使用"
                                                        : `最近活跃：${formatLastActive(item.lastSeenAt)}`}
                                                </Typography>
                                            </Box>
                                            {/* 当前这台不给踢：踢掉等于把自己立刻踢下线，
                                                还容易让人以为站点把自己锁在门外 */}
                                            {item.current ? null : (
                                                <Button
                                                    variant='outlined'
                                                    size='small'
                                                    onClick={() => onRevokeSession?.(item.jti)}
                                                    sx={{ flex: "none", whiteSpace: "nowrap" }}
                                                >
                                                    踢下线
                                                </Button>
                                            )}
                                        </Stack>
                                    ))}
                                </Stack>

                                {/* 没有「其它设备」可踢时按钮置灰但保留 ——
                                    否则用户会以为压根没有这个入口 */}
                                {onRevokeOthers ? (
                                    <Box>
                                        <Button
                                            variant='outlined'
                                            color='error'
                                            size='small'
                                            onClick={onRevokeOthers}
                                            disabled={
                                                sessions.filter(s => !s.current).length === 0
                                            }
                                            sx={{ alignSelf: "flex-start" }}
                                        >
                                            退出其它设备
                                        </Button>
                                    </Box>
                                ) : null}
                            </Section>
                        ) : null}

                        {/* 3. 邀请码：给新用户注册用，30 分钟有效、只能用一次 */}
                        <Section
                            title='邀请码'
                            hint='把码发给对方，他就能在登录页注册；30 分钟内有效，只能用一次。'
                        >
                            <Stack
                                direction={{ xs: "column", sm: "row" }}
                                spacing={1}
                                sx={{
                                    alignItems: { xs: "stretch", sm: "center" },
                                    justifyContent: 'space-between'
                                }}>
                                <Typography variant='caption' sx={{
                                    color: 'text.secondary'
                                }}>
                                    新账号注册后自带几个示例分组，数据与你互不可见。
                                </Typography>
                                <Button
                                    variant='outlined'
                                    size='small'
                                    onClick={() => void handleCreateInvite()}
                                    disabled={inviteBusy}
                                    sx={{ flex: "none", whiteSpace: "nowrap" }}
                                >
                                    {inviteBusy ? "生成中…" : "生成邀请码"}
                                </Button>
                            </Stack>

                            {invite ? (
                                <Stack direction='row' spacing={1} sx={{
                                    alignItems: 'center'
                                }}>
                                    <Typography
                                        component='code'
                                        sx={{
                                            fontFamily: "monospace",
                                            fontSize: "1rem",
                                            letterSpacing: 1,
                                            fontWeight: 700,
                                        }}
                                    >
                                        {invite.code}
                                    </Typography>
                                    <Typography variant='caption' sx={{
                                        color: 'text.secondary'
                                    }}>
                                        {invite.expiresAt
                                            ? `有效期至 ${new Date(invite.expiresAt * 1000).toLocaleTimeString()}`
                                            : "30 分钟内有效"}
                                    </Typography>
                                    <Button
                                        size='small'
                                        onClick={() => void navigator.clipboard?.writeText(invite.code)}
                                        sx={{ flex: "none" }}
                                    >
                                        复制
                                    </Button>
                                </Stack>
                            ) : null}

                            {inviteMsg ? (
                                <Typography
                                    variant='caption'
                                    sx={{
                                        color: 'error.main',
                                        display: "block",
                                        mt: 0.5
                                    }}>
                                    {inviteMsg}
                                </Typography>
                            ) : null}
                        </Section>

                        {/* 4. 账号清单：只有站点所有者看得到 —— 谁快被停用、谁快被清除。
                            沉睡治理是自动跑的，这里是人工兜底：认出是真人在用的账号就给豁免。 */}
                        {currentUser?.role === "owner" && accounts && accounts.length > 0 ? (
                            <Section
                                title='账号与沉睡治理'
                                hint='这一段属于全站治理，只有站点所有者能操作。长期不登录的账号会先被停用（数据一条不删），宽限期满后自动清除以释放空间。认出是真人在用的，可以提前豁免。'
                            >
                                <Stack spacing={1}>
                                    {accounts.map(account => {
                                        const disabled = account.status === "disabled";
                                        const daysToDisable = daysUntil(account.willDisableAt);
                                        const daysToDelete = daysUntil(account.willDeleteAt);
                                        return (
                                            <Stack
                                                key={account.id}
                                                direction={{ xs: "column", sm: "row" }}
                                                spacing={1}
                                                sx={{
                                                    alignItems: { xs: "stretch", sm: "center" },
                                                    justifyContent: 'space-between',
                                                    px: 1.25,
                                                    py: 1,
                                                    borderRadius: 1,
                                                    bgcolor: "action.hover"
                                                }}>
                                                <Box>
                                                    <Typography variant='body2' sx={{
                                                        fontWeight: '600'
                                                    }}>
                                                        {account.username}
                                                        {account.role === "owner"
                                                            ? "（站点所有者）"
                                                            : ""}
                                                    </Typography>
                                                    <Typography
                                                        variant='caption'
                                                        color={
                                                            disabled
                                                                ? disabled && daysToDelete !== null && daysToDelete <= 7
                                                                    ? "error.main"
                                                                    : "warning.main"
                                                                : "text.secondary"
                                                        }
                                                    >
                                                        {disabled
                                                            ? `已停用${daysToDelete !== null ? `，约 ${daysToDelete} 天后清除` : "，等待清除"}`
                                                            : `最近活跃：${formatLastActive(account.lastActiveAt)}${daysToDisable !== null ? ` · 约 ${daysToDisable} 天后停用` : ""}`}
                                                    </Typography>
                                                </Box>
                                                {disabled ? (
                                                    <Button
                                                        variant='outlined'
                                                        size='small'
                                                        onClick={() => onExemptUser?.(account.id)}
                                                        sx={{ flex: "none", whiteSpace: "nowrap" }}
                                                    >
                                                        重新启用
                                                    </Button>
                                                ) : null}
                                            </Stack>
                                        );
                                    })}
                                </Stack>

                                {onSaveInactivePolicy ? (
                                    <Box sx={{ mt: 1.5 }}>
                                        <Divider sx={{ mb: 1.5 }} />
                                        <TwoCol>
                                            <TextField
                                                label='多久没登录就停用（天）'
                                                size='small'
                                                value={String(
                                                    inactivePolicy?.disableDays ??
                                                        INACTIVE_DISABLE_DAYS_DEFAULT
                                                )}
                                                disabled
                                            />
                                            <TextField
                                                label='停用后保留多久再清除（天）'
                                                size='small'
                                                value={String(
                                                    inactivePolicy?.graceDays ??
                                                        INACTIVE_DELETE_GRACE_DAYS_DEFAULT
                                                )}
                                                disabled
                                            />
                                        </TwoCol>
                                        <Typography
                                            variant='caption'
                                            sx={{
                                                color: 'text.secondary',
                                                display: "block",
                                                mt: 0.5
                                            }}>
                                            要改这两个天数，去「网站设置 → 数据保留」；这里显示的是同一份配置，只是不在这里改。
                                        </Typography>
                                        <Stack
                                            direction='row'
                                            spacing={1.25}
                                            sx={{
                                                alignItems: 'center',
                                                mt: 1.25,
                                                flexWrap: "wrap",
                                                rowGap: 1
                                            }}>
                                            {/* 立刻跑一遍：不用等每周 cron，停用/清除条数直接回显 */}
                                            {onSweepInactive ? (
                                                <Button
                                                    variant='text'
                                                    size='small'
                                                    onClick={() => void handleSweep()}
                                                    disabled={sweepBusy}
                                                    sx={{ flex: "none" }}
                                                >
                                                    {sweepBusy ? "扫描中…" : "立即扫描"}
                                                </Button>
                                            ) : null}
                                            <Typography variant='caption' sx={{
                                                color: 'text.secondary'
                                            }}>
                                                站点所有者账号永不参与治理；清除前会先停用并保留数据
                                            </Typography>
                                        </Stack>
                                        {sweepMsg ? (
                                            <Typography
                                                variant='caption'
                                                color={
                                                    sweepMsg.type === "error"
                                                        ? "error.main"
                                                        : "success.main"
                                                }
                                                sx={{ display: "block", mt: 0.75 }}
                                            >
                                                {sweepMsg.text}
                                            </Typography>
                                        ) : null}
                                    </Box>
                                ) : null}
                            </Section>
                        ) : null}

                        {/* 5. 注销：破坏性操作沉底 */}
                        {onDeleteAccount ? (
                            <Section
                                title='注销账号'
                                hint='删除当前账号及其全部分组、卡片与备份配置，无法恢复。'
                            >
                                <Button
                                    variant='outlined'
                                    color='error'
                                    size='small'
                                    startIcon={<PersonRemoveIcon fontSize='small' />}
                                    onClick={onDeleteAccount}
                                    sx={{ alignSelf: "flex-start" }}
                                >
                                    注销当前账号
                                </Button>
                            </Section>
                        ) : null}
                    </Stack>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2, pt: 1 }}>
                    <Button onClick={onClose} variant='outlined'>
                        关闭
                    </Button>
                </DialogActions>
            </Dialog>

            {/* 生成恢复私钥前确认当前密码：独立弹窗，不占用上方「当前密码」输入框 */}
            <Dialog
                open={recoveryPwdOpen}
                onClose={() => (recoveryBusy ? undefined : setRecoveryPwdOpen(false))}
                maxWidth='xs'
                fullWidth
            >
                <DialogTitle sx={{ px: 3, pt: 2, pb: 1 }}>验证身份后生成恢复私钥</DialogTitle>
                <DialogContent sx={{ px: 3, pt: 0.5, pb: 1 }}>
                    {/* 一句说清就行：小屏上弹窗高度有限，文字一多底部按钮会被挤出可视区 */}
                    <DialogContentText variant='body2' sx={{ mb: 2 }}>
                        私钥等同于重置密码的万能钥匙，请输入<strong>当前账号密码</strong>验证身份。
                    </DialogContentText>
                    <PasswordField
                        autoFocus
                        id='account-recovery-current-password'
                        label='当前账号密码'
                        value={recoveryPwd}
                        onChange={e => setRecoveryPwd(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && !recoveryBusy) void submitRecoveryPwd();
                        }}
                        disabled={recoveryBusy}
                    />
                    {recoveryMsg && recoveryPwdOpen ? (
                        <Typography
                            variant='caption'
                            sx={{ display: "block", mt: 1 }}
                            color={recoveryMsg.type === "success" ? "success.main" : "error.main"}
                        >
                            {recoveryMsg.text}
                        </Typography>
                    ) : null}
                </DialogContent>
                <DialogActions
                    sx={{
                        px: 3,
                        pb: 2,
                        // 小屏键盘弹起时按钮会被挤出可视区：允许换行，并把主按钮排到前面
                        flexWrap: "wrap",
                        gap: 1,
                        "& > .MuiButton-contained": { order: { xs: 1, sm: 2 } },
                    }}
                >
                    <Button
                        onClick={() => setRecoveryPwdOpen(false)}
                        variant='outlined'
                        disabled={recoveryBusy}
                    >
                        取消
                    </Button>
                    <Button
                        onClick={() => void submitRecoveryPwd()}
                        variant='contained'
                        disabled={recoveryBusy || !recoveryPwd}
                    >
                        {recoveryBusy ? "生成中…" : "确认并下载私钥"}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
