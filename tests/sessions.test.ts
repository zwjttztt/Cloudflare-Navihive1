// tests/sessions.test.ts
// 「登录设备 / 踢下线」的回归测试。钉死几条最容易写错的规则：
//   1. 登记：登录签发的令牌会按 jti 落一行，能按账号列出来；
//   2. 隔离：A 账号列不到 B 账号的设备；
//   3. 吊销 = 拉黑 + 删行：**只删行等于没吊销**（JWT 自包含，令牌照样能用到过期）；
//   4. 归属：猜到别人的 jti 也踢不掉（WHERE 里带 user_id）；
//   5. 「退出其它设备」保留当前这台；
//   6. 同设备去重（2026-10-17 用户报「登录设备重复显示」）：一台设备只留一行 ——
//      浏览器版本升级（UA 变）、IP 漂移（双栈 / 重拨）都不能把它裂成两行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";
import { peekJwtClaim } from "../src/API/crypto";
import { deviceKeyOf } from "../src/API/methods/sessions";

type Row = Record<string, unknown>;

/**
 * 只实现 sessions 域用得到的那几条 SQL，其余一律「成功但没影响任何行」。
 * 不复用 hardening-items 里那个 InMemoryD1：那份按表名攒了一堆字段，
 * 而这里只关心会话与黑名单两张表，单独写一份更短也更好读。
 */
class SessionsD1 {
    sessions: Row[] = [];
    blacklist: Row[] = [];

    prepare(sql: string) {
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => this.read(sql, args, "first"),
            all: async () => ({ results: this.read(sql, args, "all"), success: true }),
            run: async () => this.write(sql, args),
        });
        return make([]);
    }

    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        for (const s of stmts) await s.run();
        return { results: [], success: true };
    }

    async exec() {
        return { success: true };
    }

    private read(sql: string, args: unknown[], mode: "first" | "all"): unknown {
        if (/FROM user_sessions\s+WHERE user_id = \? AND expires_at > \?/.test(sql)) {
            const [uid, now] = args as [number, number];
            const rows = this.sessions
                .filter(r => r.user_id === uid && (r.expires_at as number) > now)
                .sort((a, b) => (b.last_seen_at as number) - (a.last_seen_at as number));
            return mode === "first" ? (rows[0] ?? null) : rows;
        }
        // recordSession 的同设备去重：按 user_id 拉全部行。
        // ⚠️ 匹配只看「表 + 条件」，不钉列名 —— 2026-10-22 起这条 SQL 多了
        //    device_id（判「同一台设备」只认它），钉列名会让替身匹配不上、
        //    于是「同设备去重」在测试里静默失效（返回空数组 = 没有旧会话）。
        if (/FROM user_sessions\s+WHERE user_id = \? AND jti != \?/.test(sql)) {
            const [uid, keep] = args as [number, string];
            return this.sessions
                .filter(r => r.user_id === uid && r.jti !== keep)
                .map(r => ({
                    jti: r.jti,
                    expires_at: r.expires_at,
                    user_agent: r.user_agent,
                    device_id: r.device_id ?? null,
                }));
        }
        if (/SELECT jti, expires_at FROM user_sessions WHERE jti = \? AND user_id = \?/.test(sql)) {
            const [jti, uid] = args as [string, number];
            const row = this.sessions.find(r => r.jti === jti && r.user_id === uid);
            return row ? { jti: row.jti, expires_at: row.expires_at } : null;
        }
        if (/SELECT jti, expires_at FROM user_sessions WHERE user_id = \? AND jti != \?/.test(sql)) {
            const [uid, keep] = args as [number, string];
            return this.sessions
                .filter(r => r.user_id === uid && r.jti !== keep)
                .map(r => ({ jti: r.jti, expires_at: r.expires_at }));
        }
        // token_version / 其它查询一律当作「没有」：走默认分支即可
        return mode === "first" ? null : [];
    }

    private write(sql: string, args: unknown[]) {
        let changes = 0;

        if (/INSERT INTO user_sessions/.test(sql)) {
            // 参数顺序与实现一致：jti, user_id, user_agent, ip, created_at,
            // last_seen_at, expires_at, device_id（2026-10-22 起多一个）
            const [jti, uid, ua, ip, createdAt, lastSeenAt, expiresAt, deviceId] = args as unknown[];
            const existing = this.sessions.find(r => r.jti === jti);
            if (existing) {
                // ON CONFLICT DO UPDATE SET last_seen_at = ?, expires_at = ?（第 8、9 个参数）
                existing.last_seen_at = args[7];
                existing.expires_at = args[8];
                // device_id 用 COALESCE(excluded, 原值)：老行补登时不丢
                if (deviceId) existing.device_id = deviceId;
            } else {
                this.sessions.push({
                    jti,
                    user_id: uid,
                    user_agent: ua,
                    ip,
                    created_at: createdAt,
                    last_seen_at: lastSeenAt,
                    expires_at: expiresAt,
                    device_id: deviceId ?? null,
                });
            }
            changes = 1;
        } else if (/UPDATE user_sessions SET last_seen_at/.test(sql)) {
            // 限频写在 SQL 里：只有 last_seen_at 早于阈值才更新
            const [now, jti, staleBefore] = args as [number, string, number];
            const row = this.sessions.find(
                r => r.jti === jti && (r.last_seen_at as number) < staleBefore
            );
            if (row) {
                row.last_seen_at = now;
                changes = 1;
            }
        } else if (/INSERT INTO token_blacklist/.test(sql)) {
            const [jti, exp] = args as [string, number];
            if (!this.blacklist.find(r => r.jti === jti)) this.blacklist.push({ jti, exp });
            changes = 1;
        } else if (/DELETE FROM user_sessions WHERE jti = \?/.test(sql)) {
            const [jti] = args as [string];
            const i = this.sessions.findIndex(r => r.jti === jti);
            if (i >= 0) {
                this.sessions.splice(i, 1);
                changes = 1;
            }
        } else if (/DELETE FROM user_sessions WHERE user_id = \? AND jti != \?/.test(sql)) {
            const [uid, keep] = args as [number, string];
            const before = this.sessions.length;
            this.sessions = this.sessions.filter(r => !(r.user_id === uid && r.jti !== keep));
            changes = before - this.sessions.length;
        } else if (/DELETE FROM user_sessions\s+WHERE user_id = \? AND jti IN \(/.test(sql)) {
            // 同设备去重的删行：bind 是 (uid, ...jtis)
            const [uid, ...jtis] = args as [number, ...string[]];
            const before = this.sessions.length;
            this.sessions = this.sessions.filter(
                r => !(r.user_id === uid && jtis.includes(r.jti as string))
            );
            changes = before - this.sessions.length;
        }

        return { success: true, meta: { changes } };
    }
}

function newApi(db: SessionsD1): NavigationAPI {
    return new NavigationAPI({
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-sessions",
        AUTH_USERNAME: "",
        AUTH_PASSWORD: "",
    } as unknown as ConstructorParameters<typeof NavigationAPI>[0]);
}

/**
 * 签一张令牌并登记成会话，返回它的 jti。
 *
 * @param deviceId 客户端持久设备 ID。**同一台设备重登要传同一个值** ——
 *   2026-10-22 起「是不是同一台设备」只认它（归一化 UA 会把另一台
 *   Windows+Chrome 误判成同一台，导致互踢下线，见 sameDevice 注释）。
 *   默认按 uid + ua 派生，让老用例「同一台设备重登」的语义保持不变。
 */
async function loginDevice(
    api: NavigationAPI,
    uid: number,
    ua: string,
    ip: string,
    // ⚠️ 必须短：服务端会把 device_id 截断到 64 字符（防止有人塞几 KB），
    //    拿整条 UA 拼的话两台不同设备的前 64 字符完全一样 → 被判成同一台。
    //    真实客户端是 crypto.randomUUID()，36 字符。
    deviceId: string | null = `dev-${uid}-${deviceKeyOf(ua)}`
) {
    const token = await api.generateToken({ username: `u${uid}`, uid }, 3600);
    await api.recordSession(token, ua, ip, deviceId);
    return { token, jti: peekJwtClaim(token, "jti") as string };
}

test("会话：登录后按 jti 登记一行，能按账号列出来并标出当前设备", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const { jti } = await loginDevice(api, 7, "Mozilla/5.0 (Windows NT 10.0) Chrome/120", "1.2.3.4");

    const list = await api.listSessions(7, jti);
    assert.equal(list.length, 1, "登录过一次就有一台设备");
    assert.equal(list[0].jti, jti);
    assert.equal(list[0].current, true, "传入的 jti 会被标成当前设备");
    assert.match(list[0].userAgent, /Windows/, "UA 原样存下来，界面上再解析成可读名字");
    assert.equal(list[0].ip, "1.2.3.4");
});

test("会话：别的账号列不到这台设备（按 user_id 隔离）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    await loginDevice(api, 7, "Chrome", "1.1.1.1");
    await loginDevice(api, 8, "Firefox", "2.2.2.2");

    assert.equal((await api.listSessions(7, "")).length, 1, "7 号只看到自己那一台");
    assert.equal((await api.listSessions(8, "")).length, 1, "8 号只看到自己那一台");
    assert.equal((await api.listSessions(9, "")).length, 0, "没登过的账号没有设备");
});

test("会话：已过期的会话不再列出（列出来只会让人以为还能踢）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    await loginDevice(api, 7, "Chrome", "1.1.1.1");
    // 把 expires_at 推到过去
    db.sessions[0].expires_at = Math.floor(Date.now() / 1000) - 10;

    assert.equal((await api.listSessions(7, "")).length, 0, "过期会话不该出现在设备列表里");
});

test("会话：吊销 = 拉黑 + 删行 —— 只删行等于没吊销（令牌照样能用）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const { jti } = await loginDevice(api, 7, "Chrome", "1.1.1.1");

    const result = await api.revokeSession(7, jti);
    assert.equal(result.success, true, "吊销自己的设备应当成功");
    assert.equal(db.sessions.length, 0, "列表里要消失");
    assert.ok(
        db.blacklist.some(r => r.jti === jti),
        "关键：必须同时拉黑，否则那张令牌在过期前仍能通过验签"
    );
});

test("会话：猜到别人的 jti 也踢不掉（WHERE 带 user_id）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const { jti } = await loginDevice(api, 7, "Chrome", "1.1.1.1");

    const result = await api.revokeSession(8, jti);
    assert.equal(result.success, false, "不是自己的会话不能吊销");
    assert.equal(db.sessions.length, 1, "别人的设备不受影响");
    assert.equal(db.blacklist.length, 0, "也没被拉黑");
});

test("会话：退出其它设备时保留当前这台，并报出吊销了几台", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const current = await loginDevice(api, 7, "Chrome", "1.1.1.1");
    const other1 = await loginDevice(api, 7, "Firefox", "2.2.2.2");
    const other2 = await loginDevice(api, 7, "Safari", "3.3.3.3");

    const result = await api.revokeOtherSessions(7, current.jti);
    assert.equal(result.success, true);
    assert.equal(result.revoked, 2, "吊销了另外两台");
    assert.equal(db.sessions.length, 1, "只剩当前这台");
    assert.equal(db.sessions[0].jti, current.jti, "留下的必须是当前设备");
    for (const jti of [other1.jti, other2.jti]) {
        assert.ok(db.blacklist.some(r => r.jti === jti), "被踢的每台都要拉黑");
    }
    assert.ok(
        !db.blacklist.some(r => r.jti === current.jti),
        "当前这台不能把自己也拉黑了"
    );
});

test("会话：touchSession 限频 —— 一小时内的重复刷新不写库", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const { jti } = await loginDevice(api, 7, "Chrome", "1.1.1.1");
    const before = db.sessions[0].last_seen_at as number;

    await api.touchSession(jti);
    assert.equal(db.sessions[0].last_seen_at, before, "刚登记过，1 小时内不重复写");

    // 把 last_seen_at 推回 2 小时前，这次就该刷新了
    db.sessions[0].last_seen_at = before - 2 * 3600;
    await api.touchSession(jti);
    assert.notEqual(db.sessions[0].last_seen_at, before - 2 * 3600, "超过限频窗口才会更新");
});

// ---------------- 同设备去重（2026-10-17） ----------------
// 用户两次报「登录设备列表有重复」。根因：v2.0.0 按「UA + IP」判重，而
//   - Chrome 大版本升级 UA 就变（141 → 142），IP 没变也不算同一行；
//   - 家庭宽带 IPv4/IPv6 双栈、重拨换 IP，UA 没变也不算同一行。
// 两种漂移任意撞一个，列表里就多出一行看着一模一样的「Chrome · Windows」。
// 判据改成归一化设备键（deviceKeyOf：浏览器 + 系统，不计版本与 IP）。

const UA_CHROME_141 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const UA_CHROME_142 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

test("会话：同一台设备重登（浏览器升级 + IP 漂移）—— 库里只留最新一行，旧令牌拉黑", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    // ⚠️ 同一个 deviceId：真实客户端存在 localStorage 里，浏览器升级不会变 ——
    //    「同一台设备」现在只认它（UA 版本号会变，不能再当判据）。
    const old = await loginDevice(api, 7, UA_CHROME_141, "1.2.3.4", "dev-stable");
    // Chrome 自动升级后再次登录：UA 版本号变了，出口也从 IPv4 漂到 IPv6
    const next = await loginDevice(api, 7, UA_CHROME_142, "2404:1234::1", "dev-stable");

    assert.equal(db.sessions.length, 1, "一台设备在库里只留一行");
    assert.equal(db.sessions[0].jti, next.jti, "留的是最新那次登录");
    assert.ok(
        db.blacklist.some(r => r.jti === old.jti),
        "旧令牌必须同时拉黑 —— 只删行的话它还能用到过期"
    );

    const list = await api.listSessions(7, next.jti);
    assert.equal(list.length, 1, "列表里一台设备只出一条");
    assert.equal(list[0].ip, "2404:1234::1", "显示的是最新登录的 IP");
    assert.equal(list[0].current, true);
});

test("会话：列表折叠自愈 —— 历史遗留的同设备重复行（老判重漏下的）列表时清掉", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const current = await loginDevice(api, 7, UA_CHROME_141, "1.2.3.4", "dev-stable");
    // 直接往库里塞陈行：UA 版本号与 IP 都不同（正是 v2.0.0「UA+IP」判重漏掉的形态），
    // 且 last_seen 故意比当前行还新 —— 当前会话永远不能被它挤掉。
    // ⚠️ device_id 与当前行相同：陈行就是「同一台设备的历史登录」，
    //    折叠判定只认 device_id（UA 版本不同不再是判据，见 sameDevice）。
    db.sessions.push({
        jti: "legacy-stale",
        user_id: 7,
        user_agent: UA_CHROME_142,
        ip: "9.9.9.9",
        created_at: 100,
        last_seen_at: (db.sessions[0].last_seen_at as number) + 999,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        device_id: "dev-stable",
    });

    const list = await api.listSessions(7, current.jti);
    assert.equal(list.length, 1, "折叠后一台设备只出一条");
    assert.equal(list[0].jti, current.jti, "当前会话那一行永不折叠，陈行再新也吃不到它");
    assert.ok(
        db.blacklist.some(r => r.jti === "legacy-stale"),
        "被折叠的旧会话要顺手拉黑"
    );
    assert.ok(
        !db.sessions.some(r => r.jti === "legacy-stale"),
        "并删行自愈：下次不用再折一次"
    );
});

test("会话：不同设备不互相折叠（浏览器不同 / 系统不同各是各的）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const pc = await loginDevice(api, 7, UA_CHROME_141, "1.2.3.4");
    const edge = await loginDevice(api, 7, UA_CHROME_141.replace("Chrome/", "Edg/"), "1.2.3.4");
    const phone = await loginDevice(
        api,
        7,
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "1.2.3.4"
    );

    const list = await api.listSessions(7, pc.jti);
    assert.equal(list.length, 3, "Chrome / Edge / Safari 是三台设备，一台都不能少");
    assert.deepEqual(
        list.map(s => s.jti).sort(),
        [pc.jti, edge.jti, phone.jti].sort()
    );
});

test("会话：同设备去重不跨账号（A 账号的折叠清不到 B 账号的行）", async () => {
    const db = new SessionsD1();
    const api = newApi(db);
    const a1 = await loginDevice(api, 7, UA_CHROME_141, "1.2.3.4");
    const a2 = await loginDevice(api, 7, UA_CHROME_142, "5.6.7.8");
    const b1 = await loginDevice(api, 8, UA_CHROME_141, "1.2.3.4");

    assert.equal(db.sessions.length, 2, "7 号折叠成一台，8 号那台原样留着");
    assert.ok(
        db.blacklist.some(r => r.jti === a1.jti),
        "被折叠的是 7 号自己的旧会话，与 8 号无关"
    );
    assert.equal((await api.listSessions(7, a2.jti)).length, 1);
    assert.equal((await api.listSessions(8, b1.jti)).length, 1);
    assert.equal((await api.listSessions(8, b1.jti))[0].jti, b1.jti);
});

// ---------------- 归一化设备键（deviceKeyOf） ----------------

test("deviceKeyOf：同一浏览器只认家族与系统，版本号一概不计", () => {
    assert.equal(deviceKeyOf(UA_CHROME_141), deviceKeyOf(UA_CHROME_142), "141 → 142 还是同一台");
    assert.equal(deviceKeyOf(UA_CHROME_141), "Chrome|Windows");
    // Edge 的 UA 里也含 Chrome/、Chrome 的里面也含 Safari/ —— 顺序必须 Edge 优先
    assert.equal(
        deviceKeyOf(UA_CHROME_141.replace("Chrome/", "Edg/")),
        "Edge|Windows",
        "含 Edg/ 的必须先判 Edge"
    );
    // iOS 上所有浏览器都是 WebKit：CriOS（Chrome）也归 Safari · iOS
    assert.equal(
        deviceKeyOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) CriOS/141.0.7390.8 Mobile/15E148 Safari/604.1"),
        "Safari|iOS"
    );
    assert.equal(
        deviceKeyOf("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"),
        "Firefox|Linux"
    );
    assert.equal(deviceKeyOf(""), "unknown", "空 UA（脚本客户端）也有个稳定键");
});

test("deviceKeyOf：认不出的 UA 抹掉版本号再比（至少升级不裂行）", () => {
    const v1 = "SomeAgent/1.2.3 (Foo 9; Bar 8)";
    const v2 = "SomeAgent/1.3.0 (Foo 9; Bar 8)";
    assert.equal(deviceKeyOf(v1), deviceKeyOf(v2), "同一家族的版本升级仍是一台");
    assert.notEqual(
        deviceKeyOf(v1),
        deviceKeyOf("OtherAgent/1.2.3 (Foo 9; Bar 8)"),
        "不同客户端不混一家"
    );
});
