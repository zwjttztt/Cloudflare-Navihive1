// tests/offlineQueue.test.ts
// 离线写入队列的单测。这块逻辑最容易错的两点：
// 1) 离线时入队、在线时（服务端拒绝）绝不该入队 —— 否则把脏数据塞进队列反复重放；
// 2) 重放仍失败的操作必须放回队列，不能悄悄丢。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    enqueueMutation,
    takeAll,
    pendingCount,
    flushOfflineQueue,
    failedMutations,
    clearFailedMutations,
    subscribe,
    isOfflineError,
    wrapMutations,
    setAccountUid,
    OfflineQueuedError,
    OfflineQueueFullError,
    OfflineQueueUnserializableError,
    QueuePayloadTooLargeError,
    MAX_PAYLOAD_BYTES,
    MAX_QUEUE_BYTES,
    MAX_FAILED_BYTES,
    estimatePayloadBytes,
    type FailedMutation,
    type MutationApi,
} from "../src/API/offlineQueue";

// 每个用例前把模块内的单例队列清空（takeAll 会取出并清空），账号回到匿名
const reset = () => {
    setAccountUid(null);
    takeAll();
    // 失败清单是另一个单例：只清队列的话，上一个用例留下的失败项会串到下一个用例里
    clearFailedMutations();
};

test("enqueue / pendingCount / takeAll：取出即清空", () => {
    reset();
    enqueueMutation("createSite", [{ id: 1 }]);
    enqueueMutation("deleteSite", [5]);
    assert.equal(pendingCount(), 2);
    const all = takeAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].kind, "createSite");
    assert.equal(pendingCount(), 0);
});

test("flushOfflineQueue：逐个重放并回报成功数", async () => {
    reset();
    const calls: { kind: string; args: unknown[] }[] = [];
    const api: MutationApi = {
        createSite: async (...a: unknown[]) => { calls.push({ kind: "createSite", args: a }); return { id: 9 }; },
        deleteSite: async (...a: unknown[]) => { calls.push({ kind: "deleteSite", args: a }); return true; },
        setConfig: async (...a: unknown[]) => { calls.push({ kind: "setConfig", args: a }); return true; },
    };
    enqueueMutation("createSite", [{ name: "a" }]);
    enqueueMutation("deleteSite", [5]);
    const done = await flushOfflineQueue(api);
    assert.equal(done, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [{ name: "a" }]);
    assert.equal(pendingCount(), 0);
});

test("flushOfflineQueue：重放失败（返回假）的操作放回队列，不丢", async () => {
    reset();
    const api: MutationApi = { setConfig: async () => false }; // returnsSuccess → 视为失败
    enqueueMutation("setConfig", ["k", "v"]);
    const done = await flushOfflineQueue(api);
    assert.equal(done, 0);
    assert.equal(pendingCount(), 1); // 放回队列了
    assert.equal(takeAll()[0].kind, "setConfig");
});

test("换账号登录后，上一个人排队的编辑不会被补发（不串号）", async () => {
    reset();
    setAccountUid(1);
    enqueueMutation("createSite", [{ name: "A 的编辑" }]);
    // 登出再登另一个账号：队列换成另一份，A 那条既不该被发也不该被看见
    setAccountUid(2);
    assert.equal(pendingCount(), 0, "新账号看到的是自己的空队列");
    const calls: unknown[][] = [];
    const api: MutationApi = {
        createSite: async (...a: unknown[]) => { calls.push(a); return { id: 1 }; },
    };
    const done = await flushOfflineQueue(api);
    assert.equal(done, 0);
    assert.equal(calls.length, 0, "A 的操作绝不能发到 B 的会话里");
    // 切回 A，排队的内容还在，可以正常重放
    setAccountUid(1);
    assert.equal(pendingCount(), 1);
    assert.equal(await flushOfflineQueue(api), 1);
});

test("服务端明确拒绝（4xx）的操作不再反复重放", async () => {
    reset();
    const api: MutationApi = {
        setConfig: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(pendingCount(), 0, "4xx 再排也没用，不该让角标永远挂着");
});

test("进失败清单时要通知订阅者 —— 否则界面上根本不显示这条（等于悄悄吞掉）", async () => {
    reset();
    // 重放路径是「先 drop 再 pushFailed」：drop 里那次通知发出去时，
    // 这条还没进失败清单，订阅者读到的还是旧列表。少了 pushFailed 里的通知，
    // 被服务端拒绝的改动就永远不出现在 OfflineBanner 上 —— 而那正是它唯一的用途。
    // 订阅者在通知里读到的失败条数：这才是界面实际会渲染出来的数
    let seenBySubscriber = -1;
    const unsubscribe = subscribe(() => {
        seenBySubscriber = failedMutations().length;
    });
    try {
        const api: MutationApi = {
            setConfig: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); },
        };
        enqueueMutation("setConfig", ["k", "v"]);
        await flushOfflineQueue(api);
        assert.equal(failedMutations().length, 1, "前置：确实进了失败清单");
        assert.equal(
            seenBySubscriber,
            1,
            "订阅者最后一次收到的通知里必须已经包含这条，否则横幅不会显示它"
        );
    } finally {
        unsubscribe();
        clearFailedMutations();
    }
});

test("还连不上（网络错）的操作留在队列里等下次", async () => {
    reset();
    const api: MutationApi = {
        setConfig: async () => { throw new TypeError("Failed to fetch"); },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(pendingCount(), 1, "网络没恢复就该继续留着");
});

test("重放不会被并发的两次调用重入（同一条只发一次）", async () => {
    reset();
    let calls = 0;
    const api: MutationApi = {
        setConfig: async () => { calls += 1; return true; },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    await Promise.all([flushOfflineQueue(api), flushOfflineQueue(api)]);
    assert.equal(calls, 1);
});

test("isOfflineError：网络错识别，服务端错不识别", () => {
    assert.equal(isOfflineError(new TypeError("Failed to fetch")), true);
    assert.equal(isOfflineError(new Error("fetch failed")), true);
    assert.equal(isOfflineError(new Error("500 Internal Server Error")), false);
    assert.equal(isOfflineError(new Error("参数错误")), false);
    assert.equal(isOfflineError(null), false);
});

test("wrapMutations：网络错入队并抛 OfflineQueuedError；服务端错原样抛出不入队", async () => {
    reset();
    const api: MutationApi = {
        // 网络错（fetch 抛 TypeError）→ 应入队 + 抛 OfflineQueuedError
        createSite: async () => { throw new TypeError("Failed to fetch"); },
        // 服务端错（5xx）→ 原样抛出，绝不能入队
        setConfig: async () => { throw new Error("500 boom"); },
    };
    wrapMutations(api);

    await assert.rejects(
        () => api.createSite({ id: 1 }),
        (e: unknown) => e instanceof OfflineQueuedError
    );
    assert.equal(pendingCount(), 1);

    await assert.rejects(
        () => api.setConfig("k", "v"),
        (e: unknown) => e instanceof Error && !(e instanceof OfflineQueuedError) && e.message.includes("500")
    );
    assert.equal(pendingCount(), 1); // 没新增

    // ⚠️ 必须在**同一个** wrapMutations 作用域里做这条断言：wrapMutations 是模块级幂等
    // （第二次调用直接 return），另起一个 api 对象再 wrap 是无效的，测出来的会是裸函数。
    const huge = "z".repeat(MAX_PAYLOAD_BYTES + 1);
    await assert.rejects(
        () => api.createSite({ name: huge }),
        (e: unknown) => e instanceof QueuePayloadTooLargeError && !(e instanceof OfflineQueuedError),
        "超限时队列根本没存，界面不能说「已暂存、联网自动同步」"
    );
    assert.equal(pendingCount(), 1, "被拒绝的那条不能进队列");
});

// ---------------- E-3：单条载荷上限 ----------------
//
// 队列存 localStorage（每源 ~5 MB）。真正会撑爆它的只有 `importData`（整份备份）
// 和「批量建站带 data:URL 图标」两条路。一条 4 MB 的备份进队列后，**后续所有操作
// 都会因为写不进配额而静默消失** —— 所以宁可在入队这一刻明确拒绝。

test("载荷超限：抛 QueuePayloadTooLargeError，且队列长度不变（没入队）", () => {
    reset();
    // 一份「够大」的备份：单个字符串超过上限即可，不必真造 MB 级数据
    const huge = "x".repeat(MAX_PAYLOAD_BYTES + 1024);
    assert.throws(
        () => enqueueMutation("importData", [{ sites: [{ name: huge }] }]),
        (e: unknown) => e instanceof QueuePayloadTooLargeError,
        "超限必须抛可识别的错误，而不是让它进队列"
    );
    assert.equal(pendingCount(), 0, "被拒绝的操作绝不能留在队列里");

    // 失败清单也不能收：它同样写 localStorage，收下等于换个地方撑爆配额
    assert.equal(failedMutations().length, 0);
});

test("载荷超限的错误名与文案稳定（界面靠 name 识别，文案要能直接展示给用户）", () => {
    reset();
    const huge = "y".repeat(MAX_PAYLOAD_BYTES + 1);
    try {
        enqueueMutation("importData", [huge]);
        assert.fail("应当抛错");
    } catch (error) {
        assert.ok(error instanceof QueuePayloadTooLargeError);
        assert.equal(error.name, "QueuePayloadTooLargeError");
        assert.equal(error.kind, "importData");
        assert.ok(error.size > MAX_PAYLOAD_BYTES, "要带上真实体积，用来给用户解释为什么不让存");
        // 文案必须说清「没保存」和「怎么办」：混成 OfflineQueuedError 的「已暂存」会骗人
        assert.match(error.message, /无法离线保存/);
        assert.match(error.message, /联网后重试/);
        assert.ok(!(error instanceof OfflineQueuedError), "它是「没存」，不是「已存」");
    }
});

test("普通大小的操作照旧入队（闸门不能误杀正常载荷）", () => {
    reset();
    const normalSite = { name: "普通卡片", url: "https://example.com", description: "a".repeat(2000) };
    enqueueMutation("createSite", [normalSite]);
    enqueueMutation("deleteSite", [1]);
    assert.equal(pendingCount(), 2, "几 KB 的操作必须照常排队");
});

test("体积按 UTF-8 字节算：中文标题不能被按字符数低估", () => {
    const cjk = "中".repeat(1000);
    // 1000 个汉字 = 3000 字节（JSON 里的引号另算），若按 .length 只有 1002
    const bytes = estimatePayloadBytes([cjk]);
    assert.ok(bytes >= 3000, `中文应按 UTF-8 字节计（实测 ${bytes}）`);
    assert.ok(bytes > cjk.length * 2, "字符数与字节数必须能区分开，否则闸门对中文形同虚设");
});

// ---------------- E-3 剩余一半：队列**总**字节上限 ----------------
//
// 单条上限只管住「一条有多大」，管不住「一共排了多少条」。10 条 250 KB 的操作条条合规、
// 合计 2.5 MB，抄过 localStorage 的 5 MB 配额之后 writeJson 会静默失败 ——
// 界面上表现为「角标归零、所有离线编辑凭空消失」，控制台什么都没有。
// 所以入队这一刻要按总量再拦一道，并且**明确拒绝**（抛错）而不是尽力而为。

/** 失败清单 / 队列里这些条 args 的合计字节数（与生产侧同一口径） */
const bytesOf = (items: ReadonlyArray<{ args: unknown[] }>): number =>
    items.reduce((sum, item) => sum + estimatePayloadBytes(item.args), 0);

test("队列入到总量上限：抛 OfflineQueueFullError，且队列长度不变（被拒的那条没进去）", () => {
    reset();
    // 100 KB 一条：单条离 256 KB 上限很远，撞的一定是 1 MB 的**总量**闸门
    const chunk = "x".repeat(100 * 1024);
    const perOp = estimatePayloadBytes([{ payload: chunk, seq: "000" }]);
    assert.ok(perOp < MAX_PAYLOAD_BYTES, "前置：单条必须合规，否则测的是另一道闸门");
    const capacity = Math.floor(MAX_QUEUE_BYTES / perOp);
    assert.ok(capacity >= 2, `前置：上限至少该放得下两条（实测 ${capacity}）`);

    for (let i = 0; i < capacity; i++) {
        enqueueMutation("setConfig", [{ payload: chunk, seq: String(i).padStart(3, "0") }]);
    }
    const before = pendingCount();
    assert.equal(before, capacity);

    try {
        enqueueMutation("setConfig", [{ payload: chunk, seq: "overflow" }]);
        assert.fail("队列已满时必须抛 OfflineQueueFullError");
    } catch (error) {
        assert.ok(error instanceof OfflineQueueFullError, `实际抛出：${String(error)}`);
        assert.equal(error.name, "OfflineQueueFullError");
        assert.ok(error.size > 0, "要带上本条体积，界面才好解释");
        assert.ok(error.total > MAX_QUEUE_BYTES, "total 是含本条的总量，必须超过上限");
        assert.equal(error.limit, MAX_QUEUE_BYTES);
        // 文案同样是给用户看的：说清「没保存」和「怎么办」
        assert.match(error.message, /离线待办已达上限/);
        assert.match(error.message, /请联网后再试/);
        assert.match(error.message, /MB/, "用量级而不是字节数，用户才看得懂");
        // 「已占用 X / 上限 Y」这组对比必须消失：超限 1 字节时两个数都会显示成 1 MB，
        // 用户读到「占=上限」却说满了，是自相矛盾（不是精度问题，改几位都改不掉）
        assert.doesNotMatch(error.message, /已占用/);
        assert.ok(!(error instanceof OfflineQueuedError), "它是「没存」，不是「已存」");
    }

    assert.equal(pendingCount(), before, "被拒绝的那条绝不能留在队列里");
});

test("失败清单超总字节上限：从最旧的开始裁，总量回到上限内", async () => {
    reset();
    const rejected: MutationApi = {
        setConfig: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); },
    };
    // 每条 40 KB：40 条合计 1.6 MB，撞的是**字节**上限；条数上限（50）此时还够不着，
    // 所以这条用例确实验的是新加的那道闸门，而不是老的 MAX_FAILED_KEPT。
    const chunk = "f".repeat(40 * 1024);
    const makeArgs = (seq: string) => [{ payload: chunk, seq }];
    const perItem = estimatePayloadBytes(makeArgs("000"));
    const batch = 20;
    assert.ok(perItem * (batch * 2) > MAX_FAILED_BYTES, "前置：两批加起来必须超过字节上限");

    const total = batch * 2;
    for (let i = 0; i < total; i++) {
        const seq = String(i).padStart(3, "0");
        // 队列本身也有 1 MB 上限，所以「排一批 → 冲一批（全被 4xx 拒）→ 再排」
        if (i % batch === 0) assert.equal(pendingCount(), 0, "每批开始前队列应已冲干净");
        enqueueMutation("setConfig", makeArgs(seq));
        if (i % batch === batch - 1) assert.equal(await flushOfflineQueue(rejected), 0);
    }

    const kept = failedMutations();
    assert.ok(kept.length < total, `必须裁掉一部分（留下 ${kept.length}/${total} 条）`);
    assert.ok(kept.length > 1, "至少要留一条：清空等于把「没同步成功」这件事藏起来");
    assert.ok(
        bytesOf(kept) <= MAX_FAILED_BYTES,
        `裁剪后总量 ${bytesOf(kept)} 必须回到 ${MAX_FAILED_BYTES} 以内`
    );
    const seqs = kept.map((f: FailedMutation) => (f.args[0] as { seq: string }).seq);
    assert.ok(!seqs.includes("000"), "最旧的那条应当先被裁掉");
    assert.ok(seqs.includes(String(total - 1).padStart(3, "0")), "最新那条必须还在（用户要救的是它）");
    assert.deepEqual(seqs, [...seqs].sort(), "留下的应当是最近的一段连续区间，不是随便丢");

    // 落盘的那份也得是裁过的：内存里裁完、盘上没裁，下次启动又会被读回来撑爆配额
    const store = globalThis.localStorage as Storage;
    const key = Array.from({ length: store.length }, (_, i) => store.key(i)).find(
        k => typeof k === "string" && k.includes("failedMutations")
    );
    assert.ok(key, "找不到失败清单的存储键");
    const onDisk = JSON.parse(store.getItem(key) ?? "[]") as unknown[];
    assert.equal(onDisk.length, kept.length, "盘上写的条数必须与裁剪结果一致");
});

test("总量闸门不误杀：清空队列后小载荷照旧入队", () => {
    reset();
    const chunk = "y".repeat(100 * 1024);
    const perOp = estimatePayloadBytes([{ payload: chunk, seq: "000" }]);
    const capacity = Math.floor(MAX_QUEUE_BYTES / perOp);
    for (let i = 0; i < capacity; i++) {
        enqueueMutation("setConfig", [{ payload: chunk, seq: String(i).padStart(3, "0") }]);
    }
    // 闸门看的是「当下占用」，不是「这台设备曾经满过」：同步完就应当能继续排队
    takeAll();
    const op = enqueueMutation("deleteSite", [1]);
    assert.equal(op.kind, "deleteSite");
    assert.equal(pendingCount(), 1);
    assert.ok(estimatePayloadBytes([1]) < MAX_QUEUE_BYTES);
});

// ---------------- 不可序列化的载荷：必须当场拒绝，且不能毒化整个队列 ----------------
//
// QA 实测过的原始缺陷：循环引用被 `estimatePayloadBytes` 估成 0 字节 → 两道闸门都当它
// 免费放行 → 随后 writeJson 里那次 JSON.stringify 抛错又被 catch 吞掉。
// 结果是「内存里有、盘上没有」，而且**一条就毒化整个会话**：之后每次写盘都要序列化
// 整份数组，同一个坏条目照样抛错，于是每一笔正常编辑都是「排队成功、刷新后全丢」。
// 所以这两条用例盯的不是「有没有报错」，而是「报了错之后，队列还能不能正常落盘」。

/** 读盘上（localStorage）那份待同步队列；键按账号分片，这里按名字找 */
function diskQueue(): unknown[] {
    const store = globalThis.localStorage as Storage;
    const key = Array.from({ length: store.length }, (_, i) => store.key(i)).find(
        k => typeof k === "string" && k.includes("offlineQueue")
    );
    if (!key) return [];
    return JSON.parse(store.getItem(key) ?? "[]") as unknown[];
}

/** 造一个自引用的对象：JSON.stringify 必抛 TypeError */
function cyclicPayload(): Record<string, unknown> {
    const node: Record<string, unknown> = { name: "循环引用" };
    node.self = node;
    return node;
}

test("循环引用载荷：抛 OfflineQueueUnserializableError，队列与盘上都一个字节没变", () => {
    reset();
    enqueueMutation("setConfig", ["theme", "dark"]); // 先放一条正常的做基线
    const before = pendingCount();
    const diskBefore = JSON.stringify(diskQueue());

    try {
        enqueueMutation("createSite", [cyclicPayload()]);
        assert.fail("不可序列化的载荷必须被拒绝，不能靠「估成 0 字节」放过去");
    } catch (error) {
        assert.ok(
            error instanceof OfflineQueueUnserializableError,
            `实际抛出：${String(error)}`
        );
        assert.equal(error.name, "OfflineQueueUnserializableError");
        assert.equal(error.kind, "createSite");
        // 文案对用户说清「没存 + 怎么办」
        assert.match(error.message, /无法离线暂存/);
        assert.match(error.message, /联网后重试/);
        // 不能冒充另外两种「没存」：说「太大」是误导（真实原因是没法序列化）
        assert.ok(
            !(error instanceof QueuePayloadTooLargeError),
            "Infinity 不能落到「体积过大」那条文案上，否则会打印 Infinity KB"
        );
        assert.ok(!(error instanceof OfflineQueuedError), "它是「没存」，不是「已存」");
    }

    assert.equal(pendingCount(), before, "被拒绝的那条不能留在内存队列里");
    assert.equal(JSON.stringify(diskQueue()), diskBefore, "盘上内容必须完全没变");
});

test("反毒化：拒绝一条不可序列化载荷之后，正常操作仍必须真的落盘", () => {
    // ⚠️ 这是整轮「不静默丢」的收口断言。修之前这里会红得不明显：
    // pendingCount 会涨（内存队列 push 成功），而盘上永远不涨 —— 刷新即全丢。
    // 所以断言必须落在**盘上**，只断言 pendingCount 等于把缺陷又盖回去一遍。
    reset();
    try {
        enqueueMutation("createSite", [cyclicPayload()]);
    } catch {
        /* 预期被拒：上面那条用例单独验了错误类型 */
    }
    const diskBefore = diskQueue().length;

    enqueueMutation("setConfig", ["theme", "dark"]);

    // 先断盘上、再断内存：反过来的话，缺陷表现为「内存 2 条」，报错只会说「多了 1 条」，
    // 而真正致命的是盘上根本没动 —— 那句才是「刷新后全丢」的直接证据。
    const disk = diskQueue() as Array<{ kind: string }>;
    assert.equal(disk.length, diskBefore + 1, "盘上也必须真的多一条 —— 否则刷新就丢");
    assert.equal(disk.at(-1)?.kind, "setConfig");
    assert.equal(pendingCount(), diskBefore + 1, "内存队列要加一条");
});

test("BigInt 载荷同样被拒（JSON.stringify 对 BigInt 直接抛 TypeError）", () => {
    reset();
    // 哨兵值本身也钉一下：0 会让闸门放行，Infinity 才能保证「必被拒绝」
    assert.equal(estimatePayloadBytes([1n]), Number.POSITIVE_INFINITY);
    assert.throws(
        () => enqueueMutation("setConfig", [1n]),
        (e: unknown) => e instanceof OfflineQueueUnserializableError
    );
    assert.equal(pendingCount(), 0);
    assert.equal(diskQueue().length, 0);
});
