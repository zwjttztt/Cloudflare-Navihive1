// src/hooks/useNotes.ts
// 记事本这个域的状态与请求：从 App.tsx 抽出来，和 useSiteCreator 同一分工 ——
// 这里只管「拿到列表 / 增删改 / 提示」，不碰渲染。
//
// 一个刻意的取舍：**乐观更新 + 失败回滚**，而不是等服务端回来再改界面。
// 记事本是「想到就写」的场景，保存要是有 200ms 的延迟，手感会立刻变差；
// 而失败时回滚到旧值 + 提示，代价远小于「每敲一个字都等一下」。
import { useCallback, useEffect, useRef, useState } from "react";
import { readActiveAccount } from "../utils/accountScope";
import type {
    Note,
    NoteAttachment,
    NoteFolder,
    NoteRevision,
    NoteSearchResult,
    NoteTag,
    NotesChangesResult,
    NotesImportPayload,
    WebDavResult,
} from "../API/http";
import type { WebDavErrorCode } from "../API/types";
import { reportError } from "../utils/errorReporter";
import { isNoteConflict } from "../utils/noteConflict";
import {
    loadNotesSyncCursor,
    loadNotesSyncPrefs,
    saveNotesSyncCursor,
} from "../utils/notesSync";
import type { NotifySeverity } from "./useNotify";

/** 文件夹排序：先按 order_num，再按名字（和后端 listFolders 的 ORDER BY 一致） */
function sortFolders(a: NoteFolder, b: NoteFolder): number {
    return (a.order_num ?? 0) - (b.order_num ?? 0) || a.name.localeCompare(b.name);
}
/**
 * 标签排序：按名字（后端 listTags 也是 ORDER BY name）。
 *
 * ⚠️ 两边都兜一层空串：`createTag` 会 `[...prev, tag].sort(sortTags)`，
 * 后端要是回了一条没有 name 的记录（桩接口/老数据都可能），`undefined.localeCompare`
 * 会当场把整个左栏渲染打挂（白屏），比多一个空行严重得多。
 */
function sortTags(a: NoteTag, b: NoteTag): number {
    return (a.name || "").localeCompare(b.name || "");
}

/** 回收站里的一条（阶段三：只把 kind='note' 的拎出来给记事本用） */
export interface TrashedNote {
    /** recycle_bin.id —— 还原 / 彻底删除都用它，不是 notes.id */
    recycleId: number;
    title: string;
    /** 删除时间（毫秒时间戳） */
    deletedAt: number;
}

/** 本域用到的后端方法，单测里可以塞假实现 */
export type NotesApiLike = {
    listNotes(): Promise<Note[]>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }>;
    // 阶段三：回收站。⚠️ 这几个是**可选**的 —— 老 mock / 老调用方没实现时，
    // 记事本要能优雅降级成「回收站视图不可用」，而不是整个页面崩。
    getRecycleBin?(): Promise<{
        items?: Array<{ id: number; kind: "site" | "group" | "note"; name: string; deletedAt: number }>;
    }>;
    restoreRecycleItem?(id: number): Promise<{ success: boolean }>;
    purgeRecycleItem?(id: number): Promise<{ success: boolean }>;
    emptyRecycleBin?(): Promise<{ success: boolean }>;
    // ---------- 阶段三收尾：文件夹 / 标签 ----------
    // 同样全部可选：老部署 / 老 mock 上没这几个方法时，界面退化成「没有文件夹、没有标签」，
    // 而不是整个记事本打不开。
    listFolders?(): Promise<NoteFolder[]>;
    createFolder?(name: string, parentId?: number | null): Promise<NoteFolder>;
    updateFolder?(id: number, patch: Partial<NoteFolder>): Promise<NoteFolder | null>;
    deleteFolder?(id: number): Promise<{ success: boolean; orphaned: number }>;
    listTags?(): Promise<NoteTag[]>;
    createTag?(name: string, color?: string | null): Promise<NoteTag>;
    updateTag?(id: number, patch: Partial<NoteTag>): Promise<NoteTag | null>;
    deleteTag?(id: number): Promise<{ success: boolean }>;
    setNoteTags?(noteId: number, tagIds: number[]): Promise<NoteTag[]>;
    /** 全量标签关联：{ [noteId]: tagId[] } */
    listNoteTags?(): Promise<Record<number, number[]>>;
    /** 版本历史：列表 / 取全文 / 恢复 */
    listNoteRevisions?(noteId: number): Promise<NoteRevision[]>;
    getNoteRevision?(noteId: number, revisionId: number): Promise<NoteRevision | null>;
    restoreNoteRevision?(noteId: number, revisionId: number): Promise<Note | null>;
    /** 服务端全文检索（2026-10-09）。可选：老部署没有 notes/search 时前端退回本地搜 */
    notesSearch?(query: string, limit?: number): Promise<NoteSearchResult>;

    // ---------- 图片附件（2026-07）----------
    // 同样**可选**：后端没配存储（R2 / KV 都没绑）时这个方法不存在，
    // 界面退化成「上传图片不可用」并置灰，而不是整个记事本打不开。
    uploadAttachment?(
        file: File,
        noteId?: number | null
    ): Promise<{ id: string; url: string; filename: string; mime: string; size: number }>;
    listAttachments?(): Promise<NoteAttachment[]>;
    deleteAttachment?(id: string): Promise<{ ok: boolean }>;
    /** 设置→数据→维护：清理未引用附件（2026-10-08）。可选：老部署没有 */
    pruneAttachments?(): Promise<{ removed: number; freedBytes: number }>;

    // ---------- 记事本备份（2026-10-09 照 inkstone 的 BackupSettings）----------
    // 同样**可选**：老部署没有 notesBackup 端点 / 配置读写时，设置→备份页自动降级。
    notesBackupTest?(): Promise<WebDavResult>;
    notesBackupUpload?(): Promise<WebDavResult<{ filename: string; size: number }>>;
    /** 列出网盘备份目录里的笔记备份文件（2026-10-09，备份闭环的「取回」一半）。
     *  ⚠️ 返回顶层 `files`：`request()` 不包 data 层。 */
    notesBackupListRemote?(): Promise<{
        success: boolean;
        message?: string;
        code?: WebDavErrorCode;
        files?: { name: string; size: number; lastModified: string }[];
    }>;
    /** 下载一份网盘备份并解密（加密备份要口令）。⚠️ 返回顶层 `payload`。 */
    notesBackupDownload?(
        filename: string,
        password?: string
    ): Promise<{
        success: boolean;
        code?: WebDavErrorCode;
        message?: string;
        payload?: NotesImportPayload;
    }>;
    /** 删除网盘上的一份记事本备份（2026-10-10，最近备份的删除按钮）。可选：老部署没有 */
    notesBackupDeleteRemote?(filename: string): Promise<WebDavResult>;
    /** 备份页的配置读写（notesBackup.* 是账号私有配置，与导航页 webdav.* 同一机制） */
    getConfig?(key: string): Promise<string | null>;
    setConfig?(key: string, value: string): Promise<boolean>;
    /** 跨设备变更轮询（2026-10-11）。可选：老部署没有 notes/changes 时不轮询 */
    notesChanges?(since?: string): Promise<NotesChangesResult>;
};

type UseNotesParams = {
    api: NotesApiLike;
    onError: (message: string) => void;
    onNotify: (message: string, level?: NotifySeverity) => void;
    /**
     * 乐观并发冲突（2026-10-09）：保存时服务端回 409（这条笔记在别处被改过）。
     * 上层据此弹框让用户选「用我的覆盖 / 重新加载」；不传就退化成普通的保存失败提示。
     */
    onNoteConflict?: (
        current: Note,
        retry: () => Promise<void>
    ) => Promise<void>;
};

export function useNotes({ api, onError, onNotify, onNoteConflict }: UseNotesParams) {
    const broadcastRef = useRef<BroadcastChannel | null>(null);
    const [externalChange, setExternalChange] = useState(false);
    useEffect(() => {
        if (typeof BroadcastChannel === "undefined") return;
        const channel = new BroadcastChannel(`navihive-notes-changed:${readActiveAccount() ?? "anon"}`);
        broadcastRef.current = channel;
        channel.onmessage = event => {
            if (event.data?.type === "changed") { setExternalChange(true); onNotify("其他标签页的笔记已更新，请刷新列表后继续编辑", "info"); }
            if (event.data?.type === "sync-heartbeat") { lastHeartbeatRef.current = Date.now(); }
        };
        return () => { channel.close(); broadcastRef.current = null; };
    }, [onNotify]);

    /**
     * 跨设备变更轮询（2026-10-11，阶段 5）。
     *
     * 口径（重要，别「顺手升级」）：
     *   - 只做「发现变更 → reload() 整表重拉」，**绝不自动改编辑器里的草稿**；
     *     真正的并发保存冲突仍由 rev 守卫（409 + 冲突弹框）兜底。
     *   - 同一账号开多个标签页时只有「主标签」发请求：靠频道上的
     *     sync-heartbeat 判活，主标签关闭后其余标签自然接管。短暂的双发无害
     *     （轮询是幂等读），不做复杂的选举。
     *   - 首次轮询只初始化游标，不报变更 —— 否则每次打开记事本都会白刷一次。
     *   - 页面隐藏时跳过（省 D1 读配额）；回前台后的下一轮自然补上。
     *   - notesChanges 不存在（老部署）时整个 effect 直接退化为空转。
     */
    useEffect(() => {
        if (typeof api.notesChanges !== "function") return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tabId =
            typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
        const tick = async () => {
            if (stopped) return;
            const prefs = loadNotesSyncPrefs();
            const intervalMs = Math.max(30, prefs.intervalSec) * 1000;
            try {
                const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
                if (prefs.enabled && !hidden) {
                    // 主标签判活：最近 intervalMs*1.5 内有其它标签的心跳就让位
                    const isLeader = Date.now() - lastHeartbeatRef.current >= intervalMs * 1.5;
                    if (isLeader) {
                        broadcastRef.current?.postMessage({ type: "sync-heartbeat", tabId });
                        const since = loadNotesSyncCursor();
                        const r = await api.notesChanges!(since || undefined);
                        if (r?.success && r.now && !stopped) {
                            const shape = JSON.stringify([r.folders, r.tags, r.noteTags]);
                            const structural =
                                lastSyncShapeRef.current !== null &&
                                shape !== lastSyncShapeRef.current;
                            lastSyncShapeRef.current = shape;
                            // since 为空 = 首次轮询，只建立基线不触发刷新
                            const shouldReload = Boolean(since) && (r.notesChanged > 0 || structural);
                            saveNotesSyncCursor(r.now);
                            if (shouldReload) {
                                await reloadForSyncRef.current();
                                if (!stopped) {
                                    onNotify("其他设备的笔记更新已同步到列表", "info");
                                    broadcastRef.current?.postMessage({ type: "changed" });
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                // 轮询失败静默：下一轮再试。连续失败也不 toast —— 断网时每分钟弹一次没人受得了
                reportError(error, { source: "notes-sync-poll" });
            }
            if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
        };
        timer = setTimeout(() => { void tick(); }, 5_000);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [api, onNotify]);
    const [notes, setNotes] = useState<Note[]>([]);
    const [loaded, setLoaded] = useState(false);
    /**
     * 跨设备轮询的「主标签」判活：最近一次收到其它标签心跳的时间。
     * 放 ref 不放 state —— 它每轮都在变，进 state 会无谓地重渲染整棵树。
     */
    const lastHeartbeatRef = useRef(0);
    /** 上一轮轮询的文件夹/标签快照（JSON 字符串），用来发现结构性变更 */
    const lastSyncShapeRef = useRef<string | null>(null);
    /** 阶段三：回收站里的笔记（懒加载，进「回收站」视图时才拉） */
    const [trash, setTrash] = useState<TrashedNote[]>([]);
    /** 阶段三收尾：笔记文件夹 / 标签（左栏第一列要用，所以状态放在这里而不是组件里） */
    const [folders, setFolders] = useState<NoteFolder[]>([]);
    const [tags, setTags] = useState<NoteTag[]>([]);
    /** 笔记 → 标签Id：[noteId]: tagId[] */
    const [noteTags, setNoteTags] = useState<Record<number, number[]>>({});

    /**
     * 每条笔记**最新已知的版本号**（rev）。
     *
     * ⚠️ 为什么不能只读 notes 里的 rev：React 的状态更新要等渲染 + effect 才落进
     * notesRef，而排队的下一笔写入在**同一轮微任务**里就开跑了（上一笔的网络请求
     * 一 resolve，`.then` 立刻执行）。等它跑的时候 notesRef 里还是旧 rev ——
     * 排队就白排了，第二笔照样带着旧版本号发出去。
     * 所以服务端一回就把新 rev 记在这里，下一笔**同步**就能读到。
     */
    const revById = useRef(new Map<number, number>());
    /** 拉列表 / 重建状态时把 rev 的底账重铺一遍 */
    const seedRevs = useCallback((list: Note[]) => {
        const map = new Map<number, number>();
        for (const item of list) {
            if (typeof item.id === "number" && typeof item.rev === "number") map.set(item.id, item.rev);
        }
        revById.current = map;
    }, []);

    const reload = useCallback(async () => {
        try {
            const list = await api.listNotes();
            const next = Array.isArray(list) ? list : [];
            seedRevs(next);
            setNotes(next);
            setLoaded(true);
            setExternalChange(false);
        } catch (error) {
            reportError(error, { source: "notes-list" });
            onError("加载记事本失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onError, seedRevs]);

    // 首屏拉一次：笔记条数要显示在顶栏按钮上，不能等用户点开面板才加载
    useEffect(() => {
        void reload();
    }, [reload]);

    /** 轮询 effect 里用 ref 读 reload，避免把整条 useNotes 依赖链拖进轮询的依赖数组 */
    const reloadForSyncRef = useRef(reload);
    useEffect(() => {
        reloadForSyncRef.current = reload;
    }, [reload]);

    const createNote = useCallback(
        async (draft: Partial<Note> = {}) => {
            try {
                const created = await api.createNote(draft);
                broadcastRef.current?.postMessage({ type: "changed" });
                setNotes(prev => [...prev, created]);
                if (draft.content && api.listTags && api.listNoteTags) {
                    try {
                        const [nextTags, nextLinks] = await Promise.all([api.listTags(), api.listNoteTags()]);
                        setTags(nextTags); setNoteTags(nextLinks);
                    } catch (error) {
                        reportError(error, { source: "notes-tags-refresh" });
                        onError("笔记已创建，但标签刷新失败，请重新打开记事本");
                    }
                }
                return created;
            } catch (error) {
                reportError(error, { source: "note-create" });
                onError("新建笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onError]
    );

    /**
     * 最新的 notes。排队中的那笔写入必须**真正执行时**再读它，
     * 不能拿调用那一刻的快照 —— 快照里的 rev 是上一次保存的版本号，
     * 拿它去保存就会被并发守卫当成「别处改过」（见下面的 writeQueue）。
     */
    const notesRef = useRef(notes);
    useEffect(() => {
        notesRef.current = notes;
    }, [notes]);

    /**
     * 同一条笔记的写入队列：noteId → 「上一笔写完」的 promise。
     *
     * ⚠️ 没有它的时候，「连点两下置顶」会稳定弹出冲突框：
     * 第二下点击发生在第一笔保存的**请求还在路上**时，`before.rev` 读到的还是
     * 上一次的版本号，于是带着同一个 rev 又发一笔 —— 服务端第一笔已经把 rev
     * +1，第二笔命中 `AND rev = 旧值` 一条都改不到，回 409 → 弹「别处被修改过」。
     * 那个框本意是防**别的设备/标签页**抢写，结果自己把自己撞下去了。
     *
     * 排队之后：第二笔等第一笔**落地、并把响应里新的 rev 回填进 notes** 之后才开始，
     * 带的是新版本号，不会误判；真有别处抢写时才弹框。
     */
    const writeQueue = useRef(new Map<number, Promise<void>>());

    /** 乐观更新：先把界面上改掉，失败再回滚到旧值并提示 */
    const runUpdate = useCallback(
        async (id: number, patch: Partial<Note>, opts: { force?: boolean } = {}): Promise<boolean> => {
            const before = notesRef.current.find(n => n.id === id);
            if (!before) return false;
            setNotes(prev => prev.map(n => (n.id === id ? { ...n, ...patch } : n)));
            try {
                // 乐观并发：带上「我改的是哪一版」（force = 用户已确认要覆盖，不校验）
                // ⚠️ rev 以 revById 为准（上一笔保存刚记下的），notesRef 里的可能还没刷新
                const known = revById.current.get(id);
                const baseRev = typeof known === "number" ? known : before.rev;
                const withRev =
                    !opts.force && typeof baseRev === "number"
                        ? { ...patch, rev: baseRev }
                        : patch;
                const saved = await api.updateNote(id, withRev);
                if (saved) {
                    broadcastRef.current?.postMessage({ type: "changed" });
                    // 服务端给的新版本号**立刻**记账，下一笔排队写入就能带上它
                    if (typeof saved.rev === "number") revById.current.set(id, saved.rev);
                    else revById.current.delete(id);
                    setNotes(prev => prev.map(n => (n.id === id ? saved : n)));
                    if (patch.content !== undefined && api.listTags && api.listNoteTags) {
                        try {
                            const [nextTags, nextLinks] = await Promise.all([api.listTags(), api.listNoteTags()]);
                            setTags(nextTags); setNoteTags(nextLinks);
                        } catch (error) {
                            // 保存已成功，元数据读取失败不能把正文回滚成旧版本。
                            reportError(error, { source: "notes-tags-refresh" });
                            onError("笔记已保存，但标签刷新失败，请重新打开记事本");
                        }
                    }
                } else {
                    throw new Error("笔记不存在或保存失败");
                }
            } catch (error) {
                // 乐观并发冲突：不是「保存失败」，是「要先问用户一句」。
                // 交给上层弹框（覆盖 / 重新加载）；上层没接就退化成老的错误提示。
                if (isNoteConflict(error) && onNoteConflict) {
                    setNotes(prev => prev.map(n => (n.id === id ? before : n)));
                    await onNoteConflict(
                        error.note ?? before,
                        async () => { await updateNote(id, patch, { force: true }); }
                    );
                    return false;
                }
                reportError(error, { source: "note-update" });
                setNotes(prev => prev.map(n => (n.id === id ? before : n)));
                onError("保存笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
                return false;
            }
            return true;
        },
        [api, onError, onNoteConflict]
    );

    /**
     * 对外那一个 updateNote：**同一条笔记的写入串行化**。
     * 新来的一笔排到上一笔后面，且真正轮到它时才去读 rev（见 notesRef 的说明）。
     * 返回的是这一笔自己的结果（不是队列的），调用方语义不变。
     */
    const updateNote = useCallback(
        (id: number, patch: Partial<Note>, opts: { force?: boolean } = {}): Promise<boolean> => {
            const queue = writeQueue.current;
            const prev = queue.get(id) ?? Promise.resolve();
            const run = prev.then(() => runUpdate(id, patch, opts));
            // 队列里存的是「吞掉结果」的尾巴：任何一笔失败都不能让后续的写入
            // 永远卡在 rejected 的 promise 上（那会变成「保存彻底不动了」）。
            const tail = run.then(
                () => undefined,
                () => undefined
            );
            queue.set(id, tail);
            void tail.then(() => {
                if (queue.get(id) === tail) queue.delete(id);
            });
            return run;
        },
        [runUpdate]
    );

    /**
     * 置顶：走同一个 updateNote（服务端白名单里有 pinned）。
     *
     * ⚠️ 取反必须**按最新状态**算，不能按传进来的那份 note 快照算：
     * 连点两下时第二下拿到的还是旧快照（第一笔刚发出去、界面上的乐观更新有可能
     * 还没回到这一行），按快照取反会得到和第一下一样的值 —— 于是「点两下」净效果是
     * 停在置顶状态、外加一次带着旧 rev 的写入（那就是冲突框的来源）。
     */
    const togglePin = useCallback(
        async (note: Note) => {
            const id = note.id!;
            const cur = notesRef.current.find(n => n.id === id) ?? note;
            await updateNote(id, { pinned: !cur.pinned });
        },
        [updateNote]
    );

    /** 收藏（与置顶分离，2026-10-09）：置顶管排序、收藏管筛选（取反同上按最新状态） */
    const toggleStar = useCallback(
        async (note: Note) => {
            const id = note.id!;
            const cur = notesRef.current.find(n => n.id === id) ?? note;
            await updateNote(id, { starred: !cur.starred });
        },
        [updateNote]
    );

    const deleteNote = useCallback(
        async (note: Note) => {
            const before = notes;
            // 先从列表里拿掉，用户点删除就该马上看到它消失
            setNotes(prev => prev.filter(n => n.id !== note.id));
            try {
                const res = await api.deleteNote(note.id!);
                broadcastRef.current?.postMessage({ type: "changed" });
                onNotify(
                    res.recycleId
                        ? "笔记已移到回收站，可在「回收站」里还原"
                        : "笔记已删除",
                    "success"
                );
            } catch (error) {
                reportError(error, { source: "note-delete" });
                setNotes(before);
                onError("删除笔记失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [notes, api, onNotify, onError]
    );

    /** 拖拽排序后把新顺序写回去；失败不重排（服务端是唯一真相） */
    const saveOrder = useCallback(
        async (ordered: Note[]) => {
            setNotes(ordered);
            try {
                await (api as unknown as {
                    updateNoteOrder(o: { id: number; order_num: number }[]): Promise<boolean>;
                }).updateNoteOrder(
                    ordered.map((n, i) => ({ id: n.id!, order_num: i }))
                );
                // 排序也是一次数据集变更（2026-10-11）：其它标签页 / 同步轮询都要能看见
                broadcastRef.current?.postMessage({ type: "changed" });
            } catch (error) {
                reportError(error, { source: "note-order" });
                onError("保存排序失败，正在重新加载");
                void reload();
            }
        },
        [api, onError, reload]
    );

    // ---------- 阶段三：回收站 + 归档 ----------

    /**
     * 拉回收站里的笔记。
     *
     * 只留 `kind === "note"`：同一个回收站还放着被删的卡片和分组，
     * 那是主站那边的界面管的事，记事本不该把它们列进来。
     */
    const loadTrash = useCallback(async () => {
        if (typeof api.getRecycleBin !== "function") {
            setTrash([]);
            return;
        }
        try {
            const res = await api.getRecycleBin();
            setTrash(
                (res?.items || [])
                    .filter(i => i.kind === "note")
                    .map(i => ({ recycleId: i.id, title: i.name, deletedAt: i.deletedAt }))
            );
        } catch (error) {
            reportError(error, { source: "notes-trash-list" });
            setTrash([]);
            onError("读取回收站失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onError]);

    /** 从回收站还原一条：服务端会插回一条**新 id** 的笔记，所以要整表重拉 */
    const restoreTrashed = useCallback(
        async (recycleId: number) => {
            if (typeof api.restoreRecycleItem !== "function") return;
            try {
                await api.restoreRecycleItem(recycleId);
                broadcastRef.current?.postMessage({ type: "changed" });
                onNotify("已还原到全部笔记", "success");
                await loadTrash();
                await reload();
            } catch (error) {
                reportError(error, { source: "notes-trash-restore" });
                onError("还原失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onNotify, onError, loadTrash, reload]
    );

    /** 彻底删除：这一下就找不回来了，所以按钮要跟「还原」分开放 */
    const purgeTrashed = useCallback(
        async (recycleId: number) => {
            if (typeof api.purgeRecycleItem !== "function") return;
            try {
                await api.purgeRecycleItem(recycleId);
                broadcastRef.current?.postMessage({ type: "changed" });
                onNotify("已彻底删除", "success");
                await loadTrash();
            } catch (error) {
                reportError(error, { source: "notes-trash-purge" });
                onError("彻底删除失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onNotify, onError, loadTrash]
    );

    /** 清空回收站（只清笔记，不动卡片和分组） */
    const emptyTrash = useCallback(async () => {
        if (typeof api.emptyRecycleBin !== "function") return;
        try {
            await api.emptyRecycleBin();
            broadcastRef.current?.postMessage({ type: "changed" });
            onNotify("回收站已清空", "success");
            await loadTrash();
        } catch (error) {
            reportError(error, { source: "notes-trash-empty" });
            onError("清空回收站失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onNotify, onError, loadTrash]);

    /** 归档 / 取回归档：乐观更新走 updateNote，归档后不在「全部」里露面 */
    const toggleArchive = useCallback(
        async (note: Note) => {
            const id = note.id!;
            const cur = notesRef.current.find(n => n.id === id) ?? note;
            await updateNote(id, { archived: !cur.archived });
        },
        [updateNote]
    );

    // ---------- 阶段三收尾：文件夹 / 标签 ----------

    /**
     * 拉文件夹 + 标签两份清单。
     *
     * 放在同一个 callback 里、一次 mount 只调一次：这两份是小清单（几十条），
     * 分开两个 effect 会让首屏多两次 setState，没必要。
     */
    const loadMeta = useCallback(async () => {
        if (typeof api.listFolders === "function") {
            try {
                const list = await api.listFolders();
                setFolders(Array.isArray(list) ? list : []);
            } catch (error) {
                reportError(error, { source: "notes-folders-list" });
                setFolders([]);
            }
        }
        if (typeof api.listTags === "function") {
            try {
                const list = await api.listTags();
                setTags(Array.isArray(list) ? list : []);
            } catch (error) {
                reportError(error, { source: "notes-tags-list" });
                setTags([]);
            }
        }
        if (typeof api.listNoteTags === "function") {
            try {
                const links = await api.listNoteTags();
                // 必须是对象（Record）才敢用：null / 数组都可能被后端意外返回，
                // 而下面 `noteTags[noteId]` 的写法对 null 会直接抛。
                setNoteTags(links && typeof links === "object" ? links : {});
            } catch (error) {
                reportError(error, { source: "notes-tag-links" });
                setNoteTags({});
            }
        }
    }, [api]);

    // 文件夹 / 标签首屏一起拉：左栏第一列要在记事本打开前就有东西，
    // 挂在首屏这次上，和笔记同一个节奏（不多一次往返）。
    // ⚠️ 这个 effect 必须写在 loadMeta **之后**：依赖一个尚未声明的 callback，
    // 就是 TDZ 报错（Block-scoped variable used before its declaration）。
    useEffect(() => {
        void loadMeta();
    }, [loadMeta]);

    /** 笔记增删后文件夹/标签的计数会变，重拉一次最省事（清单就几十条） */
    const createFolder = useCallback(
        async (name: string, parentId: number | null = null) => {
            if (typeof api.createFolder !== "function") return null;
            try {
                const folder = await api.createFolder(name, parentId);
                broadcastRef.current?.postMessage({ type: "changed" });
                setFolders(prev => [...prev, folder].sort(sortFolders));
                onNotify(`已新建文件夹「${folder.name}」`, "success");
                return folder;
            } catch (error) {
                reportError(error, { source: "note-folder-create" });
                onError("新建文件夹失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onNotify, onError]
    );

    const moveFolder = useCallback(async (id: number, parentId: number | null) => {
        if (!api.updateFolder) return;
        try {
            const folder = await api.updateFolder(id, { parent_id: parentId });
            broadcastRef.current?.postMessage({ type: "changed" });
            if (!folder) throw new Error("文件夹不存在");
            setFolders(prev => prev.map(f => f.id === id ? folder : f));
        } catch (error) {
            onError("移动文件夹失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    }, [api, onError]);

    /**
     * 同级内前后挪一位（inkstone 文件夹菜单里的「向前/向后移动」）。
     *
     * 做法是**和相邻兄弟交换 order_num**，不是简单地给 ±1：
     * order_num 是后端 `COALESCE(MAX(order_num)+1, 0)` 累出来的，同级内可能有空洞、
     * 也可能有重复，直接 ±1 会撞车（两个文件夹 order_num 相同，排序就不稳定了）。
     * 交换则永远自洽。
     *
     * 两条 updateFolder 必须**都成功**才算成功：只成功一条会让两个文件夹的
     * order_num 变成同一个值，界面上顺序就乱了 —— 所以失败时整份回退。
     */
    const reorderFolder = useCallback(
        async (id: number, dir: -1 | 1) => {
            if (typeof api.updateFolder !== "function") return;
            const target = folders.find(f => f.id === id);
            if (!target) return;
            const siblings = folders
                .filter(f => (f.parent_id ?? null) === (target.parent_id ?? null))
                .sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0));
            const idx = siblings.findIndex(f => f.id === id);
            const swapWith = siblings[idx + dir];
            // 已经在最前 / 最后：不报错也不动（inkstone 同样是把这一项置灰）
            if (idx < 0 || !swapWith) return;
            const aOrder = target.order_num ?? idx;
            const bOrder = swapWith.order_num ?? idx + dir;
            const before = folders;
            try {
                const [fa, fb] = await Promise.all([
                    api.updateFolder(id, { order_num: bOrder }),
                    api.updateFolder(swapWith.id!, { order_num: aOrder }),
                ]);
                if (!fa || !fb) throw new Error("排序失败");
                setFolders(prev =>
                    prev.map(f => (f.id === id ? fa : f.id === swapWith.id ? fb : f))
                );
            } catch (error) {
                reportError(error, { source: "note-folder-reorder" });
                setFolders(before);
                onError(
                    "调整文件夹顺序失败: " +
                        (error instanceof Error ? error.message : "未知错误")
                );
            }
        },
        [api, folders, onError]
    );

    const renameFolder = useCallback(
        async (id: number, name: string) => {
            if (typeof api.updateFolder !== "function") return;
            try {
                const folder = await api.updateFolder(id, { name });
                broadcastRef.current?.postMessage({ type: "changed" });
                if (folder) {
                    setFolders(prev => prev.map(f => (f.id === id ? folder : f)));
                }
            } catch (error) {
                reportError(error, { source: "note-folder-update" });
                onError("重命名文件夹失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError]
    );

    /** 文件夹外观（icon / color）：同 updateFolder 一条路，只改这两字段 */
    const styleFolder = useCallback(
        async (id: number, patch: { icon?: string | null; color?: string | null }) => {
            if (typeof api.updateFolder !== "function") return;
            try {
                const folder = await api.updateFolder(id, patch);
                broadcastRef.current?.postMessage({ type: "changed" });
                if (folder) {
                    setFolders(prev => prev.map(f => (f.id === id ? folder : f)));
                }
            } catch (error) {
                reportError(error, { source: "note-folder-style" });
                onError("设置文件夹外观失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError]
    );

    const removeFolder = useCallback(
        async (id: number) => {
            if (typeof api.deleteFolder !== "function") return;
            const before = folders;
            // 先摘掉，失败再放回去：删文件夹不该让左栏卡在一个已经不存在的项上
            setFolders(prev => prev.filter(f => f.id !== id));
            try {
                const res = await api.deleteFolder(id);
                broadcastRef.current?.postMessage({ type: "changed" });
                if (!res.success) throw new Error("删除失败");
                setFolders(prev => prev.map(f => f.parent_id === id ? { ...f, parent_id: null } : f));
                if (res?.orphaned > 0) {
                    onNotify(`${res.orphaned} 条笔记已移到「未归类」`, "success");
                }
                // 笔记被挪走了，本地那份 notes 里的 folder_id 也跟着失效
                await reload();
            } catch (error) {
                reportError(error, { source: "note-folder-delete" });
                setFolders(before);
                onError("删除文件夹失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError, onNotify, folders, reload]
    );

    const createTag = useCallback(
        async (name: string) => {
            if (typeof api.createTag !== "function") return null;
            try {
                const tag = await api.createTag(name);
                broadcastRef.current?.postMessage({ type: "changed" });
                setTags(prev => [...prev, tag].sort(sortTags));
                onNotify(`已新建标签「${tag.name}」`, "success");
                return tag;
            } catch (error) {
                reportError(error, { source: "note-tag-create" });
                onError("新建标签失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onNotify, onError]
    );

    const renameTag = useCallback(
        async (id: number, name: string) => {
            if (typeof api.updateTag !== "function") return;
            try {
                const tag = await api.updateTag(id, { name });
                broadcastRef.current?.postMessage({ type: "changed" });
                if (tag) setTags(prev => prev.map(t => (t.id === id ? tag : t)));
            } catch (error) {
                reportError(error, { source: "note-tag-update" });
                onError("重命名标签失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError]
    );

    /**
     * 标签颜色（`note_tag.color`）：与文件夹外观同一套路，走 updateTag 落库。
     *
     * 为什么单独一个方法而不是复用 renameTag：它只改 color 一个字段，
     * 传 diff 更清楚；而且后端 RETURNING 会把 count 一起带回来，
     * 左栏那条标签的计数顺便就刷新了（省一次 reload）。
     */
    const styleTag = useCallback(
        async (id: number, color: string | null) => {
            if (typeof api.updateTag !== "function") return;
            try {
                const tag = await api.updateTag(id, { color });
                broadcastRef.current?.postMessage({ type: "changed" });
                if (tag) setTags(prev => prev.map(t => (t.id === id ? tag : t)));
            } catch (error) {
                reportError(error, { source: "note-tag-style" });
                onError("设置标签颜色失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError]
    );

    const removeTag = useCallback(
        async (id: number) => {
            if (typeof api.deleteTag !== "function") return;
            const before = tags;
            const noteTagsBefore = noteTags;
            setTags(prev => prev.filter(t => t.id !== id));
            try {
                await api.deleteTag(id);
                broadcastRef.current?.postMessage({ type: "changed" });
                // ⚠️ 关联表也要一起清：tagCounts 是靠 noteTags 里残留的 tagId 统计的，
                // 只摘标签行的话，那个 id 还留在每条笔记的关联里 —— 一旦之后有标签
                // 复用了同一个 id，计数就会串到别的标签上（后端 deleteTag 已在事务里
                // 清了关联，这里只是让本地视图跟上）。
                setNoteTags(prev => {
                    const next: Record<number, number[]> = {};
                    let changed = false;
                    for (const [noteId, ids] of Object.entries(prev)) {
                        const kept = ids.filter(tagId => tagId !== id);
                        if (kept.length !== ids.length) changed = true;
                        if (kept.length) next[Number(noteId)] = kept;
                    }
                    return changed ? next : prev;
                });
            } catch (error) {
                reportError(error, { source: "note-tag-delete" });
                setTags(before);
                setNoteTags(noteTagsBefore);
                onError("删除标签失败: " + (error instanceof Error ? error.message : "未知错误"));
            }
        },
        [api, onError, tags, noteTags]
    );

    /** 改一条笔记的标签：返回最新清单，让界面能直接替换左栏那一份 */
    const assignTags = useCallback(
        async (noteId: number, tagIds: number[]) => {
            if (typeof api.setNoteTags !== "function") return null;
            try {
                const list = await api.setNoteTags(noteId, tagIds);
                broadcastRef.current?.postMessage({ type: "changed" });
                setTags(Array.isArray(list) ? list : []);
                // 关联表也本地更新一份：否则左栏那个「待办 2」还是旧数字，
                // 得等下一次首屏才对得上
                setNoteTags(prev => {
                    const next = { ...prev };
                    if (tagIds.length === 0) delete next[noteId];
                    else next[noteId] = [...tagIds];
                    return next;
                });
                return list;
            } catch (error) {
                reportError(error, { source: "note-tag-assign" });
                onError("保存标签失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onError]
    );

    // ---------- 版本历史（inkstone 顶栏「版本历史」）----------

    /**
     * 拉一条笔记的历史快照。
     * 失败返回空数组而不是抛错：历史是辅助功能，接口挂了不该让顶栏按钮点不动。
     */
    const listRevisions = useCallback(
        async (noteId: number): Promise<NoteRevision[]> => {
            if (typeof api.listNoteRevisions !== "function") return [];
            try {
                const list = await api.listNoteRevisions(noteId);
                return Array.isArray(list) ? list : [];
            } catch (error) {
                reportError(error, { source: "note-revisions-list" });
                return [];
            }
        },
        [api]
    );

    /**
     * 恢复某个版本：成功后把服务端回来的正文替换进本地状态。
     * 返回恢复后的笔记（失败为 null）：调用方要拿它刷新编辑器草稿 ——
     * 草稿只认「切换了笔记」才重置，版本恢复时 id 没变，不显式塞回去界面不会动。
     */
    const restoreRevision = useCallback(
        async (noteId: number, revisionId: number): Promise<Note | null> => {
            if (typeof api.restoreNoteRevision !== "function") return null;
            try {
                const note = await api.restoreNoteRevision(noteId, revisionId);
                broadcastRef.current?.postMessage({ type: "changed" });
                if (!note) {
                    onError("该版本已不存在");
                    return null;
                }
                setNotes(prev => prev.map(n => (n.id === noteId ? note : n)));
                return note;
            } catch (error) {
                reportError(error, { source: "note-revision-restore" });
                onError("恢复失败: " + (error instanceof Error ? error.message : "未知错误"));
                return null;
            }
        },
        [api, onError]
    );

    /**
     * 拉某一个历史版本的**完整正文**（列表接口为了省流量只给空串）。
     * 版本历史面板要拿它跟当前正文做行级 diff，所以必须能单独取一份。
     */
    const getRevision = useCallback(
        async (noteId: number, revisionId: number): Promise<NoteRevision | null> => {
            if (typeof api.getNoteRevision !== "function") return null;
            try {
                return await api.getNoteRevision(noteId, revisionId);
            } catch (error) {
                reportError(error, { source: "note-revision-get" });
                return null;
            }
        },
        [api]
    );

    /**
     * 服务端全文检索（2026-10-09）。
     *
     * 失败一律回 `null` 而不是抛：老部署没有 notes/search 端点、或者 FTS 表
     * 建不出来时，前端退回本地模糊搜索（它本来就持有全文，结果一致）。
     */
    const searchRemote = useCallback(
        async (query: string, limit = 50): Promise<NoteSearchResult | null> => {
            if (typeof api.notesSearch !== "function") return null;
            try {
                const res = await api.notesSearch(query, limit);
                return res && Array.isArray(res.results) ? res : null;
            } catch (error) {
                reportError(error, { source: "notes-search" });
                return null;
            }
        },
        [api]
    );

    return {
        notes,
        loaded,
        externalChange,
        reload,
        /**
         * 数据集级变更广播（2026-10-11）：导入 / 恢复这类不走单个 create/update
         * 方法的路径成功后手动喊一声，让其它标签页能提示刷新。跨标签页基础
         * 通道与常规 CRUD 用的是同一条，这里只是把它暴露给上层。
         */
        broadcastChange: () => broadcastRef.current?.postMessage({ type: "changed" }),
        createNote,
        updateNote,
        deleteNote,
        togglePin,
        toggleStar,
        saveOrder,
        trash,
        loadTrash,
        restoreTrashed,
        purgeTrashed,
        emptyTrash,
        toggleArchive,
        // ---------- 阶段三收尾 ----------
        folders,
        tags,
        noteTags,
        loadMeta,
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
        // 服务端全文检索（本地 fuzzy 是它的兜底，不是替代）
        searchRemote,
    };
}
