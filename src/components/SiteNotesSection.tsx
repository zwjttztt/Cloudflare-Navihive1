// src/components/SiteNotesSection.tsx
// 站点设置里的「相关笔记」一小节 —— D2 双向绑定的**站点那一侧**。
//
// 判据在 utils/siteNoteLink.ts：笔记正文里写了 `[[这个站名]]`、写了它的网址，
// 或者出现了站名，就算相关。站名/网址的归一化与笔记侧点 `[[站点]]` 时
// 用的是同一份（utils/siteMatch.ts）—— 两边不会各说各话
// （「笔记里点得开、站点里列不出」这种最难查）。
//
// ⚠️ 没接上记事本那座桥时不渲染（不是渲染空壳）：功能缺失要看得出来是「没有」，
// 而不是「有但坏了」。
import { useEffect, useState } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import NotesIcon from "@mui/icons-material/Notes";
import type { Site } from "../API/http";
import { useAppConfig } from "../context/appConfigStore";
import { notesMentioningSite } from "../utils/siteNoteLink";
import { Section } from "./dialogSection";

interface RelatedNote {
    id: number;
    title: string;
}

export default function SiteNotesSection({ site }: { site: Site }) {
    const { notesBridge } = useAppConfig();
    const [notes, setNotes] = useState<RelatedNote[] | null>(null);
    const [loading, setLoading] = useState(false);

    // 站名 / 网址任一变化都要重算：改了站名之后，老笔记里的 `[[老名字]]`
    // 就不再指向它了 —— 这是预期的（用户改名就是要切断这条关联）。
    const name = site.name || "";
    const url = site.url || "";
    useEffect(() => {
        if (!notesBridge || !name) {
            setNotes(null);
            return;
        }
        let alive = true;
        setLoading(true);
        void (async () => {
            try {
                const hits = await notesBridge.search(name, 50);
                if (!alive) return;
                setNotes(notesMentioningSite(hits, { id: site.id, name, url }));
            } catch {
                // 搜索端点不存在 / 网络不通：显示为空，不弹错 ——
                // 这只是一小节附加信息，不该因为它挡住整屏设置
                if (alive) setNotes([]);
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [notesBridge, site.id, name, url]);

    // 没有桥（记事本能力没接上）就整节不渲染
    if (!notesBridge) return null;

    return (
        <Section
            title='相关笔记'
            hint='正文里写了这个站名（[[站名]]）或它的网址的笔记。点一下直接跳到那条笔记。'
        >
            {loading && notes === null ? (
                <Stack direction='row' spacing={1} sx={{ mt: 0.5, alignItems: "center" }}>
                    <CircularProgress size={14} />
                    <Typography variant='caption' color='text.secondary'>
                        正在找提到它的笔记…
                    </Typography>
                </Stack>
            ) : !notes || notes.length === 0 ? (
                <Typography variant='caption' color='text.secondary'>
                    还没有笔记提到它。在笔记里打 <Box component='span' sx={{ fontFamily: "monospace" }}>[[{name || "站名"}]]</Box> 就能关联上。
                </Typography>
            ) : (
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                    {notes.map(note => (
                        <Button
                            key={note.id}
                            size='small'
                            color='inherit'
                            data-site-note={note.id}
                            onClick={() => notesBridge.open(note.id)}
                            sx={{ justifyContent: "flex-start", textAlign: "left", px: 1 }}
                            startIcon={<NotesIcon fontSize='small' />}
                        >
                            <Box
                                component='span'
                                sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {note.title}
                            </Box>
                        </Button>
                    ))}
                </Stack>
            )}
        </Section>
    );
}
