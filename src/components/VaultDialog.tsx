// src/components/VaultDialog.tsx
// 保险库弹窗（方案 B，端到端加密）—— 建库 / 解锁 / 找回 / 条目管理。
//
// 安全底线（对齐 docs/password-manager-plan-B.md）：
//   · **DEK 只在内存**（sessionRef），关闭 / 锁定 / 空闲超时即丢弃；绝不写 localStorage/sessionStorage。
//   · 主密码**独立**于登录密码；忘密码走**恢复码**找回（建库时一次性展示）。
//   · 解锁 / 建库 / 找回都要跑 PBKDF2（默认 60 万迭代，约 0.5–2s），期间给忙碌反馈，别让用户以为卡死。
//   · 空闲自动锁定（默认 5 分钟无操作）。
// 所有加解密委托给 utils/vaultSession（编排）+ utils/vaultCrypto（原语），本组件只做状态与展示。
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    InputAdornment,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOffOutlined";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import DialogCloseButton from "./DialogCloseButton";
import { SECRET_IGNORE_ATTRS, secretInputSx, secretInputType } from "../utils/secretInput";
import { generatePassword } from "../utils/passwordGenerator";
import {
    changeMasterPassword,
    deleteEntry,
    listDecryptedEntries,
    recoverVault,
    saveEncryptedEntry,
    setupVault,
    unlockVault,
    vaultExists,
    type DecryptedEntry,
    type VaultSession,
    type VaultTransport,
} from "../utils/vaultSession";

export interface VaultDialogProps {
    open: boolean;
    onClose: () => void;
    /** 传输层：NavigationClient / MockNavigationClient 都满足 */
    client: VaultTransport;
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

type Phase = "loading" | "setup" | "locked" | "unlocked";

/** 空闲自动锁定（毫秒） */
const IDLE_MS = 5 * 60 * 1000;

interface Draft {
    id: number | null;
    title: string;
    username: string;
    password: string;
    url: string;
    notes: string;
}

const EMPTY_DRAFT: Draft = { id: null, title: "", username: "", password: "", url: "", notes: "" };

export default function VaultDialog({ open, onClose, client, onNotify }: VaultDialogProps) {
    const [phase, setPhase] = useState<Phase>("loading");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const sessionRef = useRef<VaultSession | null>(null);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [entries, setEntries] = useState<DecryptedEntry[]>([]);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [revealId, setRevealId] = useState<number | null>(null);

    // 建库 / 解锁 / 找回 表单
    const [masterPw, setMasterPw] = useState("");
    const [masterPw2, setMasterPw2] = useState("");
    const [recoverCode, setRecoverCode] = useState("");
    const [recoverNewPw, setRecoverNewPw] = useState("");
    const [showRecovery, setShowRecovery] = useState<string | null>(null);

    const lock = useCallback(() => {
        sessionRef.current = null; // 丢 DEK
        if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
        setPhase(prev => (prev === "unlocked" ? "locked" : prev));
        setEntries([]);
        setDraft(null);
        setRevealId(null);
        setMasterPw("");
    }, []);

    // 空闲计时：解锁态下，每次“活动”重摆
    const armIdle = useCallback(() => {
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => {
            onNotify?.("保险库已空闲自动锁定", "info");
            lock();
        }, IDLE_MS);
    }, [lock, onNotify]);

    // 打开时探一次有没有建过库
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setPhase("loading");
        setError("");
        vaultExists(client)
            .then(exists => { if (alive) setPhase(exists ? "locked" : "setup"); })
            .catch(() => { if (alive) { setError("读取保险库状态失败"); setPhase("locked"); } });
        return () => { alive = false; };
    }, [open, client]);

    // 关闭时清空一切（DEK 丢弃）
    useEffect(() => {
        if (open) return;
        sessionRef.current = null;
        if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
        setPhase("loading");
        setEntries([]); setDraft(null); setRevealId(null);
        setMasterPw(""); setMasterPw2(""); setRecoverCode(""); setRecoverNewPw(""); setShowRecovery(null); setError("");
    }, [open]);

    const refreshEntries = useCallback(async (session: VaultSession) => {
        setEntries(await listDecryptedEntries(client, session));
        armIdle();
    }, [client, armIdle]);

    async function doSetup() {
        setError("");
        if (masterPw.length < 8) { setError("主密码至少 8 位"); return; }
        if (masterPw !== masterPw2) { setError("两次输入的主密码不一致"); return; }
        setBusy(true);
        try {
            const { recoveryCode } = await setupVault(client, masterPw);
            setShowRecovery(recoveryCode); // 一次性展示
            const session = await unlockVault(client, masterPw);
            sessionRef.current = session;
            setPhase("unlocked");
            setEntries(await listDecryptedEntries(client, session));
            armIdle();
            setMasterPw(""); setMasterPw2("");
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建保险库失败");
        } finally {
            setBusy(false);
        }
    }

    async function doUnlock() {
        setError("");
        if (!masterPw) { setError("请输入主密码"); return; }
        setBusy(true);
        try {
            const session = await unlockVault(client, masterPw);
            sessionRef.current = session;
            setPhase("unlocked");
            setEntries(await listDecryptedEntries(client, session));
            armIdle();
            setMasterPw("");
        } catch {
            setError("主密码不正确");
        } finally {
            setBusy(false);
        }
    }

    async function doRecover() {
        setError("");
        if (recoverNewPw.length < 8) { setError("新主密码至少 8 位"); return; }
        setBusy(true);
        try {
            const session = await recoverVault(client, recoverCode, recoverNewPw);
            sessionRef.current = session;
            setPhase("unlocked");
            setEntries(await listDecryptedEntries(client, session));
            armIdle();
            setRecoverCode(""); setRecoverNewPw("");
            onNotify?.("已用恢复码重置主密码", "success");
        } catch {
            setError("恢复码不正确（注意区分大小写、可带可不带连字符）");
        } finally {
            setBusy(false);
        }
    }

    async function saveDraft() {
        const session = sessionRef.current;
        if (!session || !draft) return;
        if (!draft.title.trim()) { setError("条目标题不能为空"); return; }
        setBusy(true);
        try {
            await saveEncryptedEntry(client, session, {
                id: draft.id ?? undefined,
                title: draft.title.trim(),
                username: draft.username,
                password: draft.password,
                url: draft.url,
                notes: draft.notes,
            });
            setDraft(null);
            await refreshEntries(session);
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败");
        } finally {
            setBusy(false);
        }
    }

    async function removeEntry(id: number) {
        const session = sessionRef.current;
        if (!session) return;
        setBusy(true);
        try {
            await deleteEntry(client, id);
            await refreshEntries(session);
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除失败");
        } finally {
            setBusy(false);
        }
    }

    async function copyPassword(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            onNotify?.("已复制到剪贴板", "success");
        } catch {
            onNotify?.("复制失败", "error");
        }
    }

    const title =
        phase === "setup" ? "创建密码保险库" :
        phase === "unlocked" ? "密码保险库" : "解锁密码保险库";

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 6 }}>
                {phase === "unlocked" ? <LockOpenIcon fontSize='small' /> : <LockIcon fontSize='small' />}
                <Typography variant='h6' component='div' sx={{ fontWeight: 600, flex: 1 }}>{title}</Typography>
                <DialogCloseButton onClose={onClose} />
            </DialogTitle>
            <Divider />
            <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }} onPointerDown={armIdle} onKeyDown={armIdle}>
                    {error && <Alert severity='error' onClose={() => setError("")}>{error}</Alert>}

                    {phase === "loading" && (
                        <Stack direction='row' spacing={1} sx={{ py: 2, alignItems: "center" }}>
                            <CircularProgress size={18} />
                            <Typography variant='body2' color='text.secondary'>读取中…</Typography>
                        </Stack>
                    )}

                    {/* ---- 建库 ---- */}
                    {phase === "setup" && !showRecovery && (
                        <>
                            <Alert severity='info'>
                                设一个<b>独立于登录密码</b>的主密码。它只在你的浏览器里用来解密，服务端永远看不到，
                                也无法帮你找回——所以下一步会给你一份<b>恢复码</b>，务必妥善保存。
                            </Alert>
                            <TextField
                                fullWidth size='small' type='password' label='主密码（至少 8 位）'
                                value={masterPw} onChange={e => setMasterPw(e.target.value)}
                                autoComplete='new-password'
                            />
                            <TextField
                                fullWidth size='small' type='password' label='再输一次主密码'
                                value={masterPw2} onChange={e => setMasterPw2(e.target.value)}
                                autoComplete='new-password'
                            />
                            <Button variant='contained' onClick={doSetup} disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : <VpnKeyIcon />}>
                                创建保险库
                            </Button>
                        </>
                    )}

                    {/* ---- 恢复码一次性展示 ---- */}
                    {showRecovery && (
                        <>
                            <Alert severity='warning'>
                                这是你的<b>恢复码，只显示这一次</b>。忘了主密码时靠它找回。现在抄下来存到安全的地方，
                                关掉这个弹窗后就再也看不到了。
                            </Alert>
                            <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: "action.hover", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, letterSpacing: 1, wordBreak: "break-all" }}>
                                {showRecovery}
                            </Box>
                            <Button variant='contained' onClick={() => { copyPassword(showRecovery); setShowRecovery(null); }}>
                                我已保存，进入保险库
                            </Button>
                        </>
                    )}

                    {/* ---- 解锁 ---- */}
                    {phase === "locked" && (
                        <>
                            <TextField
                                fullWidth size='small' type='password' label='主密码'
                                value={masterPw} onChange={e => setMasterPw(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") doUnlock(); }}
                                autoComplete='current-password'
                            />
                            <Button variant='contained' onClick={doUnlock} disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : <LockOpenIcon />}>
                                解锁
                            </Button>
                            <Divider />
                            <Typography variant='caption' color='text.secondary'>忘了主密码？用恢复码重置（会设一个新主密码）：</Typography>
                            <TextField
                                fullWidth size='small' label='恢复码' value={recoverCode}
                                onChange={e => setRecoverCode(e.target.value)} placeholder='XXXXX-XXXXX-…'
                            />
                            <TextField
                                fullWidth size='small' type='password' label='新主密码（至少 8 位）'
                                value={recoverNewPw} onChange={e => setRecoverNewPw(e.target.value)}
                                autoComplete='new-password'
                            />
                            <Button variant='outlined' onClick={doRecover} disabled={busy}>
                                用恢复码重置并解锁
                            </Button>
                        </>
                    )}

                    {/* ---- 已解锁：条目管理 ---- */}
                    {phase === "unlocked" && !showRecovery && (
                        <>
                            <Stack direction='row' spacing={1} sx={{ alignItems: "center" }}>
                                <Chip size='small' color='success' icon={<LockOpenIcon />} label='已解锁' />
                                <Typography variant='caption' color='text.secondary'>空闲 5 分钟自动锁定</Typography>
                                <Box sx={{ flex: 1 }} />
                                <Button size='small' startIcon={<AddIcon />} onClick={() => { setDraft({ ...EMPTY_DRAFT }); setError(""); }}>
                                    新增条目
                                </Button>
                                <Button size='small' onClick={() => lock()}>立即锁定</Button>
                            </Stack>

                            {/* 编辑器 */}
                            {draft && (
                                <Box sx={{ p: 1.5, borderRadius: 1, border: theme => `1px solid ${theme.palette.divider}` }}>
                                    <Stack spacing={1.5}>
                                        <TextField fullWidth size='small' label='标题' value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
                                        <TextField fullWidth size='small' label='用户名' value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} autoComplete='off' />
                                        <TextField
                                            fullWidth size='small' label='密码' value={draft.password}
                                            onChange={e => setDraft({ ...draft, password: e.target.value })}
                                            name='vault-secret' autoComplete='off'
                                            type={secretInputType(revealId === -1)}
                                            sx={secretInputSx(revealId === -1)}
                                            slotProps={{
                                                input: {
                                                    endAdornment: (
                                                        <InputAdornment position='end'>
                                                            <Tooltip title='生成强密码'>
                                                                <IconButton size='small' aria-label='生成强密码' onClick={() => setDraft({ ...draft, password: generatePassword() })}>
                                                                    <AutorenewIcon fontSize='small' />
                                                                </IconButton>
                                                            </Tooltip>
                                                            <IconButton size='small' aria-label={revealId === -1 ? "隐藏密码" : "显示密码"} onClick={() => setRevealId(revealId === -1 ? null : -1)}>
                                                                {revealId === -1 ? <VisibilityOffIcon fontSize='small' /> : <VisibilityIcon fontSize='small' />}
                                                            </IconButton>
                                                        </InputAdornment>
                                                    ),
                                                },
                                                htmlInput: { ...SECRET_IGNORE_ATTRS },
                                            }}
                                        />
                                        <TextField fullWidth size='small' label='网址（可选）' value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} autoComplete='off' />
                                        <TextField fullWidth size='small' label='备注（可选）' multiline minRows={2} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} />
                                        <Stack direction='row' spacing={1}>
                                            <Button variant='contained' size='small' onClick={saveDraft} disabled={busy}>保存</Button>
                                            <Button size='small' onClick={() => setDraft(null)}>取消</Button>
                                        </Stack>
                                    </Stack>
                                </Box>
                            )}

                            {/* 列表 */}
                            {entries.length === 0 && !draft && (
                                <Typography variant='body2' color='text.secondary'>还没有条目，点“新增条目”开始。</Typography>
                            )}
                            <Stack spacing={1}>
                                {entries.map(e => (
                                    <Box key={e.id} sx={{ p: 1.25, borderRadius: 1, border: theme => `1px solid ${theme.palette.divider}` }}>
                                        <Stack direction='row' spacing={1} sx={{ alignItems: "center" }}>
                                            <Typography variant='subtitle2' sx={{ fontWeight: 700 }}>{e.title || "(未命名)"}</Typography>
                                            {e.username && <Typography variant='caption' color='text.secondary'>{e.username}</Typography>}
                                            <Box sx={{ flex: 1 }} />
                                            <IconButton size='small' aria-label='复制密码' onClick={() => copyPassword(e.password)}><ContentCopyIcon fontSize='small' /></IconButton>
                                            <IconButton size='small' aria-label='删除' onClick={() => removeEntry(e.id)}><DeleteIcon fontSize='small' /></IconButton>
                                        </Stack>
                                        <Stack direction='row' spacing={1} sx={{ mt: 0.5, alignItems: "center" }}>
                                            <Typography variant='body2' sx={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                                                {revealId === e.id ? e.password : "••••••••"}
                                            </Typography>
                                            <IconButton size='small' aria-label={revealId === e.id ? "隐藏密码" : "显示密码"} onClick={() => setRevealId(revealId === e.id ? null : e.id)}>
                                                {revealId === e.id ? <VisibilityOffIcon fontSize='small' /> : <VisibilityIcon fontSize='small' />}
                                            </IconButton>
                                            <Box sx={{ flex: 1 }} />
                                            <Button size='small' onClick={() => { setDraft({ id: e.id, title: e.title, username: e.username, password: e.password, url: e.url, notes: e.notes }); setError(""); }}>编辑</Button>
                                        </Stack>
                                        {e.url && <Typography variant='caption' color='text.secondary'>{e.url}</Typography>}
                                    </Box>
                                ))}
                            </Stack>
                        </>
                    )}
                </Stack>
            </DialogContent>
            {phase === "unlocked" && !showRecovery && (
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button size='small' onClick={async () => {
                        const session = sessionRef.current;
                        if (!session) return;
                        const np = window.prompt("输入新主密码（至少 8 位）：");
                        if (!np || np.length < 8) { onNotify?.("已取消或太短", "info"); return; }
                        setBusy(true);
                        try { await changeMasterPassword(client, session, np); onNotify?.("主密码已更新", "success"); }
                        catch (e) { onNotify?.(e instanceof Error ? e.message : "改密失败", "error"); }
                        finally { setBusy(false); }
                    }}>修改主密码</Button>
                </DialogActions>
            )}
        </Dialog>
    );
}
