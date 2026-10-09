// src/components/NoteVersionHistoryDialog.tsx
// 版本历史面板（照 inkstone 的 VersionsPanel：左边一列快照、右边与当前正文的行级 diff）。
//
// 之前这里只是一个 Menu（列出「时间 / 标题 · 字数」，点了直接恢复）—— 恢复前
// 看不到这一版到底改了什么，误点一下正文就被覆盖。inkstone 是 880 的弹窗：
//   左列版本列表（最新 / 相对时间 + 完整时间 + 体积），默认选中最新的那条；
//   右栏 diff，顶上一条 `+N / -N`，正文逐行 +/- 着色；
//   底部「关闭 / 恢复此版本」，恢复提示会说明当前内容会先存成新版本。
//
// ⚠️ 列表接口给的 content 是空串（为了不一次拉十几份全文），所以选中某条时才
// 单独去取它的正文（onLoad），这是跟 inkstone 唯一的结构差别（它也是这么做的）。
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HistoryIcon from "@mui/icons-material/History";
import RestoreIcon from "@mui/icons-material/Restore";
import type { NoteRevision } from "../API/types";
import { computeLineDiff } from "../utils/noteDiff";
import { formatWhen, formatWhenFull } from "../utils/noteTime";

export interface NoteVersionHistoryDialogProps {
    open: boolean;
    /** 笔记标题：面板副标题要说明「这是谁的自动存档」 */
    noteTitle: string;
    /** null = 还在读列表 */
    revisions: NoteRevision[] | null;
    /** 当前正文（草稿优先，跟用户屏幕上看到的一致） */
    currentContent: string;
    /** 取某一条版本的完整正文 */
    onLoad: (revisionId: number) => Promise<string | null>;
    /** 恢复某一条版本；返回 true 表示成功 */
    onRestore: (revisionId: number) => Promise<boolean>;
    onClose: () => void;
}

export default function NoteVersionHistoryDialog({
    open,
    noteTitle,
    revisions,
    currentContent,
    onLoad,
    onRestore,
    onClose,
}: NoteVersionHistoryDialogProps) {
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** 换笔记 / 关闭时作废还在飞的请求，避免旧响应盖回来 */
    const epochRef = useRef(0);

    // 打开（或列表刷新）时默认选中最新的那条。
    useEffect(() => {
        if (!open) return;
        epochRef.current += 1;
        setPreview(null);
        setPreviewError(null);
        setBusy(false);
        setSelectedId(revisions && revisions.length > 0 ? revisions[0].id : null);
    }, [open, revisions]);

    // 选中变了就单独拉这一版的正文（列表里那份是空串）。
    useEffect(() => {
        if (!open || selectedId === null) return;
        const epoch = ++epochRef.current;
        setPreview(null);
        setPreviewError(null);
        void onLoad(selectedId).then(content => {
            if (epoch !== epochRef.current) return;
            if (content === null) setPreviewError("这一版的正文读不到了");
            else setPreview(content);
        });
    }, [open, selectedId, onLoad]);

    const diff = useMemo(
        () => (preview === null ? null : computeLineDiff(preview, currentContent)),
        [preview, currentContent]
    );

    const restore = async () => {
        if (selectedId === null || preview === null || previewError || busy) return;
        setBusy(true);
        const ok = await onRestore(selectedId);
        setBusy(false);
        if (ok) onClose();
    };

    const list = revisions ?? [];

    return (
        <Dialog
            open={open}
            onClose={() => !busy && onClose()}
            fullWidth
            maxWidth='md'
            aria-label='版本历史'
            data-version-history='1'
        >
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 1 }}>
                <HistoryIcon fontSize='small' sx={{ opacity: 0.7 }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 15, fontWeight: 600 }}>版本历史</Typography>
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block" }}>
                        {noteTitle || "无标题"} · 改动正文后会自动留档
                    </Typography>
                </Box>
                <Tooltip title='关闭'>
                    <IconButton aria-label='关闭版本历史' size='small' onClick={onClose} disabled={busy}>
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>

            <DialogContent dividers sx={{ p: 0 }}>
                {revisions === null ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                        <CircularProgress size={22} aria-label='正在读取历史版本' />
                    </Box>
                ) : list.length === 0 ? (
                    <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
                        <Typography variant='body2' color='text.secondary'>
                            还没有历史版本（改动正文后会自动留档）
                        </Typography>
                    </Box>
                ) : (
                    <Box
                        sx={{
                            display: "flex",
                            minHeight: 320,
                            maxHeight: "min(60vh, 460px)",
                            overflow: "hidden",
                        }}
                    >
                        {/* 左列：快照列表 */}
                        <Box
                            data-version-list='1'
                            sx={{
                                width: 200,
                                flexShrink: 0,
                                overflowY: "auto",
                                borderRight: "1px solid var(--card-border)",
                                p: 0.5,
                            }}
                        >
                            {list.map((r, index) => {
                                const active = r.id === selectedId;
                                return (
                                    <Box
                                        key={r.id}
                                        role='button'
                                        tabIndex={0}
                                        data-version-item={r.id}
                                        aria-current={active ? "true" : undefined}
                                        onClick={() => setSelectedId(r.id)}
                                        onKeyDown={e => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                setSelectedId(r.id);
                                            }
                                        }}
                                        sx={{
                                            px: 1.25,
                                            py: 0.75,
                                            borderRadius: 1.5,
                                            cursor: "pointer",
                                            bgcolor: active ? "var(--accent-soft)" : "transparent",
                                            color: active ? "text.primary" : "text.secondary",
                                            "&:hover": { bgcolor: "rgba(128,128,128,0.12)" },
                                        }}
                                    >
                                        <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                                            {index === 0 ? "最新" : formatWhen(r.created_at) || "某一版"}
                                        </Typography>
                                        <Typography variant='caption' color='text.secondary' sx={{ display: "block" }}>
                                            {formatWhenFull(r.created_at) || "某一版"} · {r.size ?? 0} 字
                                        </Typography>
                                        <Typography
                                            variant='caption'
                                            color='text.secondary'
                                            sx={{
                                                display: "block",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {r.title || "（无标题）"}
                                        </Typography>
                                    </Box>
                                );
                            })}
                        </Box>

                        {/* 右栏：与当前正文的 diff */}
                        <Box sx={{ flex: 1, minWidth: 0, overflow: "auto", bgcolor: "var(--bg-inset, transparent)" }}>
                            {previewError ? (
                                <Typography variant='body2' color='error' sx={{ p: 3 }}>
                                    {previewError}
                                </Typography>
                            ) : preview === null || diff === null ? (
                                <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                                    <CircularProgress size={22} aria-label='正在读取这一版' />
                                </Box>
                            ) : (
                                <>
                                    <Box
                                        data-diff-summary='1'
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 1.5,
                                            px: 1.5,
                                            py: 0.75,
                                            fontSize: 11.5,
                                            color: "text.secondary",
                                            borderBottom: "1px solid var(--card-border)",
                                            position: "sticky",
                                            top: 0,
                                            bgcolor: "var(--bg-base)",
                                        }}
                                    >
                                        <span>与当前正文的差别</span>
                                        <span data-diff-added style={{ color: "var(--success, #2e7d32)" }}>
                                            +{diff.added}
                                        </span>
                                        <span data-diff-removed style={{ color: "var(--danger, #d32f2f)" }}>
                                            -{diff.removed}
                                        </span>
                                        {diff.simplified && <span>内容较大，用了快速比对</span>}
                                        {diff.added === 0 && diff.removed === 0 && <span>没有差别</span>}
                                    </Box>
                                    <Box
                                        component='pre'
                                        sx={{
                                            m: 0,
                                            p: 1.5,
                                            fontFamily: "monospace",
                                            fontSize: 11.5,
                                            lineHeight: 1.65,
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-word",
                                        }}
                                    >
                                        {diff.lines.map((line, i) => (
                                            <Box
                                                key={i}
                                                data-diff-line={line.kind}
                                                sx={{
                                                    px: 0.5,
                                                    ...(line.kind === "add" && {
                                                        bgcolor: "color-mix(in srgb, #2e7d32 14%, transparent)",
                                                    }),
                                                    ...(line.kind === "remove" && {
                                                        bgcolor: "color-mix(in srgb, #d32f2f 14%, transparent)",
                                                    }),
                                                    ...(line.kind === "same" && { color: "text.disabled" }),
                                                }}
                                            >
                                                <Box
                                                    component='span'
                                                    sx={{ display: "inline-block", width: 12, mr: 1, opacity: 0.6 }}
                                                >
                                                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                                                </Box>
                                                {line.text || " "}
                                            </Box>
                                        ))}
                                    </Box>
                                </>
                            )}
                        </Box>
                    </Box>
                )}
            </DialogContent>

            <DialogActions sx={{ px: 2, py: 1.25, gap: 1 }}>
                <Typography variant='caption' color='text.secondary' sx={{ flex: 1 }}>
                    恢复前，当前内容会自动存成一份新版本。
                </Typography>
                <Button size='small' onClick={onClose} disabled={busy}>
                    关闭
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    data-version-restore='1'
                    startIcon={<RestoreIcon fontSize='small' />}
                    disabled={selectedId === null || preview === null || !!previewError || busy}
                    onClick={() => void restore()}
                >
                    {busy ? "正在恢复…" : "恢复此版本"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
