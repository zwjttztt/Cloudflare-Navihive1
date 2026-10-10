// src/components/BacklinksPanel.tsx
// 反向链接右侧常驻面板（N4）：「谁链了我」一屏摊开，每条带上下文摘要。
//
// 为什么从下拉菜单改成常驻面板：双链是记事本的核心卖点，藏在下拉里
// 「点一下看一眼就消失」，可见性差一档。inkstone 的 BacklinksPanel 是
// 工作区右栏常驻，这里照做（与大纲面板同一个位置、同一套观感）。
// 上下文摘要在客户端截取 —— 来源正文本地就持有，没必要为摘要发请求。
import { useMemo } from "react";
import { Box, Typography, IconButton, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { buildBacklinks } from "../utils/noteWikiLink";
import type { Note } from "../API/types";

export interface BacklinksPanelProps {
    open: boolean;
    onClose: () => void;
    notes: Note[];
    currentId?: number;
    currentTitle: string;
    onOpenNote: (id: number) => void;
}

/**
 * 上下文摘要：在来源正文里找到「[[当前标题]]」第一次出现的行，
 * 压掉 Markdown 语法符号、截一段，让人一眼看出「是被哪句话引用的」。
 * 找不到（比如链接写在别的别名里）就退回正文开头一句。
 */
export function wikiContextSnippet(sourceContent: string, targetTitle: string, max = 96): string {
    const key = targetTitle.trim().toLowerCase();
    if (!key) return "";
    const lines = sourceContent.split("\n");
    for (const line of lines) {
        if (line.toLowerCase().includes(`[[${key}`)) {
            const flat = line
                .replace(/```[\s\S]*?```/g, " ")
                .replace(/^#{1,6}\s+/gm, "")
                .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/gm, "")
                .replace(/^>\s?/gm, "")
                .replace(/[*_`~]/g, "")
                .replace(/\s+/g, " ")
                .trim();
            return flat.length > max ? `${flat.slice(0, max)}…` : flat;
        }
    }
    return "";
}

export default function BacklinksPanel({
    open,
    onClose,
    notes,
    currentId,
    currentTitle,
    onOpenNote,
}: BacklinksPanelProps) {
    const items = useMemo(() => {
        if (!open || currentId === undefined) return [];
        return buildBacklinks(notes, { id: currentId, title: currentTitle, content: "" }).map(link => {
            const source = notes.find(n => n.id === link.id);
            return { ...link, snippet: source ? wikiContextSnippet(source.content, currentTitle) : "" };
        });
    }, [open, notes, currentId, currentTitle]);

    if (!open) return null;
    return (
        <Box
            data-backlinks-panel='1'
            sx={{
                width: 230,
                flexShrink: 0,
                borderLeft: "1px solid rgba(128,128,128,0.18)",
                overflowY: "auto",
                py: 1,
                px: 0.75,
            }}
        >
            <Box sx={{ display: "flex", alignItems: "center", px: 1, pb: 0.5 }}>
                <Typography
                    variant='caption'
                    sx={{ flex: 1, fontSize: 11, color: "text.disabled" }}
                >
                    {/* 数量角标直接写进标题：inkstone 的 badge 同款信息，实现更省 */}
                    反向链接（{items.length}）
                </Typography>
                <Tooltip title='收起'>
                    <IconButton
                        size='small'
                        aria-label='收起反向链接面板'
                        data-backlinks-close='1'
                        onClick={onClose}
                        sx={{ width: 22, height: 22, color: "text.disabled" }}
                    >
                        <CloseIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                </Tooltip>
            </Box>
            {items.length === 0 ? (
                <Typography
                    variant='caption'
                    data-backlinks='empty'
                    sx={{ display: "block", px: 1, fontSize: 11.5, color: "text.secondary" }}
                >
                    还没有别的笔记用 [[双链]] 引用这一条
                </Typography>
            ) : (
                items.map(item => (
                    <Box
                        key={item.id}
                        component='button'
                        type='button'
                        data-backlink-item={item.id}
                        onClick={() => onOpenNote(item.id)}
                        sx={{
                            display: "block",
                            width: "100%",
                            appearance: "none",
                            border: "none",
                            m: 0,
                            mb: 0.5,
                            font: "inherit",
                            cursor: "pointer",
                            textAlign: "left",
                            minWidth: 0,
                            px: 1,
                            py: 0.5,
                            borderRadius: 1,
                            bgcolor: "transparent",
                            color: "text.secondary",
                            "&:hover": {
                                bgcolor: "rgba(128,128,128,0.1)",
                                color: "text.primary",
                            },
                        }}
                    >
                        <Typography
                            variant='body2'
                            noWrap
                            sx={{ fontSize: 12.5, fontWeight: 600, color: "inherit" }}
                        >
                            {item.title || "（无标题）"}
                        </Typography>
                        {item.snippet && (
                            <Typography
                                variant='caption'
                                sx={{
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                                fontSize: 11,
                                color: "text.secondary",
                            }}
                            >
                                {item.snippet}
                            </Typography>
                        )}
                    </Box>
                ))
            )}
        </Box>
    );
}
