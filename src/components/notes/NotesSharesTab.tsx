// src/components/notes/NotesSharesTab.tsx
// 记事本设置·分享列表页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 列出所有已分享的笔记：链接、剩余有效期、创建/更新时间，以及复制/打开/管理/撤销。
// 撤销走二次确认；「管理」打开 NoteShareDialog（叠在设置弹窗上，关掉时顺带刷新列表）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import LaunchIcon from "@mui/icons-material/Launch";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import RefreshIcon from "@mui/icons-material/Refresh";
import TuneIcon from "@mui/icons-material/Tune";
import SearchIcon from "@mui/icons-material/Search";
import NoteShareDialog, { type NoteShareApi } from "../NoteShareDialog";
import ConfirmDialog from "../ConfirmDialog";
import { fmtTime } from "./settingsShared";
import type { NoteShareListItem } from "../../API/types";

export interface NotesSharesTabProps {
    shareApi: NoteShareApi;
    onNotify?: (message: string, kind?: "success" | "error") => void;
    onOpenNote?: (noteId: number) => void;
    onClose: () => void;
}

export default function NotesSharesTab({ shareApi, onNotify, onOpenNote, onClose }: NotesSharesTabProps) {
    const [shares, setShares] = useState<NoteShareListItem[] | null>(null);
    const [shareError, setShareError] = useState<string | null>(null);
    const [managing, setManaging] = useState<{ id: number; title: string } | null>(null);
    const [shareKeyword, setShareKeyword] = useState("");
    const [revokeTarget, setRevokeTarget] = useState<{ noteId: number; title: string } | null>(null);

    const reloadShares = useCallback(async () => {
        if (!shareApi) return;
        try {
            setShareError(null);
            setShares(await shareApi.listNoteShares());
        } catch (error) {
            setShares([]);
            setShareError(error instanceof Error ? error.message : "读取分享列表失败");
        }
    }, [shareApi]);
    // 挂载即拉（条件渲染保证只有切到本页才挂载）
    useEffect(() => {
        void reloadShares();
    }, [reloadShares]);

    const filteredShares = useMemo(() => {
        const kw = shareKeyword.trim().toLowerCase();
        if (!kw) return shares ?? [];
        return (shares ?? []).filter(s => (s.title || "").toLowerCase().includes(kw));
    }, [shares, shareKeyword]);
    // 公开分享页路径前缀是 /s/（与 main.tsx 的路由正则、PublicNotePage 注释一致）。
    const shareUrl = (token: string) => `${globalThis.location.origin}/s/${token}`;

    return (
        <>
                            <Box data-settings-shares='1'>
                                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
                                    <Typography variant='subtitle2' sx={{ flex: 1 }}>
                                        分享列表
                                    </Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        查看和管理你创建的公开链接
                                    </Typography>
                                    <IconButton
                                        size='small'
                                        aria-label='刷新分享列表'
                                        data-share-action='refresh'
                                        onClick={() => void reloadShares()}
                                        sx={{ p: 0.25 }}
                                    >
                                        <RefreshIcon fontSize='small' />
                                    </IconButton>
                                </Box>
                                <TextField
                                    fullWidth
                                    size='small'
                                    value={shareKeyword}
                                    onChange={e => setShareKeyword(e.target.value)}
                                    placeholder='搜索分享的笔记标题'
                                    slotProps={{
                                        input: {
                                            // ⚠️ aria-label 必须挂 input：直接写在 TextField 上
                                            // 会被 MUI 摊到外层 FormControl（div）上，读屏与
                                            // 选择器都找不到它（同一个坑踩第二次了）。
                                            "aria-label": '搜索分享的笔记标题',
                                            startAdornment: (
                                                <SearchIcon fontSize='small' sx={{ mr: 0.75, color: "text.disabled" }} />
                                            ),
                                        },
                                    }}
                                    sx={{ mb: 1.5, borderRadius: 2, bgcolor: "var(--neutral-wash)" }}
                                />
                                {shareError && (
                                    <Typography variant='body2' color='error' sx={{ mb: 1 }}>
                                        {shareError}
                                    </Typography>
                                )}
                                {shares === null ? (
                                    <Box sx={{ display: "grid", placeItems: "center", py: 4 }}>
                                        <CircularProgress size={20} />
                                    </Box>
                                ) : filteredShares.length === 0 ? (
                                    <Typography variant='body2' color='text.secondary' sx={{ py: 3, textAlign: "center" }}>
                                        {shareKeyword.trim() ? "没有匹配的分享。" : "还没有分享任何笔记。在笔记的「更多操作」里点「只读分享…」。"}
                                    </Typography>
                                ) : (
                                    filteredShares.map(item => {
                                        const url = shareUrl(item.token);
                                        const expired = item.expires_at !== null && item.expires_at <= Date.now();
                                        return (
                                            <Box
                                                key={item.note_id}
                                                data-share-row={item.note_id}
                                                sx={{
                                                    // --card-border 在 index.css 有定义
                                                    // （= var(--border-hairline)），不需要 fallback
                                                    border: "1px solid var(--card-border)",
                                                    borderRadius: 2,
                                                    px: 1.5,
                                                    py: 1.25,
                                                    mb: 1,
                                                }}
                                            >
                                                {/* 标题行 = 标题按钮（跳笔记）+ 状态徽章，
                                                    布局照 inkstone 的 SharedNotes 行头 */}
                                                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                                                    <Typography
                                                        variant='body2'
                                                        component='button'
                                                        type='button'
                                                        data-share-title={item.note_id}
                                                        onClick={() => {
                                                            // 点标题跳回编辑器（inkstone 的 visitNote）
                                                            onOpenNote?.(item.note_id);
                                                            onClose();
                                                        }}
                                                        sx={{
                                                            fontWeight: 600,
                                                            minWidth: 0,
                                                            flex: 1,
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                            bgcolor: "transparent",
                                                            border: "none",
                                                            font: "inherit",
                                                            p: 0,
                                                            cursor: "pointer",
                                                            textAlign: "left",
                                                            "&:hover": { color: "var(--accent)" },
                                                        }}
                                                    >
                                                        {item.title || "（无标题）"}
                                                    </Typography>
                                                    <Box
                                                        data-share-status={expired ? "expired" : "active"}
                                                        sx={{
                                                            flexShrink: 0,
                                                            borderRadius: 10,
                                                            px: 1,
                                                            py: 0.1,
                                                            fontSize: 10.5,
                                                            fontWeight: 600,
                                                            color: expired ? "text.tertiary" : "var(--accent)",
                                                            bgcolor: expired
                                                                ? "var(--neutral-hover)"
                                                                : "var(--accent-wash)",
                                                        }}
                                                    >
                                                        {expired ? "已过期" : "生效中"}
                                                    </Box>
                                                </Box>
                                                {/* 链接行（inkstone 同一行：图标 + 只读 input，
                                                    聚焦即全选，方便手动复制） */}
                                                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5 }}>
                                                    <LinkIcon sx={{ fontSize: 14, flexShrink: 0, color: "text.tertiary" }} />
                                                    <input
                                                        readOnly
                                                        value={url}
                                                        aria-label={`公开链接：${item.title || "（无标题）"}`}
                                                        onFocus={e => e.currentTarget.select()}
                                                        style={{
                                                            minWidth: 0,
                                                            flex: 1,
                                                            background: "transparent",
                                                            border: "none",
                                                            outline: "none",
                                                            font: "11px/1.5 ui-monospace, monospace",
                                                            color: "inherit",
                                                            textOverflow: "ellipsis",
                                                        }}
                                                    />
                                                </Box>
                                                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mt: 1 }}>
                                                    <Typography variant='caption' color={expired ? "error" : "text.secondary"}>
                                                        {item.expires_at === null
                                                            ? "永久有效"
                                                            : expired
                                                              ? "已过期"
                                                              : `到期于 ${fmtTime(item.expires_at)}`}
                                                    </Typography>
                                                    {fmtTime(item.created_at) && (
                                                        <Typography variant='caption' color='text.disabled'>
                                                            创建于 {fmtTime(item.created_at)}
                                                        </Typography>
                                                    )}
                                                    {item.views != null && (
                                                        <Typography variant='caption' color='text.secondary'>
                                                            浏览 {item.views} 次
                                                        </Typography>
                                                    )}
                                                    <Box sx={{ flex: 1 }} />
                                                    <Button
                                                        size='small'
                                                        startIcon={<LinkIcon fontSize='small' />}
                                                        data-share-action='copy'
                                                        onClick={async () => {
                                                            try {
                                                                await navigator.clipboard.writeText(url);
                                                                onNotify?.("已复制分享链接", "success");
                                                            } catch {
                                                                onNotify?.("复制失败（浏览器拒绝了剪贴板访问）", "error");
                                                            }
                                                        }}
                                                    >
                                                        复制
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        startIcon={<LaunchIcon fontSize='small' />}
                                                        data-share-action='open'
                                                        onClick={() => globalThis.open(url, "_blank", "noopener")}
                                                    >
                                                        打开链接
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        startIcon={<TuneIcon fontSize='small' />}
                                                        data-share-action='manage'
                                                        onClick={() => {
                                                            // 2026-10-08 照 inkstone 的「管理」：打开该笔记的
                                                            // 分享设置（有效期/重生成/撤销），不再是跳回编辑器。
                                                            setManaging({
                                                                id: item.note_id,
                                                                title: item.title || "（无标题）",
                                                            });
                                                        }}
                                                    >
                                                        管理
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        color='error'
                                                        startIcon={<LinkOffIcon fontSize='small' />}
                                                        data-share-action='revoke'
                                                        onClick={() => {
                                                            // inkstone 的撤销也走 confirm：这一步不可逆，
                                                            // 手滑点掉一条正在用的链接很难受。
                                                            setRevokeTarget({
                                                                noteId: item.note_id,
                                                                title: item.title || "（无标题）",
                                                            });
                                                        }}
                                                    >
                                                        撤销链接
                                                    </Button>
                                                </Box>
                                            </Box>
                                        );
                                    })
                                )}
                            </Box>

                {/* 「管理」打开的分享设置（叠在设置弹窗上，inkstone 的 SharePanel 同位）；
                    关掉时顺带刷新分享列表（有效期/撤销可能变了） */}
                {managing !== null && shareApi && (
                    <NoteShareDialog
                        id={managing.id}
                        noteTitle={managing.title}
                        api={shareApi}
                        onClose={() => {
                            setManaging(null);
                            void reloadShares();
                        }}
                    />
                )}

                {/* 分享列表里撤销链接的二次确认（inkstone 用 confirm，同一语义） */}
                {revokeTarget && (
                    <ConfirmDialog
                        open
                        danger
                        title='撤销这条公开链接？'
                        description={`「${revokeTarget.title}」的公开链接会立刻失效，拿到链接的人将无法访问。`}
                        confirmText='撤销链接'
                        onConfirm={async () => {
                            if (!shareApi) return;
                            try {
                                await shareApi.revokeNoteShare(revokeTarget.noteId);
                                onNotify?.("已撤销分享", "success");
                                await reloadShares();
                            } catch (error) {
                                onNotify?.(
                                    "撤销失败：" + (error instanceof Error ? error.message : "未知错误"),
                                    "error"
                                );
                                throw error;
                            }
                        }}
                        onClose={() => setRevokeTarget(null)}
                    />
                )}        </>
    );
}
