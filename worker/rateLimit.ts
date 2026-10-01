// worker/rateLimit.ts
// isolate 内的滑动窗口限流，给**公开且会替客户端出网 / 落库**的那几个端点兜底。
//
// 为什么不用 D1 里那套 CAS 限速：那套是给「登录 / 注册 / 写操作」用的，
// 成本高（一趟 SQL），而图标代理、错误上报、CSP 上报都是**高频、低价值**的端点 ——
// 为它们每次都写库，等于把「防滥用」本身变成新的滥用面。
// 内存窗口跨实例不共享，挡不住分布式刷；但挡得住单实例上最常见的「一个脚本猛刷」，
// 而这几个端点的滥用也只有这一种形态（它们没有凭据可撞）。
//
// 与 D1 那套的分工：
//   - 撞凭据 / 消耗 D1 写入配额 → 走 loginGuard 的 CAS（持久化、跨实例）
//   - 刷公开端点（出网、日志、审计行数）→ 走这里（便宜、够用）

export interface MemoryLimiter {
    /** 记一次；超窗返回 false（调用方应当直接拒绝或静默丢弃） */
    allow(key: string, now?: number): boolean;
    /** 只看不记：用于断言「现在还放不放得进去」 */
    peek(key: string, now?: number): boolean;
    /** 清空窗口（仅供测试） */
    reset(): void;
}

export interface MemoryLimiterOptions {
    /** 窗口长度 */
    windowMs: number;
    /** 每个窗口内每个 key 允许的次数 */
    max: number;
    /**
     * key 数量上限：到了就整表清空。
     * 不设上限的话，伪造不同 IP 的请求能把这张表撑到 OOM —— 内存限流自己成了内存漏洞。
     */
    maxKeys?: number;
}

export function createMemoryLimiter(options: MemoryLimiterOptions): MemoryLimiter {
    const { windowMs, max, maxKeys = 2_000 } = options;
    const windows = new Map<string, { at: number; count: number }>();

    const check = (key: string, now: number, record: boolean): boolean => {
        if (windows.size > maxKeys) windows.clear();
        const win = windows.get(key);
        if (!win || now - win.at > windowMs) {
            if (record) windows.set(key, { at: now, count: 1 });
            return true;
        }
        if (win.count >= max) return false;
        if (record) win.count += 1;
        return true;
    };

    return {
        allow: (key, now = Date.now()) => check(key, now, true),
        peek: (key, now = Date.now()) => check(key, now, false),
        reset: () => windows.clear(),
    };
}
