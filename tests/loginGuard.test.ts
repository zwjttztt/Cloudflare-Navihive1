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

/** 只实现限速真正用到的两个读写字 */
function makeApi(initial?: Record<string, string>) {
    const configs = new Map<string, string>(Object.entries(initial || {}));
    return {
        configs,
        api: {
            async getConfig(key: string) {
                return configs.has(key) ? (configs.get(key) as string) : null;
            },
            async setConfig(key: string, value: string) {
                configs.set(key, value);
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
