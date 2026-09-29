// tests/exportGuard.test.ts
// /api/export 的限速。
//
// 导出一次就把整站数据（含解密后的站点密码）打包带走，是「拿到会话之后收益最大」
// 的接口。这里要钉死两件事：短时间连着拉会被拦；正常「一天备份一次」的人
// 不能被越锁越久 —— 后者比前者更容易被做错（计数只增不减就是这么来的）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EXPORT_BASE_LOCK_MS,
    EXPORT_COUNT_RESET_MS,
    EXPORT_FREE_ATTEMPTS,
    EXPORT_GUARD_KEY,
    EXPORT_MAX_LOCK_MS,
    computeLockAfterFailure,
    nextExportCount,
    readExportGuard,
    writeExportGuard,
} from "../worker/loginGuard";
import type { NavigationAPI } from "../src/API/http";

/** 只用到了 getConfig / setConfig 两个方法的假 API */
function makeApi() {
    const store = new Map<string, string>();
    return {
        store,
        async getConfig(key: string) {
            return store.get(key) ?? null;
        },
        async setConfig(key: string, value: string) {
            store.set(key, value);
            return true;
        },
    } as unknown as NavigationAPI & { store: Map<string, string> };
}

/** 复刻 worker/index.ts 里导出路由的那段限速判断 */
async function tryExport(api: NavigationAPI, bucket: string, now = Date.now()) {
    const guard = await readExportGuard(api, bucket);
    if (guard.until > now) {
        return { allowed: false, waitSec: Math.ceil((guard.until - now) / 1000) };
    }
    const count = nextExportCount(guard, now);
    const lockMs = computeLockAfterFailure(
        count,
        EXPORT_FREE_ATTEMPTS,
        EXPORT_BASE_LOCK_MS,
        EXPORT_MAX_LOCK_MS
    );
    if (lockMs > 0) {
        // 超额：只记锁定时刻，不再往上加计数
        await writeExportGuard(api, { count: guard.count, until: now + lockMs }, bucket);
        return { allowed: false, waitSec: Math.ceil(lockMs / 1000) };
    }
    await writeExportGuard(api, { count, until: 0 }, bucket);
    return { allowed: true, count };
}

test("短时间内连着导出：前 10 次放行，第 11 次被拦", async () => {
    const api = makeApi();
    let blockedAt = 0;
    for (let i = 1; i <= 12; i++) {
        const result = await tryExport(api, "u1:1.2.3.4");
        if (!result.allowed && blockedAt === 0) blockedAt = i;
    }
    assert.equal(blockedAt, EXPORT_FREE_ATTEMPTS + 1, "第 11 次开始拦");
});

test("被拦期间再点：还是拦着，且等待时间在往下走", async () => {
    const api = makeApi();
    for (let i = 0; i < EXPORT_FREE_ATTEMPTS + 1; i++) {
        await tryExport(api, "u1:1.2.3.4");
    }
    const first = await tryExport(api, "u1:1.2.3.4");
    assert.equal(first.allowed, false);

    const later = await tryExport(api, "u1:1.2.3.4", Date.now() + 60_000);
    assert.equal(later.allowed, false);
    assert.ok((later as { waitSec: number }).waitSec < (first as { waitSec: number }).waitSec);
});

test("换账号 / 换出口 IP：各算各的，不互相牵连", async () => {
    const api = makeApi();
    for (let i = 0; i < EXPORT_FREE_ATTEMPTS + 1; i++) {
        await tryExport(api, "u1:1.2.3.4");
    }
    assert.equal((await tryExport(api, "u1:1.2.3.4")).allowed, false);

    // 另一个账号、另一台机器从头开始
    assert.equal((await tryExport(api, "u2:1.2.3.4")).allowed, true);
    assert.equal((await tryExport(api, "u1:5.6.7.8")).allowed, true);
});

test("计数会衰减：隔开一小时以上就从头数，正常备份不会被越锁越久", () => {
    const now = Date.now();
    // 昨天已经攒到 10 次
    assert.equal(nextExportCount({ count: 10, until: 0, seen: now - 25 * 60 * 60 * 1000 }, now), 1);
    // 一小时零一分钟前：也该重置
    assert.equal(
        nextExportCount({ count: 10, until: 0, seen: now - EXPORT_COUNT_RESET_MS - 60_000 }, now),
        1
    );
    // 一分钟内还在连着拉：累加
    assert.equal(nextExportCount({ count: 10, until: 0, seen: now - 60_000 }, now), 11);
    // 从来没导出过
    assert.equal(nextExportCount({ count: 0, until: 0, seen: 0 }, now), 1);
});

test("读不出的存储（坏 JSON / 空）：按「没限制」处理，不挡人", async () => {
    const api = makeApi();
    api.store.set(EXPORT_GUARD_KEY, "{ 这不是 JSON");
    assert.deepEqual(await readExportGuard(api, "u1:1.2.3.4"), { count: 0, until: 0, seen: 0 });
    assert.equal((await tryExport(api, "u1:1.2.3.4")).allowed, true);
});

test("存下来的结构带版本号，桶按名字分开", async () => {
    const api = makeApi();
    await tryExport(api, "u1:1.2.3.4");
    await tryExport(api, "u1:9.9.9.9");

    const parsed = JSON.parse(api.store.get(EXPORT_GUARD_KEY) as string);
    assert.equal(parsed.version, 2);
    assert.deepEqual(Object.keys(parsed.buckets).sort(), ["u1:1.2.3.4", "u1:9.9.9.9"]);
});
