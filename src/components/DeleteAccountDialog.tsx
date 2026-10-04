// src/components/DeleteAccountDialog.tsx
// 注销账号的二次确认弹窗（「更多选项 → 注销账号」触发）。
// 之所以单独做一个而不是复用 ConfirmDialog：注销要求再输一次当前密码。
// 只凭「当前是登录状态」就允许注销，等于捡到一台已登录的电脑就能毁掉整个账号。
import { Dialog, DialogActions, DialogContent, DialogTitle, Button, Typography, Alert } from "@mui/material";
import { PasswordField } from "./PasswordField";

interface DeleteAccountDialogProps {
    open: boolean;
    /** 当前账号名，用来提示「你要注销的是 xxx」 */
    username?: string;
    busy?: boolean;
    password: string;
    onPasswordChange: (value: string) => void;
    onConfirm: () => void;
    onClose: () => void;
}

export default function DeleteAccountDialog({
    open,
    username,
    busy = false,
    password,
    onPasswordChange,
    onConfirm,
    onClose,
}: DeleteAccountDialogProps) {
    return (
        <Dialog
            open={open}
            onClose={() => (busy ? undefined : onClose())}
            maxWidth='xs'
            fullWidth
        >
            <DialogTitle sx={{ pb: 1 }}>注销账号</DialogTitle>
            <DialogContent>
                <Alert severity='warning' sx={{ mb: 2 }}>
                    注销后，这个账号的<strong>全部分组、卡片与保存的账号密码都会被删除</strong>，
                    且无法恢复。此操作不可撤销。
                </Alert>
                <Typography
                    variant='body2'
                    sx={{
                        color: 'text.secondary',
                        mb: 1.5
                    }}>
                    {username ? `当前账号：${username}。` : ""}
                    请先用「更多选项 → 数据备份」保存一份备份，再输入当前密码确认注销。
                </Typography>
                <PasswordField
                    autoFocus
                    id='delete-account-password'
                    label='当前密码'
                    value={password}
                    onChange={e => onPasswordChange(e.target.value)}
                    disabled={busy}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !busy && password) onConfirm();
                    }}
                />
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={onClose} variant='outlined' disabled={busy}>
                    取消
                </Button>
                <Button
                    onClick={onConfirm}
                    variant='contained'
                    color='error'
                    disabled={busy || !password}
                >
                    {busy ? "注销中…" : "确认注销"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
