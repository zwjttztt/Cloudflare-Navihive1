// src/components/SiteNoteDialog.tsx
// 站点卡片上的「笔记」入口（#477 站点↔笔记双向绑定）—— 绑定 / 换绑 / 解除绑定。
//
// 为什么这里选笔记、而不是在笔记里选站点：用户看到一张卡片，脑子里想的是
// 「这个站点我记过笔记」，从卡片出发最直接；笔记那一侧只做**反查展示**
// （编辑器头部显示它属于哪个站点），不做选择器 —— 两头都放选择器只会让人
// 疑惑「我在哪儿绑的来着」。
//
// 数据面两件要紧的事：
//   - 绑定关系存在**笔记侧**（notes.site_id），站点上的 note_id / note_title 是
//     查出来的。所以这里只调 `notesBridge.bind`，不碰站点本身的 CRUD ——
//     「卡片删了笔记还在」因此不需要级联，也不会出现两份真相。
//   - 「一个站点最多一篇」由服务端 updateNote 收口。界面照这个前提做：
//     换绑直接覆盖，不追问「要不要先解绑」。
import { useEffect, useMemo, useState } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItemButton,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import AddIcon from "@mui/icons-material/Add";
import type { Site } from "../API/http";
import { useAppConfig } from "../context/appConfigStore";
import { useNotify } from "../context/NotifyContext";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "./dialogShell";

interface Props {
    site: Site;
    onClose: () => void;
}

type NoteRow = { id?: number; title: string; site_id?: number | null };

export default function SiteNoteDialog({ site, onClose }: Props) {
    const { notesBridge } = useAppConfig();
    const notify = useNotify();
    const [notes, setNotes] = useState<NoteRow[] | null>(null);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);

    // 打开时拉一次列表。拿不到就当作「列表为空」并给一句说明 ——
    // 这只是一份附加信息，不该因为它挡住整屏。
    useEffect(() => {
        if (!notesBridge) return;
        let alive = true;
        void (async () => {
            const rows = await notesBridge.list();
            if (alive) setNotes(rows);
        })();
        return () => {
            alive = false;
        };
    }, [notesBridge]);

    const filtered = useMemo(() => {
        if (!notes) return [];
        const q = query.trim().toLowerCase();
        if (!q) return notes;
        return notes.filter(n => (n.title || "").toLowerCase().includes(q));
    }, [notes, query]);

    const boundId = site.note_id ?? null;
    const boundTitle = site.note_title || "";

    const run = async (label: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
            notify(label, "success");
            onClose();
        } catch (error) {
            // 不关弹窗：失败时让用户还能重试或换个笔记，而不是从头再点一遍
            notify(error instanceof Error ? error.message : `${label}失败`, "error");
        } finally {
            setBusy(false);
        }
    };

    const handleBind = (note: NoteRow) => {
        if (!notesBridge || note.id == null) return;
        if (note.id === boundId) {
            onClose();
            return;
        }
        void run(`已绑定「${note.title || "未命名笔记"}」`, () =>
            notesBridge.bind(note.id as number, site.id as number)
        );
    };

    const handleUnbind = () => {
        if (!notesBridge || boundId == null) return;
        void run(`已解除与「${boundTitle || "笔记"}」的绑定`, () =>
            notesBridge.bind(boundId, null)
        );
    };

    const handleCreate = () => {
        if (!notesBridge || site.id == null) return;
        const title = site.name ? `${site.name} · 笔记` : "未命名笔记";
        void run(`已新建「${title}」并绑定`, async () => {
            await notesBridge.createAndBind(site.id as number, title);
        });
    };

    const handleOpenBound = () => {
        if (notesBridge && boundId != null) {
            notesBridge.open(boundId);
            onClose();
        }
    };

    return (
        <Dialog
            open
            onClose={onClose}
            maxWidth='xs'
            fullWidth
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                <Box component='span' sx={{ flexGrow: 1 }}>
                    站点笔记
                </Box>
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        aria-label='关闭'
                        onClick={onClose}
                        sx={{ position: "absolute", right: 12, top: 12 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>
            <DialogContent sx={dialogContentSx}>
                <Typography variant='caption' component='div' color='text.secondary' sx={{ mb: 1.5 }}>
                    「{site.name || "这个站点"}」最多绑一篇笔记。换绑会替换掉原来那篇（笔记本身不会删）。
                </Typography>

                {!notesBridge ? (
                    <Typography variant='body2' color='text.secondary'>
                        记事本还没就绪，暂时不能绑定笔记。
                    </Typography>
                ) : (
                    <>
                        {boundId != null && (
                            <Box
                                sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 1,
                                    px: 1,
                                    py: 0.75,
                                    mb: 1.5,
                                    borderRadius: "var(--radius-md)",
                                    border: "1px solid var(--border-subtle)",
                                    bgcolor: "action.hover",
                                }}
                            >
                                <DescriptionOutlinedIcon fontSize='small' color='primary' />
                                <Box
                                    component='button'
                                    type='button'
                                    onClick={handleOpenBound}
                                    sx={{
                                        flexGrow: 1,
                                        minWidth: 0,
                                        textAlign: "left",
                                        border: 0,
                                        background: "none",
                                        p: 0,
                                        cursor: "pointer",
                                        font: "inherit",
                                        color: "inherit",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                    title={boundTitle}
                                >
                                    {boundTitle || "未命名笔记"}
                                </Box>
                                <Tooltip title='解除绑定'>
                                    <IconButton
                                        size='small'
                                        aria-label='解除绑定'
                                        disabled={busy}
                                        onClick={handleUnbind}
                                    >
                                        <LinkOffIcon fontSize='small' />
                                    </IconButton>
                                </Tooltip>
                            </Box>
                        )}

                        <TextField
                            size='small'
                            fullWidth
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder='按标题筛选笔记'
                            slotProps={{ htmlInput: { "aria-label": "按标题筛选笔记" } }}
                        />

                        <Box
                            sx={{
                                mt: 1,
                                maxHeight: 260,
                                overflowY: "auto",
                                border: "1px solid var(--border-subtle)",
                                borderRadius: "var(--radius-md)",
                            }}
                        >
                            {notes === null ? (
                                <Stack
                                    direction='row'
                                    spacing={1}
                                    sx={{ alignItems: "center", justifyContent: "center", py: 3 }}
                                >
                                    <CircularProgress size={16} />
                                    <Typography variant='caption' color='text.secondary'>
                                        正在读取笔记…
                                    </Typography>
                                </Stack>
                            ) : filtered.length === 0 ? (
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    sx={{ display: "block", py: 3, textAlign: "center" }}
                                >
                                    {notes.length === 0 ? "记事本里还没有笔记" : "没有匹配的笔记"}
                                </Typography>
                            ) : (
                                <List dense disablePadding>
                                    {filtered.map(note => {
                                        const other = note.site_id != null && note.site_id !== site.id;
                                        return (
                                            <ListItemButton
                                                key={note.id}
                                                selected={note.id === boundId}
                                                disabled={busy}
                                                onClick={() => handleBind(note)}
                                                sx={{ gap: 1 }}
                                            >
                                                <DescriptionOutlinedIcon
                                                    fontSize='small'
                                                    sx={{ color: "text.secondary", flex: "none" }}
                                                />
                                                <Box
                                                    component='span'
                                                    sx={{
                                                        flexGrow: 1,
                                                        minWidth: 0,
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {note.title || "未命名笔记"}
                                                </Box>
                                                {other && (
                                                    <Typography
                                                        variant='caption'
                                                        color='text.secondary'
                                                        sx={{ flex: "none" }}
                                                    >
                                                        其它站点
                                                    </Typography>
                                                )}
                                            </ListItemButton>
                                        );
                                    })}
                                </List>
                            )}
                        </Box>
                    </>
                )}
            </DialogContent>
            <DialogActions sx={dialogActionsSx}>
                <Button
                    size='small'
                    startIcon={<AddIcon />}
                    onClick={handleCreate}
                    disabled={!notesBridge || busy || site.id == null}
                >
                    新建笔记并绑定
                </Button>
                <Box sx={{ flexGrow: 1 }} />
                <Button size='small' color='inherit' onClick={onClose} disabled={busy}>
                    取消
                </Button>
            </DialogActions>
        </Dialog>
    );
}
