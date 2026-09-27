// 撤销 / 重做：命令模式的操作栈核心（纯逻辑，不依赖 React，方便单测）。
// 为什么不用「整份数据快照」：服务端这条链路不好倒着走（删掉的行 id 变了、排序号重排、
// 失败还得回滚），而每个操作自己最清楚怎么把自己复原。
// 所以每条记录是「一件事 + 它的撤销/重做动作」，谁干的事谁负责把它倒回去。
//
// 注意：这一层是纯 JS，正在 undo/redo 时若命令本身抛错，会把这一步放回原栈，
// 不让「撤销到一半」的中间态泄漏出去。useHistoryStack 这层 hook 只是把它包成 React 状态。

export interface HistoryCommand {
    /** 读屏和提示条用的一句话说明，例如「删除站点 xxx」 */
    label: string;
    undo: () => void | Promise<void>;
    redo: () => void | Promise<void>;
}

/** 最多记多少步：太多的话内存里全是一份份卡片快照 */
export const MAX_HISTORY_STEPS = 50;

export class HistoryStack {
    private undoStack: HistoryCommand[] = [];
    private redoStack: HistoryCommand[] = [];

    /** 是否还能撤销（驱动「撤销」按钮的可用态） */
    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    /** 是否还能重做 */
    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** 当前撤销栈深度（单测 / 调试用） */
    get undoDepth(): number {
        return this.undoStack.length;
    }

    /** 当前重做栈深度 */
    get redoDepth(): number {
        return this.redoStack.length;
    }

    /**
     * 做完一件事就登记一次；redo 栈在这里清空——新操作作废了原来的重做路径。
     * 超过上限时丢掉最旧的一步（shift），保证内存有界。
     */
    push(cmd: HistoryCommand): void {
        this.undoStack.push(cmd);
        if (this.undoStack.length > MAX_HISTORY_STEPS) this.undoStack.shift();
        this.redoStack = [];
    }

    /** 撤销最近一步，成功返回它的说明文字，栈空返回 null */
    async undo(): Promise<string | null> {
        const cmd = this.undoStack.pop();
        if (!cmd) return null;
        try {
            await cmd.undo();
            this.redoStack.push(cmd);
        } catch {
            // 撤销失败就把它放回栈顶，别丢了这一步
            this.undoStack.push(cmd);
            throw new Error("撤销失败");
        }
        return cmd.label;
    }

    /** 重做刚撤的那一步 */
    async redo(): Promise<string | null> {
        const cmd = this.redoStack.pop();
        if (!cmd) return null;
        try {
            await cmd.redo();
            this.undoStack.push(cmd);
        } catch {
            this.redoStack.push(cmd);
            throw new Error("重做失败");
        }
        return cmd.label;
    }

    /** 清空两个栈（例如切换账号 / 重新加载数据时） */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }
}
