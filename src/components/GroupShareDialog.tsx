// src/components/GroupShareDialog.tsx
// 分组分享对话框（2026-10-11 阶段④）：创建/更新设置/撤销/复制链接。
// 语义与 NoteShareDialog 一致：创建会轮换令牌（旧链接失效），
// 「更新设置」保留链接只改有效期与口令。
import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ConfirmDialog from "./ConfirmDialog";
import type { GroupShareConfig } from "../API/types";

export interface GroupShareDialogProps {
    open: boolean;
    groupId: number;
    groupName: string;
    onClose: () => void;
    api: {
        createGroupShare(id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null>;
        updateGroupShare(id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null>;
        revokeGroupShare(id: number): Promise<{ success: boolean }>;
        getGroupShareConfig(id: number): Promise<GroupShareConfig | null>;
    };
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

type Days = 1 | 7 | 30 | null;

export default function GroupShareDialog({
    open,
    groupId,
    groupName,
    onClose,
    api,
    onNotify,
}: GroupShareDialogProps) {
    const [config, setConfig] = useState<GroupShareConfig | null>(null);
    const [days, setDays] = useState<Days>(7);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [loadedOnce, setLoadedOnce] = useState(false);
    /** 撤销前确认（站内 ConfirmDialog，替代 window.confirm：jsdom 可测、观感与整站一致） */
    const [revokeConfirm, setRevokeConfirm] = useState(false);

    const refresh = useCallback(async () => {
        // ⚠️ setLoadedOnce(true) 必须在 **finally** 里：放在 await 之后的话，
        // getGroupShareConfig 一抛错就永远执行不到 —— 界面卡在「读取中…」，
        // 用户只看到一条错误提示，弹窗里却没有任何可点的东西（连创建按钮都没有）。
        // 这条是 tests/groupShareDialog.dom.test.tsx 的「读配置失败要提示，
        // 且不能卡在读取中」钉住的。
        try {
            const current = await api.getGroupShareConfig(groupId);
            setConfig(current);
            if (current) {
                setDays(current.expires_at === null ? null : ((current.expires_at - Date.now() > 3 * 86_400_000 ? 30 : 7) as Days));
            }
        } finally {
            setLoadedOnce(true);
        }
    }, [api, groupId]);

    useEffect(() => {
        if (!open) return;
        setConfig(null);
        setPassword("");
        setLoadedOnce(false);
        void refresh().catch(error => {
            onNotify?.("读取分享配置失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        });
    }, [open, refresh, onNotify]);

    const shareUrl = config ? `${location.origin}/sg/${config.token}` : "";

    const create = async () => {
        setBusy(true);
        try {
            const next = await api.createGroupShare(groupId, days, password || null);
            if (next) {
                setConfig(next);
                onNotify?.("分享已创建：链接立即生效，旧链接已轮换失效", "success");
            } else {
                onNotify?.("创建失败：分组不存在", "error");
            }
        } catch (error) {
            onNotify?.("创建失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBusy(false);
        }
    };

    const update = async () => {
        setBusy(true);
        try {
            const next = await api.updateGroupShare(groupId, days, password === "" ? undefined : password || null);
            if (next) {
                setConfig(next);
                onNotify?.("分享设置已更新（链接不变）", "success");
            } else {
                onNotify?.("更新失败：分享不存在", "error");
            }
        } catch (error) {
            onNotify?.("更新失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBusy(false);
        }
    };

    const revoke = async () => {
        setBusy(true);
        try {
            await api.revokeGroupShare(groupId);
            setConfig(null);
            onNotify?.("分享已撤销", "success");
        } catch (error) {
            onNotify?.("撤销失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth='xs'>
            <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
                <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600 }}>
                    分享分组「{groupName}」
                </Typography>
                <IconButton size='small' aria-label='关闭' onClick={onClose}>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>
            <Box sx={{ px: 3, pb: 3 }} data-group-share='1'>
                {!loadedOnce ? (
                    <Typography variant='body2' color='text.secondary'>
                        读取中…
                    </Typography>
                ) : config ? (
                    <>
                        <Typography variant='body2' sx={{ mb: 1 }}>
                            链接已生效（浏览 {config.views} 次{config.hasPassword ? " · 受口令保护" : ""}）：
                        </Typography>
                        <TextField
                            fullWidth
                            size='small'
                            value={shareUrl}
                            data-group-share-link='1'
                            slotProps={{ input: { "aria-label": "分享链接", readOnly: true } as never }}
                            onClick={e => (e.target as HTMLInputElement).select()}
                            sx={{ mb: 1.5 }}
                        />
                        <Button
                            size='small'
                            data-group-share-copy='1'
                            onClick={() => {
                                void navigator.clipboard?.writeText(shareUrl).then(
                                    () => onNotify?.("链接已复制", "success"),
                                    () => onNotify?.("复制失败，请手动选择复制", "error")
                                );
                            }}
                        >
                            复制链接
                        </Button>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 2 }}>
                            <Select
                                size='small'
                                value={days === null ? "forever" : String(days)}
                                onChange={e => setDays(e.target.value === "forever" ? null : (Number(e.target.value) as Days))}
                                slotProps={{ input: { "aria-label": "有效期" } }}
                                sx={{ minWidth: 110 }}
                            >
                                <MenuItem value='1'>1 天</MenuItem>
                                <MenuItem value='7'>7 天</MenuItem>
                                <MenuItem value='30'>30 天</MenuItem>
                                <MenuItem value='forever'>永久</MenuItem>
                            </Select>
                            <TextField
                                size='small'
                                type='password'
                                label='访问口令（留空=不改）'
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                slotProps={{ input: { "aria-label": "访问口令" } }}
                                sx={{ flex: 1 }}
                            />
                        </Box>
                        <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
                            <Button variant='contained' data-group-share-update='1' disabled={busy} onClick={() => void update()}>
                                更新设置
                            </Button>
                            <Button color='error' data-group-share-revoke='1' disabled={busy} onClick={() => setRevokeConfirm(true)}>
                                撤销分享
                            </Button>
                        </Box>
                    </>
                ) : (
                    <>
                        <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                            创建一个只读公开页：访问者能看到组内卡片的名称、链接与描述（不含站点密码），不能修改任何内容。
                        </Typography>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                            <Select
                                size='small'
                                value={days === null ? "forever" : String(days)}
                                onChange={e => setDays(e.target.value === "forever" ? null : (Number(e.target.value) as Days))}
                                slotProps={{ input: { "aria-label": "有效期" } }}
                                sx={{ minWidth: 110 }}
                            >
                                <MenuItem value='1'>1 天</MenuItem>
                                <MenuItem value='7'>7 天</MenuItem>
                                <MenuItem value='30'>30 天</MenuItem>
                                <MenuItem value='forever'>永久</MenuItem>
                            </Select>
                            <TextField
                                size='small'
                                type='password'
                                label='访问口令（可选）'
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                slotProps={{ input: { "aria-label": "访问口令" } }}
                                sx={{ flex: 1 }}
                            />
                        </Box>
                        <Button variant='contained' data-group-share-create='1' disabled={busy} onClick={() => void create()}>
                            创建分享链接
                        </Button>
                    </>
                )}
            </Box>
            {/* 撤销确认：叠在分享对话框上层（MUI Dialog 嵌套天然支持） */}
            <ConfirmDialog
                open={revokeConfirm}
                title="撤销分享"
                description={`「${groupName}」的公开链接将立即失效，已拿到链接的人也打不开了（撤销后可重新创建，但链接会换新的）。`}
                impact={{ object: "分组分享", undoable: false }}
                confirmText="撤销"
                danger
                onConfirm={() => {
                    setRevokeConfirm(false);
                    void revoke();
                }}
                onClose={() => setRevokeConfirm(false)}
            />
        </Dialog>
    );
}
