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
     * key 数量上限：到了就按 LRU 丢最久未用的那几个。
     * 不设上限的话，伪造不同 IP 的请求能把这张表撑到 OOM —— 内存限流自己成了内存漏洞。
     *
     * ⚠️ 以前这里是「到了就整表 clear()」：那是把「防滥用」做成了新的滥用面 ——
     * 攻击者只要造一批不同的 key 把表顶到上限，全部计数一次性归零，
     * 限流当场失效，而且比刷还省事（刷要撞上限，清表只要 2000 个一次性 key）。
     */
    maxKeys?: number;
}

export function createMemoryLimiter(options: MemoryLimiterOptions): MemoryLimiter {
    const { windowMs, max, maxKeys = 2_000 } = options;
    const windows = new Map<string, { at: number; count: number }>();

    /** 把一条记录挪到 Map 末尾（= 最近使用）。Map 只在**插入**时定顺序，
     *  已存在的 key 再 set 一次位置不变，所以刷新必须 delete + set */
    const touch = (key: string, win: { at: number; count: number }): void => {
        windows.delete(key);
        windows.set(key, win);
    };

    /** 超限时的淘汰：先丢过期的（它们本来就不该占位），不够再从头部（最久未用）丢 */
    const evict = (now: number): void => {
        if (windows.size <= maxKeys) return;
        for (const [key, win] of windows) {
            if (windows.size <= maxKeys) break;
            if (now - win.at > windowMs) windows.delete(key);
        }
        if (windows.size <= maxKeys) return;
        let drop = windows.size - maxKeys;
        for (const key of windows.keys()) {
            if (drop <= 0) break;
            windows.delete(key);
            drop -= 1;
        }
    };

    const check = (key: string, now: number, record: boolean): boolean => {
        const win = windows.get(key);
        if (win && now - win.at <= windowMs) {
            // 仍在窗口内。超限时也要刷新 LRU 位置：一个持续超限的 key 若是被当成
            // 「最久未用」先淘汰掉，等于帮攻击者把别人的计数挤出去。
            if (record) touch(key, win);
            if (win.count >= max) return false;
            if (record) win.count += 1;
            return true;
        }
        // 没见过、或这条已经过期 → 开一个新窗口
        if (!record) return true;
        touch(key, { at: now, count: 1 });
        evict(now);
        return true;
    };

    return {
        allow: (key, now = Date.now()) => check(key, now, true),
        peek: (key, now = Date.now()) => check(key, now, false),
        reset: () => windows.clear(),
    };
}
