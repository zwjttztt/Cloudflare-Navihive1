// src/components/AttachmentManager.tsx
//
// 附件管理器 —— **照抄 inkstone 的 AttachmentManager 方案**（2026-10-09 用户要求
// 「管理附件参考 inkstone 的方案，方案要一模一样」）：
//   右侧 420px 抽屉 → 顶部四档筛选（全部 / 图片 / 文档 / 其他）→
//   两列卡片网格（4:3 缩略图；非图片显示文档图标 + 文件名；右上角悬停出现删除）→
//   卡片下方「文件名 / 大小 · 引用 N 次（未引用时警示色）」→
//   底部「已显示 N 个 / 共 N 个 + 加载更多 + 清理未引用附件（带确认）」。
// 删除与清理都是破坏性操作，一律二次确认（inkstone 用 confirm，同一语义）。
//
// 与 inkstone 的两处刻意差异（能力来源不同，不是方案不同）：
//   - 缩略图取图走**带凭据 fetch**（NaviHive 的附件 GET 挂在鉴权后面，<img> 直连
//     在部分部署下 401 —— 与预览里的 NoteImage 同一套三态语义）；
//   - 分页在**前端切片**（listAttachments 一次回元数据全量，行很小；「加载更多 /
//     已显示 N 个」的交互与 inkstone 的游标分页完全一致）。
import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import DescriptionIcon from "@mui/icons-material/Description";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import type { SxProps, Theme } from "@mui/material/styles";
import ConfirmDialog from "./ConfirmDialog";
import { fmtBytes } from "../utils/format";

export interface AttachmentManagerFile {
    id: string;
    size: number;
    width?: number | null;
    height?: number | null;
    filename: string;
    mime: string;
    /**
     * 服务端算好的「被多少条笔记引用」（笔记正文不出库，用 SQL 的 INSTR 数的）。
     * 老部署没有这个字段，会回 undefined —— 那时退回调用方传进来的 countRefs 本地扫。
     */
    ref_count?: number | null;
}

export interface AttachmentManagerApi {
    list(): Promise<AttachmentManagerFile[]>;
    remove(id: string): Promise<void>;
    /** 可选：老部署没有 pruneAttachments 时「清理」按钮不出现 */
    prune?(): Promise<{ removed: number; freedBytes: number }>;
}
type FilterKind = "all" | "image" | "document" | "other";

const FILTERS: { value: FilterKind; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "image", label: "图片" },
    { value: "document", label: "文档" },
    { value: "other", label: "其他" },
];

/** 一页显示多少条：与列表接口解耦的前端分页（见文件头注释） */
const PAGE_SIZE = 50;

/**
 * 卡片缩略图：带凭据 fetch 附件字节转 objectURL（失败给虚线占位，不静默空白）。
 * 卸载/换 id 时 revoke，管理器里图多也不能泄漏。
 */
function AttachmentThumb({ id, filename }: { id: string; filename: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        let objectUrl: string | null = null;
        setUrl(null);
        setFailed(false);
        void (async () => {
            try {
                const response = await fetch(`/api/notes/attachments/${encodeURIComponent(id)}`, {
                    credentials: "same-origin",
                });
                if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
                const blob = await response.blob();
                // 401 的登录页 / SPA 兜底也是 200，但类型是 text/html —— 别当图显示
                if (!blob.type.startsWith("image/")) throw new Error("不是图片");
                objectUrl = URL.createObjectURL(blob);
                if (live) setUrl(objectUrl);
            } catch {
                if (live) setFailed(true);
            }
        })();
        return () => {
            live = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [id]);

    if (url) {
        return (
            <img
                src={url}
                alt={filename}
                loading='lazy'
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
        );
    }
    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 0.5,
                color: failed ? "warning.main" : "text.secondary",
                px: 1,
            }}
        >
            <DescriptionIcon sx={{ fontSize: 26 }} />
            <Typography
                sx={{
                    fontSize: 10,
                    maxWidth: "80%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {failed ? "无法加载" : filename}
            </Typography>
        </Box>
    );
}

/** 分段筛选（inkstone 的 Segmented 同款观感：小号圆角胶囊，选中描边） */
function Segmented({
    value,
    onChange,
    disabled,
}: {
    value: FilterKind;
    onChange: (next: FilterKind) => void;
    disabled: boolean;
}) {
    return (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }} data-att-filter='1'>
            {FILTERS.map(opt => {
                const active = opt.value === value;
                return (
                    <Box
                        key={opt.value}
                        component='button'
                        type='button'
                        data-att-filter-option={opt.value}
                        disabled={disabled}
                        onClick={() => onChange(opt.value)}
                        sx={{
                            px: 1.25,
                            py: 0.4,
                            fontSize: 12,
                            borderRadius: 1.5,
                            cursor: "pointer",
                            appearance: "none",
                            font: "inherit",
                            border: active
                                ? "1px solid var(--accent)"
                                : "1px solid var(--neutral-border)",
                            bgcolor: active ? "var(--accent-wash)" : "transparent",
                            color: active ? "var(--accent)" : "text.secondary",
                        }}
                    >
                        {opt.label}
                    </Box>
                );
            })}
        </Box>
    );
}

const hoverRevealSx: SxProps<Theme> = {
    // 桌面端悬停 / 键盘聚焦时才出现（inkstone 的 md:opacity-0 group-hover 同款）；
    // 触屏没有 hover，opacity 再低也能点。
    opacity: 0,
    transition: "opacity 120ms",
};

/**
 * 附件管理器抽屉。与设置弹窗叠用时 zIndex 必须顶到 Dialog 一档：
 * MUI Drawer 默认 1200、Dialog 1300，不抬的话整个抽屉被设置弹窗压在下面。
 * 同为 1300 时按 DOM 顺序叠放 —— 抽屉晚于设置弹窗挂载（在上），
 * 删除确认 ConfirmDialog 又晚于抽屉挂载（在最上）。
 */
export default function AttachmentManager({
    open,
    onClose,
    mgr,
    countRefs,
    onNotify,
    onChanged,
    onPreview,
}: {
    open: boolean;
    onClose: () => void;
    // ⚠️ 这个 prop 不能叫 `api`：契约守卫（apiContract.dom.test.tsx）会把它扫成
    // 「前端调用了 api.list/api.remove」，逼着 mock/client 实现两个不存在的裸名方法。
    mgr: AttachmentManagerApi;
    /** 附件被多少条笔记引用（0 = 未引用，inkstone 同款警示色） */
    countRefs?: (id: string) => number;
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
    /** 删除 / 清理后回调：数据页要刷新概览统计 */
    onChanged?: () => void;
    /**
     * 点文件名 / 缩略图 → 打开预览弹窗（2026-10-19 用户要求「点击文件名也改成
     * 弹窗预览」）。不传时文件名退回纯文本 —— 分享页 / 老部署没有这个能力。
     */
    onPreview?: (file: AttachmentManagerFile) => void;
}) {
    const [files, setFiles] = useState<AttachmentManagerFile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<FilterKind>("all");
    const [busy, setBusy] = useState(false);
    const [visible, setVisible] = useState(PAGE_SIZE);
    const [deleteTarget, setDeleteTarget] = useState<AttachmentManagerFile | null>(null);
    const [confirmPrune, setConfirmPrune] = useState(false);

    /**
     * 这张附件被多少条笔记引用。
     *
     * ⚠️ 服务端优先：列表现在是摘要档（正文只有开头 200 字），本地扫 notes.content
     * 会**少算** —— 尾巴里的引用数不到，正在用的附件会被显示成「未引用」，
     * 用户照着清理就真删了。所以只要有 ref_count 就信它，本地扫只给老部署兜底。
     */
    const refsOf = useCallback(
        (file: AttachmentManagerFile): number =>
            typeof file.ref_count === "number" ? file.ref_count : countRefs ? countRefs(file.id) : 0,
        [countRefs]
    );

    // 每次打开都重拉（inkstone 同款：open 变化触发 reload）
    useEffect(() => {
        if (!open) return;
        let live = true;
        setFiles(null);
        setError(null);
        setFilter("all");
        setVisible(PAGE_SIZE);
        mgr
            .list()
            .then(list => {
                if (live) setFiles(list);
            })
            .catch(err => {
                if (live) setError(err instanceof Error ? err.message : "读取附件列表失败");
            });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 open 变化时重跑；内部异步逻辑用 live 标志防重复拉取
    }, [open]);

    const isImage = (f: AttachmentManagerFile) => f.mime.startsWith("image/");
    const isDocument = (f: AttachmentManagerFile) => !isImage(f) && f.mime !== "application/octet-stream";

    const filtered = useMemo(() => {
        if (!files) return [];
        switch (filter) {
            case "image":
                return files.filter(isImage);
            case "document":
                return files.filter(isDocument);
            case "other":
                return files.filter(f => !isImage(f) && !isDocument(f));
            default:
                return files;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅依赖 files / filter；isImage / isDocument 是稳定纯函数
    }, [files, filter]);

    const shown = filtered.slice(0, visible);
    const hasMore = filtered.length > visible;

    const doDelete = async () => {
        if (!deleteTarget) return;
        setBusy(true);
        try {
            await mgr.remove(deleteTarget.id);
            setFiles(prev => (prev ?? []).filter(f => f.id !== deleteTarget.id));
            onNotify?.("附件已删除", "success");
            onChanged?.();
        } catch (err) {
            onNotify?.("删除失败：" + (err instanceof Error ? err.message : "未知错误"), "error");
            throw err; // ConfirmDialog 契约：reject 保持打开
        } finally {
            setBusy(false);
            setDeleteTarget(null);
        }
    };

    /**
     * 批量清理未引用附件（删除动作，不可撤销 —— 只在这里调服务端 prune）。
     *
     * 判据与服务端 `ref_count` 同源：服务端数的是**库里的全文**，只会多算不会少算，
     * 所以卡片上显示的「未引用」与它清掉的那批是同一口径 —— 宁可不删，不误删。
     * 前端绝不自己用 notes.content 判一遍再按自己的结论删（摘要档下会漏算）。
     */
    const doPrune = async () => {
        setBusy(true);
        try {
            const result = (await mgr.prune?.()) ?? { removed: 0, freedBytes: 0 };
            // 重新拉一遍列表（被清掉的那些条目要从网格里消失）
            const list = await mgr.list();
            setFiles(list);
            setVisible(PAGE_SIZE);
            onChanged?.();
            onNotify?.(
                result.removed
                    ? `已清理 ${result.removed} 个附件，释放 ${fmtBytes(result.freedBytes)}`
                    : "没有需要清理的附件",
                "success"
            );
        } catch (err) {
            onNotify?.("清理失败：" + (err instanceof Error ? err.message : "未知错误"), "error");
            throw err;
        } finally {
            setBusy(false);
            setConfirmPrune(false);
        }
    };

    return (
        <Drawer
            open={open}
            anchor='right'
            onClose={busy ? undefined : onClose}
            slotProps={{
                paper: {
                    sx: {
                        width: 420,
                        maxWidth: "92vw",
                        borderTopLeftRadius: 12,
                        borderBottomLeftRadius: 12,
                        zIndex: (theme: Theme) => theme.zIndex.modal,
                    },
                },
            }}
            sx={{ zIndex: (theme: Theme) => theme.zIndex.modal }}
            data-attachment-manager='1'
        >
            <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
                {/* 顶部：标题 + 四档筛选 */}
                <Box sx={{ flexShrink: 0, px: 1.5, pt: 1.5, pb: 1, borderBottom: "1px solid var(--neutral-hover)" }}>
                    <Typography sx={{ fontWeight: 600, mb: 1 }}>管理附件</Typography>
                    <Segmented value={filter} onChange={setFilter} disabled={busy} />
                </Box>

                {/* 卡片网格（两列，inkstone 同款） */}
                <Box sx={{ minHeight: 0, flex: 1, overflowY: "auto", p: 1 }}>
                    {error ? (
                        <Typography
                            data-att-state='error'
                            sx={{ px: 3, py: 8, textAlign: "center", fontSize: 12, color: "error.main" }}
                        >
                            {error}
                        </Typography>
                    ) : files === null ? (
                        <Typography data-att-state='loading' sx={{ px: 3, py: 8, textAlign: "center", fontSize: 12, color: "text.secondary" }}>
                            正在读取附件列表…
                        </Typography>
                    ) : files.length === 0 ? (
                        <Typography data-att-state='empty' sx={{ px: 3, py: 10, textAlign: "center", fontSize: 12, color: "text.disabled" }}>
                            还没有上传过任何附件。
                        </Typography>
                    ) : filtered.length === 0 ? (
                        <Typography data-att-state='none-match' sx={{ px: 3, py: 10, textAlign: "center", fontSize: 12, color: "text.disabled" }}>
                            没有符合筛选的附件。
                        </Typography>
                    ) : (
                        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 1 }}>
                            {shown.map(file => {
                                const refs = refsOf(file);
                                return (
                                    <Box
                                        key={file.id}
                                        data-attachment-row={file.id}
                                        // 整张卡片都是预览入口（2026-10-21 用户要求）：
                                        // 之前只有下面那行文件名能点，缩略图那一大块点了没反应 ——
                                        // 卡片长得像个按钮，点上去却什么都不发生，比没有按钮更让人困惑。
                                        // ⚠️ 键盘可达性由下面那个真 <button> 负责（Tab 只停一次），
                                        // 这里只补指针点击，不再加 tabIndex/role —— 否则同一个动作会
                                        // 在 Tab 序列里出现两次。
                                        onClick={onPreview ? () => onPreview(file) : undefined}
                                        sx={{
                                            overflow: "hidden",
                                            borderRadius: 2,
                                            border: "1px solid var(--neutral-hairline)",
                                            bgcolor: "var(--neutral-wash)",
                                            cursor: onPreview ? "pointer" : "default",
                                            "&:hover .att-del, &:focus-within .att-del": { opacity: 1 },
                                        }}
                                    >
                                        <Box
                                            sx={{
                                                position: "relative",
                                                aspectRatio: "4 / 3",
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                overflow: "hidden",
                                                bgcolor: "var(--neutral-wash)",
                                            }}
                                        >
                                            {isImage(file) ? (
                                                <AttachmentThumb id={file.id} filename={file.filename} />
                                            ) : (
                                                <Box
                                                    sx={{
                                                        display: "flex",
                                                        flexDirection: "column",
                                                        alignItems: "center",
                                                        gap: 0.5,
                                                        color: "text.secondary",
                                                        px: 1,
                                                    }}
                                                >
                                                    <DescriptionIcon sx={{ fontSize: 26 }} />
                                                    <Typography
                                                        sx={{
                                                            fontSize: 10,
                                                            maxWidth: "80%",
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                        }}
                                                    >
                                                        {file.filename}
                                                    </Typography>
                                                </Box>
                                            )}
                                            <Box sx={{ position: "absolute", top: 6, right: 6, ...hoverRevealSx }} className='att-del'>
                                                <IconButton
                                                    size='small'
                                                    aria-label={`删除 ${file.filename}`}
                                                    data-attachment-action='delete'
                                                    disabled={busy}
                                                    onClick={event => {
                                                        // 卡片整块可点了，删除按钮必须掐断冒泡，
                                                        // 否则「点删除」会先弹出预览窗再弹确认框
                                                        event.stopPropagation();
                                                        setDeleteTarget(file);
                                                    }}
                                                    sx={{
                                                        bgcolor: "background.paper",
                                                        border: "1px solid var(--neutral-border)",
                                                        "&:hover": { color: "error.main" },
                                                    }}
                                                >
                                                    <DeleteIcon sx={{ fontSize: 15 }} />
                                                </IconButton>
                                            </Box>
                                        </Box>
                                        <Box sx={{ px: 1, py: 0.75 }}>
                                            {/* 文件名 = 预览入口（2026-10-19）。
                                                ⚠️ 用真 <button> 而不是给 Typography 挂 onClick：
                                                键盘用户要能 Tab 到它、回车打开，与 NavRow 同一套道理。
                                                没有 onPreview 时退回纯文本，不出现「看得见点不动」的死按钮。 */}
                                            {onPreview ? (
                                                <Box
                                                    component='button'
                                                    type='button'
                                                    data-attachment-action='preview'
                                                    title={`预览 ${file.filename || "附件"}`}
                                                    onClick={event => {
                                                        // 卡片外层也挂了同一个动作，这里掐掉冒泡，避免调两次
                                                        event.stopPropagation();
                                                        onPreview(file);
                                                    }}
                                                    sx={{
                                                        display: "block",
                                                        width: "100%",
                                                        p: 0,
                                                        m: 0,
                                                        border: "none",
                                                        background: "none",
                                                        font: "inherit",
                                                        textAlign: "left",
                                                        cursor: "pointer",
                                                        fontSize: 11.5,
                                                        color: "text.secondary",
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                        borderRadius: 0.5,
                                                        "&:hover": { color: "primary.main" },
                                                        "&:focus-visible": {
                                                            outline: "2px solid var(--accent)",
                                                            outlineOffset: 1,
                                                        },
                                                    }}
                                                >
                                                    {file.filename || "(未命名)"}
                                                </Box>
                                            ) : (
                                                <Typography
                                                    sx={{
                                                        fontSize: 11.5,
                                                        color: "text.secondary",
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {file.filename || "(未命名)"}
                                                </Typography>
                                            )}
                                            <Typography
                                                sx={{
                                                    fontSize: 10.5,
                                                    display: "flex",
                                                    gap: 0.5,
                                                    color: refs > 0 ? "text.disabled" : "warning.main",
                                                }}
                                            >
                                                <span>{fmtBytes(file.size || 0)}{file.width && file.height ? ` · ${file.width}×${file.height}` : ""}</span>
                                                <span aria-hidden='true'>·</span>
                                                <span>{refs > 0 ? `引用 ${refs} 次` : "未引用"}</span>
                                            </Typography>
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Box>
                    )}
                </Box>

                {/* 底部：计数 + 加载更多 + 清理（inkstone 同款布局） */}
                <Box
                    sx={{
                        flexShrink: 0,
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 1,
                        borderTop: "1px solid var(--neutral-hover)",
                        px: 1.5,
                        py: 1,
                    }}
                >
                    <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
                        {files !== null ? (hasMore ? `已显示 ${shown.length} 个` : `共 ${filtered.length} 个`) : ""}
                    </Typography>
                    <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
                        {hasMore && (
                            <Button
                                size='small'
                                disabled={busy}
                                data-attachment-action='load-more'
                                onClick={() => setVisible(v => v + PAGE_SIZE)}
                            >
                                加载更多
                            </Button>
                        )}
                        {mgr.prune && (
                            <Button
                                size='small'
                                variant='outlined'
                                startIcon={<AutoAwesomeIcon sx={{ fontSize: 15 }} />}
                                disabled={busy || files === null}
                                data-attachment-action='prune'
                                onClick={() => setConfirmPrune(true)}
                            >
                                清理
                            </Button>
                        )}
                    </Box>
                </Box>
            </Box>

            {/* 删除单条：二次确认（措辞与原管理器一致，用例钉着） */}
            {deleteTarget && (
                <ConfirmDialog
                    open
                    danger
                    title='删除这个附件？'
                    description={`「${deleteTarget.filename}」将被永久删除；引用了它的笔记里会显示加载失败的占位。`}
                    confirmText='删除'
                    onConfirm={doDelete}
                    onClose={() => setDeleteTarget(null)}
                />
            )}

            {/* 清理未引用：二次确认（inkstone 的 cleanup_confirm 同语义） */}
            {confirmPrune && (
                <ConfirmDialog
                    open
                    danger
                    title='清理未引用附件？'
                    // ⚠️ 文案别写「图片」：清理判据是 `corpus.includes(id)`（见
                    // API/methods/notes.ts 的 pruneAttachments），**与文件类型无关**，
                    // txt / json 一样会被清。2026-10-19 用户指出提示漏了文档。
                    description='只删除不再出现在任何笔记正文里的附件（图片、txt / json 文档等）；正在使用的附件不受影响。'
                    confirmText='清理'
                    onConfirm={doPrune}
                    onClose={() => setConfirmPrune(false)}
                />
            )}
        </Drawer>
    );
}
