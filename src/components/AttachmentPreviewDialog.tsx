// src/components/AttachmentPreviewDialog.tsx
//
// 附件预览弹窗（2026-10-19 用户需求：「点击上传的 txt / json 链接改成在新的
// 弹窗中打开」，随后追加「加上编辑功能」）。
//
// 为什么要有这个东西：正文里插的是 `[文件名](</api/notes/attachments/<id>>)`，
// 点下去以前是**整页跳转**——浏览器直接把 txt 当页面渲染，记事本被顶掉，
// 回退还要重新加载一遍列表；json 更是直接铺一屏没有换行的长串。改成弹窗之后，
// 「看一眼附件」是原地发生的事，不打断正在写的笔记。
//
// 三条设计取舍：
//  1. **不在正文渲染层取字节**：链接上只有 id，没有类型也没有内容。弹窗打开时
//     才 fetch 一次（带凭据），失败给明确占位而不是空白。
//  2. **编辑只对 txt / json 开放**：图片改内容没有意义；第三方类型（理论上
//     不存在的 octet-stream）连预览都只给「下载」。服务端也会再拒一次
//     （worker/routes/data.ts 的 handleUpdateAttachmentContent），前端这层只是
//     少让用户白点。
//  3. **重命名走独立字段而不是改标题**：标题同时承担「显示名」和「保存后刷新」
//     两件事，直接在标题上编辑会让「改完没保存就关掉」变成静默丢失。
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    TextField,
    Tooltip,
    Typography,
    CircularProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DescriptionIcon from "@mui/icons-material/Description";
import EditIcon from "@mui/icons-material/Edit";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "./dialogShell";
import type { AttachmentPreviewRequest } from "../utils/attachmentPreview";

/** 判断一份字节是不是「可以当文本显示」的类型 */
function isTextMime(mime: string): boolean {
    const m = mime.toLowerCase();
    return m.startsWith("text/") || m.includes("json") || m.includes("xml");
}

/** 字节数 → 人类可读（与附件管理器同一套口径） */
function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 超过这个字符数就**只读**（2026-10-19 自查边界情况时补）。
 *
 * 两个理由，都不是性能洁癖：
 *  1. 把 25MB 的日志塞进 `<pre>` 会把标签页卡住几十秒；
 *  2. 更要命的是**数据安全** —— 只显示前 N 个字符却还允许编辑保存的话，
 *     一次「打开 → 改一个字 → 保存」就把剩下的内容全写没了。
 *     所以超过阈值时：预览截断 + 明确说明 + **不给编辑入口**。
 */
const EDITABLE_MAX_CHARS = 400_000;

export default function AttachmentPreviewDialog({
    target,
    onClose,
    onSaveContent,
    onRename,
    onNotify,
    onChanged,
}: {
    /** 要看的附件；null = 关闭。换 id 会自动重新取内容 */
    target: AttachmentPreviewRequest | null;
    onClose: () => void;
    /** 给了才有「编辑 → 保存」；不给就是纯预览（老部署 / 分享页） */
    onSaveContent?: (id: string, text: string) => Promise<{ size: number }>;
    /** 给了才有「重命名」 */
    onRename?: (id: string, filename: string) => Promise<{ filename: string; updatedNotes: number }>;
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
    /**
     * 内容或名字被改过。**带原因**是必须的：改内容不动笔记正文，
     * 重命名会同步改正文里的链接文字 —— 后者才需要外层重拉笔记列表
     * （不重拉的话本地还是旧正文，用户再存一次就把新名字覆盖回去）。
     */
    onChanged?: (reason: "content" | "rename") => void;
}) {
    const [status, setStatus] = useState<"loading" | "ready" | "binary" | "error">("loading");
    const [error, setError] = useState<string | null>(null);
    const [mime, setMime] = useState("");
    const [size, setSize] = useState(0);
    const [text, setText] = useState("");
    /** 服务端当前那份内容：用来判断「有没有改动」，也用来「撤销」 */
    const [saved, setSaved] = useState("");
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");

    /** 显示名：重命名成功后要以服务端返回的为准 */
    const [filename, setFilename] = useState("");
    const idRef = useRef<string | null>(null);

    const id = target?.id ?? null;

    // 取内容。⚠️ 依赖只写 id：目标对象每次渲染都可能是新字面量，
    // 拿它做依赖会无限重取（每取一次 setState 一次）。
    useEffect(() => {
        idRef.current = id;
        if (!id) return;
        let live = true;
        let objectUrl: string | null = null;
        setStatus("loading");
        setError(null);
        setText("");
        setSaved("");
        setImageUrl(null);
        setEditing(false);
        setRenaming(false);
        setFilename(target?.filename ?? "");
        setMime(target?.mime ?? "");
        setSize(0);

        void (async () => {
            try {
                const response = await fetch(`/api/notes/attachments/${encodeURIComponent(id)}`, {
                    credentials: "same-origin",
                });
                if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
                const blob = await response.blob();
                if (!live) return;
                const type = blob.type || "application/octet-stream";
                // ⚠️ 登录过期时整条 /api 会回 SPA 登录页（200 + text/html）。
                // 那种响应按「文本附件」显示出来就是一坨 HTML —— 看起来像附件坏了。
                // 明确当成「会话过期」报出来，用户知道该去重新登录。
                if (type.includes("text/html")) {
                    throw new Error("读到的不是附件内容（可能登录已过期，请刷新页面重新登录）");
                }
                setMime(type);
                setSize(blob.size);
                if (type.startsWith("image/")) {
                    objectUrl = URL.createObjectURL(blob);
                    setImageUrl(objectUrl);
                    setStatus("ready");
                    return;
                }
                if (!isTextMime(type)) {
                    // ⚠️ 登录页 / SPA 兜底也是 200，但类型是 text/html；
                    // 那种情况当文本显示会露出一坨 HTML。这里只放行真的文本类型。
                    setStatus("binary");
                    return;
                }
                const body = await blob.text();
                if (!live) return;
                setText(body);
                setSaved(body);
                setStatus("ready");
            } catch (err) {
                if (!live) return;
                setStatus("error");
                setError(err instanceof Error ? err.message : "附件内容读取失败");
            }
        })();

        return () => {
            live = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    const isImage = mime.startsWith("image/");
    const dirty = status === "ready" && !isImage && text !== saved;
    /**
     * 超大文本：只读。看注释（EDITABLE_MAX_CHARS）——允许编辑等于给「保存时截断」开了口子。
     * 这里判的是**已读到的正文**而不是字节数：一份 25MB 的文件读成字符串同样是 25M 个字符。
     */
    const tooLarge = status === "ready" && !isImage && saved.length > EDITABLE_MAX_CHARS;
    const canEdit =
        Boolean(onSaveContent) && status === "ready" && !isImage && isTextMime(mime) && !tooLarge;
    /** 展示用正文：超大时截断，并在界面上说清楚「看到的是前 N 个字符」 */
    const shownText = tooLarge ? `${text.slice(0, EDITABLE_MAX_CHARS)}\n\n…（已截断，共 ${text.length} 个字符）` : text;

    const downloadHref = useMemo(
        () => (id ? `/api/notes/attachments/${encodeURIComponent(id)}` : ""),
        [id]
    );

    const doSave = async () => {
        if (!id || !onSaveContent || busy) return;
        setBusy(true);
        try {
            const result = await onSaveContent(id, text);
            setSaved(text);
            setSize(result.size);
            setEditing(false);
            onNotify?.("附件内容已保存", "success");
            onChanged?.("content");
        } catch (err) {
            // 失败**不退出编辑态**：用户刚写完的一大段不能因为一次网络错误就没了
            onNotify?.("保存失败：" + (err instanceof Error ? err.message : "未知错误"), "error");
        } finally {
            setBusy(false);
        }
    };

    const doRename = async () => {
        if (!id || !onRename || busy) return;
        const next = renameValue.trim();
        if (!next) {
            onNotify?.("文件名不能为空", "error");
            return;
        }
        setBusy(true);
        try {
            const result = await onRename(id, next);
            setFilename(result.filename);
            setRenaming(false);
            onNotify?.(
                result.updatedNotes > 0
                    ? `已重命名为「${result.filename}」，并同步了 ${result.updatedNotes} 篇笔记里的链接文字`
                    : `已重命名为「${result.filename}」`,
                "success"
            );
            onChanged?.("rename");
        } catch (err) {
            onNotify?.("重命名失败：" + (err instanceof Error ? err.message : "未知错误"), "error");
        } finally {
            setBusy(false);
        }
    };

    /**
     * 关窗。有未保存的改动先问一句 —— 弹窗是「看着看着顺手改两行」的场景，
     * 一个 Esc 就把改动丢掉太容易发生了。
     * ⚠️ 用 window.confirm 而不是再套一层 ConfirmDialog：这里只是「要不要丢」，
     * 不需要影响面与二次确认那一套（而且套了会出现弹窗叠弹窗）。
     */
    const handleClose = () => {
        if (busy) return;
        if (dirty && !window.confirm("还有没保存的修改，确定关闭吗？")) return;
        onClose();
    };

    return (
        <Dialog
            open={Boolean(target)}
            onClose={handleClose}
            maxWidth='md'
            fullWidth
            data-attachment-preview='1'
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx} component='h2'>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, pr: 4 }}>
                    <Box
                        sx={{
                            width: 30,
                            height: 30,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: "10px",
                            color: "primary.main",
                            bgcolor: theme =>
                                theme.palette.mode === "dark"
                                    ? "rgba(255,255,255,0.08)"
                                    : "rgba(15,23,42,0.05)",
                        }}
                    >
                        <DescriptionIcon fontSize='small' />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                        <Typography
                            component='span'
                            sx={{
                                display: "block",
                                fontSize: 15,
                                fontWeight: 600,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                            data-att-filename
                        >
                            {filename || "附件预览"}
                        </Typography>
                        <Typography
                            component='span'
                            sx={{ display: "block", fontSize: 11, color: "text.disabled" }}
                        >
                            {isImage ? "图片" : mime || "未知类型"}
                            {size > 0 ? ` · ${fmtBytes(size)}` : ""}
                            {canEdit ? " · 可直接编辑" : ""}
                        </Typography>
                    </Box>
                </Box>
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        onClick={handleClose}
                        disabled={busy}
                        aria-label='关闭附件预览'
                        sx={{ position: "absolute", right: 10, top: 10 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>

            <DialogContent sx={{ ...dialogContentSx, pt: 1 }}>
                {/* 重命名：独立一行，不和内容编辑混在一起 */}
                {renaming && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
                        <TextField
                            size='small'
                            fullWidth
                            autoFocus
                            value={renameValue}
                            onChange={event => setRenameValue(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === "Enter") void doRename();
                                if (event.key === "Escape") setRenaming(false);
                            }}
                            // 浏览器自动填充会盖住文件名，也会把密码管理器的下拉顶上来
                            slotProps={{ htmlInput: { autoComplete: "off", "data-att-rename-input": "1" } }}
                        />
                        <Button
                            size='small'
                            variant='contained'
                            disableElevation
                            disabled={busy}
                            onClick={() => void doRename()}
                            data-att-action='rename-confirm'
                        >
                            确定
                        </Button>
                        <Button size='small' color='inherit' disabled={busy} onClick={() => setRenaming(false)}>
                            取消
                        </Button>
                    </Box>
                )}

                {status === "loading" && (
                    <Box
                        data-att-state='loading'
                        sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, py: 8 }}
                    >
                        <CircularProgress size={18} />
                        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>正在读取附件…</Typography>
                    </Box>
                )}

                {status === "error" && (
                    <Typography
                        data-att-state='error'
                        sx={{ py: 6, textAlign: "center", fontSize: 12, color: "error.main" }}
                    >
                        {error ?? "附件内容读取失败"}
                    </Typography>
                )}

                {status === "binary" && (
                    <Typography
                        data-att-state='binary'
                        sx={{ py: 6, textAlign: "center", fontSize: 12, color: "text.secondary" }}
                    >
                        这种类型没法在弹窗里预览，可以下载到本地打开。
                    </Typography>
                )}

                {status === "ready" && isImage && imageUrl && (
                    <Box
                        data-att-body='image'
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            bgcolor: "rgba(128,128,128,0.06)",
                            borderRadius: 2,
                            p: 1,
                        }}
                    >
                        <img
                            src={imageUrl}
                            alt={filename || "附件图片"}
                            style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
                        />
                    </Box>
                )}

                {status === "ready" && !isImage && !editing && (
                    <Box
                        component='pre'
                        data-att-body='text'
                        sx={{
                            m: 0,
                            p: 1.5,
                            maxHeight: "60vh",
                            overflow: "auto",
                            borderRadius: 2,
                            bgcolor: "rgba(128,128,128,0.06)",
                            fontFamily:
                                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                            fontSize: 12.5,
                            lineHeight: 1.65,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                        }}
                    >
                        {shownText}
                    </Box>
                )}

                {tooLarge && (
                    <Typography sx={{ mt: 1, fontSize: 11.5, color: "warning.main" }} data-att-too-large='1'>
                        文件较大（{text.length} 个字符），这里只显示前 {EDITABLE_MAX_CHARS} 个，且不支持在线编辑。
                    </Typography>
                )}

                {status === "ready" && !isImage && editing && (
                    <TextField
                        multiline
                        fullWidth
                        // 16 行起步：文本附件通常是一份配置 / 一段日志，
                        // 给的框太小会让人先在弹窗里滚来滚去才看到自己写的位置
                        minRows={16}
                        maxRows={30}
                        value={text}
                        onChange={event => setText(event.target.value)}
                        data-att-editor='1'
                        slotProps={{
                            htmlInput: {
                                autoComplete: "off",
                                spellCheck: false,
                                style: {
                                    fontFamily:
                                        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                                    fontSize: 12.5,
                                    lineHeight: 1.65,
                                },
                            },
                        }}
                    />
                )}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                {onRename && status === "ready" && (
                    <Button
                        size='small'
                        color='inherit'
                        startIcon={<DriveFileRenameOutlineIcon sx={{ fontSize: 15 }} />}
                        disabled={busy || renaming}
                        onClick={() => {
                            setRenameValue(filename);
                            setRenaming(true);
                        }}
                        data-att-action='rename'
                    >
                        重命名
                    </Button>
                )}
                <Button
                    size='small'
                    color='inherit'
                    startIcon={<FileDownloadIcon sx={{ fontSize: 15 }} />}
                    href={downloadHref}
                    // 下载走原始 URL（走鉴权、用 Content-Disposition 里的文件名）
                    download={filename || undefined}
                    disabled={status === "loading" || status === "error"}
                    data-att-action='download'
                >
                    下载
                </Button>
                {canEdit && !editing && (
                    <Button
                        size='small'
                        startIcon={<EditIcon sx={{ fontSize: 15 }} />}
                        disabled={busy}
                        onClick={() => setEditing(true)}
                        data-att-action='edit'
                    >
                        编辑
                    </Button>
                )}
                {dirty && (
                    <Button size='small' color='inherit' disabled={busy} onClick={() => setText(saved)}>
                        撤销修改
                    </Button>
                )}
                {dirty && (
                    <Button
                        size='small'
                        variant='contained'
                        disableElevation
                        disabled={busy}
                        onClick={() => void doSave()}
                        data-att-action='save'
                        startIcon={busy ? <CircularProgress size={14} color='inherit' /> : undefined}
                    >
                        {busy ? "保存中…" : "保存"}
                    </Button>
                )}
                <Button
                    size='small'
                    variant='outlined'
                    color='inherit'
                    onClick={handleClose}
                    disabled={busy}
                    data-att-action='close'
                >
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
