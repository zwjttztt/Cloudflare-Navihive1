import React, { useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    TextField,
    Typography,
    Box,
    Alert,
    Tooltip,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Group } from "../API/http";
import { useNotify } from "../context/NotifyContext";
import { copyToClipboard } from "../utils/clipboard";

interface EditGroupDialogProps {
    open: boolean;
    group: Group | null;
    /** create = 新增分组，edit = 编辑分组（默认）。两种模式共用同一套排版与尺寸 */
    mode?: "create" | "edit";
    onClose: () => void;
    onSave: (group: Group) => void;
    /** 仅编辑模式需要：删除分组回调 */
    onDelete?: (groupId: number) => void;
    /** 分组强调色（空表示跟随全局主色） */
    color?: string;
    onColorChange?: (color: string) => void;
}

// 分组色板：挑了几组和主色区分度高的颜色，避免分组之间看着都一样
const GROUP_COLORS = [
    "#1976d2",
    "#7F77DD",
    "#1D9E75",
    "#D85A30",
    "#D4537E",
    "#BA7517",
    "#639922",
    "#888780",
];

const EditGroupDialog: React.FC<EditGroupDialogProps> = ({
    open,
    group,
    mode = "edit",
    onClose,
    onSave,
    onDelete,
    color = "",
    onColorChange,
}) => {
    const notify = useNotify();
    const [name, setName] = useState("");
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    /** 点提示里的分组名复制后短暂显示「已复制」，复制失败则提示手动输入 */
    const [copiedTick, setCopiedTick] = useState(false);
    // 二次确认：必须手打一遍分组名称才允许删除，避免误点
    const [deleteConfirmText, setDeleteConfirmText] = useState("");
    const isCreate = mode === "create";
    const groupId = group?.id;
    const groupName = group?.name;

    // 弹窗每次打开时初始化名称。
    // 依赖里只放 open / groupId，避免新增模式下父组件传入新对象把正在输入的内容重置掉。
    React.useEffect(() => {
        if (!open) return;
        setName(isCreate ? "" : groupName ?? "");
        setShowDeleteConfirm(false);
        setDeleteConfirmText("");
        setCopiedTick(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, groupId, isCreate]);

    const handleSave = () => {
        const trimmed = name.trim();
        if (!trimmed) return;

        onSave({
            ...(group || {}),
            name: trimmed,
        } as Group);
    };

    /** 输入的分组名和实际名称一致时才解锁「确认删除」 */
    const deleteConfirmOk =
        !!group && deleteConfirmText.trim() === (group.name ?? "").trim();

    const handleDelete = () => {
        if (!group) return;

        if (!showDeleteConfirm) {
            // 显示删除确认
            setShowDeleteConfirm(true);
            setDeleteConfirmText("");
        } else if (deleteConfirmOk) {
            // 确认删除
            onDelete?.(group.id!);
        }
    };

    /** 点提示里的分组名：一键复制，方便直接粘贴进上面的输入框 */
    const handleCopyGroupName = async () => {
        if (!group?.name) return;
        const ok = await copyToClipboard(group.name);
        if (!ok) {
            notify("复制失败，请手动输入分组名称", "error");
            return;
        }
        setCopiedTick(true);
        notify(`已复制分组名称「${group.name}」`, "success", 1600);
        window.setTimeout(() => setCopiedTick(false), 1800);
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
            <DialogTitle>{isCreate ? "新增分组" : "编辑分组"}</DialogTitle>
            <DialogContent>
                <Box sx={{ mb: 2, mt: 1 }}>
                    <TextField
                        label='分组名称'
                        fullWidth
                        value={name}
                        onChange={e => setName(e.target.value)}
                        variant='outlined'
                        autoFocus
                    />
                </Box>

                {onColorChange && (
                    <Box sx={{ mb: 1 }}>
                        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                            分组颜色
                        </Typography>
                        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                            {GROUP_COLORS.map(c => (
                                <Box
                                    key={c}
                                    component='button'
                                    type='button'
                                    aria-label={`分组颜色 ${c}`}
                                    onClick={() => onColorChange(c)}
                                    sx={{
                                        width: 26,
                                        height: 26,
                                        p: 0,
                                        cursor: "pointer",
                                        borderRadius: "50%",
                                        bgcolor: c,
                                        border: "2px solid",
                                        borderColor:
                                            color.toLowerCase() === c.toLowerCase()
                                                ? "text.primary"
                                                : "transparent",
                                        boxShadow: "0 1px 4px rgba(15,23,42,0.18)",
                                        transition: "transform .15s ease",
                                        "&:hover": { transform: "scale(1.08)" },
                                    }}
                                />
                            ))}
                            <Button
                                size='small'
                                variant='text'
                                onClick={() => onColorChange("")}
                                sx={{ minWidth: 0, fontSize: 12 }}
                            >
                                跟随主色
                            </Button>
                        </Box>
                    </Box>
                )}

                {showDeleteConfirm && group && (
                    <Alert severity='warning' sx={{ mt: 2 }}>
                        <Typography variant='body2'>
                            确定要删除分组 "{group.name}" 吗？
                            <strong>删除此分组将同时删除该分组下的所有网站。</strong>
                            此操作无法撤销。
                        </Typography>
                        <Typography
                            variant='body2'
                            sx={{ mt: 1.5, fontWeight: 600, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.5 }}
                        >
                            请输入分组名称「
                            <Tooltip title='点击复制分组名称'>
                                <Box
                                    component='span'
                                    role='button'
                                    tabIndex={0}
                                    aria-label={`复制分组名称 ${group.name}`}
                                    onClick={handleCopyGroupName}
                                    onKeyDown={e => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            handleCopyGroupName();
                                        }
                                    }}
                                    sx={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 0.5,
                                        px: 0.75,
                                        py: 0.15,
                                        borderRadius: "8px",
                                        cursor: "pointer",
                                        userSelect: "all",
                                        border: "1px dashed",
                                        borderColor: "currentColor",
                                        transition: "background-color .18s ease",
                                        "&:hover, &:focus-visible": {
                                            bgcolor: "action.selected",
                                        },
                                    }}
                                >
                                    {group.name}
                                    <ContentCopyIcon sx={{ fontSize: 13 }} />
                                </Box>
                            </Tooltip>
                            」以确认删除
                            {copiedTick && (
                                <Typography
                                    component='span'
                                    variant='caption'
                                    sx={{ ml: 0.5, color: "success.main" }}
                                >
                                    已复制
                                </Typography>
                            )}
                        </Typography>
                        <TextField
                            fullWidth
                            size='small'
                            autoFocus
                            value={deleteConfirmText}
                            onChange={e => setDeleteConfirmText(e.target.value)}
                            placeholder={group.name}
                            error={deleteConfirmText.length > 0 && !deleteConfirmOk}
                            inputProps={{ "aria-label": "输入分组名称确认删除" }}
                            sx={{ mt: 1, "& .MuiOutlinedInput-root": { bgcolor: "background.paper" } }}
                        />
                    </Alert>
                )}
            </DialogContent>
            <DialogActions>
                {!showDeleteConfirm ? (
                    <>
                        <Button onClick={onClose} color='inherit'>
                            取消
                        </Button>
                        {!isCreate && onDelete && (
                            <Button onClick={handleDelete} color='error' variant='outlined'>
                                删除
                            </Button>
                        )}
                        <Button
                            onClick={handleSave}
                            color='primary'
                            variant='contained'
                            disabled={!name.trim()}
                        >
                            {isCreate ? "创建" : "保存"}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button
                            onClick={() => {
                                setShowDeleteConfirm(false);
                                setDeleteConfirmText("");
                                setCopiedTick(false);
                            }}
                            color='inherit'
                        >
                            取消
                        </Button>
                        <Button
                            onClick={handleDelete}
                            color='error'
                            variant='contained'
                            disabled={!deleteConfirmOk}
                        >
                            确认删除
                        </Button>
                    </>
                )}
            </DialogActions>
        </Dialog>
    );
};

export default EditGroupDialog;
