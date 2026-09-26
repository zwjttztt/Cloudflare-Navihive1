// 撤销 / 重做：命令模式的操作栈。
//
// 为什么不用「整份数据快照」：服务端这条链路不好倒着走（删掉的行 id 变了、排序号重排、
// 失败还得回滚），而每个操作自己最清楚怎么把自己复原。
// 所以每条记录是「一件事 + 它的撤销/重做动作」，谁干的事谁负责把它倒回去。
import { useCallback, useRef, useState } from "react";

export interface HistoryCommand {
    /** 读屏和提示条用的一句话说明，例如「删除站点 xxx」 */
    label: string;
    undo: () => void | Promise<void>;
    redo: () => void | Promise<void>;
}

/** 最多记多少步：太多的话内存里全是一份份卡片快照 */
const MAX_STEPS = 50;

export function useHistoryStack() {
    const undoStack = useRef<HistoryCommand[]>([]);
    const redoStack = useRef<HistoryCommand[]>([]);
    // 栈的变化不体现在 props 上，用这个版本号通知 UI（按钮能不能点）刷新一次
    const [version, setVersion] = useState(0);

    const touch = () => setVersion(v => v + 1);

    /** 做完一件事就登记一次；redo 栈在这里清空（新操作作废原来的重做路径） */
    const push = useCallback((cmd: HistoryCommand) => {
        undoStack.current.push(cmd);
        if (undoStack.current.length > MAX_STEPS) undoStack.current.shift();
        redoStack.current = [];
        touch();
    }, []);

    /** 撤销最近一步，成功返回它的说明文字，栈空返回 null */
    const undo = useCallback(async () => {
        const cmd = undoStack.current.pop();
        if (!cmd) return null;
        try {
            await cmd.undo();
            redoStack.current.push(cmd);
        } catch {
            // 撤销失败就把它放回栈顶，别丢了这一步
            undoStack.current.push(cmd);
            throw new Error("撤销失败");
        }
        touch();
        return cmd.label;
    }, []);

    /** 重做刚撤的那一步 */
    const redo = useCallback(async () => {
        const cmd = redoStack.current.pop();
        if (!cmd) return null;
        try {
            await cmd.redo();
            undoStack.current.push(cmd);
        } catch {
            redoStack.current.push(cmd);
            throw new Error("重做失败");
        }
        touch();
        return cmd.label;
    }, []);

    const clear = useCallback(() => {
        undoStack.current = [];
        redoStack.current = [];
        touch();
    }, []);

    return {
        push,
        undo,
        redo,
        clear,
        canUndo: undoStack.current.length > 0,
        canRedo: redoStack.current.length > 0,
        version,
    };
}
