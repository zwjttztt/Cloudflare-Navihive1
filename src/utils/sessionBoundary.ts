// src/utils/sessionBoundary.ts
// 「账号边界」上必须做的那几件事，集中在一个地方。
//
// 退出登录 / 注销账号 / 换人登录，看着是三个不同的动作，实际上共享同一条底线：
// **上一个账号的本地痕迹一条都不许留在生效状态里**。散在各处写的时候，
// 漏掉任何一条都是同一个后果 —— 离线队列里排着的操作会被补发到新账号名下、
// 撤销快照能一键把别人的卡片改回来、首屏缓存会把上一个人的数据先画出来。
//
// 这些东西散在 App 里时没人能对一遍「到底清了哪几样」；放在这里之后，
// 清单就是这个函数体，并且可以被单测逐条核对。

import { clearActiveAccount, setActiveAccount } from "./accountScope";
import { clearBootstrapCache } from "./firstPaintCache";
import { clearPersistedUndo } from "./undoPersist";
import { writeCollapsedGroupIds } from "./collapse";

/** 切到某个账号（或退出传 null）时，按账号分开存的那几份要跟着换一份 */
export interface SessionBoundaryDeps {
    /** 离线队列归属：队列不删，但必须绑到新账号名下（它可能是还没同步出去的编辑） */
    setQueueAccount: (uid: number | null) => void;
    /** 撤销快照归属 */
    setUndoAccount: (uid: number | null) => void;
    /** 星标 / 标签 / 访问统计 / 搜索历史归属（记的是站点 id，不同账号会撞号） */
    setPrefsAccount: (uid: number | null) => void;
    /** 清撤销栈（撤销 / 重做按钮回到不可用） */
    clearHistory: () => void;
    /**
     * 折叠状态复位。它记的是分组 id，换账号后留着会折叠到「同号不同组」的分组上；
     * 这份数据本身不值钱，直接复位比费劲分片划算。
     */
    resetCollapsed: () => void;
}

/**
 * 换账号（含退出登录传 null）：把上一个账号的本地痕迹全部归零或换绑。
 *
 * @returns 账号确实变了（true）还是本来就是同一个（false）
 */
export function switchAccountBoundary(
    uid: number | null,
    deps: SessionBoundaryDeps
): boolean {
    const changed = uid === null ? true : setActiveAccount(uid);

    deps.setQueueAccount(uid);
    deps.setUndoAccount(uid);
    deps.setPrefsAccount(uid);
    deps.resetCollapsed();

    if (!changed) return false;

    // 撤销快照与撤销栈跨账号没有任何意义：留着就是「把别人的卡片改回来」的开关
    clearPersistedUndo();
    deps.clearHistory();
    return true;
}

/**
 * 彻底登出（退出登录 / 注销账号共用）：连「当前是谁」这个事实一起抹掉。
 *
 * 与 switchAccountBoundary 的差别：那个是「换到另一个人」，这个是「回到没有人的状态」——
 * 所以这边连账号作用域本身都要清掉，而不只是换绑。
 */
export function clearSessionBoundary(deps: SessionBoundaryDeps): void {
    clearActiveAccount();
    deps.setQueueAccount(null);
    deps.setUndoAccount(null);
    deps.setPrefsAccount(null);
    deps.resetCollapsed();
    clearPersistedUndo();
    deps.clearHistory();
    // 首屏缓存画的是上一个人的分组与卡片，退出后绝不能再被渲染出来
    clearBootstrapCache();
}

/** 「折叠状态复位」的默认实现：清掉内存里的折叠表并落盘一份空表 */
export function resetCollapsedState(
    setCollapsedIds: (next: string[]) => void
): () => void {
    return () => {
        setCollapsedIds([]);
        writeCollapsedGroupIds([]);
    };
}
