// src/API/methods/idempotency.ts
// NavigationAPI 的「idempotency」域方法体：让重试 / 离线重放不会把同一次操作做两遍。
//
// 为什么需要它：离线队列里的操作是「先记下来、连上了再补发」。补发这一趟有个经典
// 裂缝 —— 请求其实已经到了服务端、站点也建好了，只是**回程的响应丢了**（断网 /
// 页面关了 / Worker 冷启动超时）。客户端只看到失败，队列里那条还在，下次 online
// 再发一遍，于是同一张卡片被建了两次。
//
// 办法是给每次「意图」发一个不重复的 ID（客户端生成，重试时不变），服务端记三态：
//   - 没见过        → 抢占位，抢到的去真正执行
//   - 见过且已完成  → 把上次那一份响应原样回放，一个副作用都不再产生
//   - 见过还在执行  → 返回「进行中」，让客户端稍后再问，别并发做两遍
//
// ⚠️ 占位必须先于执行：先做再记的话，两个并发请求会在各自执行完之后才来写记录，
// 那条裂缝照样存在。INSERT 主键冲突是天然的原子抢锁，抢不到就说明有同伴先动手了。

import type { NavigationAPI } from "../http";

/** 幂等记录的存活时间：24 小时足够覆盖一次断网重连，也不至于让表无限膨胀 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存下来的响应体上限：写接口的响应都很小（几百字节），超了就不缓存，只记「做过」 */
export const IDEMPOTENCY_MAX_BODY = 8 * 1024;

/** 一次执行记多久算「超时了，允许重试」—— 正常写操作远不至于 2 分钟 */
export const IDEMPOTENCY_PENDING_MS = 2 * 60 * 1000;

export type IdempotencyState = "pending" | "done";

export interface IdempotencyRecord {
    state: IdempotencyState;
    /** done 才有：上次响应的状态码 */
    status: number | null;
    /** done 才有：上次响应的正文（超长的不缓存，为 null） */
    body: string | null;
    createdAt: number;
}

export interface IdempotencyApi {
    /**
     * 读取一条幂等记录。没有 / 已过期 / 已损坏都返回 null（视为「没见过」）。
     */
    readIdempotency(scope: string, opId: string): Promise<IdempotencyRecord | null>;
    /**
     * 抢占位。**抢到返回 true**（调用方去真正执行），抢不到返回 false ——
     * 说明已经有人（上一次请求或并发的同伴）先占了，调用方应当转去读记录。
     *
     * 也兼作**互斥锁**：给一个固定的 opId、配一个短 ttlMs，就是一把会自动过期的锁
     * （覆盖式恢复用它防止两个恢复并发互相踩）。过期时间到点自动失效，
     * 进程崩了也不会把后续操作永久堵死。
     */
    claimIdempotency(scope: string, opId: string, ttlMs?: number): Promise<boolean>;
    /**
     * 执行完落结果。state=done 记状态码与正文；state=pending 是把占位刷新成新的
     * 时间戳（长时间操作续租用）。
     */
    completeIdempotency(
        scope: string,
        opId: string,
        result: { status: number; body: string | null }
    ): Promise<void>;
    /** 执行失败：抹掉占位，让客户端下一次重试能真正重跑（而不是一直撞「进行中」） */
    releaseIdempotency(scope: string, opId: string): Promise<void>;
    /** 清掉过期记录；返回删掉的行数 */
    purgeExpiredIdempotency(now?: number): Promise<number>;
}

export const idempotencyImpl: IdempotencyApi = {
    readIdempotency: async function (
        this: NavigationAPI,
        scope: string,
        opId: string
    ): Promise<IdempotencyRecord | null> {
        const row = await this.db
            .prepare(
                `SELECT state, status, body, created_at, expires_at
                 FROM idempotency_keys WHERE scope = ? AND op_id = ?`
            )
            .bind(scope, opId)
            .first<{
                state: string;
                status: number | null;
                body: string | null;
                created_at: number;
                expires_at: number;
            }>();
        if (!row) return null;
        // 过期的记录当作不存在：客户端隔很久才重试时，重跑一次是安全的
        // （真正危险的是短时间内的重复补发，那正是 TTL 覆盖的范围）
        if (row.expires_at <= Date.now()) return null;
        if (row.state !== "pending" && row.state !== "done") return null;
        return {
            state: row.state,
            status: row.status,
            body: row.body,
            createdAt: row.created_at,
        };
    },

    claimIdempotency: async function (
        this: NavigationAPI,
        scope: string,
        opId: string,
        ttlMs = IDEMPOTENCY_TTL_MS
    ): Promise<boolean> {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        try {
            // 当锁用时这一步是关键：先清掉**已过期**的那条，否则上一次跑到一半崩掉的
            // 进程会把这把锁永久占住（过期是唯一的自动释放机制）。
            // 只删过期的，没到点的那条留着 —— 它代表确实还有人在跑。
            await this.db
                .prepare(
                    `DELETE FROM idempotency_keys
                     WHERE scope = ? AND op_id = ? AND expires_at <= ?`
                )
                .bind(scope, opId, now)
                .run();

            const result = await this.db
                .prepare(
                    // 冲突时不覆盖：谁的 INSERT 先落谁就负责执行，
                    // 后来者靠 rows_written = 0 知道自己来晚了
                    `INSERT INTO idempotency_keys
                     (scope, op_id, user_id, state, status, body, created_at, expires_at)
                     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)
                     ON CONFLICT(scope, op_id) DO NOTHING`
                )
                .bind(scope, opId, this.currentUserId, now, expiresAt)
                .run();
            const written = (result as { meta?: { rows_written?: number } } | undefined)?.meta
                ?.rows_written;
            return written === 1;
        } catch {
            // 表还没建好 / D1 抽风：拿不到锁就干脆不生效，退回「不幂等」的老行为，
            // 总比把一次正常的写操作拦下来强
            return false;
        }
    },

    completeIdempotency: async function (
        this: NavigationAPI,
        scope: string,
        opId: string,
        result: { status: number; body: string | null }
    ): Promise<void> {
        const body =
            result.body !== null && result.body.length <= IDEMPOTENCY_MAX_BODY
                ? result.body
                : null;
        const now = Date.now();
        await this.db
            .prepare(
                `UPDATE idempotency_keys
                 SET state = 'done', status = ?, body = ?, expires_at = ?
                 WHERE scope = ? AND op_id = ?`
            )
            .bind(result.status, body, now + IDEMPOTENCY_TTL_MS, scope, opId)
            .run();
    },

    releaseIdempotency: async function (
        this: NavigationAPI,
        scope: string,
        opId: string
    ): Promise<void> {
        await this.db
            .prepare(`DELETE FROM idempotency_keys WHERE scope = ? AND op_id = ?`)
            .bind(scope, opId)
            .run();
    },

    purgeExpiredIdempotency: async function (
        this: NavigationAPI,
        now = Date.now()
    ): Promise<number> {
        const result = await this.db
            .prepare(`DELETE FROM idempotency_keys WHERE expires_at <= ?`)
            .bind(now)
            .run();
        const written = (result as { meta?: { rows_written?: number } } | undefined)?.meta
            ?.rows_written;
        return typeof written === "number" ? written : 0;
    },
};
