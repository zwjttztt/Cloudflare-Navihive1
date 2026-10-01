// tests/idempotency.test.ts
// 写操作幂等闸门（D02 的服务端那一半）。
//
// 要挡的是这个场景：离线队列里的操作补发时，请求其实**已经到了服务端**、
// 站点也建好了，只是回程的响应丢了（断网 / 关页面）。客户端只看到失败，
// 队列里那条还在，下次 online 再发一遍 —— 于是同一张卡片被建了两次。
//
// 这里盯三件事：
//   1. 同一个 ID 再来一次，副作用只发生一次，且拿到的是上次那份响应
//   2. 并发的第二次补发不会被做成第二遍（拿 409，不是又建一个）
//   3. 该重试的（5xx、还没做完）不会被错误地合并掉

import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";
import {
    IDEMPOTENCY_TTL_MS,
    IDEMPOTENCY_MAX_BODY,
} from "../src/API/methods/idempotency";
import {
    IDEMPOTENCY_HEADER,
    readIdempotencyKey,
    idempotencyScope,
    withIdempotency,
} from "../worker/idempotency";

// ---------------- 只撑起 idempotency_keys 一张表的内存版 D1 ----------------
type Row = Record<string, unknown>;

class MockD1 {
    /** Map<"scope|opId", Row>，模拟主键 (scope, op_id) */
    idem = new Map<string, Row>();

    prepare(sql: string) {
        const self = this;
        const keyOf = (args: unknown[]) => `${args[0]}|${args[1]}`;
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => {
                // 注意 SELECT 子句与 FROM 跨行，`.` 不吃换行，得用 [\s\S]
                if (/SELECT[\s\S]*FROM idempotency_keys/.test(sql)) {
                    return self.idem.get(keyOf(args)) ?? null;
                }
                return null;
            },
            all: async () => ({ results: [], success: true }),
            run: async () => {
                let written = 0;
                if (/INSERT INTO idempotency_keys/.test(sql)) {
                    const k = keyOf(args);
                    if (!self.idem.has(k)) {
                        // 顺序与建表语句一致：scope, op_id, user_id, state, status, body,
                        // created_at, expires_at
                        self.idem.set(k, {
                            scope: args[0],
                            op_id: args[1],
                            user_id: args[2],
                            state: "pending",
                            status: null,
                            body: null,
                            created_at: args[3],
                            expires_at: args[4],
                        });
                        written = 1;
                    }
                } else if (/UPDATE idempotency_keys/.test(sql)) {
                    // SET state='done', status=?, body=?, expires_at=? WHERE scope=? op_id=?
                    const row = self.idem.get(`${args[3]}|${args[4]}`);
                    if (row) {
                        row.state = "done";
                        row.status = args[0];
                        row.body = args[1];
                        row.expires_at = args[2];
                        written = 1;
                    }
                } else if (/DELETE FROM idempotency_keys WHERE scope = \?/.test(sql)) {
                    if (self.idem.delete(keyOf(args))) written = 1;
                } else if (/DELETE FROM idempotency_keys WHERE expires_at/.test(sql)) {
                    const now = Number(args[0]);
                    for (const [k, row] of [...self.idem]) {
                        if (Number(row.expires_at) <= now) {
                            self.idem.delete(k);
                            written++;
                        }
                    }
                }
                return { success: true, meta: { rows_written: written } };
            },
        });
        return make([]);
    }

    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(stmts.map(s => s.run()));
    }
    async exec() {
        return { success: true };
    }
}

function newApi(): { api: NavigationAPI; db: MockD1 } {
    const db = new MockD1();
    return { api: new NavigationAPI({ DB: db } as never), db };
}

const OP = "op-0123456789abcdef";

function reqWithKey(key: string | null): Request {
    const headers: Record<string, string> = {};
    if (key !== null) headers[IDEMPOTENCY_HEADER] = key;
    return new Request("https://example.com/api/sites", { method: "POST", headers });
}

// ============ 请求头解析：只放行长得像幂等 ID 的字符串 ============
test("幂等头：正常 ID 收下，缺失 / 太短 / 带怪字符的一律不启用", () => {
    assert.equal(readIdempotencyKey(reqWithKey(OP)), OP);
    assert.equal(readIdempotencyKey(reqWithKey(null)), null, "没带就当没启用");
    assert.equal(readIdempotencyKey(reqWithKey("abc")), null, "太短的不认");
    assert.equal(readIdempotencyKey(reqWithKey("op with space!")), null, "带空格标点的不认");
    assert.equal(readIdempotencyKey(reqWithKey("x".repeat(200))), null, "超长的不认");
});

test("幂等头：两端空白会先 trim 掉再用", () => {
    assert.equal(readIdempotencyKey(reqWithKey(`  ${OP}  `)), OP);
});

// ============ 作用域：换账号 / 换端点都不该互相撞 ============
test("作用域里带账号与端点，不同账号的同名 ID 互不影响", () => {
    const { api } = newApi();
    const a = idempotencyScope(api, "POST sites");
    assert.match(a, /^u/, "未登录归到 anon 档也要有前缀");
    assert.notEqual(a, idempotencyScope(api, "PUT sites"), "换端点要换作用域");
});

// ============ 核心：同 ID 再来一次只做一遍 ============
test("同一个幂等 ID 重发：副作用只发生一次，且回放上次那份响应", async () => {
    const { api } = newApi();
    let calls = 0;
    const run = async () => {
        calls++;
        return Response.json({ success: true, id: 42 });
    };

    const first = (await withIdempotency(api, "POST sites", OP, run)) as Response;
    assert.equal(calls, 1);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.clone().json(), { success: true, id: 42 });

    const second = (await withIdempotency(api, "POST sites", OP, run)) as Response;
    assert.equal(calls, 1, "第二次不该真的执行");
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { success: true, id: 42 }, "应回放上次那份结果");
    assert.equal(second.headers.get("Idempotency-Replayed"), "true", "回放要可辨识");
});

test("不同的幂等 ID 各算一次，不会被合并", async () => {
    const { api } = newApi();
    let calls = 0;
    const run = async () => {
        calls++;
        return Response.json({ ok: calls });
    };
    await withIdempotency(api, "POST sites", "op-aaaaaaaaaaaa", run);
    await withIdempotency(api, "POST sites", "op-bbbbbbbbbbbb", run);
    assert.equal(calls, 2, "两个 ID 就是两次不同的意图");
});

test("没带幂等 ID 时行为与接入前完全一致（不带回放头、不落记录）", async () => {
    const { api, db } = newApi();
    const res = (await withIdempotency(api, "POST sites", null, async () =>
        Response.json({ ok: 1 })
    )) as Response;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Idempotency-Replayed"), null);
    assert.equal(db.idem.size, 0, "没启用就什么都不该记");
});

// ============ 并发：第二次补发拿 409，不是又做一遍 ============
test("上一条还在执行中：第二次补发拿 409，不会并发做两遍", async () => {
    const { api } = newApi();
    let calls = 0;
    const gate = () =>
        new Promise<Response>(resolve =>
            setTimeout(() => {
                calls++;
                resolve(Response.json({ done: calls }));
            }, 10)
        );

    const [a, b] = await Promise.all([
        withIdempotency(api, "POST sites", OP, gate),
        withIdempotency(api, "POST sites", OP, gate),
    ]);
    assert.equal(calls, 1, "两个并发请求只能有一个真的执行");
    const statuses = [(a as Response).status, (b as Response).status].sort();
    assert.deepEqual(statuses, [200, 409], "另一个应被告知「正在处理中」");
});

// ============ 该重试的别被合并掉 ============
test("5xx 不进缓存：下一次重试会真正重跑", async () => {
    const { api } = newApi();
    let calls = 0;
    const run = async () => {
        calls++;
        return Response.json({ error: "boom" }, { status: 500 });
    };
    const first = (await withIdempotency(api, "POST sites", OP, run)) as Response;
    assert.equal(first.status, 500);
    const second = (await withIdempotency(api, "POST sites", OP, run)) as Response;
    assert.equal(calls, 2, "服务端出错时合并掉重试等于把错误钉死");
    assert.equal(second.status, 500);
});

test("执行中抛错会抹掉占位，下一次能真正重跑", async () => {
    const { api } = newApi();
    let calls = 0;
    const run = async (): Promise<Response> => {
        calls++;
        throw new Error("D1 down");
    };
    await assert.rejects(() => withIdempotency(api, "POST sites", OP, run));
    await assert.rejects(() => withIdempotency(api, "POST sites", OP, run));
    assert.equal(calls, 2, "崩过的那次不该一直挡着后面的重试");
});

// ============ 过期与清理 ============
test("过期记录当没见过：隔太久的补发会重跑（不再回放）", async () => {
    const { api, db } = newApi();
    let calls = 0;
    const run = async () => {
        calls++;
        return Response.json({ n: calls });
    };
    await withIdempotency(api, "POST sites", OP, run);
    // 把记录的有效期拨回过去，模拟「隔了一天多才重发」
    for (const row of db.idem.values()) {
        row.expires_at = Number(row.expires_at) - IDEMPOTENCY_TTL_MS - 1000;
    }
    await withIdempotency(api, "POST sites", OP, run);
    assert.equal(calls, 2, "过了 TTL 就不再是同一次意图");
});

test("清过期的记录：只删到点的，没到点的留着", async () => {
    const { api, db } = newApi();
    await withIdempotency(api, "POST sites", "op-cccccccccccc", async () =>
        Response.json({ a: 1 })
    );
    await withIdempotency(api, "POST sites", "op-dddddddddddd", async () =>
        Response.json({ b: 2 })
    );
    assert.equal(db.idem.size, 2);

    const now = Date.now();
    // 只让第一条过期
    const firstKey = [...db.idem.keys()][0];
    (db.idem.get(firstKey) as Row).expires_at = now - 1;
    const removed = await api.purgeExpiredIdempotency(now);
    assert.equal(removed, 1);
    assert.equal(db.idem.size, 1, "不该把还有效的那条一起清掉");
});

// ============ 缓存上限 ============
test("响应超大时不缓存正文，但「做过」这件事仍然记住", async () => {
    const { api, db } = newApi();
    let calls = 0;
    const run = async () => {
        calls++;
        return Response.json({ blob: "x".repeat(IDEMPOTENCY_MAX_BODY + 100) });
    };
    await withIdempotency(api, "POST sites", OP, run);
    const stored = [...db.idem.values()][0];
    assert.equal(stored.body, null, "超限的正文不该进库");
    assert.equal(stored.state, "done");
    await withIdempotency(api, "POST sites", OP, run);
    assert.equal(calls, 1, "正文没存下来也要认出是重发（不再产生副作用）");
});
