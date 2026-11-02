// tests/endpointGuards.test.ts
// S10：配置写与 WebDAV 备份这两类端点原本一把锁都没有。
//
// 写操作那把锁只挂在 data 路由上，而这两类的成本结构与 CRUD 完全不同，
// 所以各自配了更严的阈值：配置 30 次/分钟、WebDAV 10 次/分钟。
//
// 这里盯三点：
//   1. 免罚额度内放行，超出后 429 且带 Retry-After
//   2. 两把锁各算各的，也跟写操作那把互不牵连（一个桶打爆不影响别的端点）
//   3. 计数记不上（D1 不可用）时放行 —— 不是「锁失效」，是真正的写入自己会失败

import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";
import { FakeBucketTable } from "./helpers/fakeBucketTable";
import {
    CONFIG_FREE_ATTEMPTS,
    DAV_FREE_ATTEMPTS,
    enforceConfigGuard,
    enforceDavGuard,
    endpointBucket,
} from "../worker/loginGuard";

// ---------------- 支持 CAS 的内存版 D1（与 limiter 测试同一套路） ----------------
//
// ⚠️ C1（schema 29）起，限速计数不再写在 configs 的 JSON 里，而是落在
// `rate_limit_bucket`（一桶一行）。所以这个桩必须同时认两套 SQL：
//   · configs 的读 / 插入 / CAS（老路径，本用例用它模拟「存储写不进去」）；
//   · 限速桶表的 upsert / CAS / 裁剪（`FakeBucketTable`，与 rateLimitBucket.test.ts 共用一份，
//     免得两处对「ON CONFLICT 该 +1 还是覆盖」各自理解不同）。
class MockD1 {
    configs = new Map<string, string>();
    /** 限速桶表（一桶一行） */
    buckets = new FakeBucketTable();
    /**
     * true = 整个存储层写不进去（模拟 D1 不可用）。
     *
     * 名字沿用 countAndSet 时代的 `casFail`：本文件最后那条用例要的是
     * 「计数记不上 → 放行」，而换了存储之后只让 configs 的 CAS 失败已经不足以
     * 表达这件事（桶表照样能写），所以它现在同时把桶表也置成不可用。
     */
    casFail = false;

    prepare(sql: string) {
        const self = this;
        const norm = sql.replace(/\s+/g, " ").trim();
        self.buckets.unavailable = self.casFail;
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => {
                const bucket = self.buckets.exec(norm, args);
                if (bucket) return bucket.rows[0] ?? null;
                if (/SELECT value FROM configs/.test(norm)) {
                    const v = self.configs.get(String(args[0]));
                    return v == null ? null : { value: v };
                }
                return null;
            },
            all: async () => {
                const bucket = self.buckets.exec(norm, args);
                if (bucket) return { results: bucket.rows, success: true };
                return { results: [], success: true };
            },
            run: async () => {
                const bucket = self.buckets.exec(norm, args);
                if (bucket) {
                    return { success: true, meta: { rows_written: bucket.rows.length } };
                }
                let written = 0;
                if (/INSERT INTO configs/.test(norm)) {
                    const k = String(args[0]);
                    if (!self.configs.has(k)) {
                        self.configs.set(k, String(args[1]));
                        written = 1;
                    }
                } else if (/UPDATE configs SET value/.test(norm)) {
                    // SET value=? WHERE key=? AND value=?
                    const [next, key, expected] = args as [string, string, string | null];
                    const cur = self.configs.has(key) ? self.configs.get(key) : null;
                    if (cur === expected && !self.casFail) {
                        self.configs.set(key, next);
                        written = 1;
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

const req = () => new Request("https://example.com/api/configs/batch", { method: "POST" });

test("桶名里带账号与来源 IP，两个来源互不牵连", () => {
    const a = endpointBucket(req(), 7, false);
    const b = endpointBucket(req(), 8, true);
    assert.notEqual(a, b, "不同账号要在不同桶里");
    assert.match(a, /^u7:/);
    assert.match(endpointBucket(req(), null), /^uanon:/, "未登录归到 anon 一档");
});

test("配置写：免罚额度内全放行，第 31 次起 429 且带 Retry-After", async () => {
    const { api } = newApi();
    const bucket = "cfg-bucket";
    for (let i = 0; i < CONFIG_FREE_ATTEMPTS; i++) {
        const r = await enforceConfigGuard(api, bucket);
        assert.equal(r, null, `第 ${i + 1} 次不该被拦`);
    }
    const limited = await enforceConfigGuard(api, bucket);
    assert.ok(limited, "超出额度要拦");
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("Retry-After"), "要告诉客户端等多久");
    assert.match(await limited.clone().text(), /配置修改过于频繁/);
});

test("WebDAV：阈值更严（10 次），且文案指向备份", async () => {
    const { api } = newApi();
    const bucket = "dav-bucket";
    for (let i = 0; i < DAV_FREE_ATTEMPTS; i++) {
        assert.equal(await enforceDavGuard(api, bucket), null, `第 ${i + 1} 次不该被拦`);
    }
    const limited = await enforceDavGuard(api, bucket);
    assert.ok(limited);
    assert.equal(limited.status, 429);
    assert.match(await limited.clone().text(), /备份操作过于频繁/);
});

test("两把锁各算各的：把 WebDAV 打爆不影响配置写入", async () => {
    const { api } = newApi();
    for (let i = 0; i < DAV_FREE_ATTEMPTS + 2; i++) await enforceDavGuard(api, "shared-bucket");
    const afterDav = await enforceDavGuard(api, "shared-bucket");
    assert.equal(afterDav?.status, 429, "WebDAV 应当已被锁");
    assert.equal(await enforceConfigGuard(api, "shared-bucket"), null, "配置写入不该被连带");
});

test("不同来源 IP 各自计数（一个人刷爆不挡住别人）", async () => {
    const { api } = newApi();
    for (let i = 0; i < CONFIG_FREE_ATTEMPTS + 2; i++) {
        await enforceConfigGuard(api, "u1:1.1.1.1");
    }
    assert.equal((await enforceConfigGuard(api, "u1:1.1.1.1"))?.status, 429);
    assert.equal(await enforceConfigGuard(api, "u1:2.2.2.2"), null, "换来源应当从头数");
});

test("计数记不上（D1 不可用）时放行：真正的写入自己会失败，不该在这里盖成 503", async () => {
    const { api, db } = newApi();
    db.casFail = true; // CAS 永远抢不到
    for (let i = 0; i < CONFIG_FREE_ATTEMPTS + 5; i++) {
        assert.equal(await enforceConfigGuard(api, "broken"), null, "记不上数就放行");
        assert.equal(await enforceDavGuard(api, "broken"), null);
    }
});
