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
    /** 真正的保存动作；返回 false 表示没存上（会退回 pending 让防抖重试） */
    save: () => Promise<boolean>;
}

export function useNoteAutoSave(deps: NoteAutoSaveDeps) {
    const { dirty, draft, noteId, autosaveMs, save } = deps;

    // ---------- 阶段四第 14 条：自动保存 ----------
    // 之前既没有保存按钮也没有自动保存，草稿只在「切到另一条笔记」时才写库 ——
    // 改完直接关掉记事本，内容就没了。这里补 debounce 自动存 + 状态指示。
    const [saveState, setSaveState] = useState<SaveState>("idle");
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

    useEffect(() => {
        // 还没拿到 id 的新笔记不能存（onCreate 是异步的，那一瞬间 id 还是空的）
        if (!dirty || !noteId) {
            setSaveState(cur => (cur === "pending" ? "idle" : cur));
            return;
        }
        setSaveState("pending");
        const timer = setTimeout(async () => {
            setSaveState("saving");
            if (!(await saveRef.current())) {
                setSaveState("pending");
                return;
            }
            setSaveState("saved");
            setSavedAt(Date.now());
            setTick(Date.now());
        }, autosaveMs);

        // 失焦立即落盘：防抖放宽到 5 秒（见 AUTO_SAVE_MS 那条注释）之后，
        // 「打完字切走」这一下的等待窗口也变长了 —— 这里是它的补偿。
        // 切标签页 / 点到别的窗口都算失焦，都是低频动作，不会把省下来的往返又花回去。
        const flush = () => {
            clearTimeout(timer);
            void saveRef.current().then(ok => {
                if (!ok) return;
                setSaveState("saved");
                setSavedAt(Date.now());
                setTick(Date.now());
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("blur", flush);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
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
                void saveRef.current();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return { saveState, savedAt, tick };
}
