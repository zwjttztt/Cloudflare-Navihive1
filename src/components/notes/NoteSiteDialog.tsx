// src/components/notes/NoteSiteDialog.tsx
// 笔记这一侧的「绑定网站…」（2026-10-23 用户要求：绑定不能只在站点卡片上做）。
//
// 与卡片那一侧（SiteNoteDialog）是**同一件事的两个方向**，落库都是 `notes.site_id`：
//   - 卡片上点笔记按钮 → 选笔记；
//   - 笔记右键 → 绑定网站…（这里）→ 选网站。
// 两个入口都留着，是因为用户的念头可能从任意一头起 —— 「这个站我记过笔记」和
// 「这条笔记是给哪个站写的」都会发生，只放一头就总要绕。
//
// ⚠️ 网站清单不从网络取：App 直接把内存里的分组树摊平递进来（siteLinkApi.list）。
// 带上 note_id / note_title 是为了在这里就把「这个站已经绑了『X』」说清楚 ——
// 不说的话用户点完才发现自己把别的笔记顶掉了。
import { useMemo, useState } from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItemButton,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import LanguageIcon from "@mui/icons-material/Language";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import type { Note } from "../../API/http";
import type { NotesSiteLinkApi } from "./notesPageCtx";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "../dialogShell";

interface Props {
    note: Note;
    siteLinkApi: NotesSiteLinkApi;
    /**
     * 真正的写入交给上层：它要用笔记自己的 `onUpdate`，那样记事本本地的 notes
     * 状态会一起更新（状态栏那行立刻变），然后再让 App 重取卡片。
     */
    onBind: (siteId: number) => Promise<void>;
    /** 解除 = 把这篇笔记的 site_id 清掉 */
    onUnbind: () => Promise<void>;
    onClose: () => void;
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

export default function NoteSiteDialog({ note, siteLinkApi, onBind, onUnbind, onClose, onNotify }: Props) {
    const sites = useMemo(() => siteLinkApi.list(), [siteLinkApi]);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<number | null>(note.site_id ?? null);
    const [busy, setBusy] = useState(false);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return sites;
        return sites.filter(s => (s.name || "").toLowerCase().includes(q));
    }, [sites, query]);

    const run = async (label: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
            onNotify?.(label, "success");
            onClose();
        } catch (error) {
            onNotify?.(error instanceof Error ? error.message : `${label}失败`, "error");
        } finally {
            setBusy(false);
        }
    };

    const handleBind = () => {
        if (picked == null || note.id == null) return;
        const target = sites.find(s => s.id === picked);
        void run(`已绑定到「${target?.name || "网站"}」`, () => onBind(picked));
    };

    const handleUnbind = () => {
        if (note.site_id == null) return;
        void run("已解除绑定", () => onUnbind());
    };

    const title = note.title || "未命名笔记";

    return (
        <Dialog
            open
            onClose={onClose}
            maxWidth='xs'
            fullWidth
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                <Box component='span' sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    绑定网站
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
                <Typography variant='caption' component='div' color='text.secondary' sx={{ mb: 1.25 }}>
                    「{title}」绑定到哪个网站？一个网站最多绑一篇笔记，绑上去会把那个站原来那篇换下来（笔记本身不会删）。
                </Typography>

                <TextField
                    size='small'
                    fullWidth
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder='按网站名筛选'
                    slotProps={{ htmlInput: { "aria-label": "按网站名筛选" } }}
                />

                <Box
                    sx={{
                        mt: 1,
                        maxHeight: 300,
                        overflowY: "auto",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-md)",
                    }}
                >
                    {filtered.length === 0 ? (
                        <Typography
                            variant='caption'
                            color='text.secondary'
                            sx={{ display: "block", py: 3, textAlign: "center" }}
                        >
                            {sites.length === 0 ? "还没有任何网站" : "没有匹配的网站"}
                        </Typography>
                    ) : (
                        <List dense disablePadding>
                            {filtered.map(site => {
                                // 已经被「别的笔记」占着的站要提前说一声：绑上去就会把别人换下来
                                const takenByOther =
                                    site.note_id != null && site.note_id !== note.id
                                        ? site.note_title || "另一篇笔记"
                                        : null;
                                return (
                                    <ListItemButton
                                        key={site.id}
                                        data-site-id={site.id}
                                        selected={site.id === picked}
                                        disabled={busy}
                                        onClick={() => setPicked(site.id ?? null)}
                                        sx={{ gap: 1 }}
                                    >
                                        <LanguageIcon
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
                                            {site.name || "未命名网站"}
                                        </Box>
                                        {takenByOther && (
                                            <Typography
                                                variant='caption'
                                                color='text.secondary'
                                                sx={{
                                                    flex: "none",
                                                    maxWidth: 130,
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                }}
                                                title={`这个站已经绑了「${takenByOther}」`}
                                            >
                                                已绑「{takenByOther}」
                                            </Typography>
                                        )}
                                    </ListItemButton>
                                );
                            })}
                        </List>
                    )}
                </Box>
            </DialogContent>
            <DialogActions sx={dialogActionsSx}>
                {note.site_id != null && (
                    <Button
                        size='small'
                        color='inherit'
                        startIcon={<LinkOffIcon />}
                        onClick={handleUnbind}
                        disabled={busy}
                    >
                        解除绑定
                    </Button>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Button size='small' color='inherit' onClick={onClose} disabled={busy}>
                    取消
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    disableElevation
                    onClick={handleBind}
                    disabled={busy || picked == null || picked === (note.site_id ?? null)}
                >
                    绑定
                </Button>
            </DialogActions>
        </Dialog>
    );
}
