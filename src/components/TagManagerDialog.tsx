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
    TextField,
    MenuItem,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import MergeTypeIcon from "@mui/icons-material/MergeType";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import LabelIcon from "@mui/icons-material/Label";
import ConfirmDialog from "./ConfirmDialog";
import { dialogActionsSx, dialogContentSx, dialogPaperSx, dialogTitleSx } from "./dialogShell";

interface TagManagerDialogProps {
    open: boolean;
    /** 全部标签名（已按使用次数从多到少排序） */
    tags: string[];
    /** 每个标签被多少张卡片使用 */
    counts: Record<string, number>;
    /** 删除某个标签（把该标签从所有卡片上摘掉） */
    onDeleteTag: (tag: string) => void;
    /** 重命名：from 改成 to（to 已存在时等于合并） */
    onRenameTag?: (from: string, to: string) => void;
    /** 合并：把 sources 里的标签全部并到 target 名下 */
    onMergeTags?: (sources: string[], target: string) => void;
    /** 用 AI 给存量站点建议标签（不传就不显示这个入口） */
    onAiSuggest?: () => void;
    onClose: () => void;
}

export default function TagManagerDialog({
    open,
    tags,
    counts,
    onDeleteTag,
    onRenameTag,
    onMergeTags,
    onAiSuggest,
    onClose,
}: TagManagerDialogProps) {
    // 待确认删除的标签名；非 null 时显示确认弹窗
    const [pending, setPending] = useState<string | null>(null);
    // 重命名：正在改哪个标签 + 输入框里的新名字
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameTo, setRenameTo] = useState("");
    // 合并：源标签 + 目标标签
    const [merging, setMerging] = useState<string | null>(null);
    const [mergeTarget, setMergeTarget] = useState("");

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
                    {onAiSuggest ? (
                        <Button
                            size='small'
                            variant='outlined'
                            startIcon={<AutoAwesomeIcon />}
                            onClick={onAiSuggest}
                            sx={{ mb: 1.5 }}
                        >
                            用 AI 整理标签
                        </Button>
                    ) : null}
                    {tags.length === 0 ? (
                        <Typography
                            variant='body2'
                            sx={{
                                color: 'text.secondary',
                                py: 2,
                                textAlign: "center"
                            }}>
                            还没有任何标签
                        </Typography>
                    ) : (
                        <>
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    display: 'block',
                                    mb: 1.25
                                }}>
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
                                            sx={{
                                                color: 'text.secondary',
                                                flex: 1
                                            }}>
                                            {counts[tag] ?? 0} 个网站
                                        </Typography>
                                        {onRenameTag && (
                                            <Tooltip title='重命名这个标签'>
                                                <IconButton
                                                    size='small'
                                                    className='nav-tag-manager-rename'
                                                    aria-label={`重命名标签 ${tag}`}
                                                    onClick={() => {
                                                        setRenaming(tag);
                                                        setRenameTo(tag);
                                                    }}
                                                >
                                                    <EditIcon fontSize='small' />
                                                </IconButton>
                                            </Tooltip>
                                        )}
                                        {onMergeTags && tags.length > 1 && (
                                            <Tooltip title='合并到另一个标签'>
                                                <IconButton
                                                    size='small'
                                                    className='nav-tag-manager-merge'
                                                    aria-label={`合并标签 ${tag}`}
                                                    onClick={() => {
                                                        setMerging(tag);
                                                        setMergeTarget(
                                                            tags.find(t => t !== tag) ?? ""
                                                        );
                                                    }}
                                                >
                                                    <MergeTypeIcon fontSize='small' />
                                                </IconButton>
                                            </Tooltip>
                                        )}
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
                    impact={{
                        object: "网站",
                        count: pending ? counts[pending] ?? 0 : 0,
                        undoable: true,
                    }}
                    onConfirm={() => {
                        if (pending) onDeleteTag(pending);
                        setPending(null);
                    }}
                    onClose={() => setPending(null)}
                />

                {/* 重命名：改一个标签等于改几十张卡片，所以要说清影响面，
                    新名字撞上已有标签时明确写成「合并」而不是「改名」 */}
                <Dialog
                    open={renaming !== null}
                    onClose={() => setRenaming(null)}
                    maxWidth='xs'
                    fullWidth
                    className='nav-tag-rename-dialog'
                    slotProps={{ paper: { sx: dialogPaperSx } }}
                >
                    <DialogTitle sx={dialogTitleSx}>重命名标签</DialogTitle>
                    <DialogContent sx={dialogContentSx}>
                        <TextField
                            autoFocus
                            size='small'
                            fullWidth
                            label='新的标签名'
                            value={renameTo}
                            onChange={e => setRenameTo(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter" && renameTo.trim()) {
                                    e.preventDefault();
                                    onRenameTag?.(renaming!, renameTo);
                                    setRenaming(null);
                                }
                            }}
                            sx={{ mt: 0.5 }}
                        />
                        {renaming && (
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    display: "block",
                                    mt: 1
                                }}>
                                「{renaming}」现在用于 {counts[renaming] ?? 0} 个网站，改名后这些卡片一起变。
                                {renameTo.trim() &&
                                renameTo.trim() !== renaming &&
                                tags.includes(renameTo.trim())
                                    ? ` 「${renameTo.trim()}」已经有 ${
                                          counts[renameTo.trim()] ?? 0
                                      } 个网站在用了，这次操作等于把两个标签合并。`
                                    : ""}
                            </Typography>
                        )}
                    </DialogContent>
                    <DialogActions sx={dialogActionsSx}>
                        <Button size='small' variant='outlined' color='inherit' onClick={() => setRenaming(null)}>
                            取消
                        </Button>
                        <Button
                            size='small'
                            variant='contained'
                            className='nav-tag-rename-submit'
                            disabled={!renameTo.trim()}
                            onClick={() => {
                                if (renaming) onRenameTag?.(renaming, renameTo);
                                setRenaming(null);
                            }}
                        >
                            确定
                        </Button>
                    </DialogActions>
                </Dialog>

                {/* 合并：选一个目标标签，源标签从此消失 */}
                <Dialog
                    open={merging !== null}
                    onClose={() => setMerging(null)}
                    maxWidth='xs'
                    fullWidth
                    className='nav-tag-merge-dialog'
                    slotProps={{ paper: { sx: dialogPaperSx } }}
                >
                    <DialogTitle sx={dialogTitleSx}>合并标签</DialogTitle>
                    <DialogContent sx={dialogContentSx}>
                        <TextField
                            select
                            size='small'
                            fullWidth
                            label='合并到'
                            value={mergeTarget}
                            onChange={e => setMergeTarget(e.target.value)}
                            sx={{ mt: 0.5 }}
                        >
                            {tags
                                .filter(t => t !== merging)
                                .map(t => (
                                    <MenuItem key={t} value={t}>
                                        {t}（{counts[t] ?? 0} 个网站）
                                    </MenuItem>
                                ))}
                        </TextField>
                        {merging && (
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    display: "block",
                                    mt: 1
                                }}>
                                「{merging}」的 {counts[merging] ?? 0} 个网站会改用「
                                {mergeTarget || "…"}」，「{merging}」不再存在。
                            </Typography>
                        )}
                    </DialogContent>
                    <DialogActions sx={dialogActionsSx}>
                        <Button size='small' variant='outlined' color='inherit' onClick={() => setMerging(null)}>
                            取消
                        </Button>
                        <Button
                            size='small'
                            variant='contained'
                            className='nav-tag-merge-submit'
                            disabled={!mergeTarget.trim() || mergeTarget === merging}
                            onClick={() => {
                                if (merging) onMergeTags?.([merging], mergeTarget);
                                setMerging(null);
                            }}
                        >
                            合并
                        </Button>
                    </DialogActions>
                </Dialog>
            </Dialog>
        </>
    );
}
