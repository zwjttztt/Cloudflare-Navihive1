// src/components/MoveFolderDrawer.tsx
// 「移动到文件夹」的**右侧抽屉**（inkstone 的做法：点「移动到文件夹」后，
// 屏幕右侧滑出一个带搜索的文件夹列表，而不是在原地弹一个窄菜单）。
//
// 为什么不用原来的锚点 Menu：菜单是「围绕触发点」的小浮层，文件夹一多就得滚动，
// 在 208px 的列表列边上开菜单挤得没法看；抽屉有完整宽度 + 搜索框，放得下
// 「未归类 + 全部文件夹」并支持输入过滤。
import { useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
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
    /** 就地新建一个根目录文件夹，返回新 id；不传则不显示新建入口（调用方没接线时不冒出死按钮） */
    onCreateFolder?: (name: string) => Promise<number | null>;
    onClose: () => void;
}

export default function MoveFolderDrawer({
    open,
    noteTitle,
    folders,
    currentFolderId,
    onPick,
    onCreateFolder,
    onClose,
}: MoveFolderDrawerProps) {
    const [keyword, setKeyword] = useState("");
    // 就地新建：点「新建文件夹」展开输入行；创建成功直接把笔记移进去并关抽屉
    //（从「移动到文件夹」进来建文件夹，目的就是把这条笔记放进去，一步到位）
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [newBusy, setNewBusy] = useState(false);
    const [newError, setNewError] = useState("");

    const visible = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return folders;
        return folders.filter(f => (f.name || "").toLowerCase().includes(kw));
    }, [folders, keyword]);

    // 展开输入行时重置为干净状态；抽屉每次打开也重置（残留的上次输入不该再出现）
    useEffect(() => {
        if (open) {
            setCreating(false);
            setNewName("");
            setNewError("");
        }
    }, [open]);

    // 输入行挂载后手动聚焦一次（ref 方式：autoFocus 属性与 MUI Modal 焦点陷阱
    // 的交互在 jsdom 下行为不稳，ref 只在挂载后聚焦一次，语义明确）
    const newInputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (creating) newInputRef.current?.focus();
    }, [creating]);

    const startCreating = () => {
        // 搜索没命中时把搜索词直接带过去当初始名，少打一次字
        const kw = keyword.trim();
        setNewName(visible.length === 0 && kw ? kw : "");
        setNewError("");
        setCreating(true);
    };
    const resetCreating = () => {
        setCreating(false);
        setNewName("");
        setNewError("");
    };
    const submitNewFolder = async () => {
        const name = newName.trim();
        if (!name || !onCreateFolder || newBusy) return;
        setNewBusy(true);
        setNewError("");
        try {
            const createdId = await onCreateFolder(name);
            if (createdId === null || createdId === undefined) {
                setNewError("创建失败，请重试");
                return;
            }
            resetCreating();
            // 直接把当前笔记移进新文件夹（onPick 由调用方关闭抽屉）
            onPick(createdId);
        } catch (error) {
            setNewError(error instanceof Error ? error.message : "创建失败，请重试");
        } finally {
            setNewBusy(false);
        }
    };

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
                            没有匹配的文件夹。可以在下方新建「{keyword.trim()}」。
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
                {onCreateFolder && (
                    <>
                        <Divider />
                        <Box sx={{ px: 2, py: 1.5 }} data-new-folder-area='1'>
                            {creating ? (
                                <Box
                                    component='form'
                                    onSubmit={e => {
                                        e.preventDefault();
                                        void submitNewFolder();
                                    }}
                                    sx={{ display: "flex", alignItems: "center", gap: 1 }}
                                >
                                    <TextField
                                        // ⚠️ 不用 autoFocus：它在 MUI Modal 的焦点陷阱（TrapFocus）
                                        // 里会与「把焦点拉回弹层」互相打架，jsdom 下实测引发
                                        // 无限重渲染直至内存耗尽。改成挂载后 ref 手动聚焦一次。
                                        ref={newInputRef}
                                        size='small'
                                        fullWidth
                                        value={newName}
                                        onChange={e => setNewName(e.target.value)}
                                        placeholder='新文件夹名称'
                                        disabled={newBusy}
                                        data-new-folder-input='1'
                                        slotProps={{
                                            input: {
                                                "aria-label": "新文件夹名称",
                                                startAdornment: (
                                                    <FolderIcon fontSize='small' sx={{ mr: 0.75, color: "text.disabled" }} />
                                                ),
                                            },
                                        }}
                                    />
                                    <Button
                                        type='submit'
                                        variant='contained'
                                        size='small'
                                        disabled={newBusy || !newName.trim()}
                                        data-new-folder-submit='1'
                                    >
                                        创建
                                    </Button>
                                    <IconButton
                                        size='small'
                                        aria-label='取消新建文件夹'
                                        data-new-folder-cancel='1'
                                        disabled={newBusy}
                                        onClick={resetCreating}
                                    >
                                        <CloseIcon fontSize='small' />
                                    </IconButton>
                                </Box>
                            ) : (
                                <Box
                                    component='button'
                                    type='button'
                                    data-new-folder='1'
                                    onClick={startCreating}
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 1.25,
                                        width: "100%",
                                        px: 1.5,
                                        py: 1,
                                        appearance: "none",
                                        border: "none",
                                        font: "inherit",
                                        cursor: "pointer",
                                        borderRadius: 1.5,
                                        textAlign: "left",
                                        bgcolor: "transparent",
                                        color: "text.secondary",
                                        "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                                    }}
                                >
                                    <CreateNewFolderIcon fontSize='small' />
                                    <Typography variant='body2' sx={{ textAlign: "left" }}>
                                        新建文件夹
                                    </Typography>
                                </Box>
                            )}
                            {newError && (
                                <Typography variant='caption' color='error' sx={{ display: "block", px: 1.5, pt: 0.5 }}>
                                    {newError}
                                </Typography>
                            )}
                        </Box>
                    </>
                )}
            </Box>
        </Drawer>
    );
}
