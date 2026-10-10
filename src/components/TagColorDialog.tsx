// src/components/TagColorDialog.tsx
// 给一个标签挑颜色。
//
// 这里故意**不做**自由调色盘：色值直接存进 note_tag.color，而渲染端（左栏小圆点、
// 列表里的标签片）只用它在小面积色块上着色 —— 允许用户填 `#ff00ff` 的话，
// 亮色主题下会拿到一堆看不清字的浅色，再纠正就要改回腹部沉淀的数据。
// 所以和文件夹外观共用一组约定色（FOLDER_COLORS），渲染端之外的脏数据一律按「无色」画。
//
// 为什么要单独的弹窗而不是塞进「重命名」对话框：改名字和改颜色是两种不同的意图，
// 前者是「我写错了」，后者是「我想让它更好认」。同一个输入框里塞两件事，
// 用户得先理解「这次是要改哪一个」。
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { FOLDER_COLORS, isFolderColor } from "../utils/folderAppearance";

export interface TagColorDialogProps {
    open: boolean;
    /** 要改颜色的标签；null 时不渲染内容 */
    tag: { id: number; name: string; color?: string | null } | null;
    /** 保存：交给上层走 updateTag（服务端是唯一真相） */
    onSave: (color: string | null) => Promise<void>;
    onClose: () => void;
}

export default function TagColorDialog({ open, tag, onSave, onClose }: TagColorDialogProps) {
    // 编辑副本：保存/取消之前不动真实状态
    const [color, setColor] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (tag) {
            // 脏数据（手改过库 / 旧版本）可能不在调色板里 → 按「无色」起手，
            // 免得界面显示一个自己渲染不出来的值。
            setColor(isFolderColor(tag.color) ? tag.color : null);
            setSaving(false);
        }
    }, [tag?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

    const submit = async () => {
        setSaving(true);
        try {
            await onSave(color);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open && tag !== null}
            onClose={onClose}
            maxWidth='xs'
            fullWidth
            slotProps={{ paper: { sx: { borderRadius: 2.5 } } }}
        >
            <DialogTitle sx={{ fontSize: 16, pb: 1 }}>
                标签颜色{tag?.name ? ` · ${tag.name}` : ""}
            </DialogTitle>
            <DialogContent sx={{ pt: "4px!important" }}>
                <Typography variant='caption' sx={{ display: "block", mb: 1, color: "text.secondary" }}>
                    颜色只用来区分，不影响排序与搜索。
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    {/* 「默认」= 不设色，跟随主题；和文件夹外观那个「空」圆同款 */}
                    <Tooltip title='默认（跟随主题）'>
                        <Box
                            component='button'
                            type='button'
                            aria-label='默认颜色'
                            data-tag-color='default'
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
                    </Tooltip>
                    {FOLDER_COLORS.map(c => (
                        <Tooltip key={c} title={c}>
                            <Box
                                component='button'
                                type='button'
                                aria-label={`颜色 ${c}`}
                                data-tag-color={c}
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
                        </Tooltip>
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
                    data-tag-color-save='1'
                >
                    {saving ? "保存中…" : "保存"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
