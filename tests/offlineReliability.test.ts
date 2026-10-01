// tests/offlineReliability.test.ts
// D02 剩下的几条（审查报告原文）：逐项 pending→sending→acked 状态机、确认后删除、
// 暂时错误指数退避、永久错误进「可查看失败队列」、离线新建分组→新建站点映射临时 ID，
// 以及「调用包装后的 API 也需防止再次入队」——重放时再入一条会让同一件事做两遍。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    enqueueMutation,
    takeAll,
    requeue,
    pendingCount,
    flushOfflineQueue,
    wrapMutations,
    setAccountUid,
    clearFailedMutations,
    discardFailedMutation,
    failedMutations,
    retryFailedMutation,
    backoffDelayMs,
    isTempId,
    translateTempIds,
    resolvedTempIds,
    OfflineQueuedError,
    MAX_REPLAY_ATTEMPTS,
    BACKOFF_MAX_MS,
    SENDING_LEASE_MS,
    type MutationApi,
} from "../src/API/offlineQueue";

// navigator.onLine 是「是否离线」的判据，Node 里没有真的浏览器 navigator，自己给一个
const nav = { onLine: true } as { onLine: boolean };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

/** 每个方法的真实实现放在这里，测试按需替换（包过一层之后就不能直接改 api.xxx 了） */
const impl: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    createGroup: async () => ({ id: 42 }),
    createSite: async () => ({ id: 7 }),
    updateSite: async () => ({ id: 7 }),
    deleteSite: async () => true,
    setConfig: async () => true,
    importData: async () => ({ success: true }),
};
/** 把「网络断了」做成开关：打开时所有实现都抛典型的 fetch 网络错 */
let netDown = false;

const api: MutationApi = {};
for (const name of Object.keys(impl)) {
    api[name] = (...a: unknown[]) => {
        if (netDown) return Promise.reject(new TypeError("Failed to fetch"));
        return impl[name](...a);
    };
}
// 只包一次（模块内的 wrapped 标志是一次性的），之后靠换 impl 改行为
wrapMutations(api);

const reset = () => {
    setAccountUid(null);
    takeAll();
    clearFailedMutations();
    netDown = false;
    nav.onLine = true;
};

/** 把队列里唯一那条取出来改一改再放回去（没有 peek，只能这样） */
function editOnly(fn: (op: ReturnType<typeof takeAll>[number]) => void): void {
    const [op] = takeAll();
    fn(op);
    requeue(op);
}

// ================= 1. 重放期间不再入队（否则同一件事做两遍）=================
test("重放失败时不会再入一条：队列不会自我复制", async () => {
    reset();
    netDown = true;
    try {
        await api.createSite({ name: "离线新建" });
        assert.fail("离线应当抛 OfflineQueuedError");
    } catch (err) {
        assert.ok(err instanceof OfflineQueuedError, "应抛出可识别的离线入队错误");
    }
    assert.equal(pendingCount(), 1, "离线时入队一条");

    // 联网了但服务端还是收不到（典型网络错）：重放这一条，不该再入一条
    nav.onLine = true;
    netDown = true;
    await flushOfflineQueue(api);
    assert.equal(pendingCount(), 1, "重放失败也只能是原来那一条，不能变成两条");

    // 服务端恢复了：把退避拨到已到期，一次重放就该清干净
    netDown = false;
    editOnly(o => { o.nextAttemptAt = undefined; });
    assert.equal(await flushOfflineQueue(api), 1);
    assert.equal(pendingCount(), 0);
    assert.equal(failedMutations().length, 0, "最终成功了就不该留在失败列表里");
});

// ================= 2. 逐项状态机：成功一条才划掉一条 =================
test("成功一条才从盘上划掉一条：中途断网，剩下的还在", async () => {
    reset();
    enqueueMutation("createSite", [{ name: "第一条" }]);
    enqueueMutation("createSite", [{ name: "第二条" }]);
    impl.createSite = async (site: unknown) => {
        // 第一条成功之后把网络掐了，模拟「同步到一半断网」
        if ((site as { name?: string })?.name === "第一条") nav.onLine = false;
        return { id: 1 };
    };

    const done = await flushOfflineQueue(api);
    assert.equal(done, 1, "只同步成功了一条");
    assert.equal(pendingCount(), 1, "第二条必须还在盘上，不能凭空消失");
    const left = takeAll()[0];
    assert.equal((left.args[0] as { name: string }).name, "第二条");
    assert.equal(left.state, "pending", "没发出去的那条要留在 pending，下次 online 接着发");
});

test("sending 状态不会被同一轮重放再发一次", async () => {
    reset();
    let calls = 0;
    impl.createSite = async () => { calls++; return { id: 1 }; };
    enqueueMutation("createSite", [{ name: "x" }]);
    // 模拟「另一个页面正在发这一条」：租期之内不该被抢
    editOnly(op => { op.state = "sending"; op.sentAt = Date.now(); });

    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(calls, 0, "sending 的那条不该被再发一次");
    assert.equal(pendingCount(), 1, "它还在队列里，等别人发完或租期到期");
});

test("重入保护：上一轮 flush 还没跑完时再调一次直接返回 0", async () => {
    reset();
    let release: (() => void) | undefined;
    impl.createSite = async () => new Promise<{ id: number }>(r => { release = () => r({ id: 1 }); });
    enqueueMutation("createSite", [{ name: "x" }]);

    const running = flushOfflineQueue(api); // 挂住，模拟「还在同步」
    assert.equal(await flushOfflineQueue(api), 0, "重入的第二次不该再发一遍");
    release?.();
    assert.equal(await running, 1, "上一轮那条正常完成");
});

test("卡住的 sending 超过租期会被收回重排（页面关了不会丢操作）", async () => {
    reset();
    enqueueMutation("createSite", [{ name: "x" }]);
    editOnly(op => { op.state = "sending"; op.sentAt = Date.now() - SENDING_LEASE_MS - 1; });

    let called = false;
    impl.createSite = async () => { called = true; return { id: 1 }; };
    assert.equal(await flushOfflineQueue(api), 1);
    assert.equal(called, true, "过期的 sending 应当被收回并重发");
});

// ================= 3. 指数退避 =================
test("暂时性失败按指数退避推迟，未到期不重试", async () => {
    reset();
    impl.setConfig = async () => false; // returnsSuccess 类方法返回假 = 没成功

    enqueueMutation("setConfig", ["k", "v"]);
    await flushOfflineQueue(api);

    let op = takeAll()[0];
    assert.equal(op.attempts, 1, "记一次重试");
    assert.ok(op.nextAttemptAt && op.nextAttemptAt > Date.now(), "应推迟到未来某个时刻");
    requeue(op);

    // 未到期：flush 直接跳过
    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(pendingCount(), 1, "还没到点就不该再试");

    // 拨到过去再试：这次会真的再发一次
    editOnly(o => { o.nextAttemptAt = Date.now() - 1; });
    await flushOfflineQueue(api);
    op = takeAll()[0];
    assert.equal(op.attempts, 2);
});

test("backoffDelayMs：指数增长且封顶，带抖动", () => {
    const a = backoffDelayMs(1);
    const b = backoffDelayMs(3);
    assert.ok(a >= 500 && a <= BACKOFF_MAX_MS, `第一次退避应在合理区间，实际 ${a}`);
    assert.ok(b >= a, `第 3 次不该比第 1 次更急，实际 ${a} / ${b}`);
    // 封顶：再多重试也不会等到天荒地老
    for (let i = 0; i < 20; i++) {
        const d = backoffDelayMs(20);
        assert.ok(d <= BACKOFF_MAX_MS && d >= BACKOFF_MAX_MS / 2, `封顶后应落在 [30s, 60s]，实际 ${d}`);
    }
});

// ================= 4. 永久错误进可查看失败队列 =================
test("服务端明确拒绝（4xx）直接进失败列表，不再占着角标", async () => {
    reset();
    impl.setConfig = async () => {
        throw Object.assign(new Error("HTTP 400 Bad Request"), { status: 400 });
    };
    enqueueMutation("setConfig", ["k", "v"]);
    await flushOfflineQueue(api);

    assert.equal(pendingCount(), 0, "4xx 再排也没用，不该继续占角标");
    const failed = failedMutations();
    assert.equal(failed.length, 1, "要进可查看的失败列表");
    assert.match(failed[0].reason, /400/);
    assert.equal(failed[0].kind, "setConfig");
});

test("重试到上限后转入失败列表（不是无限重试）", async () => {
    reset();
    impl.setConfig = async () => false;

    enqueueMutation("setConfig", ["k", "v"]);
    for (let i = 0; i < MAX_REPLAY_ATTEMPTS; i++) {
        await flushOfflineQueue(api);
        if (pendingCount() === 0) break;
        editOnly(o => { o.nextAttemptAt = Date.now() - 1; });
    }

    assert.equal(pendingCount(), 0, `试够 ${MAX_REPLAY_ATTEMPTS} 次后该从队列移除`);
    const failed = failedMutations();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempts, MAX_REPLAY_ATTEMPTS);
});

test("失败列表可重试 / 可放弃 / 可清空", async () => {
    reset();
    impl.setConfig = async () => {
        throw Object.assign(new Error("HTTP 422"), { status: 422 });
    };
    enqueueMutation("setConfig", ["k", "v"]);
    await flushOfflineQueue(api);

    const [item] = failedMutations();
    assert.ok(item.opId, "失败条目要带得回幂等键");
    assert.equal(retryFailedMutation(item.opId!), true, "放回队列");
    assert.equal(failedMutations().length, 0);
    assert.equal(pendingCount(), 1);

    // 再失败一次，然后放弃
    await flushOfflineQueue(api);
    const [again] = failedMutations();
    assert.equal(discardFailedMutation(again.opId!), true);
    assert.equal(failedMutations().length, 0);

    enqueueMutation("setConfig", ["k2", "v2"]);
    await flushOfflineQueue(api);
    assert.equal(failedMutations().length, 1);
    clearFailedMutations();
    assert.equal(failedMutations().length, 0);
});

// ================= 5. 临时 ID：离线新建分组 → 在它下面新建站点 =================
test("离线新建分组拿到占位 id，重放后站点挂到真实分组上", async () => {
    reset();
    const created: unknown[] = [];
    impl.createSite = async (site: unknown) => {
        created.push(site);
        return { id: 7 };
    };

    // 断网：新建分组拿不到真实 id，只能拿占位 id
    netDown = true;
    let tempId: number | undefined;
    try {
        await api.createGroup({ name: "离线分组" });
        assert.fail("离线应当抛 OfflineQueuedError");
    } catch (err) {
        assert.ok(err instanceof OfflineQueuedError);
        tempId = err.tempId;
    }
    assert.ok(isTempId(tempId), `应该拿到负数占位 id，实际 ${tempId}`);

    // 在这个（还不存在的）分组下新建站点：入队时记的是占位 id
    try {
        await api.createSite({ name: "离线站点", group_id: tempId, url: "https://a.com" });
    } catch (err) {
        assert.ok(err instanceof OfflineQueuedError);
    }
    assert.equal(pendingCount(), 2);

    // 联网重放：分组先落库拿到真实 id，站点要挂到那个号上
    netDown = false;
    assert.equal(await flushOfflineQueue(api), 2);
    assert.equal(pendingCount(), 0);
    assert.equal(resolvedTempIds()[String(tempId)], 42, "占位 id 应已解析成真实 id");
    assert.equal(
        (created[0] as { group_id?: number })?.group_id,
        42,
        "重放时站点的 group_id 必须翻译成真实 id，不能还是负数"
    );
});

test("translateTempIds：没解析过的占位 id 原样保留（不猜、不填 0）", () => {
    const args = translateTempIds([{ group_id: -1234567 }], {});
    assert.equal((args[0] as { group_id: number }).group_id, -1234567);
    const mapped = translateTempIds([{ group_id: -1234567 }], { "-1234567": 9 });
    assert.equal((mapped[0] as { group_id: number }).group_id, 9);
    // 非对象参数原样返回
    assert.deepEqual(translateTempIds([5], { "5": 1 }), [5]);
});

test("离线新建分组的占位 id 是负数：与真实 id 不可能撞", async () => {
    reset();
    netDown = true;
    try {
        await api.createGroup({ name: "G" });
    } catch {
        /* 预期抛错 */
    }
    const [op] = takeAll();
    assert.ok(isTempId(op.tempId), `实际 ${op.tempId}`);
    assert.ok((op.tempId as number) < 0);
});
