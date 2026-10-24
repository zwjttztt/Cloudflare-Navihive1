// src/components/notes/NotesBackupTab.tsx
// 记事本设置·备份页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 照 inkstone 的 BackupSettings：概览 + 立即备份 / 目标（WebDAV，凭据自动带入
// 导航页保存的那套）/ 频率与保留 / 最近备份列表（展开详情、删除记录）/
// 从网盘恢复（列文件 → 下载 → 解密 → 走同一条导入链路）。
// 状态自持：挂载（= 用户切到本页）时才拉备份配置。

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import IconButton from "@mui/material/IconButton";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import StorageIcon from "@mui/icons-material/Storage";
import ConfirmDialog from "../ConfirmDialog";
import { SettingRow, fmtTime, fmtBytes } from "./settingsShared";
import { decodeBase64Bytes } from "../../utils/zip";
import type { NoteImportProgress, NotesBackupRun, NotesBackupSavePatch, NotesBackupState } from "../../API/types";
import type { NotesDataTab as NotesDataTabData } from "../NotesSettingsDialog";

export interface NotesBackupTabProps {
    data: NotesDataTabData;
    onNotify?: (message: string, kind?: "success" | "error") => void;
}

export default function NotesBackupTab({ data, onNotify }: NotesBackupTabProps) {
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
    // ---- 从网盘恢复（备份闭环的另一半）----
    // 网盘上现在有哪些备份文件；null = 还没列过（不自动列，免得每次进设置页都打网盘）
    const [remoteFiles, setRemoteFiles] = useState<
        { name: string; size: number; lastModified: string }[] | null
    >(null);
    const [remoteError, setRemoteError] = useState<string | null>(null);
    /** 待恢复的那份：弹口令框用 */
    const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
    const [restorePwd, setRestorePwd] = useState("");
    const [restoreBusy, setRestoreBusy] = useState(false);
    /** 从网盘恢复的进行中进度（下载 / 解包 / 上传附件 / 写入笔记） */
    const [restoreProgress, setRestoreProgress] = useState<NoteImportProgress | null>(null);
    /** 待删除的那条「最近备份」记录（ConfirmDialog 里用） */
    const [deleteRunTarget, setDeleteRunTarget] = useState<NotesBackupRun | null>(null);
    /** 删除记录的二次确认（原来是主弹窗里的 confirmKind，随本页一起自治） */
    const [confirmKind, setConfirmKind] = useState<"backup-run" | null>(null);

    const dataRef = useRef(data);
    dataRef.current = data;

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
        if (!cur?.onNotesBackupFetch || restoreBusy) return;
        if (!cur.onImportNotes && !cur.onImportFile) return;
        setRestoreBusy(true);
        // 下载阶段前端拿不到百分比（服务端从 WebDAV 整包下完才一次性返回），
        // 但大备份能等十几秒——挂个秒表让用户知道没卡死，比一根纹丝不动的不确定条强。
        const t0 = Date.now();
        const tick = window.setInterval(() => {
            setRestoreProgress(p =>
                p && p.phase.startsWith("下载备份")
                    ? { ...p, phase: `下载备份…（${Math.round((Date.now() - t0) / 1000)} 秒）` }
                    : p
            );
        }, 1000);
        try {
            setRestoreProgress({ phase: "下载备份", current: 0, total: 0 });
            const r = await cur.onNotesBackupFetch(filename, password);
            if (r.code === "encrypted") {
                setRestoreTarget(filename);
                setRemoteError(r.message || "这份备份加密了，请输入备份密码");
                return;
            }
            if (!r.success) {
                setRemoteError(r.message || "取回备份失败");
                return;
            }
            if (r.zipBase64) {
                // ZIP 备份（含附件）：交给与「数据页导入 zip」完全同一条链路 ——
                // 解包、附件回传、正文引用改写都在那边，这里不重写一遍。
                if (!cur.onImportFile) {
                    setRemoteError("当前部署不支持附件回传，无法恢复含附件的 ZIP 备份");
                    return;
                }
                const bytes = decodeBase64Bytes(r.zipBase64);
                const out = new Uint8Array(bytes.byteLength);
                out.set(bytes);
                const file = new File([out.buffer], filename, { type: "application/zip" });
                await cur.onImportFile(file, setRestoreProgress);
            } else if (r.payload) {
                if (!cur.onImportNotes) {
                    setRemoteError("当前部署不支持导入笔记");
                    return;
                }
                setRestoreProgress({ phase: "写入笔记", current: 0, total: 0 });
                await cur.onImportNotes(r.payload, setRestoreProgress);
            } else {
                setRemoteError(r.message || "取回备份失败");
                return;
            }
            setRemoteError(null);
            setRestoreTarget(null);
            setRestorePwd("");
            onNotify?.(`已从网盘恢复「${filename}」，列表已刷新`, "success");
        } catch (error) {
            setRemoteError(error instanceof Error ? error.message : "恢复失败");
        } finally {
            window.clearInterval(tick);
            setRestoreBusy(false);
            setRestoreProgress(null);
        }
    };

    const reloadBackupState = async () => {
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
    };
    // 挂载即拉（条件渲染保证只有切到本页才挂载）
    useEffect(() => {
        void reloadBackupState();
    }, []);

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

    return (
        <>
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
                                            bgcolor: "var(--accent-wash)",
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
                                        border: "1px solid var(--neutral-hairline)",
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
                                        border: "1px solid var(--neutral-hairline)",
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
                                            ? "设口令的备份加密上传，恢复需同一密码。"
                                            : "留空则明文上传；填了会覆盖导航页的备份口令。"}
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
                                                    ? "color-mix(in srgb, var(--success) 10%, transparent)"
                                                    : "var(--accent-wash)",
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
                                    description='服务端定时执行，页面无需打开；最多延迟 1 小时。'
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
                                    description='网盘保留的自动备份份数；手动备份全保留。'
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
                                            bgcolor: "var(--neutral-wash)",
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
                                                    border: "1px solid var(--neutral-hover)",
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
                                                            "&:hover": { bgcolor: "var(--neutral-wash)" },
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
                                                            ? `${run.noteCount ?? 0} 条${
                                                                  typeof run.attachmentCount === "number"
                                                                      ? ` · ${run.attachmentCount} 附件`
                                                                      : ""
                                                              }${
                                                                  run.skippedAttachments
                                                                      ? `（跳过 ${run.skippedAttachments}）`
                                                                      : ""
                                                              }${run.verified ? " · 已自检" : ""} · ${fmtBytes(run.bytes ?? 0)}`
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
                                                            borderTop: "1px solid var(--neutral-hover)",
                                                            bgcolor: "var(--neutral-wash)",
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
                                                border: "1px solid var(--neutral-hairline)",
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
                                                        bgcolor: "var(--accent-wash)",
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
                                                        // off 对 password 字段无效，浏览器照样填；new-password 才是挡板
                                                        autoComplete='new-password'
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
                                        {restoreProgress && (
                                            <Box sx={{ mt: 1 }} data-backup-progress='1'>
                                                <LinearProgress
                                                    variant={
                                                        restoreProgress.total > 0 ? "determinate" : "indeterminate"
                                                    }
                                                    value={
                                                        restoreProgress.total > 0
                                                            ? Math.min(
                                                                  100,
                                                                  Math.round(
                                                                      (restoreProgress.current /
                                                                          restoreProgress.total) *
                                                                          100
                                                                  )
                                                              )
                                                            : undefined
                                                    }
                                                />
                                                <Typography
                                                    variant='caption'
                                                    color='text.secondary'
                                                    sx={{ display: "block", mt: 0.5 }}
                                                >
                                                    {restoreProgress.phase}
                                                    {restoreProgress.total > 0
                                                        ? `（${restoreProgress.current}/${restoreProgress.total}）`
                                                        : ""}
                                                </Typography>
                                            </Box>
                                        )}
                                    </>
                                )}
                            </Box>
        )
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
        </>
    );
}