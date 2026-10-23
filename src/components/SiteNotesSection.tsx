// src/components/SiteNotesSection.tsx
// 站点设置里的「相关笔记」一小节 —— 站点↔笔记绑定的**站点那一侧**。
//
// 2026-10-23 用户定的口径：**每个网站只绑一篇笔记，并且去掉「[[站名]] 自动关联」那套**。
// 所以这里只剩一件事：显示当前绑的那篇，并且能在这一节里换 / 绑 / 解除。
// （原来那套启发式「正文里提到了站名或网址就算相关」已整个删掉：它靠不住，
//   用户还会疑惑「我明明没绑，它怎么冒出来了」。）
//
// 点已绑定的那个标题 → **弹只读预览**（与卡片角上那颗按钮同一个弹窗），
// 想要改再在预览里点「编辑」跳进记事本（2026-10-23 用户要求：这里也别直接跳走）。
//
// 为什么绑定入口要在三个地方都有（卡片按钮 / 笔记右键 / 这一节）：
// 用户的念头可能从任意一头起 —— 「这个站我记过笔记」「这条笔记是给哪个站写的」
// 「我在编辑这个站，顺手绑一篇」。三处落库都是同一条 `notes.site_id`。
//
// ⚠️ 没接上记事本那座桥时不渲染（不是渲染空壳）：功能缺失要看得出来是「没有」，
// 而不是「有但坏了」。
import { lazy, useEffect, useMemo, useState } from "react";
import { Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import NotesIcon from "@mui/icons-material/Notes";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import type { Site } from "../API/http";
import { useAppConfig } from "../context/appConfigStore";
import { Section } from "./dialogSection";
import ChunkBoundary from "./ChunkBoundary";
import { prefetchChunk } from "../utils/lazyPrefetch";
import { dialogChunks } from "../utils/dialogChunks";

// 预览弹窗按需加载：它带 markdown 渲染层，静态 import 会把那一整包拽进站点设置块。
// 与 SiteCard 里那个 lazy() 指向同一个模块，rolldown 会归进同一个 chunk。
const SiteNoteDialog = lazy(dialogChunks.siteNote);

type NoteRow = { id?: number; title: string; site_id?: number | null };

export default function SiteNotesSection({ site }: { site: Site }) {
    const { notesBridge } = useAppConfig();
    const [notes, setNotes] = useState<NoteRow[] | null>(null);
    const [query, setQuery] = useState("");
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState(false);
    /** 点标题 → 弹只读预览（不是直接跳进记事本） */
    const [previewOpen, setPreviewOpen] = useState(false);
    const [bound, setBound] = useState<{ id: number; title: string } | null>(
        site.note_id != null ? { id: site.note_id, title: site.note_title || "" } : null
    );

    // 绑完 App 会静默重取卡片数据，site 会带着新的 note_id / note_title 回来
    useEffect(() => {
        setBound(site.note_id != null ? { id: site.note_id, title: site.note_title || "" } : null);
    }, [site.note_id, site.note_title]);

    // 列表只在真的要选的时候拉（只是看看当前绑了哪篇就不该多发一次请求）
    useEffect(() => {
        if (!picking || !notesBridge || notes) return;
        let alive = true;
        void (async () => {
            const rows = await notesBridge.list();
            if (alive) setNotes(rows);
        })();
        return () => {
            alive = false;
        };
    }, [picking, notesBridge, notes]);

    const filtered = useMemo(() => {
        if (!notes) return [];
        const q = query.trim().toLowerCase();
        if (!q) return notes;
        return notes.filter(n => (n.title || "").toLowerCase().includes(q));
    }, [notes, query]);

    // 没有桥（记事本能力没接上）就整节不渲染
    if (!notesBridge) return null;

    const bind = async (note: NoteRow) => {
        if (busy || note.id == null || site.id == null) return;
        setBusy(true);
        try {
            await notesBridge.bind(note.id, site.id);
            setBound({ id: note.id, title: note.title || "" });
            setPicking(false);
            setQuery("");
        } finally {
            setBusy(false);
        }
    };

    const unbind = async () => {
        if (busy || bound == null) return;
        setBusy(true);
        try {
            await notesBridge.bind(bound.id, null);
            setBound(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section title='相关笔记'>
            {bound ? (
                <Stack direction='row' spacing={0.5} sx={{ mt: 0.5, alignItems: "center", flexWrap: "wrap" }}>
                    <Button
                        size='small'
                        color='inherit'
                        data-site-note-bound={bound.id}
                        onMouseEnter={() => prefetchChunk("siteNote", dialogChunks.siteNote)}
                        onClick={() => setPreviewOpen(true)}
                        sx={{ justifyContent: "flex-start", textAlign: "left", px: 1, minWidth: 0, maxWidth: 260 }}
                        startIcon={<NotesIcon fontSize='small' color='primary' />}
                    >
                        <Box component='span' sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {bound.title || "未命名笔记"}
                        </Box>
                    </Button>
                    <Box
                        component='span'
                        sx={{
                            flex: "none",
                            fontSize: 10.5,
                            lineHeight: 1.6,
                            px: 0.75,
                            borderRadius: "var(--radius-pill, 999px)",
                            color: "primary.main",
                            bgcolor: "color-mix(in srgb, var(--accent) 12%, transparent)",
                        }}
                    >
                        已绑定
                    </Box>
                    <Box sx={{ flex: 1 }} />
                    <Button
                        size='small'
                        color='inherit'
                        startIcon={<SwapHorizIcon />}
                        data-site-note-swap
                        onClick={() => setPicking(v => !v)}
                        disabled={busy}
                    >
                        {picking ? "收起" : "换一篇"}
                    </Button>
                    <Button
                        size='small'
                        color='inherit'
                        startIcon={<LinkOffIcon />}
                        data-site-note-unbind
                        onClick={() => void unbind()}
                        disabled={busy}
                    >
                        解除
                    </Button>
                </Stack>
            ) : (
                <Stack direction='row' spacing={1} sx={{ mt: 0.5, alignItems: "center" }}>
                    <Typography variant='caption' color='text.secondary'>
                        还没有绑定笔记。
                    </Typography>
                    <Button
                        size='small'
                        data-site-note-bind
                        onClick={() => setPicking(true)}
                        disabled={busy || picking}
                    >
                        绑定笔记
                    </Button>
                </Stack>
            )}

            {picking && (
                <Box sx={{ mt: 1 }}>
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
                            maxHeight: 200,
                            overflowY: "auto",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--radius-md)",
                        }}
                    >
                        {notes === null ? (
                            <Stack
                                direction='row'
                                spacing={1}
                                sx={{ alignItems: "center", justifyContent: "center", py: 2.5 }}
                            >
                                <CircularProgress size={14} />
                                <Typography variant='caption' color='text.secondary'>
                                    正在读取笔记…
                                </Typography>
                            </Stack>
                        ) : filtered.length === 0 ? (
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ display: "block", py: 2.5, textAlign: "center" }}
                            >
                                {notes.length === 0 ? "记事本里还没有笔记" : "没有匹配的笔记"}
                            </Typography>
                        ) : (
                            filtered.map(note => (
                                <Button
                                    key={note.id}
                                    size='small'
                                    color='inherit'
                                    fullWidth
                                    data-site-note-pick={note.id}
                                    disabled={busy || note.id === bound?.id}
                                    onClick={() => void bind(note)}
                                    startIcon={<NotesIcon fontSize='small' />}
                                    sx={{ justifyContent: "flex-start", textAlign: "left", px: 1, borderRadius: 0 }}
                                >
                                    <Box
                                        component='span'
                                        sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                    >
                                        {note.title || "未命名笔记"}
                                    </Box>
                                </Button>
                            ))
                        )}
                    </Box>
                </Box>
            )}

            {previewOpen && (
                <ChunkBoundary>
                    {/* 用当前这一节显示的绑定关系（刚绑完、App 还没重取完时，
                        site.note_id 可能是旧的）*/}
                    <SiteNoteDialog
                        site={bound ? { ...site, note_id: bound.id, note_title: bound.title } : site}
                        onClose={() => setPreviewOpen(false)}
                    />
                </ChunkBoundary>
            )}
        </Section>
    );
}
