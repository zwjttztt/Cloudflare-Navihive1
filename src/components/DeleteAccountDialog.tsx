// src/components/DeleteAccountDialog.tsx
// 注销账号的二次确认弹窗（「账号与安全 → 注销当前账号」触发）。
// 之所以单独做一个而不是复用 ConfirmDialog：注销要求再输一次当前密码。
// 只凭「当前是登录状态」就允许注销，等于捡到一台已登录的电脑就能毁掉整个账号。
//
// ⚠️ 角色门控（2026-10-17 用户要求）：这个功能**只给普通账号**——站点所有者本人
// 不提供注销入口（App 只在 role !== "owner" 时传 onDeleteAccount），后端
// deleteAccount 对 owner 也一律拒绝。两层都挡：只藏入口的话，脚本照样能调 API
// 把站点唯一的 owner 删掉，站点就成了没人能管的孤儿。
import { Dialog, DialogActions, DialogContent, DialogTitle, Button, Typography, Alert } from "@mui/material";
import { PasswordField } from "./PasswordField";
import DialogCloseButton from "./DialogCloseButton";

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
            {/* pr 给右上角那枚 × 让位；注销提交中禁用，免得「点关闭」和「正在提交」打架 */}
            <DialogTitle sx={{ pb: 1, pr: 5 }}>
                注销账号
                <DialogCloseButton onClose={onClose} label='关闭注销弹窗' disabled={busy} />
            </DialogTitle>
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
                        if (e.key === "Enter" && !busy && password.trim()) onConfirm();
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
                    // 只填空格不算填过：密码校验在后端，但这里放行的话用户会以为
                    // 「按钮亮了就是填对了」，然后被一个 400 打回来
                    disabled={busy || !password.trim()}
                >
                    {busy ? "注销中…" : "确认注销"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
