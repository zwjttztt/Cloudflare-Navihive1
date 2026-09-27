// 撤销 / 重做：命令模式的操作栈（React 包装层）。
// 纯逻辑在 src/utils/historyStack.ts 的 HistoryStack 类里，这一层只负责把它接到
// React 的渲染节奏上——栈的变化不体现在 props 上，用 version 版本号通知 UI
// （撤销/重做按钮能不能点）刷新一次。
import { useCallback, useRef, useState } from "react";
import { HistoryStack, type HistoryCommand } from "../utils/historyStack";

export type { HistoryCommand };

export function useHistoryStack() {
    const stackRef = useRef(new HistoryStack());
    const [version, setVersion] = useState(0);

    const touch = () => setVersion(v => v + 1);

    /** 做完一件事就登记一次；redo 栈在核心里清空（新操作作废原来的重做路径） */
    const push = useCallback((cmd: HistoryCommand) => {
        stackRef.current.push(cmd);
        touch();
    }, []);

    /** 撤销最近一步，成功返回它的说明文字，栈空返回 null */
    const undo = useCallback(async () => {
        const label = await stackRef.current.undo();
        touch();
        return label;
    }, []);

    /** 重做刚撤的那一步 */
    const redo = useCallback(async () => {
        const label = await stackRef.current.redo();
        touch();
        return label;
    }, []);

    const clear = useCallback(() => {
        stackRef.current.clear();
        touch();
    }, []);

    return {
        push,
        undo,
        redo,
        clear,
        canUndo: stackRef.current.canUndo,
        canRedo: stackRef.current.canRedo,
        version,
    };
}
