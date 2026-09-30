// tests/sessions.test.ts
// 「登录设备 / 踢下线」的回归测试。钉死几条最容易写错的规则：
//   1. 登记：登录签发的令牌会按 jti 落一行，能按账号列出来；
//   2. 隔离：A 账号列不到 B 账号的设备；
//   3. 吊销 = 拉黑 + 删行：**只删行等于没吊销**（JWT 自包含，令牌照样能用到过期）；
//   4. 归属：猜到别人的 jti 也踢不掉（WHERE 里带 user_id）；
//   5. 「退出其它设备」保留当前这台。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";
import { peekJwtClaim } from "../src/API/crypto";

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
            const [jti, uid, ua, ip, createdAt, lastSeenAt, expiresAt] = args as unknown[];
            const existing = this.sessions.find(r => r.jti === jti);
            if (existing) {
                // ON CONFLICT DO UPDATE SET last_seen_at = ?, expires_at = ?（第 8、9 个参数）
                existing.last_seen_at = args[7];
                existing.expires_at = args[8];
            } else {
                this.sessions.push({
                    jti,
                    user_id: uid,
                    user_agent: ua,
                    ip,
                    created_at: createdAt,
                    last_seen_at: lastSeenAt,
                    expires_at: expiresAt,
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

/** 签一张令牌并登记成会话，返回它的 jti */
async function loginDevice(api: NavigationAPI, uid: number, ua: string, ip: string) {
    const token = await api.generateToken({ username: `u${uid}`, uid }, 3600);
    await api.recordSession(token, ua, ip);
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
