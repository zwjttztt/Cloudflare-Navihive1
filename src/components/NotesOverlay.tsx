// src/components/NotesOverlay.tsx
// 记事本的**懒加载入口**：hook（useNotes）与视图（NotesPage）都在这里面，
// 于是「打开记事本」之前，这整块代码一行都不进首屏包。
//
// 为什么值得单独一个文件（2026-10-06）：
// `NotesPage` 组件本身早就是 `lazy(() => import(...))` 了，但 **hook 还在首屏** ——
// 因为 App 顶层直接调了 `useNotes()`，而 hooks 不能异步调用。
// 结果：首屏包里still留着 hook 的全部逻辑与文案（实测 22 条中文文案、
// 连带整个 notes/recycle 的数据层都跟着进去）。
//
// ⚠️ 唯一从 App 那边漏出来的需求是**菜单上那个「记事本（N）」的计数**。
// 那个数字改由 App 自己用一个 `notesCount` state 持有，进入本组件时同步一次 ——
// 一个数字换一整个 hook 出首屏，这笔买卖很划算。
//
// 换句话说：这里的 props 只有「关掉自己」和「通知」两件事，
// 凡是记事本自己的状态，都由本组件内部持有。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NotesPage from "./NotesPage";
import type { NoteShareApi } from "./NoteShareDialog";
import { useNotes, type NotesApiLike } from "../hooks/useNotes";
import type { Note, NotesBackupSavePatch, NotesBackupState } from "../API/http";
import ConfirmDialog from "./ConfirmDialog";
import { Alert, Button } from "@mui/material";

export interface NotesOverlayProps {
    /**
     * 只需要 useNotes 要的那一部分 API。
     *
     * ⚠️ 这里刻意用 `NotesApiLike` 而不是 App 里的具体 client 类型：
     * 那个类型的 `restoreRecycleItem` 返回 `Promise<boolean>`，
     * 而 useNotes 声明的接口要 `Promise<{success:boolean}>` ——
     * 直接写具体类型会在此报一个和业务毫无关系的类型不兼容。
     */
    api: NotesApiLike & Partial<NoteShareApi>;
    /** 关掉整个记事本层 */
    onClose: () => void;
    onError: (message: string) => void;
    onNotify: (message: string, severity?: "success" | "error" | "info") => void;
    /** 把当前笔记数回报给宿主（菜单上那个「记事本（N）」要用） */
    onCountChange: (count: number) => void;
    /** 左下角显示的账号名（inkstone 布局）。没传就不显示具体用户名 */
    accountName?: string;
}

export default function NotesOverlay({
    api,
    onClose,
    onError,
    onNotify,
    onCountChange,
    accountName,
}: NotesOverlayProps) {
    /**
     * 乐观并发冲突的弹框（2026-10-09）。
     *
     * 多端 / 多标签页同时编辑同一条笔记时，后保存的那个会撞上 409。
     * 这里不替用户做决定：弹出来让他选「用我的覆盖」还是「看别人的版本」。
     *
     * ⚠️ 用 ref 持有处理函数：useNotes 在下面第一行就要它，而完整的处理逻辑
     * 又要用到 useNotes 返回的 reload —— 直接写函数会撞上「先声明后使用」。
     * ref 让两边解耦（组件每次渲染都把最新的闭包写进去）。
     */
    const [conflict, setConflict] = useState<{
        title: string;
        retry: () => Promise<void>;
    } | null>(null);
    /**
     * ⚠️ 传给 useNotes 的必须是**稳定引用**的包装函数：hook 把 onNoteConflict 放进
     * 了 updateNote 的依赖数组，直接把 ref.current 传进去的话，它拿到的是
     * 首次渲染那个空的初始值，之后我们往 ref 里写什么都跟它无关 ——
     * 冲突就变成「静默什么都不发生」（弹框永远不出来）。包装一层转发即可。
     */
    const conflictResolver = useRef<(
        current: Note,
        retry: () => Promise<void>
    ) => Promise<void>>(async () => {});
    const handleNoteConflict = useCallback(
        async (current: Note, retry: () => Promise<void>) => {
            await conflictResolver.current(current, retry);
        },
        []
    );
    const reloadRef = useRef<() => Promise<void>>(async () => {});

    const {
        notes,
        externalChange,
        reload,
        trash,
        loadTrash,
        restoreTrashed,
        purgeTrashed,
        emptyTrash,
        toggleArchive,
        createNote,
        updateNote,
        deleteNote,
        togglePin,
        toggleStar,
        folders,
        tags,
        noteTags,
        createFolder,
        moveFolder,
        reorderFolder,
        renameFolder,
        styleFolder,
        removeFolder,
        createTag,
        renameTag,
        styleTag,
        removeTag,
        assignTags,
        listRevisions,
        restoreRevision,
        getRevision,
        searchRemote,
        broadcastChange,
    } = useNotes({ api, onError, onNotify, onNoteConflict: handleNoteConflict });

    // 每次渲染把最新闭包写进 ref：冲突处理要用 reload / onNotify 的最新值
    reloadRef.current = reload;
    conflictResolver.current = async (current, retry) => {
        setConflict({ title: current.title || "无标题", retry });
    };

    /** 冲突弹框的两个出口：覆盖 / 重新加载 */
    const resolveConflict = async (overwrite: boolean) => {
        const pending = conflict;
        setConflict(null);
        if (!pending) return;
        if (overwrite) {
            await pending.retry();
            onNotify("已用你的版本覆盖", "success");
        } else {
            // 放弃本地改动，重拉一份 —— 用户能马上看到「别人改成了什么」
            await reloadRef.current();
            onNotify("已加载最新的版本（你这次的改动没有保存）", "info");
        }
    };

    /**
     * 打包给左栏第一列的那一套。
     *
     * ⚠️ 用 useMemo 而不是每次渲染新造一个字面量：NotesPage 里那几个 callback 会把
     * 这里挂进去的方法当依赖，外层对象每次都变会让它们跟着重跑（回调一变，
     * 下方 memo 与 effect 全失效，严重的会滚成「内存打满」那类死循环）。
     * （这段原本在 App.tsx 里，跟着 hook 一起搬到了这里。）
     */
    const folderTags = useMemo(
        () => ({
            folders,
            tags,
            noteTags,
            onCreateFolder: createFolder,
            onMoveFolder: moveFolder,
            onReorderFolder: reorderFolder,
            onRenameFolder: renameFolder,
            onStyleFolder: styleFolder,
            onRemoveFolder: removeFolder,
            onCreateTag: createTag,
            onRenameTag: renameTag,
            // ⚠️ 只有后端真有 updateTag 时才把它交出去：方法存在与否决定 UI 给不给
            // 「设置颜色」入口，否则按钮点了什么都不发生（比没有这个按钮更糟 ——
            // 用户会以为「颜色设上了」，换台设备打开又没了）。
            ...(typeof api.updateTag === "function" ? { onStyleTag: styleTag } : {}),
            onRemoveTag: removeTag,
            onAssignTags: assignTags,
            onListRevisions: listRevisions,
            onRestoreRevision: restoreRevision,
            onGetRevision: getRevision,
            onSearchRemote: searchRemote,
        }),
        [
            folders,
            tags,
            noteTags,
            createFolder,
            moveFolder,
            reorderFolder,
            renameFolder,
            styleFolder,
            removeFolder,
            createTag,
            renameTag,
            styleTag,
            removeTag,
            assignTags,
            listRevisions,
            restoreRevision,
            getRevision,
            searchRemote,
        ]
    );

    // 笔记数变化时回报宿主。
    // ⚠️ 依赖里放 `notes.length` 而不是 `notes` 本身：notes 每次保存都会换新引用，
    // 用它当依赖会在这里多跑一轮（而这里只是算个数字，不值当）。
    const [lastCount, setLastCount] = useState(notes.length);
    useEffect(() => {
        if (notes.length !== lastCount) {
            setLastCount(notes.length);
            onCountChange(notes.length);
        }
    }, [notes.length, lastCount, onCountChange]);

    /**
     * 记事本备份能力（2026-10-09 照 inkstone 的 BackupSettings）。
     * 与 shareApi / uploadApi 同一个套路：只在 api 实例真的有这些方法时才传，
     * 老部署（没有 notesBackup 端点 / 配置读写）设置里不出现「备份」页。
     */
    const backupApi = useMemo(() => {
        if (
            typeof api.getConfig !== "function" ||
            typeof api.setConfig !== "function" ||
            typeof api.notesBackupUpload !== "function" ||
            typeof api.notesBackupTest !== "function"
        ) {
            return undefined;
        }
        return {
            getState: async (): Promise<NotesBackupState> => {
                const [url, username, path, pwd, navPwd, schedule, retention, runsRaw] =
                    await Promise.all([
                        api.getConfig!("webdav.url"),
                        api.getConfig!("webdav.username"),
                        api.getConfig!("notesBackup.path"),
                        api.getConfig!("notesBackup.backupPassword"),
                        api.getConfig!("webdav.backupPassword"),
                        api.getConfig!("notesBackup.schedule"),
                        api.getConfig!("notesBackup.retention"),
                        api.getConfig!("notesBackup.runs"),
                    ]);
                let runs: NotesBackupState["runs"] = [];
                try {
                    const parsed: unknown = JSON.parse(runsRaw || "[]");
                    if (Array.isArray(parsed)) runs = parsed as NotesBackupState["runs"];
                } catch {
                    // 记录坏了就当没有，别让整个备份页打不开
                }
                const retentionNum = Number(retention);
                return {
                    webdavUrl: url || "",
                    webdavUsername: username || "",
                    path: path || "navihive-notes-backup",
                    // 库里没设自己的口令时告诉用户会沿用导航页的那份（占位提示用，
                    // 不把导航页口令回填进输入框 —— 免得「看着设了其实是空」）
                    backupPassword: pwd ?? "",
                    hasNavBackupPassword: Boolean(navPwd),
                    schedule: schedule || "off",
                    // retention 可以是 0（全部保留），别用 || 短路成默认值
                    retention:
                        retention === null || !Number.isFinite(retentionNum) ? 7 : retentionNum,
                    runs,
                };
            },
            save: async (patch: NotesBackupSavePatch): Promise<void> => {
                if (patch.path !== undefined) {
                    await api.setConfig!("notesBackup.path", patch.path);
                }
                if (patch.backupPassword !== undefined) {
                    await api.setConfig!("notesBackup.backupPassword", patch.backupPassword ?? "");
                }
                if (patch.schedule !== undefined) {
                    await api.setConfig!("notesBackup.schedule", patch.schedule);
                }
                if (patch.retention !== undefined) {
                    await api.setConfig!("notesBackup.retention", String(patch.retention));
                }
                if (patch.runs !== undefined) {
                    // 删除「最近备份」记录时全量写回（Worker 侧同一把钥匙，最多 12 条）
                    await api.setConfig!("notesBackup.runs", JSON.stringify(patch.runs));
                }
            },
            test: async () => {
                const r = await api.notesBackupTest!();
                return { success: r.success, message: r.message ?? "" };
            },
            run: async () => {
                const r = await api.notesBackupUpload!();
                return { success: r.success, message: r.message ?? "" };
            },
            // 备份闭环的另一半：把网盘上那份备份**取回来**恢复（2026-10-09）。
            // 同样是老部署没有这两个端点时自动不出现，而不是点了才报错。
            listRemote: async () => {
                if (typeof api.notesBackupListRemote !== "function") {
                    return { success: false, files: [], message: "当前部署不支持从网盘恢复" };
                }
                const r = await api.notesBackupListRemote();
                return {
                    success: r.success,
                    // ⚠️ 后端返回顶层 files（request 不包 data 层），别写 r.data?.files
                    files: r.files ?? [],
                    message: r.message ?? "",
                };
            },
            fetch: async (filename: string, password: string) => {
                if (typeof api.notesBackupDownload !== "function") {
                    return { success: false, message: "当前部署不支持从网盘恢复" };
                }
                const r = await api.notesBackupDownload(filename, password);
                return {
                    success: r.success,
                    message: r.message ?? "",
                    // ⚠️ 后端返回顶层 payload（request 不包 data 层），别写 r.data?.payload
                    payload: r.payload,
                    // 加密备份缺口令时后端回 encrypted / badPassword，前端据此弹口令框
                    code: r.code,
                };
            },
            // 删除网盘上的一份备份文件（最近备份的删除按钮，2026-10-10）。
            // 老部署没有该端点时返回失败，前端保留记录并提示。
            deleteRemote: async (filename: string) => {
                if (typeof api.notesBackupDeleteRemote !== "function") {
                    return { success: false, message: "当前部署不支持删除网盘备份" };
                }
                const r = await api.notesBackupDeleteRemote(filename);
                return { success: r.success, message: r.message ?? "" };
            },
        };
        // 依赖只有 api：getState/save/test/run 闭包里用到的都是它自己的方法
    }, [api]);

    return (
        <>
        {externalChange && <Alert severity='info' sx={{ position: "fixed", top: 8, left: "25%", zIndex: theme => theme.zIndex.modal + 1 }} action={<Button color='inherit' onClick={() => { if (window.confirm("刷新将重新加载页面，请先保存当前草稿；若其他标签页或其他设备修改了同一条笔记，保存时请先处理冲突。确定刷新吗？")) window.location.reload(); }}>刷新页面</Button>}>其他标签页或其他设备已更新笔记，请先保存草稿再刷新。</Alert>}
        <NotesPage
            shareApi={api.getNoteShare && api.createNoteShare && api.revokeNoteShare ? api as NotesApiLike & NoteShareApi : undefined}
            // ⚠️ 与 shareApi 同一个套路：只在这个 api 实例**真的有** uploadAttachment
            // 时才传。用途不只是类型 —— 老版本后端（没升级 migration 12、或没绑
            // 存储）拿不到这个方法，此时工具栏的「上传图片」会自动置灰并说明原因，
            // 而不是点了才报一个看不懂的错误。
            uploadApi={
                typeof api.uploadAttachment === "function"
                    ? {
                          uploadAttachment: api.uploadAttachment.bind(api),
                          // 附件统计 / 清理（2026-10-08 设置→数据）：老部署的 api 没有
                          // 这两个方法，可选透传，设置里相应能力自动隐藏。
                          ...(typeof api.listAttachments === "function"
                              ? { listAttachments: api.listAttachments.bind(api) }
                              : {}),
                          ...(typeof api.pruneAttachments === "function"
                              ? { pruneAttachments: api.pruneAttachments.bind(api) }
                              : {}),
                          // 附件管理器里逐条删除（2026-10-08 设置→数据→附件）
                          ...(typeof api.deleteAttachment === "function"
                              ? { deleteAttachment: api.deleteAttachment.bind(api) }
                              : {}),
                      }
                    : undefined
            }
            backupApi={backupApi}
            onDatasetChanged={broadcastChange}
            notes={notes}
            onClose={onClose}
            accountName={accountName}
            onCreate={createNote}
            onUpdate={updateNote}
            onDelete={deleteNote}
            onTogglePin={togglePin}
            trashedNotes={trash}
            onLoadTrash={loadTrash}
            onRestoreTrashed={restoreTrashed}
            onPurgeTrashed={purgeTrashed}
            onEmptyTrash={emptyTrash}
            onToggleArchive={toggleArchive}
            onToggleStar={toggleStar}
            onNotify={onNotify}
            folderTags={folderTags}
        />

        {/* 乐观并发冲突：必须挂在根层（Modal 塞进条件块会被一起卸掉） */}
        <ConfirmDialog
            open={conflict !== null}
            title='这条笔记在别处被改过了'
            confirmText='用我的覆盖'
            cancelText='看别人的版本'
            description={
                conflict
                    ? `「${conflict.title}」在另一个设备或标签页里刚被保存过。要用你现在的改动覆盖它吗？（选「看别人的版本」会丢弃你这次的改动）`
                    : ""
            }
            onConfirm={() => void resolveConflict(true)}
            onClose={() => void resolveConflict(false)}
        />
        </>
    );
}
