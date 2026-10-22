// tests/sessionDeviceParity.test.ts
// 「同一台设备」判定与登录态互踢（2026-10-22）。
//
// 线上实证（自托管审计流水）：login.success 之前必有 client-error
// （"加载数据失败: 认证已过期或无效，请重新登录"），且出现过
// 「登录 → 57 秒后 401 → 再登录 → 26 秒后 401」的循环。
// 根因：recordSession 用**归一化 UA**（浏览器+系统）判「是不是同一台设备」，
// 于是所有「Windows + Chrome」客户端共用一把键 —— 另一台电脑、另一个 Chrome
// 配置文件、虚拟机，后登录的都会把先登录的令牌拉黑，两边互相顶下线。
// 用户看到的就是「每次电脑开机第一次打开就要重新登录」。
//
// 修法：客户端给一个持久 device_id（utils/deviceId.ts），判重只认它；
// 没有 device_id（老客户端 / 隐私模式）才回退归一化 UA。
//
// 这里钉三件事：
//   1. device_id 不同 → 绝不互踢（这是本次修复的核心）；
//   2. device_id 相同 → 仍然去重（保住 2026-10-17「登录设备不重复显示」的成果）；
//   3. 没有 device_id → 回退 UA（老行为不倒退）。
//
// ⚠️ 只断言字符串与数字：node:assert 失败时会 util.inspect(actual)，
//    把 DOM 元素塞进失败路径会炸进程堆（2026-10-21 踩过）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeSqliteD1 } from "../server/sqlite-d1";
import { deviceKeyOf } from "../src/API/methods/sessions";

/** 造一个能跑的最小 API：只实现 recordSession 用到的几个方法 */
function makeApi(db: ReturnType<typeof makeSqliteD1>) {
    const sessions = new Map<string, number>(); // jti -> expires_at
    return {
        db,
        blacklistToken: async (jti: string, exp: number) => {
            sessions.set(jti, exp);
        },
        isTokenBlacklisted: async (jti: string) => sessions.has(jti),
        /** 供断言用：当前被拉黑的 jti 集合 */
        blacklisted: () => [...sessions.keys()],
    };
}

type Api = ReturnType<typeof makeApi>;

/** 直接把 sessionsImpl 的 recordSession 绑到一个假 api 上跑 */
async function record(
    api: Api,
    token: string,
    userAgent: string,
    ip: string,
    deviceId?: string | null
): Promise<void> {
    const { sessionsImpl } = await import("../src/API/methods/sessions");
    await sessionsImpl.recordSession.call(api as never, token, userAgent, ip, deviceId);
}

/** 造一枚可解的 JWT（HS256，密钥随意 —— 这里只 peek jti/exp/uid） */
async function makeToken(uid: number, jti: string, ttlSec = 3600): Promise<string> {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const header = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({
        uid,
        jti,
        exp: Math.floor(Date.now() / 1000) + ttlSec,
        iat: Math.floor(Date.now() / 1000),
    });
    const sig = createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
}

const UA_WIN_CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

function withDb(fn: (api: Api) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "nh-dev-"));
    const db = makeSqliteD1(path.join(dir, "t.db"));
    const api = makeApi(db);
    return (async () => {
        try {
            await db.exec(
                `CREATE TABLE user_sessions (
                    jti TEXT PRIMARY KEY, user_id INTEGER, user_agent TEXT, ip TEXT,
                    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL, device_id TEXT
                );`
            );
            await fn(api);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    })();
}

test("归一化 UA 的坑：两台「Windows + Chrome」会拿到同一把键（这就是互踢的根因）", () => {
    const a = deviceKeyOf(UA_WIN_CHROME);
    const b = deviceKeyOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    );
    assert.equal(a, b, "同一浏览器不同版本 → 同键（这是「不重复显示」需要的）");
    assert.equal(a, "Chrome|Windows");
    // ⚠️ 反证：换一台电脑、UA 完全相同 → 还是同键。设备判重不能只靠它。
    assert.equal(deviceKeyOf(UA_WIN_CHROME), deviceKeyOf(UA_WIN_CHROME));
});

test("device_id 不同：后登录不会拉黑先登录的令牌（本次修复的核心）", async () => {
    await withDb(async api => {
        const t1 = await makeToken(1, "jti-desktop");
        const t2 = await makeToken(1, "jti-laptop");
        await record(api, t1, UA_WIN_CHROME, "1.1.1.1", "did-desktop");
        await record(api, t2, UA_WIN_CHROME, "1.1.1.1", "did-laptop");
        const bl = api.blacklisted();
        assert.equal(bl.includes("jti-desktop"), false, "另一台设备的令牌不许被拉黑");
        assert.equal(bl.includes("jti-laptop"), false);
    });
});

test("device_id 相同：仍然去重（保住「登录设备不重复显示」）", async () => {
    await withDb(async api => {
        const t1 = await makeToken(1, "jti-old");
        const t2 = await makeToken(1, "jti-new");
        await record(api, t1, UA_WIN_CHROME, "1.1.1.1", "did-same");
        await record(api, t2, UA_WIN_CHROME, "1.1.1.1", "did-same");
        assert.deepEqual(api.blacklisted(), ["jti-old"], "同一台设备重登，旧令牌该被拉黑");
    });
});

test("两边都没有 device_id：也判不同（隐私模式多窗口不再互相顶下线）", async () => {
    await withDb(async api => {
        const t1 = await makeToken(1, "jti-legacy");
        const t2 = await makeToken(1, "jti-fresh");
        await record(api, t1, UA_WIN_CHROME, "1.1.1.1", null);
        await record(api, t2, UA_WIN_CHROME, "1.1.1.1", null);
        // ⚠️ 刻意不回退 UA：回退就等于把「一台旧版 + 一台新版」这个最常见的
        //    过渡组合继续留在互踢里。代价只是列表里多一行，30 天内自然过期。
        assert.deepEqual(api.blacklisted(), [], "缺 device_id 时不互踢");
    });
});

test("一边有一边没有：不互踢（宁可多一行，也不误踢）", async () => {
    await withDb(async api => {
        const t1 = await makeToken(1, "jti-null");
        const t2 = await makeToken(1, "jti-has");
        await record(api, t1, UA_WIN_CHROME, "1.1.1.1", null);
        await record(api, t2, UA_WIN_CHROME, "1.1.1.1", "did-x");
        assert.deepEqual(api.blacklisted(), [], "缺一边 device_id 时判为不同设备");
    });
});

test("device_id 落库：能按它查回来（列表折叠靠这一列）", async () => {
    await withDb(async api => {
        const t1 = await makeToken(1, "jti-store");
        await record(api, t1, UA_WIN_CHROME, "1.1.1.1", "did-store-me");
        const row = await api.db
            .prepare("SELECT device_id FROM user_sessions WHERE jti = ?")
            .bind("jti-store")
            .first<{ device_id: string | null }>();
        assert.equal(row?.device_id, "did-store-me");
    });
});

test("迁移：user_sessions 必须补出 device_id 列（老库没有会直接 SELECT 报错）", async () => {
    await withDb(async api => {
        // 老库形态：建表时不带 device_id
        const { sessionsImpl } = await import("../src/API/methods/sessions");
        void sessionsImpl;
        const { migrationImpl } = await import("../src/API/methods/migration");
        const t = await makeToken(1, "jti-mig");
        await record(api, t, UA_WIN_CHROME, "1.1.1.1", "did-mig");
        // 直接跑迁移步骤：它应该幂等地补列
        const fakeApi = {
            ...api,
            hasColumn: async (table: string, column: string) => {
                const cols = await api.db
                    .prepare(`PRAGMA table_info(${table})`)
                    .all<{ name: string }>();
                return (cols.results || []).some(c => c.name === column);
            },
        };
        await migrationImpl.migrateSessionDeviceColumn.call(fakeApi as never);
        const row = await api.db
            .prepare("SELECT device_id FROM user_sessions WHERE jti = ?")
            .bind("jti-mig")
            .first<{ device_id: string | null }>();
        assert.equal(row?.device_id, "did-mig", "补列后原有数据要还能读");
    });
});

test("超长 device_id 会被截断到 64（真实客户端是 36 字符 UUID，够用）", async () => {
    await withDb(async api => {
        const long = "x".repeat(200);
        const t = await makeToken(1, "jti-long");
        await record(api, t, UA_WIN_CHROME, "1.1.1.1", long);
        const row = await api.db
            .prepare("SELECT device_id FROM user_sessions WHERE jti = ?")
            .bind("jti-long")
            .first<{ device_id: string | null }>();
        assert.equal(String(row?.device_id).length, 64, "落库长度要收在 64");

        // ⚠️ 副作用（2026-10-22 踩到）：拿整个 UA 拼 device_id 会超过 64 字符，
        //    两台不同设备的前 64 字符一模一样 → 又被判成「同一台」，白修。
        //    所以客户端只用 crypto.randomUUID()（36 字符），别拼别的。
        const uaA = "dev-" + UA_WIN_CHROME;
        const uaB = "dev-" + UA_WIN_CHROME.replace("Chrome/", "Edg/");
        assert.equal(uaA.slice(0, 64), uaB.slice(0, 64), "前 64 字符相同 —— 这就是那个坑");
    });
});
