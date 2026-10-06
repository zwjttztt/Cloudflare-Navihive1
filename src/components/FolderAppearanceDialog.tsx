// src/components/FolderAppearanceDialog.tsx
// 「文件夹外观」（inkstone 文件夹右键菜单里的那一项）：选图标 + 选颜色。
//
// 数据按约定枚举存：icon 存图标名（FOLDER_ICONS 里的 key），color 存十六进制色值。
// 渲染端只认自己清单里的名字 —— 脏数据（手改过库 / 旧版本）直接按默认样式画，
// 不会因为一个未知字符串把左栏打崩。
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { FOLDER_COLORS, FOLDER_ICONS } from "../utils/folderAppearance";

export interface FolderAppearanceDialogProps {
    open: boolean;
    /** 要改外观的文件夹（id + 当前 icon/color + 名字用于标题显示） */
    folder: { id: number; name: string; icon?: string | null; color?: string | null } | null;
    /** 保存：交给上层走 updateFolder（服务端是唯一真相） */
    onSave: (icon: string | null, color: string | null) => Promise<void>;
    onClose: () => void;
}

export default function FolderAppearanceDialog({ open, folder, onSave, onClose }: FolderAppearanceDialogProps) {
    // 编辑的是对话框打开那一刻的副本：保存/取消之前不动左栏的真实状态
    const [icon, setIcon] = useState("");
    const [color, setColor] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (folder) {
            setIcon(folder.icon ?? "");
            setColor(folder.color ?? null);
            setSaving(false);
        }
    }, [folder?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

    const submit = async () => {
        setSaving(true);
        try {
            await onSave(icon || null, color);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open && folder !== null}
            onClose={onClose}
            maxWidth='xs'
            fullWidth
            slotProps={{ paper: { sx: { borderRadius: 2.5 } } }}
        >
            <DialogTitle sx={{ fontSize: 16, pb: 1 }}>
                文件夹外观{folder?.name ? ` · ${folder.name}` : ""}
            </DialogTitle>
            <DialogContent sx={{ pt: "4px!important" }}>
                <Typography variant='caption' sx={{ display: "block", mb: 1, color: "text.secondary" }}>
                    图标
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mb: 2 }}>
                    {FOLDER_ICONS.map(item => {
                        const Icon = item.icon;
                        const active = icon === item.key;
                        return (
                            <Tooltip key={item.key || "default"} title={item.label}>
                                <Box
                                    component='button'
                                    type='button'
                                    aria-label={`图标 ${item.label}`}
                                    data-appearance-icon={item.key || "default"}
                                    onClick={() => setIcon(item.key)}
                                    sx={{
                                        width: 38,
                                        height: 38,
                                        display: "grid",
                                        placeItems: "center",
                                        borderRadius: 1.5,
                                        cursor: "pointer",
                                        appearance: "none",
                                        border: active ? "2px solid var(--accent)" : "1px solid rgba(128,128,128,0.3)",
                                        bgcolor: active ? "rgba(176,67,58,0.08)" : "transparent",
                                        color: color || "text.secondary",
                                        "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                                    }}
                                >
                                    <Icon fontSize='small' />
                                </Box>
                            </Tooltip>
                        );
                    })}
                </Box>
                <Typography variant='caption' sx={{ display: "block", mb: 1, color: "text.secondary" }}>
                    颜色
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    {/* 「默认」= 不设色，跟随主题；inkstone 同样给了一个取消色的小圆 */}
                    <Box
                        component='button'
                        type='button'
                        aria-label='默认颜色'
                        data-appearance-color='default'
                        onClick={() => setColor(null)}
                        sx={{
                            width: 26,
                            height: 26,
                            borderRadius: "50%",
                            cursor: "pointer",
                            appearance: "none",
                            border: color === null ? "2px solid var(--accent)" : "1px solid rgba(128,128,128,0.4)",
                            bgcolor: "transparent",
                            fontSize: 11,
                            color: "text.secondary",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        空
                    </Box>
                    {FOLDER_COLORS.map(c => (
                        <Box
                            key={c}
                            component='button'
                            type='button'
                            aria-label={`颜色 ${c}`}
                            data-appearance-color={c}
                            onClick={() => setColor(c)}
                            sx={{
                                width: 26,
                                height: 26,
                                borderRadius: "50%",
                                cursor: "pointer",
                                appearance: "none",
                                bgcolor: c,
                                border: color === c ? "2px solid var(--accent)" : "2px solid transparent",
                                outline: "1px solid rgba(128,128,128,0.25)",
                            }}
                        />
                    ))}
                </Box>
            </DialogContent>
            <DialogActions sx={{ px: 2.5, pb: 1.5 }}>
                <Button onClick={onClose} size='small'>取消</Button>
                <Button
                    onClick={() => void submit()}
                    size='small'
                    variant='contained'
                    disabled={saving}
                    data-appearance-save='1'
                >
                    {saving ? "保存中…" : "保存"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
