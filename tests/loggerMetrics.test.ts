// tests/loggerMetrics.test.ts
// 观测层的两个最小件（P1-4）：
//   ① `shared/logger.ts` —— Error 序列化 + rid 自动补齐
//   ② `shared/metrics.ts` —— 4 个运行时计数
//
// 为什么这两样必须有单测：它们是**所有**排障线索的产出端。这东西错了不会让任何功能
// 挂掉，只会让「线上出问题时看到的东西」变成噪音 —— 而那种失败只有真出事那天才暴露。
import { test } from "node:test";
import assert from "node:assert/strict";
import { logger, setRidProvider } from "../shared/logger";
import { SLOW_REQUEST_MS, metricsSnapshot, recordRequest, resetMetricsForTest } from "../shared/metrics";

/** 把 console.warn / error 换成记录器，跑完还原（绝不把真日志打进测试输出） */
function capture(level: "warn" | "error", run: () => void): unknown[][] {
    const original = console[level];
    const calls: unknown[][] = [];
    console[level] = (...args: unknown[]) => {
        calls.push(args);
    };
    try {
        run();
    } finally {
        console[level] = original;
    }
    return calls;
}

type Fields = Record<string, unknown>;

// ============ ① Error 序列化 ============

test("logger：Error 被转成 {name,message,stack}，不是宿主 inspect 格式", () => {
    const calls = capture("error", () => {
        logger.error("保存失败", { component: "notes", err: new Error("boom") });
    });
    assert.equal(calls.length, 1, "应当只发一条");
    const [message, fields] = calls[0] ?? [];
    assert.equal(message, "保存失败");
    const serialized = (fields as Fields).err as Fields;
    assert.equal(serialized.name, "Error");
    assert.equal(serialized.message, "boom");
    assert.equal(typeof serialized.stack, "string", "stack 必须带上 —— 那是唯一能看到调用链的地方");
    assert.equal(serialized instanceof Object, true);
});

test("logger：一层嵌套的对象与数组里的 Error 也会被序列化", () => {
    const calls = capture("error", () => {
        logger.error("批量失败", { ctx: { err: new Error("inner") }, list: [new Error("a"), new Error("b")] });
    });
    const fields = calls[0]?.[1] as Fields;
    assert.equal((fields.ctx as Fields).err instanceof Object, true);
    assert.equal(((fields.ctx as Fields).err as Fields).message, "inner");
    const list = fields.list as Fields[];
    assert.equal(list.length, 2);
    assert.equal(list[0]?.message, "a");
    assert.equal(list[1]?.message, "b");
});

test("logger：保留 code / helperExitCode / cause（这几条正是升级链路排障要看的）", () => {
    const err = Object.assign(new Error("outer"), { code: "ENOENT", helperExitCode: 40 });
    (err as Error & { cause?: unknown }).cause = new Error("root");
    const calls = capture("error", () => {
        logger.error("x", { err });
    });
    const serialized = (calls[0]?.[1] as Fields).err as Fields;
    assert.equal(serialized.code, "ENOENT");
    assert.equal(serialized.helperExitCode, 40);
    assert.equal((serialized.cause as Fields).message, "root");
});

test("logger：Date / Buffer 这类宿主对象原样保留（硬拆成普通对象既慢又没用）", () => {
    const when = new Date(0);
    const buf = Buffer.from("hi");
    const calls = capture("warn", () => {
        logger.warn("x", { when, buf });
    });
    const fields = calls[0]?.[1] as Fields;
    assert.ok(fields.when instanceof Date, "Date 必须还是 Date");
    assert.ok(Buffer.isBuffer(fields.buf), "Buffer 不能被拆成几千个数字");
});

// ============ ② rid 自动补齐 ============

test("logger：注入 rid provider 后，调用方没带 rid 的日志会自动补上", () => {
    setRidProvider(() => "rid-abc");
    try {
        const calls = capture("warn", () => {
            logger.warn("x", { component: "t" });
        });
        assert.equal((calls[0]?.[1] as Fields).rid, "rid-abc");
    } finally {
        setRidProvider(undefined);
    }
});

test("logger：一个字段都没传时也能补 rid（否则「无上下文的 warn」照样对不上请求）", () => {
    setRidProvider(() => "rid-only");
    try {
        const calls = capture("warn", () => {
            logger.warn("裸消息");
        });
        assert.equal((calls[0]?.[1] as Fields).rid, "rid-only");
    } finally {
        setRidProvider(undefined);
    }
});

test("logger：调用方显式给的 rid 优先，不会被 provider 覆盖", () => {
    setRidProvider(() => "from-context");
    try {
        const calls = capture("error", () => {
            logger.error("x", { rid: "explicit" });
        });
        assert.equal((calls[0]?.[1] as Fields).rid, "explicit");
    } finally {
        setRidProvider(undefined);
    }
});

test("logger：provider 抛异常 / 返回空串都不影响日志本身", () => {
    setRidProvider(() => {
        throw new Error("provider 自己炸了");
    });
    try {
        const calls = capture("warn", () => {
            logger.warn("x", { component: "t" });
        });
        assert.equal(calls.length, 1, "日志必须照发");
        assert.equal((calls[0]?.[1] as Fields).rid, undefined, "拿不到就不写，别写个空串");
    } finally {
        setRidProvider(undefined);
    }

    setRidProvider(() => "");
    try {
        const calls = capture("warn", () => {
            logger.warn("x", { component: "t" });
        });
        assert.equal((calls[0]?.[1] as Fields).rid, undefined);
    } finally {
        setRidProvider(undefined);
    }
});

// ============ ③ 运行时计数 ============

test("metrics：4 个计数各自独立累加", () => {
    resetMetricsForTest();
    recordRequest(200, 10);
    recordRequest(500, 10);
    recordRequest(429, 10);
    recordRequest(200, SLOW_REQUEST_MS + 1);
    const m = metricsSnapshot();
    assert.equal(m.requests, 4);
    assert.equal(m.serverErrors, 1);
    assert.equal(m.rateLimited, 1);
    assert.equal(m.slowRequests, 1);
    assert.equal(typeof m.startedAt, "number");
});

test("metrics：慢但成功的请求不算 5xx；504 / 503 都算 5xx", () => {
    resetMetricsForTest();
    recordRequest(200, SLOW_REQUEST_MS + 500);
    recordRequest(503, 1);
    recordRequest(504, 1);
    const m = metricsSnapshot();
    assert.equal(m.serverErrors, 2, "只有 5xx 计错误");
    assert.equal(m.slowRequests, 1, "慢与错是两个维度，互不包含");
});

test("metrics：阈值是「大于」，恰好等于 1s 不算慢（与访问日志的判据同一个数）", () => {
    resetMetricsForTest();
    recordRequest(200, SLOW_REQUEST_MS);
    assert.equal(metricsSnapshot().slowRequests, 0, "等于阈值不算慢");
    recordRequest(200, SLOW_REQUEST_MS + 1);
    assert.equal(metricsSnapshot().slowRequests, 1);
});

test("metrics：4xx（非 429）既不算 5xx 也不算限速", () => {
    resetMetricsForTest();
    recordRequest(400, 1);
    recordRequest(401, 1);
    recordRequest(404, 1);
    recordRequest(413, 1);
    const m = metricsSnapshot();
    assert.equal(m.requests, 4);
    assert.equal(m.serverErrors, 0);
    assert.equal(m.rateLimited, 0);
});

test("metrics：快照是副本，改返回值不影响计数器", () => {
    resetMetricsForTest();
    recordRequest(200, 1);
    const first = metricsSnapshot();
    first.requests = 999;
    assert.equal(metricsSnapshot().requests, 1, "计数器不能被调用方改坏");
});

test("metrics：resetMetricsForTest 只清计数，语义上仍是同一个起点", () => {
    resetMetricsForTest();
    const before = metricsSnapshot();
    recordRequest(500, 1);
    resetMetricsForTest();
    const after = metricsSnapshot();
    assert.equal(after.requests, 0);
    assert.equal(after.serverErrors, 0);
    assert.equal(after.startedAt, before.startedAt, "startedAt 是模块加载时间，不随重置变化");
});
