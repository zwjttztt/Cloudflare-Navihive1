// src/components/SiteNoteDialog.tsx
// 站点卡片上的「笔记」入口（#477 站点↔笔记双向绑定）。
//
// 两种面孔，同一个弹窗（都从卡片角上那枚按钮进来）：
//   - **预览**：这张卡片已经绑了某篇笔记 → 先把正文只读地摆出来，
//     想看细节再点「编辑」跳进记事本。用户明确要求「先弹预览、点编辑再跳转」
//     （2026-10-23），所以「点一下就把人扔进记事本」那条不做了 ——
//     在导航页上点一下就被换掉页面，比多点一次更烦人。
//   - **选择**：还没绑（或点了「换一篇」）→ 列出笔记、可搜标题、可新建即绑。
//
// 数据面两件要紧的事：
//   - 绑定关系存在**笔记侧**（notes.site_id），站点上的 note_id / note_title 是
//     查出来的。所以这里只调 `notesBridge.bind`，不碰站点本身的 CRUD ——
//     「卡片删了笔记还在」因此不需要级联，也不会出现两份真相。
//   - 「一个站点最多一篇」由服务端 updateNote 收口。界面照这个前提做：
//     换绑直接覆盖，不追问「要不要先解绑」。
//
// ⚠️ 这里 import 了 markdown 渲染层（markdownToReact）。这在**首屏**是禁忌
// （它会把 markdown-it 整包拖进首页），但本文件只被 SiteCard 用 lazy() 引，
// 属于「打开才下载」的块 —— 体积预算那条守卫盯的是首屏，这里安全。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    List,
    ListItemButton,
    Stack,
    TextField,
    Typography,
} from "@mui/material";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EditIcon from "@mui/icons-material/Edit";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import AddIcon from "@mui/icons-material/Add";
import type { Site } from "../API/http";
import { useAppConfig } from "../context/appConfigStore";
import { useNotify } from "../context/NotifyContext";
import { renderMarkdownToReact } from "../utils/markdownToReact";
import {
    AttachmentPreviewProvider,
    type AttachmentPreviewRequest,
} from "../utils/attachmentPreview";
import AttachmentPreviewDialog from "./AttachmentPreviewDialog";
import DialogCloseButton from "./DialogCloseButton";
import { prefetchChunk } from "../utils/lazyPrefetch";
import { dialogChunks } from "../utils/dialogChunks";
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

/** 预览区三态：加载中 / 有内容 / 那条笔记已经不在了 */
type Preview =
    | { status: "loading" }
    | { status: "missing" }
    | { status: "ok"; title: string; body: ReactNode; empty: boolean };

export default function SiteNoteDialog({ site, onClose }: Props) {
    const { notesBridge } = useAppConfig();
    const notify = useNotify();
    const boundId = site.note_id ?? null;
    const boundTitle = site.note_title || "";
    // 绑过就先给预览；没绑直接进选择器
    const [mode, setMode] = useState<"preview" | "picker">(boundId != null ? "preview" : "picker");
    const [notes, setNotes] = useState<NoteRow[] | null>(null);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<Preview>({ status: "loading" });

    /**
     * 正文里点附件链接（txt / json / 图片…）走这个弹窗 —— 与记事本里那一套**同一个组件**。
     *
     * ⚠️ 不挂 Provider 的话，`AttachmentLink` 会退回成裸 `<a href="/api/notes/attachments/…">`：
     * 点一下既不开预览、也没人拦默认行为，整页会被顶走（2026-10-23 用户实测
     * 「预览里的 txt 附件点了还是停在预览窗」就是这个 —— 因为没有 Provider 时
     * 那条点击根本没被接管）。控制器对象引用必须稳定，否则整棵渲染树跟着重渲染。
     */
    const [attachmentTarget, setAttachmentTarget] = useState<AttachmentPreviewRequest | null>(null);
    const attachmentController = useMemo(
        () => ({ open: (request: AttachmentPreviewRequest) => setAttachmentTarget(request) }),
        []
    );

    // 触屏上没有 hover，卡片那颗按钮的预取永远不会触发 —— 预览窗一打开就先备好记事本
    // 整块（「编辑」要跳进去，是这里最贵的一次下载）。
    useEffect(() => {
        prefetchChunk("notesOverlay", dialogChunks.notesOverlay);
    }, []);

    // 选择器列表：只在真的切到「选择」时才拉（只是看看预览就不该多打一次请求）
    useEffect(() => {
        if (mode !== "picker" || !notesBridge || notes) return;
        let alive = true;
        void (async () => {
            const rows = await notesBridge.list();
            if (alive) setNotes(rows);
        })();
        return () => {
            alive = false;
        };
    }, [mode, notesBridge, notes]);

    // 预览正文：按 id 取一次全文，再交给渲染层
    useEffect(() => {
        if (mode !== "preview" || boundId == null || !notesBridge) return;
        let alive = true;
        setPreview({ status: "loading" });
        void (async () => {
            const note = await notesBridge.get(boundId);
            if (!alive) return;
            if (!note) {
                setPreview({ status: "missing" });
                return;
            }
            let body: ReactNode;
            try {
                body = await renderMarkdownToReact(note.content);
            } catch {
                // 渲染层挂了不该让整窗空白：退回纯文本，用户至少还能读到内容
                body = (
                    <Box component='pre' sx={{ whiteSpace: "pre-wrap", m: 0, fontFamily: "inherit" }}>
                        {note.content}
                    </Box>
                );
            }
            if (!alive) return;
            setPreview({
                status: "ok",
                title: note.title || boundTitle || "未命名笔记",
                body,
                empty: !note.content.trim(),
            });
        })();
        return () => {
            alive = false;
        };
        // boundTitle 只在兜底标题时用到，不该作为依赖触发重取
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, boundId, notesBridge]);

    const filtered = useMemo(() => {
        if (!notes) return [];
        const q = query.trim().toLowerCase();
        if (!q) return notes;
        return notes.filter(n => (n.title || "").toLowerCase().includes(q));
    }, [notes, query]);

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
        void run(`已解除与「${boundTitle || "笔记"}」的绑定`, () => notesBridge.bind(boundId, null));
    };

    const handleCreate = () => {
        if (!notesBridge || site.id == null) return;
        const title = site.name ? `${site.name} · 笔记` : "未命名笔记";
        void run(`已新建「${title}」并绑定`, async () => {
            await notesBridge.createAndBind(site.id as number, title);
        });
    };

    const handleEdit = () => {
        if (!notesBridge || boundId == null) return;
        // 用户点的是「编辑」：这时候才跳进记事本，并直接定位到这条
        notesBridge.open(boundId);
        onClose();
    };

    const titleText = mode === "preview" ? previewTitle(preview, boundTitle) : "绑定笔记";

    return (
        <Dialog
            open
            onClose={onClose}
            maxWidth={mode === "preview" ? "sm" : "xs"}
            fullWidth
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                <Box
                    component='span'
                    sx={{
                        flexGrow: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                    title={titleText}
                >
                    {titleText}
                </Box>
                {/* 换成全站统一的右上角「×」：这里原先手写的那份位置 / Tooltip /
                    aria-label 与 DialogCloseButton 一模一样，直接换成共用组件 */}
                <DialogCloseButton onClose={onClose} />
            </DialogTitle>
            <DialogContent sx={dialogContentSx}>
                <Typography variant='caption' component='div' color='text.secondary' sx={{ mb: 1.25 }}>
                    绑定在「{site.name || "这个站点"}」上的笔记。一个站点最多绑一篇，换绑会替换掉原来那篇（笔记本身不会删）。
                </Typography>

                {!notesBridge ? (
                    <Typography variant='body2' color='text.secondary'>
                        记事本还没就绪，暂时不能绑定笔记。
                    </Typography>
                ) : mode === "preview" ? (
                    <Box
                        data-site-note-preview
                        sx={{
                            maxHeight: "52vh",
                            overflowY: "auto",
                            px: 1.5,
                            py: 1,
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border-subtle)",
                            bgcolor: "background.paper",
                        }}
                    >
                        {preview.status === "loading" ? (
                            <Stack
                                direction='row'
                                spacing={1}
                                sx={{ alignItems: "center", py: 3, justifyContent: "center" }}
                            >
                                <CircularProgress size={16} />
                                <Typography variant='caption' color='text.secondary'>
                                    正在读取笔记…
                                </Typography>
                            </Stack>
                        ) : preview.status === "missing" ? (
                            <Typography variant='body2' color='text.secondary' sx={{ py: 2 }}>
                                这篇笔记已经不在了（可能被删掉了）。可以换一篇重新绑定。
                            </Typography>
                        ) : preview.empty ? (
                            <Typography variant='body2' color='text.secondary' sx={{ py: 2 }}>
                                这篇笔记还是空的。点「编辑」去写点什么。
                            </Typography>
                        ) : (
                            <AttachmentPreviewProvider value={attachmentController}>
                                <Box className='note-preview-body' sx={{ fontSize: 14, lineHeight: 1.75 }}>
                                    {preview.body}
                                </Box>
                            </AttachmentPreviewProvider>
                        )}
                    </Box>
                ) : (
                    <>
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
                {mode === "preview" ? (
                    <>
                        <Button
                            size='small'
                            startIcon={<EditIcon />}
                            variant='contained'
                            disableElevation
                            onClick={handleEdit}
                            disabled={boundId == null || busy}
                        >
                            编辑
                        </Button>
                        <Button
                            size='small'
                            startIcon={<SwapHorizIcon />}
                            onClick={() => setMode("picker")}
                            disabled={busy}
                        >
                            换一篇
                        </Button>
                        <Button
                            size='small'
                            color='inherit'
                            startIcon={<LinkOffIcon />}
                            onClick={handleUnbind}
                            disabled={boundId == null || busy}
                        >
                            解除绑定
                        </Button>
                    </>
                ) : (
                    <Button
                        size='small'
                        startIcon={<AddIcon />}
                        onClick={handleCreate}
                        disabled={!notesBridge || busy || site.id == null}
                    >
                        新建笔记并绑定
                    </Button>
                )}
                <Box sx={{ flexGrow: 1 }} />
                {mode === "picker" ? (
                    <Button
                        size='small'
                        color='inherit'
                        onClick={() => (boundId != null ? setMode("preview") : onClose())}
                        disabled={busy}
                    >
                        {boundId != null ? "返回预览" : "取消"}
                    </Button>
                ) : (
                    <Button size='small' color='inherit' onClick={onClose} disabled={busy}>
                        关闭
                    </Button>
                )}
            </DialogActions>

            {/* 附件预览（只读）：这个弹窗没有 uploadApi，所以不给「编辑 / 重命名」，
                正文预览本来也强调是「看一眼」，要改就点「编辑」进记事本。 */}
            <AttachmentPreviewDialog
                target={attachmentTarget}
                onClose={() => setAttachmentTarget(null)}
                onNotify={notify}
            />
        </Dialog>
    );
}

/** 预览态标题：加载中先用站点侧带来的标题兜底，免得标题栏先空一下 */
function previewTitle(p: Preview, fallbackTitle: string): string {
    if (p.status === "ok") return p.title;
    if (p.status === "missing") return fallbackTitle || "笔记已删除";
    return fallbackTitle || "笔记";
}
