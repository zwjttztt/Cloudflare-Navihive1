// src/components/NotesShortcutsDialog.tsx
// 记事本的「键盘快捷键」弹窗。
//
// 从 NotesPage.tsx 抽出来（2026-10-20 拆分第一期）：那个文件 6675 行，
// 而这个弹窗只依赖 EDITOR_SHORTCUTS 和 Kbd，跟父组件的状态毫无关系 ——
// 典型的「占了父文件十几行、却要跟着它一起被 typecheck / review」。
// 抽走之后父组件少一块 JSX，这里多一个能单独看的文件。
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { Kbd } from "./Kbd";
import { EDITOR_SHORTCUTS } from "../utils/editorShortcuts";

export interface NotesShortcutsDialogProps {
    open: boolean;
    onClose: () => void;
}

export default function NotesShortcutsDialog({ open, onClose }: NotesShortcutsDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth='sm'>
            <DialogTitle>键盘快捷键</DialogTitle>
            <DialogContent>
                <Typography>Ctrl / ⌘ K：编辑器内插入链接，编辑器外打开命令面板</Typography>
                <Typography>Ctrl / ⌘ S：保存当前笔记</Typography>
                {EDITOR_SHORTCUTS.filter(shortcut => shortcut.combo).map(shortcut => (
                    <Box key={shortcut.id} sx={{ display: "flex", justifyContent: "space-between", gap: 2, py: 0.5 }}>
                        <Typography>{shortcut.label}</Typography><Kbd combo={shortcut.combo!} />
                    </Box>
                ))}
            </DialogContent>
            <DialogActions><Button onClick={onClose}>关闭</Button></DialogActions>
        </Dialog>
    );
}
