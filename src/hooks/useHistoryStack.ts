// 撤销 / 重做：命令模式的操作栈（React 包装层）。
// 纯逻辑在 src/utils/historyStack.ts 的 HistoryStack 类里，这一层只负责把它接到
// React 的渲染节奏上——栈的变化不体现在 props 上，用 version 版本号通知 UI
// （撤销/重做按钮能不能点）刷新一次。
//
// 另外这里顺手做「跨刷新保留」：栈每动一次就把可重放的那几步写进 localStorage，
// 刷新后再由 hydrate 把它们变回命令压回栈里（详见 utils/undoPersist）。
import { useCallback, useRef, useState } from "react";
import { HistoryStack, type HistoryCommand } from "../utils/historyStack";
import { savePersistedUndo, type PersistedUndo } from "../utils/undoPersist";

export type { HistoryCommand };

export function useHistoryStack() {
    const stackRef = useRef(new HistoryStack());
    const [version, setVersion] = useState(0);

    const touch = () => setVersion(v => v + 1);

    /** 栈一变就落盘：撤销一步、重做一步都会改变「还留着哪几步」 */
    const syncPersisted = useCallback(() => {
        savePersistedUndo(stackRef.current.persistable);
    }, []);

    const bump = useCallback(() => {
        syncPersisted();
        touch();
    }, [syncPersisted]);

    /** 做完一件事就登记一次；redo 栈在核心里清空（新操作作废原来的重做路径） */
    const push = useCallback(
        (cmd: HistoryCommand) => {
            stackRef.current.push(cmd);
            bump();
        },
        [bump]
    );

    /** 撤销最近一步，成功返回它的说明文字，栈空返回 null */
    const undo = useCallback(async () => {
        const label = await stackRef.current.undo();
        bump();
        return label;
    }, [bump]);

    /** 重做刚撤的那一步 */
    const redo = useCallback(async () => {
        const label = await stackRef.current.redo();
        bump();
        return label;
    }, [bump]);

    const clear = useCallback(() => {
        stackRef.current.clear();
        bump();
    }, [bump]);

    /** 启动时把上次留下的记录变回命令压回栈里，返回真正恢复了几步 */
    const hydrate = useCallback(
        (list: PersistedUndo[], rebuild: (item: PersistedUndo) => HistoryCommand | null) => {
            const count = stackRef.current.hydrate(list, rebuild);
            if (count > 0) touch();
            return count;
        },
        []
    );

    return {
        push,
        undo,
        redo,
        clear,
        hydrate,
        canUndo: stackRef.current.canUndo,
        canRedo: stackRef.current.canRedo,
        version,
    };
}
