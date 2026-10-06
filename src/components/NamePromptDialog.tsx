// src/components/NamePromptDialog.tsx
// 站内统一的「起个名字」弹窗：替代 window.prompt。
//
// 为什么不用 prompt()（2026-10-06 换掉它的原因）：
//   - 样式是系统级的，在毛玻璃界面里像「另一个世界」；
//   - 部分 WebView / 内嵌浏览器会直接拦掉，表现为「点了没反应」；
//   - 拿不到输入框焦点，无法预选文字、无法校验。
// 顺带把「新建子文件夹」这类需要父级上下文的地方也统一了 ——
// 之前子文件夹是另一条 prompt 分支，行为和主入口不一致。
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    TextField,
    Box,
    IconButton,
    Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "./dialogShell";

export interface NamePromptDialogProps {
    open: boolean;
    title: string;
    /** 输入框上方的说明，默认不显示 */
    description?: string;
    /** 预填内容（重命名时用） */
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    /** 回车提交 */
    onConfirm: (name: string) => void | Promise<void>;
    onClose: () => void;
}

export default function NamePromptDialog({
    open,
    title,
    description,
    defaultValue = "",
    placeholder,
    confirmText = "确定",
    onConfirm,
    onClose,
}: NamePromptDialogProps) {
    const [value, setValue] = useState(defaultValue);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 每次打开都重置成这次的初始值：连着重命名两个文件夹时
    // 不能带着上一个的名字（那样第二次直接就「确认」了错的）
    useEffect(() => {
        if (open) {
            setValue(defaultValue);
            busyRef.current = false;
            setBusy(false);
        }
    }, [open, defaultValue]);

    // 打开后聚焦并全选，省一次鼠标 —— 也让键盘用户直接能改
    useEffect(() => {
        if (!open) return;
        const id = window.setTimeout(() => inputRef.current?.select(), 0);
        return () => window.clearTimeout(id);
    }, [open]);

    const submit = useCallback(async () => {
        const name = value.trim();
        if (!name || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        try {
            await onConfirm(name);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }, [value, onConfirm]);

    return (
        <Dialog
            open={open}
            onClose={(event, reason) => {
                void event;
                if (busyRef.current) return;
                if (reason === "backdropClick" || reason === "escapeKeyDown") onClose();
            }}
            maxWidth='xs'
            fullWidth
            className='nav-name-prompt'
            slotProps={{ paper: { className: "nav-name-prompt-dialog", sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx} component='h2'>
                {title}
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        onClick={onClose}
                        disabled={busy}
                        aria-label='关闭弹窗'
                        sx={{ position: "absolute", right: 10, top: 10 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>
            <DialogContent sx={dialogContentSx}>
                {description && (
                    <Box sx={{ fontSize: 13, color: 'text.secondary', mb: 1.5, lineHeight: 1.7 }}>
                        {description}
                    </Box>
                )}
                <TextField
                    inputRef={inputRef}
                    autoFocus
                    fullWidth
                    size='small'
                    value={value}
                    placeholder={placeholder}
                    data-name-prompt-input=''
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void submit();
                        }
                    }}
                    slotProps={{ htmlInput: { 'aria-label': title, maxLength: 80 } }}
                />
            </DialogContent>
            <DialogActions sx={dialogActionsSx}>
                <Button onClick={onClose} variant='outlined' color='inherit' size='small' disabled={busy}>
                    取消
                </Button>
                <Button
                    onClick={() => void submit()}
                    variant='contained'
                    size='small'
                    disableElevation
                    disabled={busy || !value.trim()}
                >
                    {busy ? '处理中…' : confirmText}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
