// src/components/MoveFolderDrawer.tsx
// 「移动到文件夹」的**右侧抽屉**（inkstone 的做法：点「移动到文件夹」后，
// 屏幕右侧滑出一个带搜索的文件夹列表，而不是在原地弹一个窄菜单）。
//
// 为什么不用原来的锚点 Menu：菜单是「围绕触发点」的小浮层，文件夹一多就得滚动，
// 在 208px 的列表列边上开菜单挤得没法看；抽屉有完整宽度 + 搜索框，放得下
// 「未归类 + 全部文件夹」并支持输入过滤。
import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import FolderIcon from "@mui/icons-material/Folder";
import FolderOffIcon from "@mui/icons-material/FolderOff";
import SearchIcon from "@mui/icons-material/Search";
import { isFolderColor } from "../utils/folderAppearance";

export interface MoveFolderDrawerProps {
    open: boolean;
    /** 要移动的笔记标题（标题栏显示，用户确认自己在移哪条） */
    noteTitle: string;
    folders: { id: number; name: string; icon?: string | null; color?: string | null }[];
    /** 这条笔记当前所在的文件夹（选中态高亮 + 打勾） */
    currentFolderId: number | null;
    /** 选中某个文件夹（null = 移到「未归类」） */
    onPick: (folderId: number | null) => void;
    onClose: () => void;
}

export default function MoveFolderDrawer({
    open,
    noteTitle,
    folders,
    currentFolderId,
    onPick,
    onClose,
}: MoveFolderDrawerProps) {
    const [keyword, setKeyword] = useState("");

    const visible = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return folders;
        return folders.filter(f => (f.name || "").toLowerCase().includes(kw));
    }, [folders, keyword]);

    return (
        <Drawer
            anchor='right'
            open={open}
            onClose={onClose}
            slotProps={{ paper: { sx: { width: 300, borderTopLeftRadius: 12, borderBottomLeftRadius: 12 } } }}
        >
            <Box data-move-drawer='1' sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
                    <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600, fontSize: 15 }}>
                        移动到文件夹
                    </Typography>
                    <IconButton size='small' aria-label='关闭' data-move-drawer-close='1' onClick={onClose}>
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Box>
                <Box sx={{ px: 2, pb: 1 }}>
                    <TextField
                        fullWidth
                        size='small'
                        value={keyword}
                        onChange={e => setKeyword(e.target.value)}
                        placeholder='搜索文件夹'
                        slotProps={{
                            input: {
                                // ⚠️ aria-label 必须挂在 **input** 上：直接写在 TextField 上
                                // 会被 MUI 摊到外层 FormControl（div）上，读屏软件与
                                // `input[aria-label=...]` 选择器都找不到它。
                                "aria-label": '搜索文件夹',
                                startAdornment: <SearchIcon fontSize='small' sx={{ mr: 0.75, color: "text.disabled" }} />,
                                sx: { borderRadius: 2, bgcolor: "rgba(128,128,128,0.06)" },
                            },
                        }}
                    />
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 1, px: 0.5 }}>
                        {noteTitle ? `「${noteTitle}」` : ""}
                    </Typography>
                </Box>
                <Divider />
                <Box sx={{ flex: 1, overflowY: "auto", py: 1 }}>
                    {/* 「未归类」= folder_id 置空。inkstone 列表第一项「最外层」同位 */}
                    <Box
                        component='button'
                        type='button'
                        data-move-target='none'
                        onClick={() => onPick(null)}
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1.25,
                            width: "calc(100% - 16px)",
                            mx: 1,
                            px: 1.5,
                            py: 1,
                            appearance: "none",
                            border: "none",
                            font: "inherit",
                            cursor: "pointer",
                            borderRadius: 1.5,
                            minWidth: 0,
                            textAlign: "left",
                            bgcolor:
                                currentFolderId === null ? "rgba(176,67,58,0.10)" : "transparent",
                            "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                        }}
                    >
                        <FolderOffIcon
                            fontSize='small'
                            sx={{ color: currentFolderId === null ? "var(--accent)" : "text.disabled" }}
                        />
                        <Typography variant='body2' sx={{ flex: 1, textAlign: "left" }}>
                            未归类（移出文件夹）
                        </Typography>
                        {currentFolderId === null && (
                            <CheckIcon fontSize='small' sx={{ color: "var(--accent)" }} />
                        )}
                    </Box>
                    {visible.length === 0 && keyword.trim() ? (
                        <Typography variant='body2' color='text.secondary' sx={{ px: 2.5, py: 1.5 }}>
                            没有匹配的文件夹。
                        </Typography>
                    ) : (
                        visible.map(f => {
                            const active = f.id === currentFolderId;
                            return (
                                <Box
                                    key={f.id}
                                    component='button'
                                    type='button'
                                    data-move-target={f.id}
                                    onClick={() => onPick(f.id)}
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 1.25,
                                        width: "calc(100% - 16px)",
                                        mx: 1,
                                        px: 1.5,
                                        py: 1,
                                        appearance: "none",
                                        border: "none",
                                        font: "inherit",
                                        cursor: "pointer",
                                        borderRadius: 1.5,
                                        minWidth: 0,
                                        textAlign: "left",
                                        bgcolor: active ? "rgba(176,67,58,0.10)" : "transparent",
                                        "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                                    }}
                                >
                                    <FolderIcon
                                        fontSize='small'
                                        sx={{
                                            color: isFolderColor(f.color) ? f.color : "text.disabled",
                                        }}
                                    />
                                    <Typography
                                        variant='body2'
                                        sx={{
                                            flex: 1,
                                            textAlign: "left",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            color: active ? "var(--accent)" : "text.primary",
                                            fontWeight: active ? 600 : 400,
                                        }}
                                    >
                                        {f.name || "未命名"}
                                    </Typography>
                                    {active && <CheckIcon fontSize='small' sx={{ color: "var(--accent)" }} />}
                                </Box>
                            );
                        })
                    )}
                </Box>
            </Box>
        </Drawer>
    );
}
