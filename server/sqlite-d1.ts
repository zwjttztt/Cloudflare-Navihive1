// server/sqlite-d1.ts
// 把 node:sqlite（Node 22.5+ 自带）包成 D1 形状，让 worker/ 与 src/API/ 一行不改地跑在 VPS 上。
// 契约来自 src/API/schema.ts 的 D1Database / D1PreparedStatement / D1Result
// （worker/types.ts 里那份是同形状的副本，两边都只声明我们真正用到的方法）。
//
// ⚠️ 与 tests/helpers/realSqliteD1.ts（测试替身）的差别，就是这个文件存在的理由：
//   1) batch() 是**真事务**：BEGIN IMMEDIATE 包起来，要么全成要么全滚。
//      替身用 Promise.all，而仓库里 29 处 db.batch() 有「删站点 + 写回收站 + 写墓碑 + 写审计」
//      这类组合，半提交就是数据半删。
//   2) run() 要同时给出 meta 和 RETURNING 的行 —— node:sqlite 的 run() 会把行丢掉，
//      所以按语句类型分派（见 runSync 注释）。
//   3) exec() 补回 D1 的 { count, duration } 形状。
//   4) 外键默认打开：D1 官方文档明确「默认强制外键约束，等价于给每条事务开
//      PRAGMA foreign_keys = on」。不开就会出现「线上拦得住、本地拦不住」的行为差。
//   5) 错误走 rejection 通道：D1 的 run()/all()/first() 只回 Promise，同步 API 的当场抛出
//      会绕过调用方的 .catch / Promise.all / assert.rejects（见 asPromise 注释）。
//   6) 行对象拍平成普通对象：node:sqlite 给的是 null-prototype，D1 给的是普通对象
//      （见 plainRow 注释）。
//
// node:sqlite 目前仍是实验特性（Node 22.5+，启动会打 ExperimentalWarning，用
// --no-warnings 或 NODE_NO_WARNINGS=1 静音）。换 better-sqlite3 时只改本文件的 import：
// 两者都是同步 API 且方法名一致（prepare / all / get / run），run() 的返回字段也同名
// （changes / lastInsertRowid），其余逻辑一行不用动。

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/API/schema";
import { recordSlowQuery, slowQueryEnabled, slowQueryThresholdMs } from "./slowQuery";

/**
 * 慢查询计时（C5，2026-10-22）。
 *
 * ⚠️ 为什么挂在这里而不是散在各条 SQL 上：本文件是全库唯一的执行出口
 * （first / run / all / batch→runSync 全从这儿走），挂一次覆盖所有语句，
 * 以后新加接口自动生效；散在业务代码里则每加一个查询就可能漏一个。
 *
 * ⚠️ 为什么在**同步**路径上计时：node:sqlite 是同步 API，performance.now()
 *    包住的就是真实执行时间，不含事件循环等待 —— 这正是要量的东西
 *    （异步等待属于请求排队，不是「这条 SQL 慢」）。
 *
 * ⚠️ 绑定值一个都不传给 recordSlowQuery：慢查询日志是要留存的，里面出现
 *    笔记正文 / 邮箱就是数据事故。只给参数个数。
 *
 * 关掉打点时（阈值 ≤ 0）这里只剩一次布尔判断，不给热路径加负担。
 */
function noteIfSlow(sql: string, params: number, rows: number, ms: number): void {
    if (!slowQueryEnabled()) return;
    if (ms < slowQueryThresholdMs()) return;
    recordSlowQuery({ sql, ms, rows, params });
}

/** D1PreparedStatement + 一个同步执行入口。batch 专用，理由见 batch() 注释 */
interface SyncPreparedStatement extends D1PreparedStatement {
    runSync<T = unknown>(): D1Result<T>;
}

export interface SqliteD1 extends D1Database {
    /**
     * exec() 的返回比 D1Database 里声明的多两个字段（D1 的形状，仓库没人读，
     * 但对齐文档；这里在接口层就暴露出来，免得用的人再去断言）。
     */
    exec(query: string): Promise<D1Result & { count: number; duration: number }>;
    /**
     * 关库。D1 没这个概念（连接由平台管），自托管进程退出时要调：
     * 不关的话 WAL 里的尾段不会 checkpoint，下次别的进程（备份 / cron）读到的可能是旧快照。
     */
    close(): void;
}

export interface SqliteD1Options {
    /** 写锁等待毫秒数。默认 5000：另一个进程（独立 cron / 备份脚本）持锁时等它，而不是立刻 SQLITE_BUSY */
    busyTimeoutMs?: number;
}

/** meta 里三个字段都来自 D1 的形状；rows_written 拿不到时 data.ts 有 success 兜底，这里照样给全 */
interface D1Meta {
    changes: number;
    rows_written: number;
    last_row_id: number;
}

/**
 * node:sqlite 回的行是 **null-prototype** 对象（Object.create(null)），而 D1 的行是
 * 普通对象。日常读写看不出差别（. 取值 / Object.keys / 展开 / JSON.stringify 都正常），
 * 但 row.hasOwnProperty(...) 会炸、跟对象字面量做 deepStrictEqual 也对不上 ——
 * 这里统一拍平，对齐 D1 的形状（一行浅拷贝的代价，换掉一整类难查的差异）。
 */
function plainRow<T>(row: T): T {
    return Object.assign({}, row) as T;
}

/**
 * 同步执行，但错误以 **rejection** 出现。
 * ⚠️ 不能图省事写 `Promise.resolve(runSync(...))`：那样 SQL 出错是**当场抛出**，
 * 而 D1 的 prepare().run()/all()/first() 只回 Promise、错误走 rejection 通道 ——
 * `assert.rejects`、`Promise.all([...run()])`、`.catch(...)` 链全指着这个形状，
 * 同步抛会绕过它们（tests/serverSqliteD1.test.ts 的外键用例钉着这条）。
 */
function asPromise<T>(fn: () => T): Promise<T> {
    try {
        return Promise.resolve(fn());
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}

// 带 RETURNING 的写语句才需要走 all() 拿行。用 \b 圈住，避免匹配到列名/表名里的 returning。
const RETURNING_RE = /\breturning\b/i;
/**
 * 会返回行的语句：SELECT / WITH（CTE）/ VALUES，外加上面那类带 RETURNING 的写语句。
 *
 * ⚠️ 为什么必须有这条：batch() 里混着 SELECT 是常态（data.ts 的 queryBootstrap 就是
 * 「分组 + 站点 + 配置」三条一批，其中前两条是 SELECT），而 D1 的 batch **会**把每条
 * 语句的行回在对应的 D1Result.results 里。早期版本只对 RETURNING 走 all()，
 * 其余一律 run() —— run() 不回行，于是「首页 bootstrap 拿到 0 分组 0 站点，
 * 但单独 GET /api/groups 却有数据」。没有任何报错，只有一个空首页。
 */
const RETURNS_ROWS_RE = /^\s*(select|with|values)\b/i;

/**
 * 绑定参数归一化：
 *  - undefined → null：JS 侧 `bind(可能为 undefined 的值)` 很常见，而 node:sqlite 对 undefined
 *    直接抛 "Provided value cannot be bound"，D1 则按 NULL 收。对齐 D1。
 *  - ArrayBuffer → Uint8Array：node:sqlite 的绑定只认 TypedArray/DataView。
 *    （Node 22.22 实测 ArrayBuffer 也能绑，但老版本不行，统一转一道兜底。）
 */
function normalizeBind(value: unknown): SQLInputValue {
    if (value === undefined) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value as SQLInputValue;
}

export function makeSqliteD1(file: string, options: SqliteD1Options = {}): SqliteD1 {
    const db = new DatabaseSync(file);

    // 四个 PRAGMA，逐个都有理由，别随手删：
    db.exec("PRAGMA journal_mode = WAL");
    //   读写不互斥：读不阻塞写、写不阻塞读。 Workers 时代多 isolate 并行写，
    //   自托管是单进程同步写，本来不会撞锁；但独立 cron 进程 / 备份脚本 / 手工 sqlite3
    //   仍可能同时持有写锁，WAL 让它们只堵在写上，不堵读。
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    //   拿不到写锁时等 5s 再报 SQLITE_BUSY，而不是立刻失败。
    db.exec("PRAGMA synchronous = NORMAL");
    //   WAL 下的官方推荐档：进程崩溃不丢已提交数据，丢电最多丢最后几毫秒。
    //   （FULL 会每次 commit 都 fsync，个人导航站没必要；真在乎就加 cron 加密备份。）
    db.exec("PRAGMA foreign_keys = ON");
    //   ⚠️ 与 D1 行为对齐（官方文档：D1 默认强制外键）。sites.group_id 是全库唯一外键，
    //   带 ON DELETE CASCADE。仓库里的删除路径本来就显式先删 sites 再删 groups
    //   （accounts.ts 注释：「级联依赖 D1 的 foreign_keys 开关，显式先删更保险」），
    //   所以打开它只是补上线上已有的那层拦截，不会改变正常删除流程的结果。

    // 连接级 helper：run() 拼 meta 用。prepare 一次复用，避免每次 run() 都重新编译 SQL。
    const changesStmt = db.prepare("SELECT changes() AS changes");
    const rowidStmt = db.prepare("SELECT last_insert_rowid() AS last_row_id");

    // batch 重入计数：逻辑上嵌套的 batch（同一调用栈里套 batch）用 SAVEPOINT 兜底。
    // 并发请求之间不会嵌套 —— batch 全程同步执行，根本不给它们插进来的机会（见 batch 注释）。
    let savepointSeq = 0;
    let txDepth = 0;

    const readMeta = (): D1Meta => {
        const changes = Number(changesStmt.get()?.changes ?? 0);
        return { changes, rows_written: changes, last_row_id: Number(rowidStmt.get()?.last_row_id ?? 0) };
    };

    const firstSync = <T>(sql: string, stmt: StatementSync, bound: SQLInputValue[], column?: string): T | null => {
        const started = slowQueryEnabled() ? performance.now() : 0;
        const row = stmt.get(...bound) as Record<string, unknown> | undefined;
        noteIfSlow(sql, bound.length, row === undefined ? 0 : 1, performance.now() - started);
        if (row === undefined) return null;
        // D1 的 first("列名") 返回该列的值而不是整行。仓库里没人传列名（全仓 .first( 零参数），
        // 但对齐形状，免得以后踩空。
        if (column !== undefined) {
            const value = row[column];
            return (value === undefined ? null : value) as T;
        }
        return plainRow(row) as T;
    };

    const runSync = <T>(sql: string, stmt: StatementSync, bound: SQLInputValue[]): D1Result<T> => {
        // node:sqlite 的 run() 只回 { changes, lastInsertRowid }，**会把行整批丢掉** ——
        // 不光 RETURNING 的行，SELECT 的行也一样。所以凡是「会返回行」的语句一律走 all()：
        //   - notes.ts 的「改笔记 + 换标签」走 batch，第一个结果直接读 .results 拿更新后的行
        //     （UPDATE ... RETURNING）；
        //   - data.ts 的 queryBootstrap 把「分组 + 站点」两条 SELECT 塞进 batch 读 .results，
        //     走 run() 的话首页就是空的（且一声不响）。
        // 其余（不带 RETURNING 的 INSERT/UPDATE/DELETE）走 run()，meta 现成，省两次 helper 查询。
        const started = slowQueryEnabled() ? performance.now() : 0;
        if (RETURNING_RE.test(sql) || RETURNS_ROWS_RE.test(sql)) {
            // 会返回行：all() 拿行，meta 用连接级的 changes()/last_insert_rowid() 补。
            const rows = (stmt.all(...bound) as T[]).map(plainRow);
            noteIfSlow(sql, bound.length, rows.length, performance.now() - started);
            // ⚠️ changes 不能拿 rows.length 顶替：正则可能被字符串字面量里的 "returning" 骗到，
            // 那时 all() 返回空数组但语句确实写了行。changes() 是连接级的，反映的正是刚才那条语句。
            return { results: rows, success: true, meta: readMeta() };
        }
        // 普通写语句：run() 一把梭，meta 现成，省掉两次 helper 查询。
        const r = stmt.run(...bound);
        noteIfSlow(sql, bound.length, Number(r.changes), performance.now() - started);
        return {
            results: [],
            success: true,
            meta: { changes: r.changes, rows_written: r.changes, last_row_id: Number(r.lastInsertRowid) },
        };
    };

    const wrap = (sql: string, stmt: StatementSync): SyncPreparedStatement => {
        let bound: SQLInputValue[] = [];
        const prepared: SyncPreparedStatement = {
            bind(...values: unknown[]) {
                bound = values.map(normalizeBind);
                return prepared;
            },
            first<T = unknown>(column?: string) {
                return asPromise(() => firstSync<T>(sql, stmt, bound, column));
            },
            run<T = unknown>() {
                return asPromise(() => runSync<T>(sql, stmt, bound));
            },
            runSync<T = unknown>() {
                return runSync<T>(sql, stmt, bound);
            },
            all<T = unknown>() {
                return asPromise(() => {
                    // ⚠️ node:sqlite 回的行是 null-prototype 对象（plainRow 里说明了），
                    // 另外无 RETURNING 的写语句走 all() 返回 [] 而不是抛错，与 D1 一致。
                    const started = slowQueryEnabled() ? performance.now() : 0;
                    const rows = (stmt.all(...bound) as T[]).map(plainRow);
                    noteIfSlow(sql, bound.length, rows.length, performance.now() - started);
                    return { results: rows, success: true as const };
                });
            },
        };
        return prepared;
    };

    const batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        // 真 D1 的 batch 是「一次往返 + 一个事务」：要么全成，要么全滚。
        const name = `nh_batch_${++savepointSeq}`;
        const nested = txDepth > 0;
        db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
        // D1 每条查询都在自己的隐式事务里跑，外键校验发生在事务末尾；显式事务里 SQLite 是
        // 逐条即时校验。开 defer 把校验推到 COMMIT，行为与 D1 的 batch 逐字一致
        // （级联删除不受影响，官方文档明确 defer 不会阻止 ON DELETE CASCADE）。
        // 只在最外层开：defer_foreign_keys 是连接级开关，嵌套时由外层那一层说话。
        if (!nested) db.exec("PRAGMA defer_foreign_keys = ON");
        txDepth += 1;
        try {
            const out: D1Result<T>[] = [];
            // ⚠️ 全程同步，一个 await 都不留：node:sqlite 本身是同步 API，一旦在两条语句之间
            // 让出事件循环（await s.run() 返回的 Promise 就会），并发的另一个请求可能插进来
            // 再开一个事务 → "cannot start a transaction within a transaction" 整批失败。
            for (const statement of statements) {
                const sync = statement as Partial<SyncPreparedStatement>;
                if (typeof sync.runSync !== "function") {
                    throw new Error("batch() 只接受同一个适配器 prepare() 出来的语句（需要同步执行入口）");
                }
                out.push((statement as SyncPreparedStatement).runSync<T>());
            }
            db.exec(nested ? `RELEASE ${name}` : "COMMIT");
            return out;
        } catch (error) {
            // ⚠️ 失败后必须显式回滚：实测事务内出错后 COMMIT 仍会把之前的语句提交掉。
            try {
                db.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK");
                if (nested) db.exec(`RELEASE ${name}`);
            } catch {
                // 回滚自己也失败（比如 BEGIN 就没成功）时，顺着抛原始错误更有诊断价值
            }
            throw error;
        } finally {
            txDepth -= 1;
        }
    };

    return {
        prepare: (sql: string) => wrap(sql, db.prepare(sql)),
        async exec(sql: string): Promise<D1Result & { count: number; duration: number }> {
            const started = performance.now();
            // node:sqlite 的 exec 支持多条语句（migration.ts 的批量建表回退路径靠这个），
            // 语句里的 SELECT 结果会被丢弃、不抛错。
            db.exec(sql);
            // 建表 / 加索引这类 DDL 走 exec，慢起来同样会卡住启动，一并打点
            // （rows 记 0：exec 不回行，行数这个概念对它没意义）
            noteIfSlow(sql, 0, 0, performance.now() - started);
            // D1 的 exec 回 { count, duration }。count 在 D1 文档里没定义清楚（执行的语句条数），
            // 仓库里 10 处调用全当 void 用，这里给 0 + 真实耗时，形状对齐即可。
            return { success: true, count: 0, duration: performance.now() - started };
        },
        batch,
        close() {
            db.close();
        },
    };
}
