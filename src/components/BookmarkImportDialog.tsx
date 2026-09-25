// src/components/BookmarkImportDialog.tsx
// 从浏览器导出的书签 HTML 批量导入：顶层文件夹 → 分组，链接 → 卡片。
// 导入前可以勾选要哪些文件夹，避免把整个收藏夹一股脑塞进来。
import { useMemo, useRef, useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    Typography,
    Checkbox,
    FormControlLabel,
    List,
    ListItem,
    ListItemText,
    Chip,
    LinearProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import { parseBookmarksHtml, ParsedBookmarkGroup } from "../utils/bookmarks";

interface BookmarkImportDialogProps {
    open: boolean;
    onClose: () => void;
    onImport: (groups: ParsedBookmarkGroup[]) => Promise<number>;
}

export default function BookmarkImportDialog({
    open,
    onClose,
    onImport,
}: BookmarkImportDialogProps) {
    const [parsed, setParsed] = useState<ParsedBookmarkGroup[]>([]);
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [fileName, setFileName] = useState("");
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const total = useMemo(
        () =>
            parsed
                .filter(g => selected[g.folder] !== false)
                .reduce((sum, g) => sum + g.items.length, 0),
        [parsed, selected]
    );

    const handleFile = async (file?: File | null) => {
        if (!file) return;
        const text = await file.text();
        const groups = parseBookmarksHtml(text);
        setFileName(file.name);
        setParsed(groups);
        setSelected(Object.fromEntries(groups.map(g => [g.folder, true])));
    };

    const handleImport = async () => {
        const picked = parsed.filter(g => selected[g.folder] !== false);
        if (picked.length === 0) return;
        setBusy(true);
        try {
            await onImport(picked);
            reset();
            onClose();
        } finally {
            setBusy(false);
        }
    };

    const reset = () => {
        setParsed([]);
        setSelected({});
        setFileName("");
        if (fileRef.current) fileRef.current.value = "";
    };

    return (
        <Dialog
            open={open}
            onClose={() => {
                reset();
                onClose();
            }}
            fullWidth
            maxWidth='xs'
            slotProps={{
                paper: {
                    sx: {
                        borderRadius: "18px",
                        bgcolor: "var(--glass-bg-hover)",
                        border: "1px solid var(--glass-border)",
                        backdropFilter: "blur(16px)",
                        WebkitBackdropFilter: "blur(16px)",
                    },
                },
            }}
        >
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 16 }}>
                导入浏览器书签
                <Box sx={{ flexGrow: 1 }} />
                <Button
                    size='small'
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                    aria-label='关闭导入书签'
                    sx={{ minWidth: 0, p: 0.5 }}
                >
                    <CloseIcon fontSize='small' />
                </Button>
            </DialogTitle>

            <DialogContent sx={{ pt: 0 }}>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                    在浏览器书签管理器里选「导出书签」，得到 HTML 文件后在这里选择。
                    顶层文件夹会成为分组，里面的链接成为卡片。
                </Typography>

                <input
                    ref={fileRef}
                    type='file'
                    accept='.html,.htm,text/html'
                    style={{ display: "none" }}
                    onChange={e => handleFile(e.target.files?.[0])}
                />
                <Button
                    variant='outlined'
                    size='small'
                    startIcon={<FileUploadIcon />}
                    onClick={() => fileRef.current?.click()}
                >
                    选择书签文件
                </Button>
                {fileName && (
                    <Typography variant='caption' color='text.secondary' sx={{ ml: 1 }}>
                        {fileName}
                    </Typography>
                )}

                {parsed.length > 0 && (
                    <>
                        <Box
                            sx={{
                                mt: 2,
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                                flexWrap: "wrap",
                            }}
                        >
                            <Typography variant='subtitle2'>
                                共 {parsed.length} 个文件夹
                            </Typography>
                            <Chip size='small' label={`${total} 个链接`} />
                        </Box>
                        <List
                            dense
                            sx={{
                                mt: 1,
                                maxHeight: 240,
                                overflowY: "auto",
                                borderRadius: "12px",
                                border: "1px solid var(--glass-border)",
                            }}
                        >
                            {parsed.map(group => (
                                <ListItem key={group.folder} disableGutters sx={{ px: 1 }}>
                                    <FormControlLabel
                                        sx={{ width: "100%", m: 0 }}
                                        control={
                                            <Checkbox
                                                size='small'
                                                checked={selected[group.folder] !== false}
                                                onChange={e =>
                                                    setSelected(prev => ({
                                                        ...prev,
                                                        [group.folder]: e.target.checked,
                                                    }))
                                                }
                                            />
                                        }
                                        label={
                                            <ListItemText
                                                primary={group.folder}
                                                secondary={`${group.items.length} 个链接`}
                                                primaryTypographyProps={{ noWrap: true }}
                                                secondaryTypographyProps={{ fontSize: 11 }}
                                            />
                                        }
                                    />
                                </ListItem>
                            ))}
                        </List>
                    </>
                )}

                {busy && <LinearProgress sx={{ mt: 2, borderRadius: 1 }} />}
            </DialogContent>

            <DialogActions sx={{ px: 2, pb: 2 }}>
                <Button
                    size='small'
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                >
                    取消
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    disabled={busy || total === 0}
                    onClick={handleImport}
                >
                    导入 {total > 0 ? `${total} 个` : ""}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
