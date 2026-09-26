// src/components/BulkActionBar.tsx
// 批量多选模式的操作条：底部居中浮出，对勾出来的卡片做删除 / 星标 / 标签 / 移动分组。
import { useEffect, useRef, useState } from "react";
import {
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    Menu,
    MenuItem,
    ListItemIcon,
    ListItemText,
    TextField,
    Typography,
} from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LabelIcon from "@mui/icons-material/Label";
import DriveFileMoveIcon from "@mui/icons-material/DriveFileMove";
import CloseIcon from "@mui/icons-material/Close";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";

export interface BulkGroupOption {
    id: number;
    name: string;
}

interface BulkActionBarProps {
    /** 已勾选的卡片数量 */
    count: number;
    groups: BulkGroupOption[];
    allTags: string[];
    onStar: (starred: boolean) => void;
    onTag: (tags: string[]) => void;
    onMove: (groupId: number) => void;
    onDelete: () => void;
    /** 清空勾选（仍留在多选模式） */
    onClearSelection: () => void;
    /** 退出多选模式 */
    onExit: () => void;
}

export default function BulkActionBar({
    count,
    groups,
    allTags,
    onStar,
    onTag,
    onMove,
    onDelete,
    onClearSelection,
    onExit,
}: BulkActionBarProps) {
    // 打标签的小弹窗
    const [tagOpen, setTagOpen] = useState(false);
    const [tagInput, setTagInput] = useState("");
    const [pickedTags, setPickedTags] = useState<string[]>([]);
    // 移动到分组的菜单
    const [moveAnchor, setMoveAnchor] = useState<HTMLElement | null>(null);
    // 提交类操作防连点：同步守卫 + 按钮禁用双保险
    const taggingRef = useRef(false);
    const [tagging, setTagging] = useState(false);

    const openTagDialog = () => {
        setPickedTags([]);
        setTagInput("");
        setTagOpen(true);
    };

    // 弹窗里勾选/取消已有标签
    const togglePicked = (tag: string) => {
        setPickedTags(prev =>
            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
        );
    };

    // 确认打标签：输入框里用逗号或空格分开，多个标签一次加上
    const submitTags = () => {
        if (taggingRef.current) return;
        const typed = tagInput
            .split(/[,，\s]+/)
            .map(t => t.trim())
            .filter(Boolean);
        const merged = Array.from(new Set([...pickedTags, ...typed]));
        if (merged.length === 0) {
            setTagOpen(false);
            return;
        }
        taggingRef.current = true;
        setTagging(true);
        onTag(merged);
        taggingRef.current = false;
        setTagging(false);
        setTagOpen(false);
    };

    // Esc 退出多选模式（输入框里打字时不拦）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const typing =
                !!target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable);
            if (typing) return;
            if (e.key === "Escape") onExit();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onExit]);

    return (
        <>
            <Box
                className='nav-bulk-bar'
                role='toolbar'
                aria-label='批量操作'
                sx={{
                    position: "fixed",
                    left: "50%",
                    bottom: { xs: 64, md: 20 },
                    transform: "translateX(-50%)",
                    zIndex: (t) => t.zIndex.appBar + 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    flexWrap: "wrap",
                    justifyContent: "center",
                    maxWidth: "calc(100vw - 24px)",
                    px: 1.5,
                    py: 1,
                    borderRadius: "16px",
                    bgcolor: "var(--glass-bg-hover)",
                    border: "1px solid var(--glass-border)",
                    backdropFilter: "blur(14px) saturate(1.5)",
                    WebkitBackdropFilter: "blur(14px) saturate(1.5)",
                    boxShadow: "var(--glass-shadow-hover)",
                }}
            >
                <Typography
                    variant='body2'
                    fontWeight={700}
                    sx={{ whiteSpace: "nowrap", px: 0.5 }}
                >
                    已选 {count} 个
                </Typography>

                <Divider orientation='vertical' flexItem sx={{ mx: 0.25 }} />

                <Button
                    size='small'
                    startIcon={<StarIcon />}
                    onClick={() => onStar(true)}
                    className='nav-bulk-star'
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    加星标
                </Button>
                <Button
                    size='small'
                    color='inherit'
                    startIcon={<StarBorderIcon />}
                    onClick={() => onStar(false)}
                    className='nav-bulk-unstar'
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    取消星标
                </Button>
                <Button
                    size='small'
                    color='inherit'
                    startIcon={<LabelIcon />}
                    onClick={openTagDialog}
                    className='nav-bulk-tag'
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    打标签
                </Button>
                <Button
                    size='small'
                    color='inherit'
                    startIcon={<DriveFileMoveIcon />}
                    onClick={e => setMoveAnchor(e.currentTarget)}
                    className='nav-bulk-move'
                    aria-haspopup='true'
                    aria-expanded={Boolean(moveAnchor)}
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    移动分组
                </Button>

                <Divider orientation='vertical' flexItem sx={{ mx: 0.25 }} />

                <Button
                    size='small'
                    color='error'
                    startIcon={<DeleteOutlineIcon />}
                    onClick={onDelete}
                    className='nav-bulk-delete'
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    删除
                </Button>

                <Divider orientation='vertical' flexItem sx={{ mx: 0.25 }} />

                <Button
                    size='small'
                    color='inherit'
                    onClick={onClearSelection}
                    className='nav-bulk-clear'
                    startIcon={<RadioButtonUncheckedIcon />}
                    sx={{ minWidth: "auto", whiteSpace: "nowrap" }}
                >
                    清空
                </Button>
                <IconButton
                    size='small'
                    onClick={onExit}
                    aria-label='退出多选模式'
                    className='nav-bulk-exit'
                >
                    <CloseIcon fontSize='small' />
                </IconButton>
            </Box>

            {/* 移动到哪个分组 */}
            <Menu
                anchorEl={moveAnchor}
                open={Boolean(moveAnchor)}
                onClose={() => setMoveAnchor(null)}
                slotProps={{ paper: { sx: { minWidth: 180, borderRadius: "14px" } } }}
            >
                {groups.map(group => (
                    <MenuItem
                        key={group.id}
                        onClick={() => {
                            setMoveAnchor(null);
                            onMove(group.id);
                        }}
                    >
                        <ListItemIcon>
                            <DriveFileMoveIcon fontSize='small' />
                        </ListItemIcon>
                        <ListItemText>{group.name}</ListItemText>
                    </MenuItem>
                ))}
            </Menu>

            {/* 打标签：可以勾选已有标签，也可以直接输入新的（逗号分隔） */}
            <Dialog
                open={tagOpen}
                onClose={() => setTagOpen(false)}
                maxWidth='xs'
                fullWidth
                className='nav-tag-dialog'
                slotProps={{
                    paper: {
                        sx: {
                            borderRadius: "var(--card-radius)",
                            p: 0.5,
                            backgroundColor: theme =>
                                theme.palette.mode === "dark"
                                    ? "rgba(23,27,38,0.94)"
                                    : "rgba(255,255,255,0.94)",
                            backdropFilter: "blur(var(--glass-blur))",
                            WebkitBackdropFilter: "blur(var(--glass-blur))",
                        },
                    },
                }}
            >
                <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pb: 0.5 }}>
                    给 {count} 个网站打标签
                </DialogTitle>
                <DialogContent sx={{ pt: 0 }}>
                    {/* MUI 会把「标题 + 内容」相邻时的内容区上内边距归零，
                        浮起的 label 需要往上探出约 9px，这里补一层上内边距免得被裁 */}
                    <Box sx={{ pt: 1.5 }}>
                        <TextField
                            autoFocus
                            size='small'
                            fullWidth
                            label='标签（逗号分隔可一次加多个）'
                            value={tagInput}
                            onChange={e => setTagInput(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    submitTags();
                                }
                            }}
                        />
                        {allTags.length > 0 && (
                            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 1.5 }}>
                                {allTags.map(tag => {
                                    const picked = pickedTags.includes(tag);
                                    return (
                                        <Chip
                                            key={tag}
                                            label={tag}
                                            size='small'
                                            variant={picked ? "filled" : "outlined"}
                                            color={picked ? "primary" : "default"}
                                            icon={picked ? <CheckCircleIcon /> : undefined}
                                            onClick={() => togglePicked(tag)}
                                        />
                                    );
                                })}
                            </Box>
                        )}
                    </Box>
                </DialogContent>
                <DialogActions sx={{ px: 2, pb: 2, pt: 0.5, gap: 1 }}>
                    <Button size='small' color='inherit' variant='outlined' onClick={() => setTagOpen(false)}>
                        取消
                    </Button>
                    <Button
                        size='small'
                        variant='contained'
                        onClick={submitTags}
                        disabled={tagging}
                        className='nav-tag-submit'
                    >
                        {tagging ? "添加中…" : "添加标签"}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
