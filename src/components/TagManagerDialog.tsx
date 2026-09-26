// src/components/TagManagerDialog.tsx
// 标签管理：集中列出本机用过的所有标签，删除某个标签 = 所有卡片都不再带它。
// 删除前先确认（删除会波及多张卡片），删除后由调用方给一条带「撤销」的提示条。
import { useState } from "react";
import {
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Stack,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LabelIcon from "@mui/icons-material/Label";
import ConfirmDialog from "./ConfirmDialog";

interface TagManagerDialogProps {
    open: boolean;
    /** 全部标签名（已按使用次数从多到少排序） */
    tags: string[];
    /** 每个标签被多少张卡片使用 */
    counts: Record<string, number>;
    /** 删除某个标签（把该标签从所有卡片上摘掉） */
    onDeleteTag: (tag: string) => void;
    onClose: () => void;
}

export default function TagManagerDialog({
    open,
    tags,
    counts,
    onDeleteTag,
    onClose,
}: TagManagerDialogProps) {
    // 待确认删除的标签名；非 null 时显示确认弹窗
    const [pending, setPending] = useState<string | null>(null);

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                maxWidth='xs'
                fullWidth
                className='nav-tag-manager-dialog'
            >
                <DialogTitle
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        pr: 5,
                        py: 1.5,
                        fontSize: 17,
                        fontWeight: 600,
                    }}
                >
                    <Box
                        sx={{
                            width: 30,
                            height: 30,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: "10px",
                            color: "primary.main",
                            bgcolor: theme =>
                                theme.palette.mode === "dark"
                                    ? "rgba(255,255,255,0.08)"
                                    : "rgba(15,23,42,0.05)",
                        }}
                    >
                        <LabelIcon fontSize='small' />
                    </Box>
                    标签管理
                    <Tooltip title='关闭'>
                        <IconButton
                            size='small'
                            onClick={onClose}
                            aria-label='关闭标签管理'
                            sx={{ position: "absolute", right: 10, top: 10 }}
                        >
                            <CloseIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
                </DialogTitle>

                <DialogContent sx={{ pt: 0, pb: 1 }}>
                    {tags.length === 0 ? (
                        <Typography
                            variant='body2'
                            color='text.secondary'
                            sx={{ py: 2, textAlign: "center" }}
                        >
                            还没有任何标签
                        </Typography>
                    ) : (
                        <>
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                display='block'
                                sx={{ mb: 1.25 }}
                            >
                                删除一个标签，会把它从所有卡片上移除（删除后可在提示条里撤销）。
                            </Typography>
                            <Stack spacing={0.75} className='nav-tag-manager-list'>
                                {tags.map(tag => (
                                    <Box
                                        key={tag}
                                        className='nav-tag-manager-row'
                                        data-tag={tag}
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 1,
                                            px: 1,
                                            py: 0.5,
                                            borderRadius: "10px",
                                            border: "1px solid var(--glass-panel-border)",
                                            bgcolor: "action.hover",
                                        }}
                                    >
                                        <Chip
                                            label={tag}
                                            size='small'
                                            variant='outlined'
                                            className='nav-tag-manager-chip'
                                        />
                                        <Typography
                                            variant='caption'
                                            color='text.secondary'
                                            sx={{ flex: 1 }}
                                        >
                                            {counts[tag] ?? 0} 个网站
                                        </Typography>
                                        <Tooltip title='删除这个标签'>
                                            <IconButton
                                                size='small'
                                                color='error'
                                                className='nav-tag-manager-del'
                                                aria-label={`删除标签 ${tag}`}
                                                onClick={() => setPending(tag)}
                                            >
                                                <DeleteOutlineIcon fontSize='small' />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                ))}
                            </Stack>
                        </>
                    )}
                </DialogContent>

                <DialogActions sx={{ px: 2, pb: 2, pt: 0.5 }}>
                    <Button size='small' variant='outlined' color='inherit' onClick={onClose}>
                        关闭
                    </Button>
                </DialogActions>

                <ConfirmDialog
                    open={pending !== null}
                    title='删除这个标签？'
                    description={`「${pending ?? ""}」会从所有卡片上移除（共 ${
                        pending ? counts[pending] ?? 0 : 0
                    } 个网站）。删除后可用提示条上的「撤销」找回。`}
                    confirmText='删除'
                    danger
                    onConfirm={() => {
                        if (pending) onDeleteTag(pending);
                        setPending(null);
                    }}
                    onClose={() => setPending(null)}
                />
            </Dialog>
        </>
    );
}
