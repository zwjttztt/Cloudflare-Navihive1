// src/components/NotesSettingsDialog.tsx
// 记事本自己的设置（左下角齿轮打开）—— **不与导航站设置页共用**。
//
// 导航站的设置是站点级的（标题、背景、账号、安全）；记事本要的是「阅读与书写
// 习惯」：字号、行高、强调色、编辑器字体、行号……两拨配置毫无交集，塞同一个
// 弹窗只会让两边都变长。所以这里是独立弹窗，样式参考 inkstone：左侧一列小节、
// 右侧是「一行标签 + 一行控件」的设置行。
//
// 只放**真的会生效**的开关：每个控件都能说出它改了哪个渲染行为；
// 「存了没用」的假开关比缺一个功能更糟。
//
// 2026-10-24 拆分（行动项 5）：本文件原来是 2372 行的巨石——六个设置页的
// JSX、各自的状态与副作用、五个二次确认弹窗全在一起。现在按页拆到
// notes/ 目录，本文件只剩「弹窗外壳 + 左列导航 + 分发」：
//   notes/settingsShared.tsx     SettingRow / SegOptions / fmtTime / fmtBytes
//   notes/NotesAppearanceTab.tsx 外观页
//   notes/NotesEditorTab.tsx     编辑器页
//   notes/NotesDataTab.tsx       数据页（含附件管理器 / 预览 / 两个危险确认）
//   notes/NotesSyncTab.tsx       同步页
//   notes/NotesSharesTab.tsx     分享列表页（含管理弹窗 / 撤销确认）
//   notes/NotesBackupTab.tsx     备份页（含删除记录确认）
// 每个页自持自己的状态，挂载（= 用户切到该页）时才拉数据；跨页共享的只有
// settings（外观/编辑器是受控组件）与几个 api 回调。
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import PaletteIcon from "@mui/icons-material/Palette";
import TuneIcon from "@mui/icons-material/Tune";
import ShareIcon from "@mui/icons-material/Share";
import StorageIcon from "@mui/icons-material/Storage";
import SyncIcon from "@mui/icons-material/Sync";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { dialogPaperTokens } from "./dialogShell";
import type { NotesUiSettings } from "../utils/notesSettings";
import type { NoteShareApi } from "./NoteShareDialog";
import type {
    NoteImportStats,
    NotesBackupSavePatch,
    NotesBackupState,
    NotesImportPayload,
    NoteStats,
    NoteImportProgress,
    WebDavErrorCode,
} from "../API/types";
import NotesAppearanceTab from "./notes/NotesAppearanceTab";
import NotesEditorTab from "./notes/NotesEditorTab";
import NotesDataTab from "./notes/NotesDataTab";
import NotesSyncTab from "./notes/NotesSyncTab";
import NotesSharesTab from "./notes/NotesSharesTab";
import NotesBackupTab from "./notes/NotesBackupTab";

/** 左列导航的页（顺序即显示顺序） */
type SettingsTab = "appearance" | "editor" | "data" | "sync" | "shares" | "backup";

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
    onImportFile?: (file: File, onProgress?: (p: NoteImportProgress) => void) => Promise<NoteImportStats>;
    onEmptyTrash: () => Promise<void>;
    /** 可选：老部署的 api 没有附件方法，相应能力自动隐藏 */
    onLoadAttachments?: () => Promise<
        { id: string; size: number; filename: string; mime: string }[]
    >;
    onPruneAttachments?: () => Promise<{ removed: number; freedBytes: number }>;
    /** 删除单个附件（附件管理器里用）。可选：老部署没有就整个管理器不出现 */
    onDeleteAttachment?: (id: string) => Promise<void>;
    /**
     * 附件预览 / 编辑 / 重命名（2026-10-19）。
     *
     * 这一组**只在设置页的管理器里用**：不传时那里点文件名退回纯文本（不预览），
     * 弹窗里也没有编辑 / 重命名按钮 —— 老部署的能力降级走的就是这条路。
     * 传了之后，管理器里点文件名会开一个和记事本里**同一个**预览弹窗。
     */
    onSaveAttachmentContent?: (id: string, text: string) => Promise<{ size: number }>;
    onRenameAttachment?: (
        id: string,
        filename: string
    ) => Promise<{ filename: string; updatedNotes: number }>;
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
     * onProgress（2026-10-17）：实现方在重拉列表前上报「刷新列表」阶段，
     * 调用方据此把进度条一直展示到列表真正刷新完。
     */
    onImportNotes?: (
        payload: NotesImportPayload,
        onProgress?: (p: NoteImportProgress) => void
    ) => Promise<NoteImportStats>;
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
        /** ZIP 备份（2026-10-11 起，含附件）：服务端不解包，回 base64 由前端走 onImportFile */
        zipBase64?: string;
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
    const set = <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) =>
        onChange({ ...settings, [key]: value });

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth='md'
            fullWidth
            slotProps={{
                paper: {
                    sx: {
                        // 纸面换成统一外壳（docs/dialogs-audit-2026-10-23.md A3）：
                        // 原来这里写死 height: 560 + maxHeight: "86vh" + borderRadius: 3，
                        // 既没有毛玻璃/底色（和其它弹窗不是一种材质），vh 也不跟软键盘变。
                        // 现在材质走 dialogPaperTokens，高度分档：小屏贴近底部面板，
                        // 桌面固定 560（左列导航 + 右列表单，高度稳定才好用）。
                        ...dialogPaperTokens,
                        p: 0.5,
                        height: { xs: "86dvh", sm: 560 },
                    },
                },
            }}
        >
            <Box data-notes-settings='1' sx={{ display: "flex", height: "100%", minHeight: 0 }}>
                {/* 左列小节导航（inkstone 设置的样子） */}
                <Box
                    sx={{
                        width: 148,
                        flexShrink: 0,
                        borderRight: "1px solid var(--neutral-hover)",
                        py: 2,
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.5,
                        bgcolor: "var(--neutral-wash)",
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
                            // 同步页：跨设备变更轮询的本机偏好（开关 + 间隔）。
                            // 老部署没有 notes/changes 时轮询本身不会启动，开关开着也无害。
                            ["sync", "同步", <SyncIcon fontSize='small' key='y' />] as const,
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
                                bgcolor: tab === key ? "var(--accent-wash)" : "transparent",
                                color: tab === key ? "var(--accent)" : "text.secondary",
                                "&:hover": { bgcolor: "var(--neutral-wash)" },
                            }}
                        >
                            {icon}
                            {label}
                        </Box>
                    ))}
                </Box>

                {/* 右侧内容：按页分发，每页自持状态（挂载时才拉数据） */}
                <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <Box sx={{ display: "flex", alignItems: "center", px: 2.5, py: 1.5 }}>
                        <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600 }}>
                            {tab === "appearance"
                                ? "外观"
                                : tab === "editor"
                                  ? "编辑器"
                                  : tab === "data"
                                    ? "数据"
                                    : tab === "sync"
                                      ? "同步"
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
                        <NotesAppearanceTab settings={settings} set={set} />
                    ) : tab === "editor" ? (
                        <NotesEditorTab settings={settings} set={set} />
                    ) : tab === "data" && data ? (
                        <NotesDataTab data={data} shareApi={shareApi} onNotify={onNotify} />
                    ) : tab === "sync" ? (
                        <NotesSyncTab />
                    ) : tab === "shares" && shareApi ? (
                        <NotesSharesTab
                            shareApi={shareApi}
                            onNotify={onNotify}
                            onOpenNote={onOpenNote}
                            onClose={onClose}
                        />
                    ) : tab === "backup" && data ? (
                        <NotesBackupTab data={data} onNotify={onNotify} />
                    ) : null}
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "flex-end", px: 2.5, py: 1.5, borderTop: "1px solid var(--neutral-hover)" }}>
                        <Button size='small' variant='contained' onClick={onClose} data-settings-done='1'>
                            完成
                        </Button>
                    </Box>
                </Box>
            </Box>
        </Dialog>
    );
}
