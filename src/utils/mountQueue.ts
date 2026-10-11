// src/utils/mountQueue.ts
// 挂载调度：把「同一帧里触发的一批挂载/追加」摊到每帧一个（从 GroupCard 抽出，#86）。
//
// 快速滚动时可能同时有多个分组跨进 600px 预挂载圈、或一个分组的哨兵连续
// 触发追加，若立刻 setState，每组首次渲染的几十张卡会叠成上百毫秒的长任务
// （perf-probe 实测 300 卡滚动 3s 内 14 个长任务、最长 176ms）。
// 队列每帧只放行一个，渲染突发被摊平；挂载本身不丢，只是错开几帧。
//
// 注意这是**模块级单例**：所有分组共享同一条队列，才会把整屏的挂载突发
// 摊到同一条时间线上（每个组件各自一条队列就失去意义了）。

const mountTaskQueue: Array<() => void> = [];
let mountQueueScheduled = false;

export function enqueueMountTask(task: () => void) {
    mountTaskQueue.push(task);
    if (mountQueueScheduled) return;
    mountQueueScheduled = true;
    const drain = () => {
        const next = mountTaskQueue.shift();
        if (next) next();
        if (mountTaskQueue.length > 0) {
            requestAnimationFrame(drain);
        } else {
            mountQueueScheduled = false;
        }
    };
    requestAnimationFrame(drain);
}

/** 测试专用：清空队列并复位调度标记（全局 rAF 替身是逐用例换的） */
export function resetMountQueueForTests(): void {
    mountTaskQueue.length = 0;
    mountQueueScheduled = false;
}
