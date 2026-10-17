// src/utils/lazyPrefetch.ts
// 懒加载块的预取机制（2026-10-17 首开延迟排查的修复件）。
//
// 问题：弹窗 / 菜单都是「条件挂载 + lazy」，首次点击要现场下载块（在每请求
// 1~3 秒的链路上是数秒空窗，且 Suspense fallback 为 null、毫无反馈）；
// 二次打开因模块已加载而瞬时恢复 —— 用户实测的原话是
// 「首次点击后反馈延迟很久、关闭后再次打开才恢复正常」。
//
// 修法是**把下载挪到点击之前**，三层兜底：
//   1. 悬停预取：鼠标移到「更多选项」/ 卡片设置按钮上就开始取菜单块
//      （pointerenter，点下去之间通常有 300ms+，够小块完成）；
//   2. 菜单展开预取：菜单挂载时把全部菜单项的目标弹窗块并行取掉
//      （用户读菜单的那几秒足够）；
//   3. 空闲预取：首屏渲染完、浏览器空闲时按使用频率把常用块逐个备齐
//      （覆盖触屏无悬停、以及「不开菜单直接右键」的路径）。
//
// 失败处理：预取失败（断网 / 部署切换块哈希）就从集合里摘掉，允许下次重试；
// 组件自己的 ChunkBoundary 仍有错误边界兜底，这里静默即可。
const prefetched = new Set<string>();

/** 按 key 幂等预取：同 key 只发一次，失败后允许重试 */
export function prefetchChunk(key: string, load: () => Promise<unknown>): void {
    if (prefetched.has(key)) return;
    prefetched.add(key);
    void load().catch(() => {
        prefetched.delete(key);
    });
}

/** 已预取过吗（测试与调试用） */
export function isPrefetched(key: string): boolean {
    return prefetched.has(key);
}

type PrefetchTask = [key: string, load: () => Promise<unknown>];

let idleScheduled = false;

/**
 * 首屏空闲后按顺序逐个预取（每个任务等一个空闲槽，避免一口气几十个请求
 * 抢带宽）。requestIdleCallback 不可用时退化为错峰 setTimeout。
 * App 在首屏挂载后调用一次；重复调用是幂等的。
 */
export function prefetchOnIdle(tasks: PrefetchTask[]): void {
    if (idleScheduled) return;
    idleScheduled = true;
    const w = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    const schedule = (i: number) => {
        if (i >= tasks.length) return;
        if (typeof w.requestIdleCallback === "function") {
            w.requestIdleCallback(() => {
                prefetchChunk(tasks[i][0], tasks[i][1]);
                schedule(i + 1);
            }, { timeout: 3000 });
        } else {
            window.setTimeout(() => {
                prefetchChunk(tasks[i][0], tasks[i][1]);
                schedule(i + 1);
            }, 600 * (i + 1));
        }
    };
    schedule(0);
}
