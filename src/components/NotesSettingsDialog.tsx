// src/components/NotesSettingsDialog.tsx
// 记事本自己的设置（左下角齿轮打开）—— **不与导航站设置页共用**。
//
// 导航站的设置是站点级的（标题、背景、账号、安全）；记事本要的是「阅读与书写
// 习惯」：字号、行高、强调色、编辑器字体、行号……两拨配置毫无交集，塞同一个
// 弹窗只会让两边都变长。所以这里是独立弹窗，样式参考 inkstone：左侧一列小节、
// 右侧是「一行标签 + 一行控件」的设置行，底部给效果预览。
//
// 只放**真的会生效**的开关：每个控件都能说出它改了哪个渲染行为；
// 「存了没用」的假开关比缺一个功能更糟。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import CircularProgress from "@mui/material/CircularProgress";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import PaletteIcon from "@mui/icons-material/Palette";
import TuneIcon from "@mui/icons-material/Tune";
import ShareIcon from "@mui/icons-material/Share";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import LaunchIcon from "@mui/icons-material/Launch";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import LinkIcon from "@mui/icons-material/Link";
import StorageIcon from "@mui/icons-material/Storage";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import NoteShareDialog, { type NoteShareApi } from "./NoteShareDialog";
import AttachmentManager from "./AttachmentManager";
import ConfirmDialog from "./ConfirmDialog";
import { FOLDER_COLORS } from "../utils/folderAppearance";
import type { NotesUiSettings } from "../utils/notesSettings";
import type {
    NoteImportStats,
    NotesBackupRun,
    NotesBackupSavePatch,
    NotesBackupState,
    NotesImportPayload,
    NoteShareListItem,
    NoteStats,
    WebDavErrorCode,
} from "../API/types";

type SettingsTab = "appearance" | "editor" | "data" | "shares" | "backup";

/** 数据页统计（2026-10-08 照 inkstone 的 DataSettings，精简到现有端点能做到的） */
export interface NotesDataTab {
    stats: {
        notes: number;
        folders: number;
        tags: number;
        /** 全站正文总字数（inkstone 概览里的「总字数」；前端按正文现算） */
        words: number;
        /** null = 回收站还没拉过 / 老部署没有 */
        trashed: number | null;
    };
    onExportAll: () => void;
    /**
     * 导出 zip（含图片附件，2026-10-09）。
     * 可选：后端没配附件存储时没有附件可打包，这一行就不出现。
     */
    onExportZip?: () => Promise<void>;
    /**
     * 导入一个文件：`.json`（老格式）或 `.zip`（含附件，导出 zip 打出来的那种）。
     * 与 onImportNotes 的区别：这个接的是**原始文件**，zip 要解包、附件要回传，
     * 不是前端能直接 JSON.parse 的。
     */
    onImportFile?: (file: File) => Promise<NoteImportStats>;
    onEmptyTrash: () => Promise<void>;
    /** 可选：老部署的 api 没有附件方法，相应能力自动隐藏 */
    onLoadAttachments?: () => Promise<
        { id: string; size: number; filename: string; mime: string }[]
    >;
    onPruneAttachments?: () => Promise<{ removed: number; freedBytes: number }>;
    /** 删除单个附件（附件管理器里用）。可选：老部署没有就整个管理器不出现 */
    onDeleteAttachment?: (id: string) => Promise<void>;
    /**
     * 附件被多少条笔记引用（0 = 未引用）。NotesPage 从已加载的笔记正文里现算，
     * 可选：不给的话管理器里不显示引用数（inkstone 的 references 同格）。
     */
    countAttachmentRefs?: (id: string) => number;
    /**
     * 「双链 / 版本历史」两格的全站计数（inkstone 的 stats.links / stats.versions）。
     * 可选：老部署的 api 没有 notes/stats 端点，两格自动显示「—」。
     */
    onNotesStats?: () => Promise<NoteStats>;
    /**
     * 导入「记事本导出」JSON（exportAllData 的形状）：按 uuid 合并、较新者胜。
     * 可选：老部署没有 notes/import 端点时整行不出现。失败抛错，消息直接给用户。
     */
    onImportNotes?: (payload: NotesImportPayload) => Promise<NoteImportStats>;
    /**
     * 备份页（2026-10-09 照 inkstone 的 BackupSettings）。可选：老部署没有
     * notesBackup 端点 / 配置读写时整页不出现。备份与导航页的分开（独立目录 /
     * 独立文件名 / 独立频率与保留），网盘配置自动带入导航页已保存的那套。
     */
    onNotesBackupGetState?: () => Promise<NotesBackupState>;
    onNotesBackupSave?: (patch: NotesBackupSavePatch) => Promise<void>;
    onNotesBackupTest?: () => Promise<{ success: boolean; message: string }>;
    onNotesBackupRun?: () => Promise<{ success: boolean; message: string }>;
    /**
     * 备份闭环的另一半：从网盘**取回**备份并恢复（2026-10-09）。
     * 两个都可选 —— 老部署没有这两个端点时「从网盘恢复」这一节整段不出现。
     */
    onNotesBackupListRemote?: () => Promise<{
        success: boolean;
        files: { name: string; size: number; lastModified: string }[];
        message: string;
    }>;
    onNotesBackupFetch?: (filename: string, password: string) => Promise<{
        success: boolean;
        message: string;
        payload?: NotesImportPayload;
        code?: WebDavErrorCode;
    }>;
    /**
     * 删除网盘上的一份备份文件（最近备份的删除按钮，2026-10-10）。
     * 可选：老部署没有该端点时只删本地记录，不删网盘文件。
     */
    onNotesBackupDeleteRemote?: (filename: string) => Promise<{
        success: boolean;
        message: string;
    }>;
}

/** 一行设置：左标签（+可选说明）、右控件 —— inkstone 的设置行样式 */
function SettingRow({
    label,
    description,
    children,
}: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                py: 1.25,
                borderBottom: "1px solid rgba(128,128,128,0.12)",
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant='body2'>{label}</Typography>
                {description && (
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.25 }}>
                        {description}
                    </Typography>
                )}
            </Box>
            <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 0.75 }}>{children}</Box>
        </Box>
    );
}

/** 附件字节数 → 人类可读（数据页「附件占用」用） */
/** 时间戳 →「2026-10-08 14:30」。兼容数字与字符串（D1 里两种都可能出现） */
function fmtTime(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "";
    const ts = typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n: number): string {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

/** 一组互斥的小段选择（暖纸/纯白 那种样式）：选中项描强调色 */
function SegOptions<T extends string>({
    value,
    options,
    onChange,
    dataKey,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    dataKey: string;
}) {
    return (
        <Box sx={{ display: "flex", gap: 0.5 }}>
            {options.map(opt => {
                const active = opt.value === value;
                return (
                    <Box
                        key={opt.value}
                        component='button'
                        type='button'
                        data-setting={`${dataKey}:${opt.value}`}
                        onClick={() => onChange(opt.value)}
                        sx={{
                            px: 1.25,
                            py: 0.4,
                            fontSize: 12,
                            borderRadius: 1.5,
                            cursor: "pointer",
                            appearance: "none",
                            font: "inherit",
                            border: active ? "1px solid var(--accent)" : "1px solid rgba(128,128,128,0.35)",
                            bgcolor: active ? "rgba(176,67,58,0.08)" : "transparent",
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

export interface NotesSettingsDialogProps {
    open: boolean;
    settings: NotesUiSettings;
    onChange: (next: NotesUiSettings) => void;
    onClose: () => void;
    /**
     * 分享列表要用的方法。没传就不显示「分享列表」这一页（老部署/未登录）。
     * 只取这四个，别把整个 api 塞进来 —— 设置弹窗不该有权限去干别的事。
     * 2026-10-08 起「管理」直接打开该笔记的分享设置（NoteShareDialog，
     * 与 inkstone 的「管理 → SharePanel」同语义），所以补上 get/create 两个。
     */
    shareApi?: NoteShareApi | null;
    /** 撤销后回执（成功/失败都提示一下，别让用户猜） */
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
    /** 打开某条笔记（分享列表里点笔记标题跳回编辑器；「管理」开分享设置） */
    onOpenNote?: (id: number) => void;
    /** 数据页（概览 / 导出 / 维护）。没传就不显示「数据」这一页 */
    data?: NotesDataTab;
}

export default function NotesSettingsDialog({
    open,
    settings,
    onChange,
    onClose,
    shareApi = null,
    onNotify,
    onOpenNote,
    data,
}: NotesSettingsDialogProps) {
    const [tab, setTab] = useState<SettingsTab>("appearance");
    // ---- 数据页（2026-10-08 照 inkstone 的 DataSettings）----
    const [attStats, setAttStats] = useState<{ count: number; bytes: number } | null>(null);
    // 附件管理器（inkstone 的 AttachmentManager 同位）：列表 / 删除 / 清理都在
    // AttachmentManager 抽屉里自持，这里只留概览统计。
    const [attManagerOpen, setAttManagerOpen] = useState(false);
    /** 分享列表里要撤销的那条（inkstone 的 confirm 同语义） */
    const [revokeTarget, setRevokeTarget] = useState<{ noteId: number; title: string } | null>(
        null
    );
    const [sharesCount, setSharesCount] = useState<number | null>(null);
    /** 「双链 / 版本历史」全站计数（后端 notes/stats；老部署没有 → null 显示「—」） */
    const [noteStats, setNoteStats] = useState<NoteStats | null>(null);
    // 导入笔记：走隐藏的 file input（真机测 <input type=file> 也不能 input.click()
    // 之外的方式触发；这里由按钮 ref.click() 调起，读文件后整包交给后端合并）
    const importFileRef = useRef<HTMLInputElement>(null);
    const [importBusy, setImportBusy] = useState(false);

    const handleImportFile = async (file: File | null | undefined) => {
        if (!file || !dataRef.current?.onImportNotes) return;
        setImportBusy(true);
        try {
            let r: NoteImportStats;
            // zip（含附件）走整条链路：解包 → 附件回传 → id 重映射 → 导入
            if (dataRef.current.onImportFile && /\.zip$/i.test(file.name)) {
                r = await dataRef.current.onImportFile(file);
            } else {
                let parsed: NotesImportPayload;
                try {
                    parsed = JSON.parse(await file.text()) as NotesImportPayload;
                } catch {
                    throw new Error("文件不是有效的 JSON");
                }
                if (!parsed || !Array.isArray(parsed.notes)) {
                    throw new Error("文件里没有笔记数据（请选择本工具导出的笔记 JSON）");
                }
                r = await dataRef.current.onImportNotes(parsed);
            }
            onNotify?.(
                `导入完成：新增 ${r.created} 条，更新 ${r.updated} 条，保留本地 ${r.skipped} 条`,
                "success"
            );
        } catch (error) {
            onNotify?.("导入失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setImportBusy(false);
            // 清空 value：同一个文件选第二次也要能触发 change
            if (importFileRef.current) importFileRef.current.value = "";
        }
    };
    const [confirmKind, setConfirmKind] = useState<
        "trash" | "prune" | "backup-run" | null
    >(null);
    /** 待删除的那条「最近备份」记录（ConfirmDialog 里用） */
    const [deleteRunTarget, setDeleteRunTarget] = useState<NotesBackupRun | null>(null);
    // ---- 分享列表（2026-07-07 参考 inkstone 新增）----
    const [shares, setShares] = useState<NoteShareListItem[] | null>(null);
    const [shareError, setShareError] = useState<string | null>(null);
    /** 「管理」打开的那条分享（NoteShareDialog，inkstone 的 SharePanel 同位） */
    const [managing, setManaging] = useState<{ id: number; title: string } | null>(null);
    const [shareKeyword, setShareKeyword] = useState("");
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
    // 打开设置或切到这一页时才拉 —— 首屏不需要它
    useEffect(() => {
        if (open && tab === "shares") void reloadShares();
    }, [open, tab, reloadShares]);
    // 数据页打开时拉一次附件统计与分享数（都是轻量读；data 回调用 ref 持有，
    // 避免 NotesPage 每次重渲染都重拉）
    const dataRef = useRef(data);
    dataRef.current = data;
    /** 数据页概览统计要重算时用（管理器里删除/清理后回调） */
    const reloadAttStats = useCallback(async () => {
        const cur = dataRef.current;
        if (!cur?.onLoadAttachments) return;
        try {
            const list = await cur.onLoadAttachments();
            setAttStats({
                count: list.length,
                bytes: list.reduce((s, a) => s + (a.size || 0), 0),
            });
        } catch {
            setAttStats(null);
        }
    }, []);
    useEffect(() => {
        if (!open || tab !== "data") return;
        let live = true;
        const cur = dataRef.current;
        if (cur?.onLoadAttachments) {
            cur
                .onLoadAttachments()
                .then(list => {
                    if (!live) return;
                    setAttStats({
                        count: list.length,
                        bytes: list.reduce((s, a) => s + (a.size || 0), 0),
                    });
                })
                .catch(() => {
                    if (live) setAttStats(null);
                });
        } else {
            setAttStats(null);
        }
        if (shareApi) {
            shareApi
                .listNoteShares()
                .then(list => {
                    if (live) setSharesCount(list.length);
                })
                .catch(() => {
                    if (live) setSharesCount(null);
                });
            // 「双链 / 版本历史」两格的全站计数：后端现算（前端不持有全量正文）。
            // 老部署没有 notesStats 方法 → 保持 null，两格显示「—」。
            if (shareApi.notesStats) {
                shareApi
                    .notesStats()
                    .then(s => {
                        if (live) setNoteStats(s);
                    })
                    .catch(() => {
                        if (live) setNoteStats(null);
                    });
            }
        }
        return () => {
            live = false;
        };
    }, [open, tab, shareApi, reloadAttStats]);

    // ---- 备份页（2026-10-09 照 inkstone 的 BackupSettings）----
    const [backupState, setBackupState] = useState<NotesBackupState | null>(null);
    const [backupError, setBackupError] = useState<string | null>(null);
    const [backupBusy, setBackupBusy] = useState(false);
    const [backupTestResult, setBackupTestResult] = useState<{
        success: boolean;
        message: string;
    } | null>(null);
    /** 展开的那条运行记录（inkstone 的 RunRow 同交互） */
    const [expandedRun, setExpandedRun] = useState<string | null>(null);
    /** 目录 / 口令输入框草稿：失焦才写回（不逐键打配置接口） */
    const [pathDraft, setPathDraft] = useState("");
    const [pwdDraft, setPwdDraft] = useState("");
    // ---- 从网盘恢复（2026-10-09，备份闭环的另一半）----
    // 网盘上现在有哪些备份文件；null = 还没列过（不自动列，免得每次进设置页都打网盘）
    const [remoteFiles, setRemoteFiles] = useState<
        { name: string; size: number; lastModified: string }[] | null
    >(null);
    const [remoteError, setRemoteError] = useState<string | null>(null);
    /** 待恢复的那份：弹口令框用 */
    const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
    const [restorePwd, setRestorePwd] = useState("");
    const [restoreBusy, setRestoreBusy] = useState(false);

    const listRemoteBackups = async () => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupListRemote || backupBusy || restoreBusy) return;
        setBackupBusy(true);
        setRemoteError(null);
        try {
            const r = await cur.onNotesBackupListRemote();
            if (r.success) setRemoteFiles(r.files ?? []);
            else {
                setRemoteFiles(null);
                setRemoteError(r.message || "没能列出网盘备份");
            }
        } catch (error) {
            setRemoteFiles(null);
            setRemoteError(error instanceof Error ? error.message : "没能列出网盘备份");
        } finally {
            setBackupBusy(false);
        }
    };

    /**
     * 真恢复：下载 → 解密 → 交给同一条导入（onImportNotes）。
     *
     * ⚠️ 加密备份缺口令时后端回 code==='encrypted'，此时不报错、改成弹口令框；
     * 口令错了是 'badPassword'，留在框里让用户重填（不清空已输入的文件名）。
     */
    const doRestore = async (filename: string, password: string) => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupFetch || !cur.onImportNotes || restoreBusy) return;
        setRestoreBusy(true);
        try {
            const r = await cur.onNotesBackupFetch(filename, password);
            if (r.code === "encrypted") {
                setRestoreTarget(filename);
                setRemoteError(r.message || "这份备份加密了，请输入备份密码");
                return;
            }
            if (!r.success || !r.payload) {
                setRemoteError(r.message || "取回备份失败");
                return;
            }
            const stats = await cur.onImportNotes(r.payload);
            setRemoteError(null);
            setRestoreTarget(null);
            setRestorePwd("");
            onNotify?.(
                `已从网盘恢复：新增 ${stats.created ?? 0} 条、更新 ${stats.updated ?? 0} 条`,
                "success"
            );
        } catch (error) {
            setRemoteError(error instanceof Error ? error.message : "恢复失败");
        } finally {
            setRestoreBusy(false);
        }
    };

    const reloadBackupState = useCallback(async () => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupGetState) return;
        try {
            setBackupError(null);
            const state = await cur.onNotesBackupGetState();
            setBackupState(state);
            setPathDraft(state.path);
            setPwdDraft(state.backupPassword);
        } catch (error) {
            setBackupState(null);
            setBackupError(error instanceof Error ? error.message : "读取备份配置失败");
        }
    }, []);
    // 切到这一页时才拉配置（都是轻量读，但首屏不需要它们）
    useEffect(() => {
        if (open && tab === "backup") void reloadBackupState();
    }, [open, tab, reloadBackupState]);

    const saveBackupField = async (patch: NotesBackupSavePatch) => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupSave) return;
        setBackupBusy(true);
        try {
            await cur.onNotesBackupSave(patch);
            onNotify?.("备份设置已保存", "success");
        } catch (error) {
            onNotify?.("保存失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBackupBusy(false);
        }
    };

    const runBackupNow = async () => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupRun || backupBusy) return;
        setBackupBusy(true);
        try {
            const r = await cur.onNotesBackupRun();
            if (r.success) onNotify?.(r.message || "备份完成", "success");
            else onNotify?.(r.message || "备份失败", "error");
        } catch (error) {
            onNotify?.("备份失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBackupBusy(false);
            void reloadBackupState();
        }
    };

    const testBackup = async () => {
        const cur = dataRef.current;
        if (!cur?.onNotesBackupTest || backupBusy) return;
        setBackupBusy(true);
        setBackupTestResult(null);
        try {
            setBackupTestResult(await cur.onNotesBackupTest());
        } catch (error) {
            setBackupTestResult({
                success: false,
                message: error instanceof Error ? error.message : "测试失败",
            });
        } finally {
            setBackupBusy(false);
        }
    };
    const filteredShares = useMemo(() => {
        const kw = shareKeyword.trim().toLowerCase();
        if (!kw) return shares ?? [];
        return (shares ?? []).filter(s => (s.title || "").toLowerCase().includes(kw));
    }, [shares, shareKeyword]);
    // 公开分享页路径前缀是 /s/（与 main.tsx 的路由正则、PublicNotePage 注释一致）。
    // 之前写成 /note/，和路由的 /s/ 对不上，打开会落到导航主页而不是公开笔记页。
    const shareUrl = (token: string) => `${globalThis.location.origin}/s/${token}`;
    const set = <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) =>
        onChange({ ...settings, [key]: value });

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth='md'
            fullWidth
            slotProps={{ paper: { sx: { height: 560, maxHeight: "86vh", borderRadius: 3 } } }}
        >
            <Box data-notes-settings='1' sx={{ display: "flex", height: "100%", minHeight: 0 }}>
                {/* 左列小节导航（inkstone 设置的样子） */}
                <Box
                    sx={{
                        width: 148,
                        flexShrink: 0,
                        borderRight: "1px solid rgba(128,128,128,0.12)",
                        py: 2,
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.5,
                        bgcolor: "rgba(128,128,128,0.04)",
                    }}
                >
                    <Typography variant='subtitle1' sx={{ px: 2, pb: 1, fontWeight: 600 }}>
                        设置
                    </Typography>
                    {(
                        [
                            ["appearance", "外观", <PaletteIcon fontSize='small' key='a' />],
                            ["editor", "编辑器", <TuneIcon fontSize='small' key='e' />],
                            ...(data
                                ? [["data", "数据", <StorageIcon fontSize='small' key='d' />] as const]
                                : []),
                            // 备份页照 inkstone 的 BackupSettings；老部署没能力时整页不出现
                            ...(data?.onNotesBackupGetState
                                ? [[
                                      "backup",
                                      "备份",
                                      <CloudUploadIcon fontSize='small' key='b' />,
                                  ] as const]
                                : []),
                            ...(shareApi
                                ? [["shares", "分享列表", <ShareIcon fontSize='small' key='s' />] as const]
                                : []),
                        ] as const
                    ).map(([key, label, icon]) => (
                        <Box
                            key={key}
                            component='button'
                            type='button'
                            data-settings-tab={key}
                            onClick={() => setTab(key)}
                            sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                                mx: 1,
                                px: 1.5,
                                py: 0.9,
                                appearance: "none",
                                border: "none",
                                font: "inherit",
                                cursor: "pointer",
                                borderRadius: 1.5,
                                textAlign: "left",
                                fontSize: 13.5,
                                bgcolor: tab === key ? "rgba(176,67,58,0.10)" : "transparent",
                                color: tab === key ? "var(--accent)" : "text.secondary",
                                "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                            }}
                        >
                            {icon}
                            {label}
                        </Box>
                    ))}
                </Box>

                {/* 右侧内容 */}
                <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <Box sx={{ display: "flex", alignItems: "center", px: 2.5, py: 1.5 }}>
                        <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600 }}>
                            {tab === "appearance"
                                ? "外观"
                                : tab === "editor"
                                  ? "编辑器"
                                  : tab === "data"
                                    ? "数据"
                                    : tab === "backup"
                                      ? "备份"
                                      : "分享列表"}
                        </Typography>
                        <IconButton size='small' aria-label='关闭设置' onClick={onClose} data-settings-close='1'>
                            <CloseIcon fontSize='small' />
                        </IconButton>
                    </Box>
                    <Box sx={{ flex: 1, overflowY: "auto", px: 2.5, pb: 2 }}>
                        {tab === "appearance" ? (
                            <>
                                <SettingRow label='强调色' description='记事本内的选中态、链接与图标颜色'>
                                    <Box sx={{ display: "flex", gap: 0.75 }}>
                                        {FOLDER_COLORS.map(c => (
                                            <Box
                                                key={c}
                                                component='button'
                                                type='button'
                                                aria-label={`强调色 ${c}`}
                                                data-setting={`accent:${c}`}
                                                onClick={() => set("accent", c)}
                                                sx={{
                                                    width: 22,
                                                    height: 22,
                                                    borderRadius: "50%",
                                                    cursor: "pointer",
                                                    appearance: "none",
                                                    bgcolor: c,
                                                    border:
                                                        settings.accent === c
                                                            ? "2px solid var(--accent)"
                                                            : "2px solid transparent",
                                                    outline: "1px solid rgba(128,128,128,0.25)",
                                                }}
                                            />
                                        ))}
                                    </Box>
                                </SettingRow>
                                {/* 背景色 / 密度 / 正文字体：inkstone「外观」页同名的三项 */}
                                <SettingRow label='背景色' description='纸感（暖白）或纯白'>
                                    <SegOptions
                                        dataKey='bgcolor'
                                        value={settings.bgcolor}
                                        onChange={v => set("bgcolor", v)}
                                        options={[
                                            { value: "warm", label: "暖白" },
                                            { value: "pure", label: "纯白" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='界面密度' description='紧凑模式下列表与行距更小，一屏能看到更多'>
                                    <SegOptions
                                        dataKey='density'
                                        value={settings.density}
                                        onChange={v => set("density", v)}
                                        options={[
                                            { value: "comfortable", label: "舒适" },
                                            { value: "compact", label: "紧凑" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='正文字体' description='预览区正文用什么字体'>
                                    <SegOptions
                                        dataKey='previewFont'
                                        value={settings.previewFont}
                                        onChange={v => set("previewFont", v)}
                                        options={[
                                            { value: "sans", label: "无衬线" },
                                            { value: "serif", label: "衬线" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='正文字号'>
                                    <Slider
                                        aria-label='正文字号'
                                        data-setting='previewFontSize'
                                        value={settings.previewFontSize}
                                        min={12}
                                        max={24}
                                        step={1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("previewFontSize", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.previewFontSize}px
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='行高'>
                                    <Slider
                                        aria-label='行高'
                                        data-setting='lineHeight'
                                        value={settings.lineHeight}
                                        min={1.2}
                                        max={2.4}
                                        step={0.1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("lineHeight", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.lineHeight.toFixed(1)}
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='内容宽度' description='预览区正文的排版宽度'>
                                    <SegOptions
                                        dataKey='contentWidth'
                                        value={settings.contentWidth}
                                        onChange={v => set("contentWidth", v)}
                                        options={[
                                            { value: "narrow", label: "窄" },
                                            { value: "standard", label: "标准" },
                                            { value: "wide", label: "宽" },
                                            { value: "full", label: "满" },
                                        ]}
                                    />
                                </SettingRow>
                                {/* 效果预览：设置行下方直接看当前字号/行高/宽度下的样子 */}
                                <Box sx={{ pt: 2 }}>
                                    <Typography variant='caption' sx={{ display: "block", mb: 1, color: "text.secondary" }}>
                                        效果预览
                                    </Typography>
                                    <Box
                                        data-settings-preview='1'
                                        sx={{
                                            border: "1px solid rgba(128,128,128,0.2)",
                                            borderRadius: 2,
                                            p: 1.5,
                                            maxWidth:
                                                settings.contentWidth === "narrow"
                                                    ? 320
                                                    : settings.contentWidth === "standard"
                                                      ? 440
                                                      : settings.contentWidth === "wide"
                                                        ? 560
                                                        : "100%",
                                            fontSize: settings.previewFontSize,
                                            lineHeight: settings.lineHeight,
                                        }}
                                    >
                                        <Typography component='div' sx={{ fontWeight: 600, fontSize: "1.2em", mb: 0.5 }}>
                                          山中问答
                                        </Typography>
                                        问余何意栖碧山，笑而不答心自闲。
                                        桃花流水窅然去，别有天地非人间。
                                    </Box>
                                </Box>
                            </>
                        ) : tab === "editor" ? (
                            <>
                                <SettingRow label='编辑器字体'>
                                    <SegOptions
                                        dataKey='editorFont'
                                        value={settings.editorFont}
                                        onChange={v => set("editorFont", v)}
                                        options={[
                                            { value: "mono", label: "等宽" },
                                            { value: "sans", label: "无衬线" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='编辑器字号'>
                                    <Slider
                                        aria-label='编辑器字号'
                                        data-setting='editorFontSize'
                                        value={settings.editorFontSize}
                                        min={12}
                                        max={22}
                                        step={1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("editorFontSize", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.editorFontSize}px
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='显示行号' description='在编辑区左侧显示行号'>
                                    <Switch
                                        checked={settings.lineNumbers}
                                        onChange={e => set("lineNumbers", e.target.checked)}
                                        data-setting='lineNumbers'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='显示工具栏' description='标题下方的 Markdown 格式工具栏'>
                                    <Switch
                                        checked={settings.showToolbar}
                                        onChange={e => set("showToolbar", e.target.checked)}
                                        data-setting='showToolbar'
                                        size='small'
                                    />
                                </SettingRow>
                                {/* 专注模式 / 编辑区实时渲染放这一组：都在「写东西」时用，
                                    埋在长列表底下要滚动才看见（实测点不到）。 */}
                                <SettingRow label='专注模式' description='淡化光标所在段落之外的内容，只留当前这段'>
                                    <Switch
                                        checked={settings.focusMode}
                                        onChange={e => set("focusMode", e.target.checked)}
                                        data-setting='focusMode'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='编辑区实时渲染' description='在编辑区里实时渲染：离开光标的那一段直接显示成渲染后的样子'>
                                    <Switch
                                        checked={settings.liveRender}
                                        onChange={e => set("liveRender", e.target.checked)}
                                        data-setting='liveRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='打字机模式' description='光标所在的那一行始终停在屏幕中间，写作时眼睛不用来回跳'>
                                    <Switch
                                        checked={settings.typewriterMode}
                                        onChange={e => set("typewriterMode", e.target.checked)}
                                        data-setting='typewriterMode'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='记住阅读位置' description='重新打开一篇笔记时，回到上次读到的地方'>
                                    <Switch
                                        checked={settings.rememberPosition}
                                        onChange={e => set("rememberPosition", e.target.checked)}
                                        data-setting='rememberPosition'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='拼写检查' description='使用浏览器的原生拼写检查'>
                                    <Switch
                                        checked={settings.spellcheck}
                                        onChange={e => set("spellcheck", e.target.checked)}
                                        data-setting='spellcheck'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='缩进宽度' description='Tab 与自动缩进用几个空格'>
                                    <SegOptions
                                        dataKey='indentWidth'
                                        value={String(settings.indentWidth) as "2" | "4"}
                                        onChange={v => set("indentWidth", Number(v) as 2 | 4)}
                                        options={[
                                            { value: "2", label: "2" },
                                            { value: "4", label: "4" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='自动保存延迟' description='停止输入后等多久自动写库（越短越频繁）'>
                                    <Slider
                                        aria-label='自动保存延迟'
                                        data-setting='autosaveMs'
                                        value={settings.autosaveMs}
                                        min={500}
                                        max={8000}
                                        step={250}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("autosaveMs", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 52, textAlign: "right" }}>
                                        {settings.autosaveMs}ms
                                    </Typography>
                                </SettingRow>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography variant='caption' color='text.secondary' sx={{ px: 0.5, display: "block", mb: 0.5 }}>
                                    预览
                                </Typography>
                                <SettingRow label='滚动同步' description='分栏时预览跟随源码滚动'>
                                    <Switch
                                        checked={settings.scrollSync}
                                        onChange={e => set("scrollSync", e.target.checked)}
                                        data-setting='scrollSync'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='数学公式' description='渲染 $行内$ 与 $$块级$$ 公式'>
                                    <Switch
                                        checked={settings.mathRender}
                                        onChange={e => set("mathRender", e.target.checked)}
                                        data-setting='mathRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='图表' description='把 Mermaid 代码块渲染为图表'>
                                    <Switch
                                        checked={settings.mermaidRender}
                                        onChange={e => set("mermaidRender", e.target.checked)}
                                        data-setting='mermaidRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='折叠较长的代码块' description='超过下面行数的代码块先折叠，点一下展开'>
                                    <Switch
                                        checked={settings.foldCode}
                                        onChange={e => set("foldCode", e.target.checked)}
                                        data-setting='foldCode'
                                        size='small'
                                    />
                                </SettingRow>
                                {settings.foldCode && (
                                    <SettingRow label='折叠阈值'>
                                        <Slider
                                            aria-label='折叠阈值'
                                            data-setting='foldCodeLines'
                                            value={settings.foldCodeLines}
                                            min={6}
                                            max={120}
                                            step={2}
                                            valueLabelDisplay='auto'
                                            onChange={(_, v) => set("foldCodeLines", v as number)}
                                            sx={{ width: 150 }}
                                        />
                                        <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                            {settings.foldCodeLines} 行
                                        </Typography>
                                    </SettingRow>
                                )}
                                <SettingRow label='默认显示大纲' description='打开笔记时右侧就带着大纲面板'>
                                    <Switch
                                        checked={settings.defaultOutline}
                                        onChange={e => set("defaultOutline", e.target.checked)}
                                        data-setting='defaultOutline'
                                        size='small'
                                    />
                                </SettingRow>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography variant='caption' color='text.secondary' sx={{ px: 0.5, display: "block" }}>
                                    字体与字号即时生效；行号、拼写检查与缩进宽度会重建编辑器（撤销历史会清空）。
                                </Typography>
                            </>
                        ) : tab === "data" && data ? (
                            // 数据页（2026-10-08 照 inkstone 的 DataSettings，
                            // 精简到现有端点能做到的：概览 / 导出 JSON / 维护）
                            <Box data-settings-data='1'>
                                <Typography variant='subtitle2' sx={{ mb: 1 }}>
                                    概览
                                </Typography>
                                <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, mb: 1.5 }}>
                                    {(
                                        [
                                            // 顺序照 inkstone 的 stats 网格：笔记 → 文件夹 →
                                            // 标签 → 双链 → 总字数 → 版本历史 → 附件 → 回收站；
                                            // 「分享」是我们多出来的（inkstone 没有公开链接这个功能）。
                                            // 双链/版本历史是后端 notes/stats 现算的全站计数，
                                            // 老部署没有这个端点时显示「—」（宁缺勿假）。
                                            ["笔记", data.stats.notes],
                                            ["文件夹", data.stats.folders],
                                            ["标签", data.stats.tags],
                                            ["双链", noteStats ? noteStats.links : null],
                                            ["总字数", data.stats.words],
                                            ["版本历史", noteStats ? noteStats.versions : null],
                                            ["附件", attStats ? attStats.count : null],
                                            ["回收站", data.stats.trashed],
                                            ["分享", sharesCount],
                                        ] as const
                                    ).map(([label, n]) => (
                                        <Box
                                            key={label}
                                            data-data-stat={label}
                                            sx={{
                                                border: "1px solid rgba(128,128,128,0.18)",
                                                borderRadius: 2,
                                                px: 1.5,
                                                py: 1.25,
                                            }}
                                        >
                                            <Typography sx={{ fontSize: 20, fontWeight: 600 }}>
                                                {n ?? "—"}
                                            </Typography>
                                            <Typography variant='caption' color='text.secondary'>
                                                {label}
                                            </Typography>
                                        </Box>
                                    ))}
                                </Box>
                                {attStats && attStats.bytes > 0 && (
                                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 2 }}>
                                        附件占用 {fmtBytes(attStats.bytes)}
                                    </Typography>
                                )}

                                {/* 附件（inkstone 数据页的第二节）：管理与清理分开 ——
                                    管理是「一条条看、按需删」，清理是「批量扫没被引用的」 */}
                                {attStats !== null && data.onDeleteAttachment && (
                                    <>
                                        <Typography variant='subtitle2' sx={{ mb: 0.5, mt: 2 }}>
                                            附件
                                        </Typography>
                                        <SettingRow
                                            label='管理附件'
                                            description='按文件名查看已上传的图片，可以逐条删除；删掉后引用它的笔记里会显示「图片加载失败」。'
                                        >
                                            <Button
                                                size='small'
                                                startIcon={<StorageIcon fontSize='small' />}
                                                data-data-action='manage-attachments'
                                                onClick={() => setAttManagerOpen(true)}
                                            >
                                                管理
                                            </Button>
                                        </SettingRow>
                                    </>
                                )}

                                <Typography variant='subtitle2' sx={{ mb: 0.5, mt: 2 }}>
                                    导出
                                </Typography>
                                <SettingRow
                                    label='导出全部笔记（JSON）'
                                    description='笔记、文件夹、标签与关联打包成一份 JSON；不含图片附件。'
                                >
                                    <Button
                                        size='small'
                                        startIcon={<FileDownloadIcon fontSize='small' />}
                                        data-data-action='export-all'
                                        onClick={data.onExportAll}
                                    >
                                        下载 JSON
                                    </Button>
                                </SettingRow>
                                {data.onExportZip && (
                                    <SettingRow
                                        label='导出全部（ZIP，含图片）'
                                        description='笔记、文件夹、标签与图片附件打包成一份 ZIP —— 导出去的图能原样导回来（JSON 那份只有正文，图片会丢）。'
                                    >
                                        <Button
                                            size='small'
                                            startIcon={<FileDownloadIcon fontSize='small' />}
                                            data-data-action='export-zip'
                                            disabled={importBusy}
                                            onClick={() => void data.onExportZip?.()}
                                        >
                                            下载 ZIP
                                        </Button>
                                    </SettingRow>
                                )}

                                {/* 导入：读回上面导出的那份 JSON，按 uuid 合并（文件较新才覆盖）。
                                    与导出同一条链路，导出的文件保证导得回来。 */}
                                {data.onImportNotes && (
                                    <SettingRow
                                        label='导入笔记（JSON / ZIP）'
                                        description='支持本工具的 JSON / ZIP 备份，以及 Obsidian 风格的 Markdown 文件夹 ZIP。备份按内部标识取较新版本；Markdown ZIP 创建笔记并保留目录与标签，附件会回传并重写引用（需附件上传能力）。'
                                    >
                                        <Button
                                            size='small'
                                            startIcon={<FileUploadIcon fontSize='small' />}
                                            data-data-action='import-notes'
                                            disabled={importBusy}
                                            onClick={() => importFileRef.current?.click()}
                                        >
                                            {importBusy ? "导入中…" : "选择文件"}
                                        </Button>
                                    </SettingRow>
                                )}
                                <input
                                    ref={importFileRef}
                                    type='file'
                                    hidden
                                    accept='.json,.zip,application/json,application/zip'
                                    aria-label='选择要导入的笔记文件（JSON 或 ZIP）'
                                    onChange={e => void handleImportFile(e.target.files?.[0])}
                                />

                                <Typography variant='subtitle2' sx={{ mb: 0.5, mt: 2 }}>
                                    维护
                                </Typography>
                                {data.onPruneAttachments && (
                                    <SettingRow
                                        label='清理未引用附件'
                                        description='删除不再出现在任何笔记正文里的图片，释放存储；正在使用的图片不受影响。'
                                    >
                                        <Button
                                            size='small'
                                            startIcon={<DeleteSweepIcon fontSize='small' />}
                                            data-data-action='prune'
                                            onClick={() => setConfirmKind("prune")}
                                        >
                                            清理
                                        </Button>
                                    </SettingRow>
                                )}
                                <SettingRow
                                    label='清空回收站'
                                    description='永久删除回收站里的全部笔记，不可恢复。'
                                >
                                    <Button
                                        size='small'
                                        color='error'
                                        data-data-action='empty-trash'
                                        onClick={() => setConfirmKind("trash")}
                                    >
                                        清空
                                    </Button>
                                </SettingRow>
                            </Box>
                        ) : tab === "backup" && data ? (
                            <Box data-settings-backup='1'>
                                {backupError && (
                                    <Typography
                                        data-backup-state='error'
                                        variant='caption'
                                        sx={{
                                            display: "block",
                                            px: 1.5,
                                            py: 1,
                                            mb: 1.5,
                                            borderRadius: 1.5,
                                            color: "error.main",
                                            bgcolor: "rgba(176,67,58,0.08)",
                                        }}
                                    >
                                        {backupError}
                                    </Typography>
                                )}

                                {/* 概览 + 立即备份（inkstone 的概览 section） */}
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: 1.5,
                                        px: 1.5,
                                        py: 1.25,
                                        mb: 2,
                                        borderRadius: 2,
                                        border: "1px solid rgba(128,128,128,0.2)",
                                    }}
                                >
                                    <CloudUploadIcon sx={{ color: "var(--accent)", fontSize: 20, mt: 0.25 }} />
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                            {backupState?.webdavUrl
                                                ? "WebDAV 备份目标已配置"
                                                : "尚未配置网盘"}
                                        </Typography>
                                        <Typography
                                            variant='caption'
                                            color='text.secondary'
                                            sx={{ display: "block", mt: 0.25 }}
                                        >
                                            备份与导航页的分开：独立目录、独立文件名、独立频率与保留；
                                            网盘地址与账号自动带入导航页「数据备份」里保存的那套。
                                        </Typography>
                                    </Box>
                                    <Button
                                        size='small'
                                        variant='contained'
                                        disabled={!backupState?.webdavUrl || backupBusy}
                                        data-backup-action='run-now'
                                        startIcon={
                                            backupBusy ? <CircularProgress size={14} /> : undefined
                                        }
                                        onClick={() => void runBackupNow()}
                                    >
                                        立即备份
                                    </Button>
                                </Box>

                                {/* 备份目标（inkstone 的 TargetCard：单 WebDAV 目标，凭据自动带入） */}
                                <Typography
                                    variant='caption'
                                    sx={{
                                        fontWeight: 600,
                                        letterSpacing: "0.06em",
                                        color: "text.disabled",
                                        display: "block",
                                        mb: 0.5,
                                    }}
                                >
                                    备份目标
                                </Typography>
                                <Box
                                    data-backup-target='1'
                                    sx={{
                                        px: 1.5,
                                        py: 1.25,
                                        mb: 2,
                                        borderRadius: 2,
                                        border: "1px solid rgba(128,128,128,0.2)",
                                    }}
                                >
                                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                        <StorageIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                                        <Box sx={{ flex: 1, minWidth: 0 }}>
                                            <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                                WebDAV
                                            </Typography>
                                            <Typography
                                                variant='caption'
                                                color='text.secondary'
                                                sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                            >
                                                {backupState?.webdavUrl || "未配置（先在导航页保存网盘地址）"}
                                                {backupState?.webdavUsername
                                                    ? ` · ${backupState.webdavUsername}`
                                                    : ""}
                                            </Typography>
                                        </Box>
                                        <Button
                                            size='small'
                                            variant='outlined'
                                            disabled={backupBusy || !backupState?.webdavUrl}
                                            data-backup-action='test'
                                            startIcon={
                                                backupBusy ? <CircularProgress size={14} /> : <RefreshIcon />
                                            }
                                            onClick={() => void testBackup()}
                                        >
                                            测试连接
                                        </Button>
                                    </Box>

                                    <Box sx={{ display: "flex", gap: 1.5, mt: 1.25, flexWrap: "wrap" }}>
                                        <TextField
                                            label='备份目录'
                                            size='small'
                                            fullWidth
                                            value={pathDraft}
                                            slotProps={{ input: { "aria-label": "备份目录" } }}
                                            onChange={e => setPathDraft(e.target.value)}
                                            onBlur={() => {
                                                const next = pathDraft.trim();
                                                if (backupState && next && next !== backupState.path) {
                                                    void saveBackupField({ path: next });
                                                    setBackupState({ ...backupState, path: next });
                                                } else {
                                                    setPathDraft(backupState?.path ?? "");
                                                }
                                            }}
                                        />
                                        <TextField
                                            label='备份密码（可选）'
                                            type='password'
                                            size='small'
                                            fullWidth
                                            value={pwdDraft}
                                            autoComplete='new-password'
                                            slotProps={{ input: { "aria-label": "备份密码" } }}
                                            onChange={e => setPwdDraft(e.target.value)}
                                            onBlur={() => {
                                                if (!backupState) return;
                                                if (pwdDraft !== backupState.backupPassword) {
                                                    void saveBackupField({
                                                        backupPassword: pwdDraft,
                                                    });
                                                    setBackupState({ ...backupState, backupPassword: pwdDraft });
                                                }
                                            }}
                                        />
                                    </Box>
                                    <Typography
                                        variant='caption'
                                        color='text.secondary'
                                        sx={{ display: "block", mt: 0.5 }}
                                    >
                                        {backupState?.backupPassword || backupState?.hasNavBackupPassword
                                            ? "设了口令的备份会加密上传，恢复时要填同一个密码。"
                                            : "口令留空则明文上传；填了会覆盖导航页那份备份口令。"}
                                    </Typography>

                                    {backupTestResult && (
                                        <Typography
                                            role={backupTestResult.success ? "status" : "alert"}
                                            data-backup-test-result={
                                                backupTestResult.success ? "ok" : "fail"
                                            }
                                            variant='caption'
                                            sx={{
                                                display: "block",
                                                mt: 1,
                                                px: 1,
                                                py: 0.75,
                                                borderRadius: 1.5,
                                                color: backupTestResult.success ? "success.main" : "error.main",
                                                bgcolor: backupTestResult.success
                                                    ? "rgba(76,175,80,0.10)"
                                                    : "rgba(176,67,58,0.08)",
                                            }}
                                        >
                                            {backupTestResult.message}
                                        </Typography>
                                    )}
                                </Box>

                                {/* 自动备份（inkstone 的频率 / 保留两个 Select） */}
                                <Typography
                                    variant='caption'
                                    sx={{
                                        fontWeight: 600,
                                        letterSpacing: "0.06em",
                                        color: "text.disabled",
                                        display: "block",
                                        mb: 0.5,
                                    }}
                                >
                                    自动备份
                                </Typography>
                                <SettingRow
                                    label='备份频率'
                                    description='由服务端定时任务执行，页面不用保持打开；到点后到下一次触发之间最多延迟 1 小时。'
                                >
                                    <Select
                                        size='small'
                                        aria-label='备份频率'
                                        value={backupState?.schedule ?? "off"}
                                        disabled={backupBusy}
                                        data-backup-select='schedule'
                                        onChange={e => {
                                            const next = e.target.value;
                                            setBackupState(s => (s ? { ...s, schedule: next } : s));
                                            void saveBackupField({ schedule: next });
                                        }}
                                        sx={{ minWidth: 110 }}
                                    >
                                        <MenuItem value='off'>关闭</MenuItem>
                                        <MenuItem value='hourly'>每小时</MenuItem>
                                        <MenuItem value='sixHourly'>每 6 小时</MenuItem>
                                        <MenuItem value='daily'>每天</MenuItem>
                                        <MenuItem value='weekly'>每周</MenuItem>
                                        <MenuItem value='monthly'>每月</MenuItem>
                                        <MenuItem value='yearly'>每年</MenuItem>
                                    </Select>
                                </SettingRow>
                                <SettingRow
                                    label='备份保留'
                                    description='自动备份在网盘上保留的份数；手动备份永远全部保留。'
                                >
                                    <Select
                                        size='small'
                                        aria-label='备份保留份数'
                                        value={String(backupState?.retention ?? 7)}
                                        disabled={backupBusy}
                                        data-backup-select='retention'
                                        onChange={e => {
                                            const next = Number(e.target.value);
                                            setBackupState(s =>
                                                s ? { ...s, retention: next } : s
                                            );
                                            void saveBackupField({ retention: next });
                                        }}
                                        sx={{ minWidth: 110 }}
                                    >
                                        <MenuItem value='0'>全部保留</MenuItem>
                                        <MenuItem value='7'>最近 7 份</MenuItem>
                                        <MenuItem value='14'>最近 14 份</MenuItem>
                                        <MenuItem value='30'>最近 30 份</MenuItem>
                                        <MenuItem value='90'>最近 90 份</MenuItem>
                                        <MenuItem value='365'>最近 365 份</MenuItem>
                                    </Select>
                                </SettingRow>

                                {/* 最近备份（inkstone 的 RunRow 列表，最多 12 条） */}
                                <Typography
                                    variant='caption'
                                    sx={{
                                        fontWeight: 600,
                                        letterSpacing: "0.06em",
                                        color: "text.disabled",
                                        display: "block",
                                        mt: 2,
                                        mb: 0.5,
                                    }}
                                >
                                    最近备份
                                </Typography>
                                {!backupState || backupState.runs.length === 0 ? (
                                    <Typography
                                        data-backup-runs-empty='1'
                                        variant='caption'
                                        color='text.disabled'
                                        sx={{
                                            display: "block",
                                            px: 1.5,
                                            py: 2,
                                            borderRadius: 1.5,
                                            textAlign: "center",
                                            bgcolor: "rgba(128,128,128,0.05)",
                                        }}
                                    >
                                        还没有备份记录
                                    </Typography>
                                ) : (
                                    <Box component='ul' sx={{ m: 0, p: 0, listStyle: "none" }}>
                                        {backupState.runs.slice(0, 12).map(run => (
                                            <Box
                                                key={run.id}
                                                component='li'
                                                data-backup-run={run.id}
                                                sx={{
                                                    borderRadius: 1.5,
                                                    border: "1px solid rgba(128,128,128,0.16)",
                                                    mb: 0.5,
                                                    overflow: "hidden",
                                                }}
                                            >
                                                <Box
                                                    sx={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                    }}
                                                >
                                                    <Box
                                                        component='button'
                                                        type='button'
                                                        aria-expanded={expandedRun === run.id}
                                                        onClick={() =>
                                                            setExpandedRun(v => (v === run.id ? null : run.id))
                                                        }
                                                        sx={{
                                                            display: "flex",
                                                            alignItems: "center",
                                                            gap: 1,
                                                            flex: 1,
                                                            minWidth: 0,
                                                            px: 1,
                                                            py: 0.75,
                                                            appearance: "none",
                                                            border: "none",
                                                            font: "inherit",
                                                            cursor: "pointer",
                                                            bgcolor: "transparent",
                                                            textAlign: "left",
                                                            "&:hover": { bgcolor: "rgba(128,128,128,0.06)" },
                                                        }}
                                                    >
                                                    <Box
                                                        aria-hidden='true'
                                                        sx={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: "50%",
                                                            flexShrink: 0,
                                                            bgcolor:
                                                                run.status === "success"
                                                                    ? "success.main"
                                                                    : "error.main",
                                                        }}
                                                    />
                                                    <Typography
                                                        variant='caption'
                                                        sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                                    >
                                                        {fmtTime(run.startedAt) || run.startedAt} ·{" "}
                                                        {run.trigger === "auto" ? "定时" : "手动"}
                                                    </Typography>
                                                    <Typography
                                                        variant='caption'
                                                        color='text.secondary'
                                                        sx={{ flexShrink: 0 }}
                                                    >
                                                        {run.status === "success"
                                                            ? `${run.noteCount ?? 0} 条 · ${fmtBytes(run.bytes ?? 0)}`
                                                            : "失败"}
                                                    </Typography>
                                                    </Box>
                                                    <IconButton
                                                        size='small'
                                                        aria-label={`删除这条备份记录（${fmtTime(run.startedAt) || run.startedAt}）`}
                                                        title='删除这条备份'
                                                        disabled={backupBusy}
                                                        onClick={() => {
                                                            setDeleteRunTarget(run);
                                                            setConfirmKind("backup-run");
                                                        }}
                                                        sx={{ flexShrink: 0, mr: 0.5 }}
                                                    >
                                                        <DeleteIcon fontSize='inherit' />
                                                    </IconButton>
                                                </Box>
                                                {expandedRun === run.id && (
                                                    <Typography
                                                        variant='caption'
                                                        color='text.secondary'
                                                        sx={{
                                                            display: "block",
                                                            px: 1.5,
                                                            py: 0.75,
                                                            borderTop: "1px solid rgba(128,128,128,0.12)",
                                                            bgcolor: "rgba(128,128,128,0.04)",
                                                        }}
                                                    >
                                                        {run.status === "success"
                                                            ? `${run.filename ?? ""} · 用时 ${Math.round((run.durationMs ?? 0) / 100) / 10} 秒`
                                                            : run.error || "备份失败"}
                                                    </Typography>
                                                )}
                                            </Box>
                                        ))}
                                    </Box>
                                )}

                                {/* 从网盘恢复（2026-10-09）：备份不能只出不进 ——
                                    列目录 → 选一份 → 需要口令时弹框 → 下载解密 → 走同一条导入。
                                    老部署没有 list/download 两个端点时这一节整段不出现。 */}
                                {(data?.onNotesBackupListRemote || data?.onNotesBackupFetch) && (
                                    <>
                                        <Typography
                                            variant='caption'
                                            sx={{
                                                fontWeight: 600,
                                                letterSpacing: "0.06em",
                                                color: "text.disabled",
                                                display: "block",
                                                mt: 2,
                                                mb: 0.5,
                                            }}
                                        >
                                            从网盘恢复
                                        </Typography>
                                        <Box
                                            data-backup-restore='1'
                                            sx={{
                                                px: 1.5,
                                                py: 1.25,
                                                borderRadius: 2,
                                                border: "1px solid rgba(128,128,128,0.2)",
                                            }}
                                        >
                                            <Box
                                                sx={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: 1,
                                                    mb: remoteFiles && remoteFiles.length > 0 ? 1 : 0,
                                                }}
                                            >
                                                <Typography
                                                    variant='caption'
                                                    color='text.secondary'
                                                    sx={{ flex: 1, minWidth: 0 }}
                                                >
                                                    按 uuid 合并、较新者胜；恢复不会删掉现有笔记。
                                                </Typography>
                                                <Button
                                                    size='small'
                                                    variant='outlined'
                                                    disabled={backupBusy || restoreBusy || !backupState?.webdavUrl}
                                                    data-backup-action='list-remote'
                                                    startIcon={
                                                        backupBusy ? (
                                                            <CircularProgress size={14} />
                                                        ) : (
                                                            <CloudDownloadIcon />
                                                        )
                                                    }
                                                    onClick={() => void listRemoteBackups()}
                                                >
                                                    列出备份
                                                </Button>
                                            </Box>

                                            {remoteError && (
                                                <Typography
                                                    role='alert'
                                                    data-backup-remote-error='1'
                                                    variant='caption'
                                                    sx={{
                                                        display: "block",
                                                        mt: 1,
                                                        px: 1,
                                                        py: 0.75,
                                                        borderRadius: 1.5,
                                                        color: "error.main",
                                                        bgcolor: "rgba(176,67,58,0.08)",
                                                    }}
                                                >
                                                    {remoteError}
                                                </Typography>
                                            )}

                                            {/* 需要口令时就地展开一行输入框（不套第二层 Dialog：
                                                嵌套弹窗在 jsdom 里焦点/断言都不好做，而且这里只有
                                                一个输入框，内联更顺手） */}
                                            {restoreTarget && (
                                                <Box
                                                    data-backup-restore-pwd='1'
                                                    sx={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 1,
                                                        mt: 1,
                                                        flexWrap: "wrap",
                                                    }}
                                                >
                                                    <TextField
                                                        label='备份密码'
                                                        type='password'
                                                        size='small'
                                                        autoComplete='off'
                                                        value={restorePwd}
                                                        // ⚠️ aria-label 不能也叫「备份密码」——
                                                        // 上面备份目标里那个口令框已经占了，
                                                        // 同名会让 querySelector 取错元素
                                                        slotProps={{ input: { "aria-label": "恢复备份密码" } }}
                                                        onChange={e => setRestorePwd(e.target.value)}
                                                        sx={{ flex: 1, minWidth: 160 }}
                                                    />
                                                    <Button
                                                        size='small'
                                                        variant='contained'
                                                        disabled={restoreBusy}
                                                        data-backup-action='restore-confirm'
                                                        onClick={() =>
                                                            void doRestore(restoreTarget, restorePwd)
                                                        }
                                                    >
                                                        恢复
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        variant='text'
                                                        data-backup-action='restore-cancel'
                                                        onClick={() => {
                                                            setRestoreTarget(null);
                                                            setRestorePwd("");
                                                            setRemoteError(null);
                                                        }}
                                                    >
                                                        取消
                                                    </Button>
                                                </Box>
                                            )}

                                            {remoteFiles && remoteFiles.length === 0 && (
                                                <Typography
                                                    data-backup-remote-empty='1'
                                                    variant='caption'
                                                    color='text.disabled'
                                                    sx={{ display: "block", textAlign: "center", py: 1 }}
                                                >
                                                    网盘上还没有备份文件
                                                </Typography>
                                            )}

                                            {remoteFiles && remoteFiles.length > 0 && (
                                                <Box component='ul' sx={{ m: 0, p: 0, listStyle: "none" }}>
                                                    {remoteFiles.map(f => (
                                                        <Box
                                                            key={f.name}
                                                            component='li'
                                                            data-backup-remote-file={f.name}
                                                            sx={{
                                                                display: "flex",
                                                                alignItems: "center",
                                                                gap: 1,
                                                                py: 0.5,
                                                            }}
                                                        >
                                                            <Typography
                                                                variant='caption'
                                                                sx={{
                                                                    flex: 1,
                                                                    minWidth: 0,
                                                                    overflow: "hidden",
                                                                    textOverflow: "ellipsis",
                                                                    whiteSpace: "nowrap",
                                                                }}
                                                            >
                                                                {f.name}
                                                            </Typography>
                                                            <Typography
                                                                variant='caption'
                                                                color='text.secondary'
                                                                sx={{ flexShrink: 0 }}
                                                            >
                                                                {fmtBytes(f.size ?? 0)}
                                                            </Typography>
                                                            <Button
                                                                size='small'
                                                                variant='text'
                                                                disabled={restoreBusy}
                                                                data-backup-action='restore'
                                                                onClick={() => {
                                                                    // 已设过备份口令的先带上去试一次，
                                                                    // 仍是加密的就弹框让用户补
                                                                    setRestorePwd(
                                                                        backupState?.backupPassword ?? ""
                                                                    );
                                                                    void doRestore(
                                                                        f.name,
                                                                        backupState?.backupPassword ?? ""
                                                                    );
                                                                }}
                                                            >
                                                                恢复
                                                            </Button>
                                                        </Box>
                                                    ))}
                                                </Box>
                                            )}
                                        </Box>
                                    </>
                                )}
                            </Box>
                        ) : (
                            // 分享列表（inkstone 设置里同名那一页）：列出所有已分享的笔记 ——
                            // 链接、剩余有效期、创建/更新时间，以及复制/打开/管理/撤销四个动作。
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
                                    sx={{ mb: 1.5, borderRadius: 2, bgcolor: "rgba(128,128,128,0.06)" }}
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
                                                    border: "1px solid var(--card-border, rgba(128,128,128,0.22))",
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
                                                                ? "rgba(128,128,128,0.12)"
                                                                : "rgba(176,67,58,0.10)",
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
                        )}
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "flex-end", px: 2.5, py: 1.5, borderTop: "1px solid rgba(128,128,128,0.12)" }}>
                        <Button size='small' variant='contained' onClick={onClose} data-settings-done='1'>
                            完成
                        </Button>
                    </Box>
                </Box>
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

                {/* 数据页的两个危险操作二次确认 */}
                {confirmKind === "trash" && (
                    <ConfirmDialog
                        open
                        danger
                        title='清空回收站？'
                        description='回收站里的全部笔记将被永久删除，无法恢复。'
                        confirmText='清空'
                        onConfirm={async () => {
                            try {
                                await data?.onEmptyTrash();
                                onNotify?.("回收站已清空", "success");
                            } catch (error) {
                                onNotify?.(
                                    "清空失败：" + (error instanceof Error ? error.message : "未知错误"),
                                    "error"
                                );
                                throw error; // ConfirmDialog 契约：reject 保持打开
                            }
                        }}
                        onClose={() => setConfirmKind(null)}
                    />
                )}
                {confirmKind === "prune" && data?.onPruneAttachments && (
                    <ConfirmDialog
                        open
                        danger
                        title='清理未引用附件？'
                        description='只删除不再出现在任何笔记正文里的图片；正在使用的图片不受影响。'
                        confirmText='清理'
                        onConfirm={async () => {
                            try {
                                const cur = dataRef.current;
                                if (!cur?.onPruneAttachments) return;
                                const r = await cur.onPruneAttachments();
                                onNotify?.(
                                    r.removed
                                        ? `已清理 ${r.removed} 个附件，释放 ${fmtBytes(r.freedBytes)}`
                                        : "没有需要清理的附件",
                                    "success"
                                );
                                // 重新拉统计 —— 管理器抽屉自己会在收到 onChanged 时重拉列表，
                                // 这里只把数据页概览的「附件 N 个 · 占用 X」刷掉。
                                await reloadAttStats();
                            } catch (error) {
                                onNotify?.(
                                    "清理失败：" + (error instanceof Error ? error.message : "未知错误"),
                                    "error"
                                );
                                throw error;
                            }
                        }}
                        onClose={() => setConfirmKind(null)}
                    />
                )}

                {/* 删除「最近备份」记录的二次确认（2026-10-10）。
                    有对应网盘文件的先把文件删掉 —— 文件删不掉就整单不删，
                    免得留下「记录没了、文件还躺在网盘上」的孤儿备份。 */}
                {confirmKind === "backup-run" && deleteRunTarget && (
                    <ConfirmDialog
                        open
                        danger
                        title='删除这条备份？'
                        description={
                            deleteRunTarget.filename
                                ? `「${deleteRunTarget.filename}」将从网盘删除，本条记录一并移除，无法恢复。`
                                : "这是一条失败的记录，删除后只是从「最近备份」里移除。"
                        }
                        confirmText='删除'
                        onConfirm={async () => {
                            const cur = dataRef.current;
                            const run = deleteRunTarget;
                            if (!cur?.onNotesBackupSave) return;
                            if (run.filename) {
                                if (!cur.onNotesBackupDeleteRemote) {
                                    onNotify?.(
                                        "当前部署不支持删除网盘备份，这份文件还在网盘上",
                                        "error"
                                    );
                                    throw new Error("unsupported");
                                }
                                const r = await cur.onNotesBackupDeleteRemote(run.filename);
                                if (!r.success) {
                                    onNotify?.(r.message || "删除网盘备份失败", "error");
                                    throw new Error(r.message || "delete failed");
                                }
                            }
                            const remaining = (backupState?.runs ?? [])
                                .filter(item => item.id !== run.id)
                                .slice(0, 12);
                            await cur.onNotesBackupSave({ runs: remaining });
                            onNotify?.("已删除这条备份", "success");
                            await reloadBackupState();
                        }}
                        onClose={() => {
                            setDeleteRunTarget(null);
                            setConfirmKind(null);
                        }}
                    />
                )}

                {/* 附件管理器（照抄 inkstone 的 AttachmentManager：420px 抽屉 +
                    四档筛选 + 两列卡片 + 引用数 + 加载更多 + 底部清理）。
                    叠在设置弹窗上，删除/清理后把概览统计刷一遍。 */}
                {attManagerOpen && data?.onDeleteAttachment && data?.onLoadAttachments && (
                    <AttachmentManager
                        open
                        onClose={() => setAttManagerOpen(false)}
                        mgr={{
                            list: () => data.onLoadAttachments!(),
                            remove: async id => {
                                await data.onDeleteAttachment!(id);
                            },
                            prune: data.onPruneAttachments
                                ? () => data.onPruneAttachments!()
                                : undefined,
                        }}
                        countRefs={data.countAttachmentRefs}
                        onNotify={onNotify}
                        onChanged={() => void reloadAttStats()}
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
                )}
            </Dialog>
    );
}
