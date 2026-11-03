// tests/offlineQueueCrossTab.test.ts
// 跨标签页 flush 协调（2026-11-03，C6）。
//
// 为什么要单独一个文件：`flushing` 是**进程内**布尔锁，只能挡住同一个页面。
// 两个标签页各有一份内存副本、各自监听自己的 online 事件，可能同时重放同一批操作；
// 而 drop 是「成功一条就整份覆盖写盘」，于是后写的那页会把先写那页刚划掉的条目
// 从盘上捡回来 —— 重放 → 划掉 → 捡回，无限循环。
//
// 这里钉两件事：
//   1) 有 Web Locks 时，两个并发 flush **不重叠**（peak === 1）；
//   2) 没有 Web Locks 时退化成 localStorage 租约：别的标签页持租约期间本页跳过，
//      但**一条都不能丢** —— 租约过期后照样能把整批做掉。
//
// ⚠️ 不试图用真的双窗口 / StorageEvent 模拟两个模块实例：Node 的 import 缓存
// 让「同一份模块跑两遍」做不干净。用「假 locks 串行化 + 并发调用」证明
// 「两个竞争者一起来，不重叠、不丢」，这就是这条用例要证明的东西。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    clearFailedMutations,
    enqueueMutation,
    flushOfflineQueue,
    pendingCount,
    setAccountUid,
    takeAll,
    type MutationApi,
} from "../src/API/offlineQueue";

// ---------------- navigator 替身（Node 里没有真的浏览器 navigator） ----------------

/**
 * 整个文件用同一个账号分片（7），「换账号」不在本文件的考点里。
 * 用非 null 的 uid 是为了贴近真实场景：登录后才有队列。
 */
const UID = 7;

interface FakeLockManager {
    request(
        name: string,
        options: { mode?: "exclusive" | "shared" },
        callback: () => Promise<unknown>
    ): Promise<unknown>;
}

/**
 * 在 globalThis 上装 navigator。Node 22 的 navigator 是 getter-only，
 * 只能 defineProperty（同 tests/offlineReliability.test.ts）。
 */
function setNavigator(extra: Record<string, unknown> = {}): void {
    Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true, ...extra },
        configurable: true,
        writable: true,
    });
}

/**
 * 最小的 Web Locks 替身：用 Promise 链把回调串行化，保证同一时刻只有一处在跑。
 * 这正是真 Web Locks 对同名 exclusive 锁的语义，只是换成了单进程里的实现。
 *
 * 除了「临界区最大并发数」（peak），还记了「请求次数」与「真正进入临界区的次数」：
 * 因为进程内的 `flushing` 布尔锁**本来**就能挡住同一个页面的两次 flush
 * （见下方第一条用例的说明），光看 peak === 1 证明不了锁有没有被用上 ——
 * 得同时看到「两次 flush 都向锁申请过」且「两个临界区都真的跑过、且不重叠」。
 */
function installFakeLocks(): {
    locks: FakeLockManager;
    peak: () => number;
    requested: () => number;
    entered: () => number;
} {
    let tail: Promise<unknown> = Promise.resolve();
    let active = 0;
    let peak = 0;
    let requested = 0;
    let entered = 0;
    const locks: FakeLockManager = {
        request: (_name, _options, callback) => {
            requested += 1;
            const run = tail.then(async () => {
                active += 1;
                entered += 1;
                peak = Math.max(peak, active);
                try {
                    return await callback();
                } finally {
                    active -= 1;
                }
            });
            // 链条不能因为某一次 reject 就断掉，否则后续请求永远拿不到锁
            tail = run.then(
                () => undefined,
                () => undefined
            );
            return run;
        },
    };
    return { locks, peak: () => peak, requested: () => requested, entered: () => entered };
}

// ---------------- localStorage 租约清理 ----------------

/** 清掉所有账号分片的租约键（纯测试替身提供了 key/length，能枚举） */
function clearLeases(): void {
    const store = globalThis.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.includes("offlineQueue.lease")) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
}

/** 写一条「别的标签页正持有」的租约 */
function writeForeignLease(ttlMs: number): void {
    globalThis.localStorage.setItem(
        `navihive.offlineQueue.lease:u${UID}`,
        JSON.stringify({ tabId: "another-tab", until: Date.now() + ttlMs })
    );
}

function readLeaseRaw(): string | null {
    return globalThis.localStorage.getItem(`navihive.offlineQueue.lease:u${UID}`);
}

// ---------------- 公共准备 ----------------

/** 让出一轮事件循环，制造真正的交错（不然并发只是同步先后） */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function reset(): void {
    // 两个分片都清干净：上一个用例可能停在匿名档
    setAccountUid(null);
    takeAll();
    clearFailedMutations();
    setAccountUid(UID);
    takeAll();
    clearFailedMutations();
    clearLeases();
}

/**
 * 装一个会记录「同时进来了几个」的 api。
 *
 * 为什么要记 opId：重放时每条操作都会先把**自己的**幂等 ID 交给 setIdempotencyKey，
 * 服务端据此去重。集合大小 === K 就说明「K 条操作一条不落地下发过」；
 * 若锁失效导致同一批被两个 flush 各发一遍，集合大小仍然是 K（这份用例的着力点
 * 是「不丢 + 不重叠」，重复由服务端幂等兜住，见 offlineQueue.ts 里那段说明）。
 */
function installApi(delayMs = 0): {
    api: MutationApi;
    peak: () => number;
    opIds: () => string[];
    calls: () => number;
} {
    const seen = new Set<string>();
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    let nextId = 100;

    const mutation = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        calls += 1;
        try {
            if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
            else await tick();
            return { success: true, id: (nextId += 1) };
        } finally {
            inFlight -= 1;
        }
    };

    // ⚠️ 这里要一次 cast：MutationApi 的索引签名要求「每个值都是 (...args) => Promise」，
    // 而 setIdempotencyKey 按设计是**同步**的（见 offlineQueue.ts 顶部的类型注释），
    // 交叉类型下字面量直接赋值过不了 TS —— 这不是替身的毛病，是那个接口本身的形状。
    const api = {
        setIdempotencyKey: (key: string | null) => {
            if (key) seen.add(key);
        },
        createSite: mutation,
        createGroup: mutation,
        updateSite: mutation,
        deleteSite: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            calls += 1;
            try {
                await tick();
                return true;
            } finally {
                inFlight -= 1;
            }
        },
    } as unknown as MutationApi;

    return {
        api,
        peak: () => peak,
        opIds: () => [...seen],
        calls: () => calls,
    };
}

/** 入队 K 条，返回它们的 opId（也就是服务端会看到的幂等键） */
function enqueueK(k: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < k; i += 1) {
        const op = enqueueMutation("createSite", [{ name: `离线建站 ${i}` }]);
        if (op.opId) ids.push(op.opId);
    }
    return ids;
}

beforeEach(() => {
    reset();
    // 默认走 Web Locks 路径；降级用例自己覆盖
    setNavigator();
});

// ---------------- 1. Web Locks 路径 ----------------

test("有 Web Locks 时两个并发 flush 都走锁、不重叠，且 K 条操作一条不丢", async () => {
    const fake = installFakeLocks();
    // onLine 与 locks 一起装上：client 的 isOffline 只看 onLine，锁在调用时才读
    setNavigator({ locks: fake.locks });

    const K = 6;
    const expected = enqueueK(K);
    assert.equal(pendingCount(), K, "前置条件：K 条都得真的入队");

    const { api, peak, opIds, calls } = installApi();
    // 并发发起两次：真实场景就是两个标签页的 online 事件同时到
    const [first, second] = await Promise.all([flushOfflineQueue(api), flushOfflineQueue(api)]);

    // ⚠️ 这条用例的着力点要先说清：单进程里 `flushing` 布尔锁本来就能挡住两次 flush
    // 同时跑，所以「peak === 1」**单独**证明不了跨标签页锁有没有被用上。
    // 真正证明的是下面三件事连起来：两次 flush 都向锁申请过（requested === 2）、
    // 两个临界区都真的跑过（entered === 2）、且从未重叠（peak === 1）。
    // 若有人把 withQueueLock 摘掉，requested 会变成 0 —— 这条立刻红。
    assert.equal(fake.requested(), 2, "两次 flush 都必须向跨标签页锁申请，否则等于没加锁");
    assert.equal(fake.entered(), 2, "第二个 flush 不该被锁永久挡住 —— 它该排在后面进来，而不是消失");
    assert.equal(
        fake.peak(),
        1,
        `临界区出现了 ${fake.peak()} 处重叠 —— 两个标签页会同时重放同一批，` +
            "drop 的整份覆盖写盘会互相把对方的进度抹掉"
    );
    assert.equal(
        calls(),
        K,
        `api 一共被调了 ${calls()} 次，应为 ${K} 次 —— 这条同时说明下面的 peak 不是「只跑了一条」的空话`
    );
    assert.equal(
        peak(),
        1,
        `api 调用出现了 ${peak()} 处重叠 —— 两个标签页会同时重放同一批，` +
            "drop 的整份覆盖写盘会互相把对方的进度抹掉"
    );
    assert.equal(
        new Set(opIds()).size,
        K,
        `实际下发 ${new Set(opIds()).size} 条不同 opId，应为 ${K} 条（少一条就是用户的编辑丢了）`
    );
    assert.equal(pendingCount(), 0, `重放完队列应当清空，实际还剩 ${pendingCount()} 条`);
    assert.equal(first + second, K, "成功数应当加总为 K（拿不到锁的那次跳过返回 0）");
    assert.equal(second, 0, "第二个进入者等锁期间队列已被清空，应当复查后返回 0");
    assert.deepEqual(
        [...new Set(opIds())].sort(),
        [...expected].sort(),
        "下发的 opId 集合必须与入队时完全一致"
    );
});

// ---------------- 2. 降级：localStorage 租约 ----------------

test("没有 Web Locks 时退化为租约：别的标签页持租约期间本页跳过，一条都不丢", async () => {
    // 只有 onLine，没有 locks
    setNavigator();

    const K = 4;
    enqueueK(K);
    writeForeignLease(30_000);

    const { api, calls } = installApi();
    const done = await flushOfflineQueue(api);

    assert.equal(done, 0, "别的标签页正在重放，本页应当跳过（返回 0）而不是排队死等");
    assert.equal(calls(), 0, "跳过时不该真的发出任何请求");
    assert.equal(pendingCount(), K, "跳过不能顺手把条目丢掉 —— 那才是真的数据丢失");
    assert.ok(readLeaseRaw(), "别人的租约不该被本页清掉");
});

test("没有 Web Locks 时租约过期可抢（对方关页/崩溃），整批照样做掉", async () => {
    setNavigator();

    const K = 5;
    enqueueK(K);
    // 已过期的租约 = 持有者已经没了。不抢的话队列会一直卡在这里，
    // 而且没有任何界面提示（角标一直挂着，用户只能看着它不动）
    writeForeignLease(-1_000);

    const { api, opIds } = installApi();
    const done = await flushOfflineQueue(api);

    assert.equal(done, K, `过期租约应当被抢下并重放完全部 ${K} 条，实际 ${done} 条`);
    assert.equal(new Set(opIds()).size, K, "K 条操作一条不丢");
    assert.equal(pendingCount(), 0);
    assert.equal(readLeaseRaw(), null, "flush 结束后必须释放租约，否则下一个标签页要白等 30 秒");
});

test("没有 Web Locks 时并发两次 flush：不丢条目、队列清空", async () => {
    setNavigator();

    const K = 3;
    enqueueK(K);

    const { api, opIds } = installApi();
    // 同一进程里两个「标签页」共享同一份模块状态（TAB_ID 相同，租约认得出是"自己"），
    // 所以这里不假设会产生跳过；要钉的是「无论谁先谁后，K 条都必须落地且不重复丢」。
    const [first, second] = await Promise.all([flushOfflineQueue(api), flushOfflineQueue(api)]);

    assert.equal(new Set(opIds()).size, K, "K 条操作一条不丢");
    assert.equal(pendingCount(), 0, "最终队列必须清空");
    assert.ok(first + second >= K, "成功数至少覆盖 K 条（另一次若跳过则为 K + 0）");
    assert.equal(readLeaseRaw(), null, "跑完不该把租约留在盘上");
});

test("对照：拿掉跨标签页锁（没有 locks，只有进程内 flushing）时 api 不会重叠", async () => {
    // 这条不是「锁生效」的证据，而是**如实记下这条用例的边界**：
    // 单进程里 `flushing` 布尔锁已经足够挡住两次 flush 同时跑，所以「peak === 1」
    // 在两条路径上都会成立。跨标签页锁真正的价值在**跨进程**：另一个标签页有自己的
    // flushing（它的值为 false），挡不住任何东西 —— 那种场景只能靠下面
    // 「别的标签页持租约 → 本页跳过且不丢条目」那条来证明（若没有锁，本页会把
    // 整批发出去，calls 就不会是 0）。
    setNavigator();

    enqueueK(4);
    const { api, peak } = installApi();
    await Promise.all([flushOfflineQueue(api), flushOfflineQueue(api)]);

    assert.equal(peak(), 1, "进程内 flushing 本就该挡住同页并发 —— 挡不住才是回归");
});

test("租约按账号分片：别人的账号持租约不挡本账号", async () => {
    setNavigator();

    // 匿名档 + 另一个账号各写一条「正在重放」的租约
    globalThis.localStorage.setItem(
        "navihive.offlineQueue.lease:anon",
        JSON.stringify({ tabId: "another-tab", until: Date.now() + 30_000 })
    );
    globalThis.localStorage.setItem(
        "navihive.offlineQueue.lease:u999",
        JSON.stringify({ tabId: "another-tab", until: Date.now() + 30_000 })
    );

    const K = 2;
    enqueueK(K);

    const { api } = installApi();
    const done = await flushOfflineQueue(api);

    assert.equal(
        done,
        K,
        "不同账号的队列本来就互不相干，不该被对方那把锁挡住（挡住了就是「联网了却不同步」）"
    );
    assert.equal(pendingCount(), 0);
});
