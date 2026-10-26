// src/components/notes/NotesDataTab.tsx
// 记事本设置·数据页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 概览统计 / 附件管理与清理 / 导出（JSON/ZIP）/ 导入 / 重建索引 / 清空回收站，
// 外加两个危险操作的二次确认与附件管理器、预览两个叠层。
// 状态自持：挂载（= 用户切到这一页）时才拉统计，关掉设置弹窗整体卸载。

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import StorageIcon from "@mui/icons-material/Storage";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import AttachmentManager from "../AttachmentManager";
import AttachmentPreviewDialog from "../AttachmentPreviewDialog";
import ConfirmDialog from "../ConfirmDialog";
import type { NoteImportStats, NoteImportProgress, NotesImportPayload, NoteStats } from "../../API/types";
import { SettingRow, fmtBytes } from "./settingsShared";
import type { NotesDataTab as NotesDataTabData } from "../NotesSettingsDialog";
import type { NoteShareApi } from "../NoteShareDialog";

export interface NotesDataTabProps {
    data: NotesDataTabData;
    shareApi?: NoteShareApi | null;
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

export default function NotesDataTab({ data, shareApi = null, onNotify }: NotesDataTabProps) {
    const [attStats, setAttStats] = useState<{ count: number; bytes: number } | null>(null);
    const [attManagerOpen, setAttManagerOpen] = useState(false);
    const [attPreview, setAttPreview] = useState<{ id: string; filename: string; mime: string } | null>(null);
    const [sharesCount, setSharesCount] = useState<number | null>(null);
    const [noteStats, setNoteStats] = useState<NoteStats | null>(null);
    const importFileRef = useRef<HTMLInputElement>(null);
    const [importBusy, setImportBusy] = useState(false);
    const [importProgress, setImportProgress] = useState<NoteImportProgress | null>(null);
    const [reindexBusy, setReindexBusy] = useState(false);
    const [reindexMessage, setReindexMessage] = useState("");
    const [confirmKind, setConfirmKind] = useState<"trash" | "prune" | null>(null);

    const dataRef = useRef(data);
    dataRef.current = data;

    const reloadAttStats = async () => {
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
    };

    // 挂载即拉（条件渲染保证只有切到本页才挂载）；live 标志防卸载后 setState
    useEffect(() => {
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
    }, [shareApi]);

    const handleImportFile = async (file: File | null | undefined) => {
        if (!file || !dataRef.current?.onImportNotes) return;
        setImportBusy(true);
        try {
            let r: NoteImportStats;
            if (dataRef.current.onImportFile && /\.zip$/i.test(file.name)) {
                r = await dataRef.current.onImportFile(file, setImportProgress);
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
                r = await dataRef.current.onImportNotes(parsed, setImportProgress);
            }
            onNotify?.(
                `导入完成：新增 ${r.created} 条，更新 ${r.updated} 条，保留本地 ${r.skipped} 条`,
                "success"
            );
        } catch (error) {
            onNotify?.("导入失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setImportBusy(false);
            setImportProgress(null);
            if (importFileRef.current) importFileRef.current.value = "";
        }
    };

    return (
        <>
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
                                            // 服务端 stats.words 是在库里数的（正文不出库）；data.stats.words 是前端扫
                                            // notes.content 算的，摘要档下只有前 200 字，会明显偏小 —— 仅作老部署兜底。
                                            // ⚠️ 用 `??` 不是三元：老部署的 stats 返回体里没有
                                            // words（字段是新加的），三元会拿到 undefined 显示空白。
                                            ["总字数", noteStats?.words ?? data.stats.words],
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
                                                border: "1px solid var(--neutral-hairline)",
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
                                            description='按文件名查看并删除附件；删后引用处显示占位。'
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
                                        description='含图片附件的完整 ZIP（JSON 只有正文，图片会丢）。'
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
                                        description='支持 JSON / ZIP 与 Obsidian Markdown 文件夹 ZIP，按内部标识取较新版本。'
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
                                {importProgress && (
                                    <Box sx={{ mt: 1 }} data-import-progress='1'>
                                        <LinearProgress
                                            variant={importProgress.total > 0 ? "determinate" : "indeterminate"}
                                            value={
                                                importProgress.total > 0
                                                    ? Math.min(
                                                          100,
                                                          Math.round(
                                                              (importProgress.current / importProgress.total) * 100
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
                                            {importProgress.phase}
                                            {importProgress.total > 0
                                                ? `（${importProgress.current}/${importProgress.total}）`
                                                : ""}
                                        </Typography>
                                    </Box>
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
                                {shareApi?.reindexNotes && (
                                    <SettingRow label='重建搜索索引' description='重建当前账号的全文索引，不改正文。'>
                                        <Button size='small' disabled={reindexBusy} onClick={async () => {
                                            setReindexBusy(true);
                                            try { const result = await shareApi.reindexNotes?.(); setReindexMessage(`已重建 ${result?.count ?? 0} 条笔记索引`); }
                                            catch (error) { setReindexMessage(error instanceof Error ? error.message : "重建失败"); }
                                            finally { setReindexBusy(false); }
                                        }}>{reindexBusy ? "重建中…" : "重建索引"}</Button>
                                        <Typography role='status' variant='caption'>{reindexMessage}</Typography>
                                    </SettingRow>
                                )}
                                {data.onPruneAttachments && (
                                    <SettingRow
                                        label='清理未引用附件'
                                        description='仅删除未被引用的图片，在用图片不受影响。'
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
                        // 文案与 AttachmentManager 保持一字不差（同一判据，与文件类型无关）
                        description='仅删除未被引用的附件，在用附件不受影响。'
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
                        // 点文件名 → 预览（2026-10-19）：这里与记事本左下角那个
                        // 入口是**同一个**管理器，行为必须一致，否则会出现
                        // 「同样的界面，一个点得开一个点不动」。
                        // 不按能力门控：只读预览不需要任何写权限，老部署上照样能用。
                        onPreview={file =>
                            setAttPreview({ id: file.id, filename: file.filename, mime: file.mime })
                        }
                    />
                )}

                {/* 附件预览 / 编辑 / 重命名（设置页这条入口）：与 NotesPage 里
                    那个是同一个组件、同一套能力。 */}
                <AttachmentPreviewDialog
                    target={attPreview}
                    onClose={() => setAttPreview(null)}
                    onNotify={onNotify}
                    onSaveContent={data?.onSaveAttachmentContent}
                    onRename={data?.onRenameAttachment}
                    // 内容 / 名字变了 → 概览统计里的条数与占用要重算
                    onChanged={() => void reloadAttStats()}
                />
        </>
    );
}
