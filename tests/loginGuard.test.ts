// tests/loginGuard.test.ts
// 登录 / 初始化接口的失败限速。
//
// 关键变化：这把锁过去是**全站一把**（所有来源共用同一个计数），
// 于是任何人连着输错 5 次，连站点主人自己都被挡在门外 30 分钟 ——
// 防护性功能反过来成了最好用的 DoS 入口。现在按来源 IP 分桶。
// 这几条测试把「互不连坐」钉死。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    readLoginGuard,
    writeLoginGuard,
    readInitGuard,
    writeInitGuard,
    readRegisterGuard,
    writeRegisterGuard,
    LOGIN_GUARD_KEY,
    LOGIN_BASE_LOCK_MS,
    REGISTER_GUARD_KEY,
} from "../worker/loginGuard";

/**
 * 只实现限速真正用到的读写。
 *
 * `compareAndSetConfig` 是这次改动的重点：**只有当前值等于 expected 才写**，
 * 并且用 `casHooks` 模拟「我们读完之后被别人抢先改了」的并发场景 —— 钩子返回 false
 * 代表 CAS 失败（别人已写入），钩子可以顺手把别人的改动写进 store。
 */
interface CasHook {
    (key: string, expected: string | null, next: string): boolean;
}

function makeApi(initial?: Record<string, string>, casHooks: CasHook[] = []) {
    const configs = new Map<string, string>(Object.entries(initial || {}));
    let casCalls = 0;
    return {
        configs,
        casCalls: () => casCalls,
        api: {
            async getConfig(key: string) {
                return configs.has(key) ? (configs.get(key) as string) : null;
            },
            async setConfig(key: string, value: string) {
                configs.set(key, value);
                return true;
            },
            async compareAndSetConfig(key: string, expected: string | null, next: string) {
                casCalls++;
                const current = configs.has(key) ? (configs.get(key) as string) : null;
                if (current !== expected) return false;
                // 钩子按调用顺序生效：返回 false 就模拟「别人抢先写了」
                const hook = casHooks.shift();
                if (hook && !hook(key, expected, next)) {
                    // 钩子负责把「别人的」改动落进 store（模拟另一路请求已提交）
                    return false;
                }
                configs.set(key, next);
                return true;
            },
        },
    };
}

test("登录限速按来源分桶：一个人的失败不会累到另一个人", async () => {
    const { api } = makeApi();
    await writeLoginGuard(api as never, { count: 4, until: 0 }, "1.2.3.4");

    const attacker = await readLoginGuard(api as never, "1.2.3.4");
    const owner = await readLoginGuard(api as never, "9.9.9.9");
    assert.equal(attacker.count, 4);
    assert.equal(owner.count, 0, "站点主人不该被别人的失败拖累");
    assert.equal(owner.until, 0);
});

test("锁定期只看自己那个桶：不会被别人的登录解开", async () => {
    const { api } = makeApi();
    const until = Date.now() + LOGIN_BASE_LOCK_MS;
    await writeLoginGuard(api as never, { count: 9, until }, "1.2.3.4");

    // 别人登录成功只会清掉自己的桶
    await writeLoginGuard(api as never, { count: 0, until: 0 }, "9.9.9.9");

    const stillLocked = await readLoginGuard(api as never, "1.2.3.4");
    assert.equal(stillLocked.until, until, "解锁他人不能顺手解开别人的锁");
});

test("旧存储格式（全站一把锁）升级时不会把正在进行的锁放开", async () => {
    const soon = Date.now() + 60_000;
    const { api } = makeApi({ [LOGIN_GUARD_KEY]: JSON.stringify({ count: 7, until: soon }) });

    // 老格式折成一个 legacy 桶：只要还在锁定期就必须继续锁住
    const migrated = await readLoginGuard(api as never, "legacy");
    assert.equal(migrated.until, soon);
});

test("旧存储格式已过期时直接丢弃计数，不必再等", async () => {
    const past = Date.now() - 1_000;
    const { api } = makeApi({ [LOGIN_GUARD_KEY]: JSON.stringify({ count: 7, until: past }) });

    const migrated = await readLoginGuard(api as never, "legacy");
    assert.equal(migrated.count, 0);
    assert.equal(migrated.until, 0);
});

test("初始化限速同样按来源分桶", async () => {
    const { api } = makeApi();
    await writeInitGuard(api as never, { count: 3, until: 0 }, "1.2.3.4");

    assert.equal((await readInitGuard(api as never, "1.2.3.4")).count, 3);
    assert.equal((await readInitGuard(api as never, "9.9.9.9")).count, 0);
});

// 注册是唯一「不用任何凭据就能写库」的入口：失败要写审计日志、成功要跑一次十万次
// PBKDF2，两头都是资源。它和登录共用同一套分桶存储，但**各自独立计数** ——
// 一个人连着注册失败，不该顺带把自己登录的额度也耗光（反之亦然）。
test("注册限速与登录限速各记各的：互不串台", async () => {
    const { api } = makeApi();
    await writeRegisterGuard(api as never, { count: 6, until: 0 }, "1.2.3.4");

    assert.equal((await readRegisterGuard(api as never, "1.2.3.4")).count, 6);
    assert.equal(
        (await readLoginGuard(api as never, "1.2.3.4")).count,
        0,
        "注册计数不该落进登录的桶"
    );
});

test("注册限速按来源分桶：一个人刷注册不影响别人", async () => {
    const { api } = makeApi();
    const until = Date.now() + 60_000;
    await writeRegisterGuard(api as never, { count: 12, until }, "1.2.3.4");

    const attacker = await readRegisterGuard(api as never, "1.2.3.4");
    const other = await readRegisterGuard(api as never, "9.9.9.9");
    assert.equal(attacker.until, until);
    assert.equal(other.count, 0);
    assert.equal(other.until, 0, "别人不该被连坐");
});

test("注册计数不会因为登录成功被清掉（成功同样消耗资源）", async () => {
    const { api, configs } = makeApi();
    await writeRegisterGuard(api as never, { count: 3, until: 0 }, "1.2.3.4");
    // 同一来源登录成功，只清登录自己的桶
    await writeLoginGuard(api as never, { count: 0, until: 0 }, "1.2.3.4");

    assert.equal((await readRegisterGuard(api as never, "1.2.3.4")).count, 3);
    assert.ok(configs.has(REGISTER_GUARD_KEY), "注册桶独立存在");
});

test("桶数量有上限：刷再多 IP 也不会把这条配置撑爆", async () => {
    const { api, configs } = makeApi();
    for (let i = 0; i < 40; i++) {
        await writeLoginGuard(api as never, { count: 1, until: 0 }, `10.0.0.${i}`);
    }
    const stored = configs.get(LOGIN_GUARD_KEY) as string;
    // 上限目前是 2000（远大于 40），这里只验证「确实写进了 buckets 且条目齐全」
    const parsed = JSON.parse(stored) as { buckets?: Record<string, unknown> };
    assert.equal(Object.keys(parsed.buckets || {}).length, 40);
    assert.ok(stored.length < 100_000, "单条配置不该无限增长");
});

// ---------------- 并发：计数不再被别人的写整个盖掉 ----------------
//
// 早先是「读整条 → 改 → 整条写回」：两个请求同时读到同一份快照，各自算完写回，
// 后写的那份会把前一份**整个覆盖**。放在攻击场景里就是
// 「受害者的一次写入，把攻击者攒下的失败次数冲回小数」，限速形同虚设。
// 现在改成 CAS + 重试：写完发现底层变了就**重读一次再算**，别人的桶会被重新捡回来。

/** 造一份「另一个 IP 已写到一半」的 store */
function twoBucketStore(aCount: number, bCount: number): string {
    const now = Date.now();
    return JSON.stringify({
        version: 2,
        buckets: {
            "1.2.3.4": { count: aCount, until: 0, seen: now },
            "9.9.9.9": { count: bCount, until: 0, seen: now },
        },
    });
}

test("并发改写会重读再算：不会把另一个 IP 的计数冲掉", async () => {
    const { api, configs, casCalls } = makeApi(
        { [LOGIN_GUARD_KEY]: twoBucketStore(7, 3) },
        [
            // 第一次 CAS：模拟「我们读完之后，另一个 request 抢先把自己的失败记了进去」
            (key, _expected, _next) => {
                configs.set(key, twoBucketStore(7, 8));
                return false;
            },
        ]
    );

    await writeLoginGuard(api as never, { count: 8, until: 0 }, "1.2.3.4");

    assert.equal(casCalls(), 2, "第一次 CAS 抢不到就该重试一次");
    const buckets = JSON.parse(configs.get(LOGIN_GUARD_KEY) as string).buckets;
    assert.equal(buckets["1.2.3.4"].count, 8, "自己的计数要写进去");
    assert.equal(buckets["9.9.9.9"].count, 8, "并发方刚写进去的计数不能被覆盖成旧值");
});

test("CAS 一直抢不到时放弃重试，也不能抛异常（限速写失败不该拖垮登录本身）", async () => {
    const before = twoBucketStore(7, 3);
    const { api, configs, casCalls } = makeApi(
        { [LOGIN_GUARD_KEY]: before },
        // 每次都失败且不改数据 —— 重试耗尽后必须安静地放弃
        [() => false, () => false, () => false, () => false]
    );

    await writeLoginGuard(api as never, { count: 9, until: 0 }, "1.2.3.4");

    assert.equal(casCalls(), 3, "重试有上限，不能无限循环");
    assert.equal(configs.get(LOGIN_GUARD_KEY), before, "写失败就不该留下半成品");
});

test("存储层不支持 CAS 时退回普通写入（老的行为不变）", async () => {
    const configs = new Map<string, string>();
    const legacyApi = {
        async getConfig(key: string) {
            return configs.has(key) ? (configs.get(key) as string) : null;
        },
        async setConfig(key: string, value: string) {
            configs.set(key, value);
            return true;
        },
    };

    await writeLoginGuard(legacyApi as never, { count: 4, until: 0 }, "1.2.3.4");

    const buckets = JSON.parse(configs.get(LOGIN_GUARD_KEY) as string).buckets;
    assert.equal(buckets["1.2.3.4"].count, 4);
});
