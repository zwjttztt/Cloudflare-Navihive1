// tests/shareGuard.test.ts
// 分享口令的尝试次数限速（第七把锁）。
//
// 为什么需要：分享口令是全站**唯一**还能被反复试的密码入口 ——
// 登录 / 注册 / 找回 / 初始化四条公开路径都有限速，只有
// `/api/note-shares/<token>` 与 `/api/group-shares/<token>` 的 POST 裸奔。
// 而它的校验是 PBKDF2-SHA256（Workers 侧 10 万次迭代），所以这既是
// 「弱口令被爆破」的问题，也是一条**免费 CPU 放大器**的问题。
//
// 这里钉死三件事：
//   1) 桶的粒度是「来源 IP + 分享 token」—— 一个人狂试 A 的分享不该锁住
//      同一出口 IP 下别人对 B 分享的正常访问；
//   2) 阈值是「连续猜错 5 次，第 6 次开始锁」；
//   3) 存储故障时放行（记不上数不等于请求该失败，与其它五把锁一致）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bumpShareGuardFailure,
    clearShareGuard,
    readShareGuard,
    shareBucket,
    shareGuardLocked,
    writeShareGuard,
    SHARE_BASE_LOCK_MS,
    SHARE_FREE_ATTEMPTS,
    SHARE_GUARD_KEY,
} from "../worker/loginGuard";

/** 只实现限速真正用到的读写（含 CAS，与 loginGuard.test.ts 同一套 mock） */
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
            async compareAndSetConfig(key: string, expected: string | null, next: string) {
                const current = configs.has(key) ? (configs.get(key) as string) : null;
                if (current !== expected) return false;
                configs.set(key, next);
                return true;
            },
        },
    };
}

/** 造一个只带来源头的请求 */
function req(ip: string, xff?: string): Request {
    const headers: Record<string, string> = {};
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (xff) headers["X-Forwarded-For"] = xff;
    return new Request("https://example.com/api/note-shares/x", { headers });
}

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

test("分享口令的桶：同一 IP + 同一 token 落同一个桶", () => {
    const a = shareBucket(req("1.2.3.4"), TOKEN_A);
    const b = shareBucket(req("1.2.3.4"), TOKEN_A);
    assert.equal(a, b);
});

test("分享口令的桶：换 token 就是新桶（换一个分享要重新积累，挡不住横向扫但不会互相连坐）", () => {
    const a = shareBucket(req("1.2.3.4"), TOKEN_A);
    const b = shareBucket(req("1.2.3.4"), TOKEN_B);
    assert.notEqual(a, b, "不同分享必须分开计数");
});

test("分享口令的桶：换 IP 就是新桶（一个人的猜测不该锁住同网段的其他人）", () => {
    const a = shareBucket(req("1.2.3.4"), TOKEN_A);
    const b = shareBucket(req("9.9.9.9"), TOKEN_A);
    assert.notEqual(a, b, "不同来源必须分开计数");
});

test("分享口令的桶：默认不信任 X-Forwarded-For（否则换一个 XFF 就能换桶绕过）", () => {
    // ⚠️ 前提：clientBucket 里 CF-Connecting-IP **永远**优先 —— 平台注入、客户端伪造不了。
    // 所以只有「拿不到 CF 头」的部署（自托管）才轮到 XFF，而那正是可伪造的场景。
    const spoofed = shareBucket(req("", "8.8.8.8"), TOKEN_A);
    assert.equal(spoofed, shareBucket(req(""), TOKEN_A), "没开 TRUST_XFF 时 XFF 不该影响分桶");
    assert.ok(spoofed.startsWith("unknown"), "取不到真实 IP 时共用一个 unknown 桶（最多粒度变粗）");

    // 显式开了才认 XFF 首段
    const trusted = shareBucket(req("", "8.8.8.8, 10.0.0.1"), TOKEN_A, true);
    assert.ok(trusted.startsWith("8.8.8.8"), "开了 TRUST_XFF 之后取 XFF 首段");

    // 有 CF 头时 TRUST_XFF 也不该让 XFF 抢走分桶权
    const withCf = shareBucket(req("1.2.3.4", "8.8.8.8"), TOKEN_A, true);
    assert.equal(withCf, shareBucket(req("1.2.3.4"), TOKEN_A), "CF 头优先，XFF 不能覆盖它");
});

test("桶名里不出现完整 token（configs 表里不该留可用的凭据）", () => {
    const bucket = shareBucket(req("1.2.3.4"), TOKEN_A);
    assert.ok(!bucket.includes(TOKEN_A), "不能把完整的 64 位 token 写进桶名");
    assert.ok(bucket.includes(TOKEN_A.slice(0, 16)), "至少要带前 16 位用来区分");
});

test("没到阈值不锁：连续猜错 5 次都放行", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    for (let i = 1; i <= SHARE_FREE_ATTEMPTS; i++) {
        const limited = await bumpShareGuardFailure(api as never, bucket);
        assert.equal(limited, null, `第 ${i} 次猜错不该锁`);
    }
    assert.equal((await readShareGuard(api as never, bucket)).count, SHARE_FREE_ATTEMPTS);
});

test("第 6 次猜错开始锁：返回 429 且带 Retry-After", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    for (let i = 1; i <= SHARE_FREE_ATTEMPTS; i++) {
        await bumpShareGuardFailure(api as never, bucket);
    }
    const limited = await bumpShareGuardFailure(api as never, bucket);
    assert.ok(limited, "超过阈值必须锁");
    assert.equal(limited!.status, 429);
    const retryAfter = Number(limited!.headers.get("Retry-After"));
    assert.ok(retryAfter >= 1, "必须给出可读的等待秒数");
});

test("锁定期内 shareGuardLocked 直接拦下（连PBKDF2都不该跑）", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    const until = Date.now() + SHARE_BASE_LOCK_MS;

    // 前提：未锁时放行
    assert.equal(await shareGuardLocked(api as never, bucket), null);

    await writeShareGuard(api as never, { count: 9, until }, bucket);
    const locked = await shareGuardLocked(api as never, bucket);
    assert.ok(locked, "锁定期内必须返回响应");
    assert.equal(locked!.status, 429);
    assert.ok(Number(locked!.headers.get("Retry-After")) >= 1);
});

test("锁过期后自动放行", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:sexpired";
    await writeShareGuard(api as never, { count: 99, until: Date.now() - 1_000 }, bucket);
    assert.equal(await shareGuardLocked(api as never, bucket), null, "锁过期就该放行");
});

test("已锁状态下继续猜错不会把锁越滚越长", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    const until = Date.now() + SHARE_BASE_LOCK_MS;
    await writeShareGuard(api as never, { count: 6, until }, bucket);

    await bumpShareGuardFailure(api as never, bucket);
    await bumpShareGuardFailure(api as never, bucket);

    const after = await readShareGuard(api as never, bucket);
    assert.equal(after.until, until, "锁定期内的失败只该刷新 seen，不该延长 until");
});

test("口令对了就清零", async () => {
    const { api } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    await bumpShareGuardFailure(api as never, bucket);
    await bumpShareGuardFailure(api as never, bucket);
    assert.equal((await readShareGuard(api as never, bucket)).count, 2);

    await clearShareGuard(api as never, bucket);
    const cleared = await readShareGuard(api as never, bucket);
    assert.equal(cleared.count, 0);
    assert.equal(cleared.until, 0);
});

test("不同分享的计数互不影响（A 被锁，B 还能正常访问）", async () => {
    const { api } = makeApi();
    const bucketA = shareBucket(req("1.2.3.4"), TOKEN_A);
    const bucketB = shareBucket(req("1.2.3.4"), TOKEN_B);

    for (let i = 0; i <= SHARE_FREE_ATTEMPTS; i++) {
        await bumpShareGuardFailure(api as never, bucketA);
    }
    assert.ok(await shareGuardLocked(api as never, bucketA), "A 该锁上");
    assert.equal(await shareGuardLocked(api as never, bucketB), null, "B 不该被连坐");
});

test("存储故障时放行（记不上数不等于请求该失败）", async () => {
    const broken = {
        async getConfig(): Promise<string | null> {
            throw new Error("db unavailable");
        },
        async setConfig(): Promise<boolean> {
            throw new Error("db unavailable");
        },
    };
    assert.equal(await bumpShareGuardFailure(broken as never, "x"), null);
    assert.equal(await shareGuardLocked(broken as never, "x"), null);
});

test("分享限速与登录 / 写操作各记各的：互不串台", async () => {
    const { api, configs } = makeApi();
    const bucket = "1.2.3.4:s" + TOKEN_A.slice(0, 16);
    await bumpShareGuardFailure(api as never, bucket);

    // 只有 shareGuard 那条配置被写
    assert.ok(configs.has(SHARE_GUARD_KEY));
    const store = JSON.parse(configs.get(SHARE_GUARD_KEY) as string) as {
        buckets: Record<string, { count: number }>;
    };
    assert.equal(store.buckets[bucket].count, 1);
    assert.equal(Object.keys(store.buckets).length, 1, "不该把别的锁的桶写进来");
});
