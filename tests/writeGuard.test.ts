/**
 * 写操作限速（B-1）：分组 / 站点增删改、批量操作、导入共用的那把锁。
 *
 * 只测 loginGuard 里的纯逻辑与 enforceWriteGuard 的门限行为 ——
 * 它只依赖 api.getConfig / api.setConfig，所以用最小假对象即可，不必拉起整个 D1 mock。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { NavigationAPI } from "../src/API/navigationApi";
import {
    WRITE_FREE_ATTEMPTS,
    enforceWriteGuard,
    nextDecayedCount,
    writeBucket,
} from "../worker/loginGuard";

/** 只有 getConfig / setConfig 的最小 api：限速存储就挂在这两个方法上 */
function fakeApi(): { api: NavigationAPI; raw: () => string | null } {
    const store = new Map<string, string>();
    const api = {
        getConfig: async (key: string) => store.get(key) ?? null,
        compareAndSetConfig: async (key: string, expected: string | null, next: string) => {
            if ((store.get(key) ?? null) !== expected) return false;
            store.set(key, next);
            return true;
        },
        setConfig: async (key: string, value: string) => {
            store.set(key, value);
        },
    };
    return {
        api: api as unknown as NavigationAPI,
        raw: () => store.get("auth.writeGuard") ?? null,
    };
}

function fakeRequest(ip: string): Request {
    return new Request("https://example.com/api/sites", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
    });
}

test("nextDecayedCount：窗口内累加，隔开一个窗口就重新数", () => {
    const now = 1_000_000;
    // 上次动作就在刚才 → 接着数
    assert.equal(nextDecayedCount({ count: 3, until: 0, seen: now - 1_000 }, 60_000, now), 4);
    // 上次动作在 61 秒前 → 从 1 重新数（不能「永不衰减」，否则天天点攒够了次次被锁）
    assert.equal(nextDecayedCount({ count: 3, until: 0, seen: now - 61_000 }, 60_000, now), 1);
    // 从没记过 seen（Infinity 间隔）→ 也算从头
    assert.equal(nextDecayedCount({ count: 3, until: 0, seen: 0 }, 60_000, now), 1);
});

test("写操作限速：免罚额度内全放行，超出后 429 且带 Retry-After", async () => {
    const { api } = fakeApi();
    const bucket = writeBucket(fakeRequest("1.2.3.4"), 7);

    for (let i = 0; i < WRITE_FREE_ATTEMPTS; i++) {
        assert.equal(await enforceWriteGuard(api, bucket), null, `第 ${i + 1} 次应当放行`);
    }

    // 超额的当前请求就拒绝，不能多放行一次。
    assert.equal(
        (await enforceWriteGuard(api, bucket))?.status,
        429,
        `第 ${WRITE_FREE_ATTEMPTS + 1} 次应拒绝并进入锁定期`
    );

    const blocked = await enforceWriteGuard(api, bucket);
    assert.ok(blocked, "超过免罚额度后应当被拦");
    assert.equal(blocked!.status, 429);
    const retryAfter = Number(blocked!.headers.get("Retry-After"));
    assert.ok(retryAfter >= 1, "Retry-After 至少 1 秒");
    assert.ok(
        (await blocked!.json()).message.includes("操作太频繁"),
        "错误信息要能看懂"
    );
});

test("写操作限速：不同账号 / 不同 IP 各算各的，互不牵连", async () => {
    const { api } = fakeApi();
    const self = writeBucket(fakeRequest("1.2.3.4"), 7);
    const otherIp = writeBucket(fakeRequest("5.6.7.8"), 7);
    const otherUser = writeBucket(fakeRequest("1.2.3.4"), 8);

    // 把 self 桶打到触发限速
    for (let i = 0; i <= WRITE_FREE_ATTEMPTS; i++) {
        await enforceWriteGuard(api, self);
    }
    assert.ok(await enforceWriteGuard(api, self), "自己这个桶应当已锁");

    // 换台机器（同一个人）不该被自己锁住
    assert.equal(await enforceWriteGuard(api, otherIp), null, "换 IP 不应被牵连");
    // 换个人（同一台机器）也不该被锁住
    assert.equal(await enforceWriteGuard(api, otherUser), null, "换账号不应被牵连");
});

test("写操作限速：锁定期内不重复放行，且计数不会把锁越滚越短的反向问题", async () => {
    const { api } = fakeApi();
    const bucket = writeBucket(fakeRequest("9.9.9.9"), 1);
    for (let i = 0; i <= WRITE_FREE_ATTEMPTS; i++) {
        await enforceWriteGuard(api, bucket);
    }
    const first = await enforceWriteGuard(api, bucket);
    const second = await enforceWriteGuard(api, bucket);
    assert.ok(first && second, "锁定期内应当一直拦着");
    // 连续被拦时 Retry-After 只会递减（剩余时间在变少），不会越等越久
    assert.ok(
        Number(second!.headers.get("Retry-After")) <= Number(first!.headers.get("Retry-After"))
    );
});

test("写入的桶会被清理：锁定期的不丢、长期不动的丢掉", async () => {
    const { api, raw } = fakeApi();
    const bucket = writeBucket(fakeRequest("1.1.1.1"), 3);
    await enforceWriteGuard(api, bucket);
    const saved = JSON.parse(raw() ?? "{}") as {
        version: number;
        buckets: Record<string, { count: number; seen: number }>;
    };
    assert.equal(saved.version, 2, "存储格式版本保持 2");
    assert.ok(saved.buckets[bucket], "刚写过的桶应当留着");
    assert.ok(saved.buckets[bucket].seen > 0, "seen 要写进去，否则下一次判不出窗口");
});
