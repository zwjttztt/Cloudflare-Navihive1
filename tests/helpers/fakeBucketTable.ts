// tests/helpers/fakeBucketTable.ts
// rate_limit_bucket（限速桶，C1）的内存版：
//
// 为什么单独抽一个：这套 SQL 现在有两个用例要认 ——
//   · tests/rateLimitBucket.test.ts（限速器本身的行为）；
//   · tests/endpointGuards.test.ts（拿真 NavigationAPI + 假 D1 打闸门，它必须能存桶）。
// 两份各写一遍，迟早在「ON CONFLICT 到底该 +1 还是覆盖」这种细节上漂移，
// 于是测出来的结论对不上真实 SQL。
//
// 它只认 worker/loginGuard.ts 里那几条语句，**别的 SQL 一律返回 null**
// （= 「不归我管」），由调用方的 mock 自己接着处理。
//
// ⚠️ 语义必须和真 SQL 一致的三处：
//   1. `count = rate_limit_bucket.count + 1` 是**原子递增**（不是读出来再写回去）；
//   2. `INSERT ... ON CONFLICT DO NOTHING` 冲突时**不覆盖**已有行，且拿不到 RETURNING 行；
//   3. 裁桶的两条 DELETE 都跳过 `until > now` 的行（锁定中的桶永远不裁）。

export interface FakeBucketRow {
    bucket_key: string;
    bucket: string;
    count: number;
    until: number;
    seen: number;
}

/** 语句种类，用例靠它断言「锁只写一次」这类行为 */
export type FakeBucketOp = "read" | "bump" | "lock" | "write" | "cas" | "insert" | "reset" | "prune";

/** 把多行 SQL 压成一行，方便按关键字识别（真 SQL 在源码里是折行的） */
function normalize(sql: string): string {
    return sql.replace(/\s+/g, " ").trim();
}

export class FakeBucketTable {
    rows: FakeBucketRow[] = [];
    /** 每条语句被发过时的种类，按调用顺序 */
    ops: FakeBucketOp[] = [];
    /**
     * true = 模拟「表不存在 / 驱动不认识这些 SQL」：所有语句都当没这回事
     * （查询不回行、写入不生效），用来验证「记不上数就放行」这条 fail-open 约定。
     */
    unavailable = false;

    /** 直接读某一行（用例断言用，不记录 op） */
    row(key: string, bucket: string): FakeBucketRow | null {
        const found = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
        return found ? { ...found } : null;
    }

    /** 直接种一行（模拟「升级前就已经存在的桶」） */
    seed(key: string, bucket: string, state: { count?: number; until?: number; seen: number }): void {
        const existed = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
        if (existed) {
            existed.count = state.count ?? existed.count;
            existed.until = state.until ?? existed.until;
            existed.seen = state.seen;
            return;
        }
        this.rows.push({
            bucket_key: key,
            bucket,
            count: state.count ?? 0,
            until: state.until ?? 0,
            seen: state.seen,
        });
    }

    /** 某把锁名下还有多少行 */
    countOf(key: string): number {
        return this.rows.filter(r => r.bucket_key === key).length;
    }

    /**
     * 执行一条语句。
     * 返回 null = 这条 SQL 不归本表管（调用方的 mock 继续处理）。
     */
    exec(sql: string, args: unknown[]): { rows: unknown[] } | null {
        const text = normalize(sql);

        // SELECT count, until, seen FROM rate_limit_bucket WHERE bucket_key = ? AND bucket = ?
        if (text.startsWith("SELECT count, until, seen FROM rate_limit_bucket")) {
            this.ops.push("read");
            if (this.unavailable) return { rows: [] };
            const found = this.row(String(args[0]), String(args[1]));
            return { rows: found ? [found] : [] };
        }

        // 原子 +1：INSERT ... ON CONFLICT DO UPDATE SET count = rate_limit_bucket.count + 1
        if (text.includes("count = rate_limit_bucket.count + 1")) {
            this.ops.push("bump");
            if (this.unavailable) return { rows: [] };
            const [key, bucket, seen] = args as [string, string, number];
            const existed = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
            if (existed) {
                existed.count += 1;
                existed.seen = seen;
                return { rows: [{ count: existed.count, until: existed.until, seen: existed.seen }] };
            }
            this.rows.push({ bucket_key: key, bucket, count: 1, until: 0, seen });
            return { rows: [{ count: 1, until: 0, seen }] };
        }

        // 锁定：UPDATE rate_limit_bucket SET until = ? WHERE ...
        if (text.startsWith("UPDATE rate_limit_bucket SET until = ?")) {
            this.ops.push("lock");
            if (this.unavailable) return { rows: [] };
            const [until, key, bucket] = args as [number, string, string];
            const row = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
            if (row) row.until = until;
            return { rows: [] };
        }

        // 绝对写回：ON CONFLICT DO UPDATE SET count = excluded.count
        if (text.includes("count = excluded.count")) {
            this.ops.push("write");
            if (this.unavailable) return { rows: [] };
            const [key, bucket, count, until, seen] = args as [string, string, number, number, number];
            const existed = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
            if (existed) {
                existed.count = count;
                existed.until = until;
                existed.seen = seen;
            } else {
                this.rows.push({ bucket_key: key, bucket, count, until, seen });
            }
            return { rows: [] };
        }

        // 值等 CAS：UPDATE ... SET count = ?, until = ?, seen = ? WHERE ... AND count = ? ...
        if (text.startsWith("UPDATE rate_limit_bucket SET count = ?")) {
            this.ops.push("cas");
            if (this.unavailable) return { rows: [] };
            const [count, until, seen, key, bucket, prevCount, prevUntil, prevSeen] = args as [
                number, number, number, string, string, number, number, number,
            ];
            const row = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
            if (!row) return { rows: [] };
            if (row.count !== prevCount || row.until !== prevUntil || row.seen !== prevSeen) {
                return { rows: [] };
            }
            row.count = count;
            row.until = until;
            row.seen = seen;
            return { rows: [{ count }] };
        }

        // 首次插入：INSERT ... ON CONFLICT DO NOTHING RETURNING count
        if (text.includes("DO NOTHING") && text.includes("RETURNING")) {
            this.ops.push("insert");
            if (this.unavailable) return { rows: [] };
            const [key, bucket, count, until, seen] = args as [string, string, number, number, number];
            const existed = this.rows.find(r => r.bucket_key === key && r.bucket === bucket);
            // 冲突时不覆盖、也不回行 —— 与真 SQL 一致（调用方据此知道「别人抢先建了」）
            if (existed) return { rows: [] };
            this.rows.push({ bucket_key: key, bucket, count, until, seen });
            return { rows: [{ count }] };
        }

        // 清零：DELETE FROM rate_limit_bucket WHERE bucket_key = ? AND bucket = ?
        if (text.startsWith("DELETE FROM rate_limit_bucket WHERE bucket_key = ? AND bucket = ?")) {
            this.ops.push("reset");
            if (this.unavailable) return { rows: [] };
            const [key, bucket] = args as [string, string];
            this.rows = this.rows.filter(r => !(r.bucket_key === key && r.bucket === bucket));
            return { rows: [] };
        }

        // 裁桶①：空闲超时（锁定中的跳过）
        if (text.startsWith("DELETE FROM rate_limit_bucket WHERE bucket_key = ? AND until <= ? AND seen <= ?")) {
            this.ops.push("prune");
            if (this.unavailable) return { rows: [] };
            const [key, now, cutoff] = args as [string, number, number];
            this.rows = this.rows.filter(
                r => !(r.bucket_key === key && r.until <= now && r.seen <= cutoff)
            );
            return { rows: [] };
        }

        // 裁桶②：超出上限时丢掉最久没动静的（锁定中的跳过）
        // ⚠️ 只按 "bucket NOT IN" 识别：源码里这段 SQL 是折行的，
        // 归一化之后子查询前面会多一个空格（`NOT IN ( SELECT`），
        // 按完整子句匹配会**悄悄匹配不上**（本文件的注释救过一次）。
        if (text.includes("bucket NOT IN")) {
            this.ops.push("prune");
            if (this.unavailable) return { rows: [] };
            const [key, now, _key2, limit] = args as [string, number, string, number];
            const sameKey = this.rows.filter(r => r.bucket_key === key);
            const keep = new Set(
                [...sameKey]
                    .sort((a, b) => b.seen - a.seen)
                    .slice(0, limit)
                    .map(r => r.bucket)
            );
            this.rows = this.rows.filter(
                r => !(r.bucket_key === key && r.until <= now && !keep.has(r.bucket))
            );
            return { rows: [] };
        }

        return null;
    }
}
