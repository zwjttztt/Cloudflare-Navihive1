// src/components/notes/useNoteAutoSave.ts
// 记事本的「草稿自动保存」（2026-10-22 从 NotesPage 抽出，第三步）。
//
// ⚠️ 这一段是全项目最容易被改坏的地方之一，搬动时**原样保留了三处技巧**，注释一并带过来：
//
//   1. **`saveRef`**：`save` 的身份随 `onUpdate` → `notes` 变化而变化，而 effect 的依赖数组
//      只想认 `dirty / draft / noteId`。用 ref 存最新的 save，effect 就不必跟着重启防抖。
//      （原注释：「用 ref 存最新的 save，effect 只认 dirty / draft / active.id 这三样」）
//   2. **卸载时 flush 用第二个 ref**：卸载是同步的，await 不上，只能 fire-and-forget。
//      这里再套一层 ref，是为了让「卸载那一刻」拿到最新的 dirty/save。
//   3. **失焦 / 切走立即落盘**：防抖放宽到 5 秒后，「打完字切走」的等待窗口变长，
//      blur 与 visibilitychange 是它的补偿。
//
// 另外：`dirty` 与 `save` 本身**不搬进来** —— `dirty` 还被「关闭前的未保存确认」用，
// `save` 依赖调用方的 onUpdate/onNotify，都由外层以参数传入。
import { useEffect, useRef, useState } from "react";

/** 防抖毫秒数（外层传入，来源是用户设置） */
export type SaveState = "idle" | "pending" | "saving" | "saved";

/**
 * 连续失败**几次之后停止自动重试**（2026-10-25 F1）。
 *
 * 之前失败只是把状态退回 `pending`，下一次重排全靠「用户又敲了一个字」——
 * 于是服务端一直错、界面上却是一个灰点，用户以为「马上就存」，关掉就丢内容。
 * 现在失败后自己隔一个防抖周期再试，但**最多这么多次**：再试下去就是
 * 无声的无限重试（离线时每分钟打一次请求，界面却什么都不说）。
 */
const MAX_SAVE_RETRIES = 3;

export interface NoteAutoSaveDeps {
    /** 草稿有没有改过（未保存） */
    dirty: boolean;
    /**
     * 草稿本体。**只用于进依赖数组** —— 内容一变就该重置防抖定时器，
     * 所以类型上刻意用 unknown：hook 不读它的字段。
     */
    draft: unknown;
    /** 当前笔记 id：还没有 id 的新笔记不能存（onCreate 是异步的，那一瞬 id 还是空） */
    noteId?: number;
    /** 防抖毫秒 */
    autosaveMs: number;
    /** 真正的保存动作；返回 false 表示没存上（状态停在「未保存」，并按上限重试） */
    save: () => Promise<boolean>;
    /**
     * 重试到上限仍失败时回调**一次**（外层接 onNotify 之类的通知）。
     * 不给也行 —— 那时失败只在 `saveState` / `saveError` 上体现，
     * 但**绝不会**显示成「已保存」。
     */
    onSaveError?: (message: string) => void;
}

export function useNoteAutoSave(deps: NoteAutoSaveDeps) {
    const { dirty, draft, noteId, autosaveMs, save, onSaveError } = deps;

    // ---------- 阶段四第 14 条：自动保存 ----------
    // 之前既没有保存按钮也没有自动保存，草稿只在「切到另一条笔记」时才写库 ——
    // 改完直接关掉记事本，内容就没了。这里补 debounce 自动存 + 状态指示。
    const [saveState, setSaveState] = useState<SaveState>("idle");
    /**
     * 自动保存已经放弃（连续失败到上限）。**单独摊出去**是因为
     * `SaveState` 那四个值被 SaveDot / ctx / 侧栏共用（加一个 "error" 会连带
     * 改三个文件），这里用一个布尔量表达「确实没存上」：`true` 时
     * `saveState` 恒为 pending（灰点「有改动」），永远不会是绿勾「已保存」。
     */
    const [saveError, setSaveError] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [tick, setTick] = useState(() => Date.now());

    // 「上次保存于 N 分钟前」：存住之后每 30s 推一次 tick 让界面重算相对时间。
    // 只在 saved 态跑，避免没保存过也在那空转。
    useEffect(() => {
        if (saveState !== "saved") return;
        const timer = setInterval(() => setTick(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [saveState]);

    // 用 ref 存最新的 save，effect 只认 dirty / draft / noteId 这三样
    const saveRef = useRef(save);
    useEffect(() => {
        saveRef.current = save;
    }, [save]);

    // 通知回调同样走 ref：它的身份随外层 onNotify 变化，不该让保存 effect 重启
    const onSaveErrorRef = useRef(onSaveError);
    useEffect(() => {
        onSaveErrorRef.current = onSaveError;
    }, [onSaveError]);

    /** 连续失败次数（一串里的） */
    const failuresRef = useRef(0);
    /** 这一串失败报过没有 —— 报**一次**就够，别每 5 秒弹一条 */
    const notifiedRef = useRef(false);
    /**
     * 当前「重试串」的身份：换笔记、或用户又改了一笔 = 新的一串，计数清零。
     * ⚠️ 只在**这两个**上清零：内容不变时不该因为一次失败就永远放弃自动保存
     *（用户接着打字仍然会重新排定时器 —— 见下面 failuresRef 到上限那一段）。
     */
    const cycleRef = useRef<{ noteId?: number; draft: unknown }>({ noteId, draft });

    useEffect(() => {
        if (cycleRef.current.noteId !== noteId || cycleRef.current.draft !== draft) {
            cycleRef.current = { noteId, draft };
            failuresRef.current = 0;
            notifiedRef.current = false;
        }
        // 还没拿到 id 的新笔记不能存（onCreate 是异步的，那一瞬间 id 还是空的）
        if (!dirty || !noteId) {
            setSaveState(cur => (cur === "pending" ? "idle" : cur));
            return;
        }
        // ⚠️ 失败时状态停在 pending（SaveDot 的灰点「有改动」）—— **不落回 saved**，
        // 那是「用户以为存好了、关掉才发现没有」的根源。
        setSaveState("pending");
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const markSaved = () => {
            failuresRef.current = 0;
            notifiedRef.current = false;
            setSaveError(false);
            setSaveState("saved");
            setSavedAt(Date.now());
            setTick(Date.now());
        };
        /** 记一次失败：状态停在「未保存」；到上限时报一次并停止重试 */
        const markFailed = () => {
            failuresRef.current += 1;
            setSaveState("pending");
            if (failuresRef.current < MAX_SAVE_RETRIES) return;
            setSaveError(true);
            if (notifiedRef.current) return;
            notifiedRef.current = true;
            onSaveErrorRef.current?.(
                `自动保存失败：连续 ${MAX_SAVE_RETRIES} 次都没存上，内容未保存。请检查网络，或按 ⌘/Ctrl+S 手动保存`
            );
        };

        const attempt = async () => {
            setSaveState("saving");
            const ok = await saveRef.current();
            if (!live) return;
            if (ok) markSaved();
            else {
                markFailed();
                // 还没到上限：隔一个防抖周期再试一次（不再是「等用户再敲一个字」）
                if (failuresRef.current < MAX_SAVE_RETRIES) {
                    timer = setTimeout(() => void attempt(), autosaveMs);
                }
            }
        };
        // 连续失败到上限的那一串：**不再**自己排定时器（再排就是无声的无限重试）。
        // 失焦落盘那条路仍然留着 —— 「打完字切走」值得再试一次。
        if (failuresRef.current < MAX_SAVE_RETRIES) {
            timer = setTimeout(() => void attempt(), autosaveMs);
        }

        // 失焦立即落盘：防抖放宽到 5 秒（见 AUTO_SAVE_MS 那条注释）之后，
        // 「打完字切走」这一下的等待窗口也变长了 —— 这里是它的补偿。
        // 切标签页 / 点到别的窗口都算失焦，都是低频动作，不会把省下来的往返又花回去。
        const flush = () => {
            clearTimeout(timer);
            void saveRef.current().then(ok => {
                if (!live) return;
                if (ok) markSaved();
                else markFailed();
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("blur", flush);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            // ⚠️ 在飞的那一次作废：它存的是**改之前**的内容，晚一步落地时
            // 界面已经又脏了，把它记成「已保存」是假绿勾。
            live = false;
            clearTimeout(timer);
            window.removeEventListener("blur", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [dirty, draft, noteId, autosaveMs]);

    // 关掉记事本时把还没落库的草稿刷一次：防抖是 5 秒（见 AUTO_SAVE_MS），
    // 打完字立刻关闭的话那 5 秒还没走完。卸载是同步的，await 不上，
    // 只能 fire-and-forget（api 是模块级的实例，组件没了请求照样发得出去）。
    const flushRef = useRef<{ dirty: boolean; save: () => Promise<unknown> }>({
        dirty: false,
        save: async () => {},
    });
    useEffect(() => {
        flushRef.current = { dirty, save };
    });
    useEffect(
        () => () => {
            if (flushRef.current.dirty) void flushRef.current.save();
        },
        []
    );

    /** ⌘/Ctrl+S 手动存一下：自动保存已经兜底，但有人就是想立刻存 */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void saveRef.current().then(ok => {
                    if (!ok) return;
                    // 手动存成功了 → 失败计数清零，自动保存恢复（不然它会一直停着不存）。
                    // 顺手把指示点也推到「已保存」：以前 ⌘S 存完界面上还是灰点。
                    failuresRef.current = 0;
                    notifiedRef.current = false;
                    setSaveError(false);
                    setSaveState("saved");
                    setSavedAt(Date.now());
                    setTick(Date.now());
                });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    /**
     * `saveError`：连续失败到上限、自动保存已停止重试（true）。
     * 外层拿着它可以把「未保存」画成错误色 / 挂一条提示；`saveState`
     * 在此期间恒为 `pending`，不会是 `saved`。
     */
    return { saveState, savedAt, tick, saveError };
}
