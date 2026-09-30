// tests/security-hardening.test.ts
// 审计发现的几个高危/中危项的回归测试，针对「多账号 + 密钥找回」架构重写：
//   H1  AUTH_SECRET 缺失时 fail-closed（启用鉴权却没配密钥，令牌一律拒签/拒验）
//   M2  webdav 口令经批量写配置入库前仍加密（不落明文）
//   M4  导出备份默认不含站点账号密码（必须显式 backup.includeCredentials=true 才带）
//   L1  导入备份时图标 URL 做清洗（挡 javascript:/vbscript:/file:/data:text/html）
//
// 说明：M1（应急重置码单次有效）在「多账号」分支里已被「Ed25519 密钥找回 + jti 单次使用」
// 取代，旧 resetCode 路径已删除，故这里不再覆盖；其防护由 tests/recovery.test.ts 的
// 单文件多次使用断言保证。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeIconUrl, normalizeImportData, BACKUP_CREDENTIALS_CONFIG, type Site } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";

// ---------------- 极简内存版 D1（只撑起本文件要用到的几条查询） ----------------
type Row = Record<string, unknown>;

class MockD1 {
    configs = new Map<string, string>();
    userConfigs = new Map<string, Map<string, string>>();
    seedSites: Row[] = [];
    seedGroups: Row[] = [];

    prepare(sql: string) {
        const self = this;
        const make = (args: unknown[]) => ({
            _sql: sql,
            _args: args,
            bind: (...a: unknown[]) => make(a),
            first: async () => {
                const rows = self.query(sql, args);
                return (rows[0] as Row) ?? null;
            },
            all: async () => ({ results: self.query(sql, args), success: true }),
            run: async () => {
                // 真实 SQL 的 VALUES 第三参是字面量 CURRENT_TIMESTAMP，这里只按语句前缀识别
                if (/INSERT INTO configs/.test(sql)) {
                    self.configs.set(String(args[0]), String(args[1]));
                }
                if (/INSERT INTO user_configs/.test(sql)) {
                    const uid = String(args[0]);
                    if (!self.userConfigs.has(uid)) self.userConfigs.set(uid, new Map());
                    self.userConfigs.get(uid)!.set(String(args[1]), String(args[2]));
                }
                // 真实 D1 里 batch / 单条执行对 SELECT 同样回带 results；这里统一返回
                // （INSERT/CREATE 等写语句 query 返回空数组，不影响调用方）。
                return { success: true, results: self.query(sql, args) };
            },
        });
        return make([]);
    }

    async batch(stmts: { _sql: string; _args: unknown[] }[]): Promise<{ results: Row[]; success: boolean }[]> {
        // D1 的 batch 会真正执行每条语句（写语句落库），SELECT 回带 results
        return Promise.all(stmts.map(s => s.run()));
    }

    async exec(): Promise<{ success: boolean }> {
        return { success: true };
    }

    query(sql: string, args: unknown[]): Row[] {
        if (/SELECT value FROM configs WHERE key = \?/.test(sql)) {
            const v = this.configs.get(String(args[0]));
            return v == null ? [] : [{ value: v }];
        }
        if (/SELECT key, value FROM configs/.test(sql)) {
            return [...this.configs.entries()].map(([key, value]) => ({ key, value }));
        }
        if (/FROM sites/.test(sql)) return this.seedSites;
        if (/FROM groups/.test(sql)) return this.seedGroups;
        if (/pragma_table_info/.test(sql)) return [];
        if (/FROM users/.test(sql)) return [];
        if (/COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
        return [];
    }
}

function newApi(env: Record<string, unknown> = {}): NavigationAPI {
    return new NavigationAPI({ DB: new MockD1(), ...env } as never);
}

// ================= H1：AUTH_SECRET 缺失 fail-closed =================
test("H1：启用鉴权但没配 AUTH_SECRET，login 拒绝签发令牌", async () => {
    const api = newApi({ AUTH_ENABLED: "true" }); // 无 AUTH_SECRET
    const res = await api.login({ username: "admin", password: "x" });
    assert.equal(res.success, false, "应登录失败");
    assert.match(res.message || "", /AUTH_SECRET/, "应提示 AUTH_SECRET 未配置");
});

test("H1：启用鉴权但没配 AUTH_SECRET，verifyToken 一律无效", async () => {
    const api = newApi({ AUTH_ENABLED: "true" });
    const r = await api.verifyToken("eyJhbGciOiJIUzI1NiJ9.whatever");
    assert.equal(r.valid, false, "缺失密钥时不得把任何令牌当有效");
});

test("H1：配了 AUTH_SECRET 后 login 才能走到校验（不提前失败）", async () => {
    const api = newApi({ AUTH_ENABLED: "true", AUTH_SECRET: "test-secret" });
    // 没建用户、凭据不匹配，应走到「用户名或密码错误」而非 AUTH_SECRET 报错
    const res = await api.login({ username: "admin", password: "wrong" });
    assert.equal(res.success, false);
    assert.equal(/AUTH_SECRET/.test(res.message || ""), false, "配了密钥就不应再报 AUTH_SECRET");
});

// ================= M2：批量写配置仍加密口令 =================
test("M2：setConfigs 写入 webdav.password 入库前加密（不落明文）", async () => {
    const db = new MockD1();
    const api = new NavigationAPI({ DB: db } as never); // 系统级调用，currentUserId=null
    const ok = await api.setConfigs({ "webdav.password": "s3cret-pass" });
    assert.equal(ok, true);
    const stored = db.configs.get("webdav.password") || "";
    assert.notEqual(stored, "s3cret-pass", "绝不能是明文");
    assert.ok(stored.startsWith("enc$"), "应是加密形态 enc$...");
});

// ================= M4：导出备份默认不含凭据 =================
test("M4：backup.includeCredentials 未设置时，导出抹掉站点账号密码", async () => {
    const db = new MockD1();
    db.seedSites = [
        {
            id: 1,
            group_id: 1,
            name: "示例",
            url: "https://example.com",
            icon: "",
            description: "",
            notes: "",
            username: "alice",
            password: "hunter2",
            order_num: 1,
        } as unknown as Site,
    ];
    const api = new NavigationAPI({ DB: db } as never);
    const data = await api.exportData();
    const site = data.sites[0];
    assert.equal(site?.username, "", "默认不导出账号");
    assert.equal(site?.password, "", "默认不导出密码");
});

test("M4：backup.includeCredentials=true 时才带站点账号密码", async () => {
    const db = new MockD1();
    db.configs.set(BACKUP_CREDENTIALS_CONFIG, "true");
    db.seedSites = [
        {
            id: 1,
            group_id: 1,
            name: "示例",
            url: "https://example.com",
            icon: "",
            description: "",
            notes: "",
            username: "alice",
            password: "hunter2",
            order_num: 1,
        } as unknown as Site,
    ];
    const api = new NavigationAPI({ DB: db } as never);
    const data = await api.exportData();
    const site = data.sites[0];
    assert.equal(site?.username, "alice", "开启后才带账号");
    assert.equal(site?.password, "hunter2", "开启后才带密码");
});

test("M4：backup.includeCredentials=false 时仍抹掉凭据", async () => {
    const db = new MockD1();
    db.configs.set(BACKUP_CREDENTIALS_CONFIG, "false");
    db.seedSites = [
        {
            id: 1,
            group_id: 1,
            name: "示例",
            url: "https://example.com",
            icon: "",
            description: "",
            notes: "",
            username: "alice",
            password: "hunter2",
            order_num: 1,
        } as unknown as Site,
    ];
    const api = new NavigationAPI({ DB: db } as never);
    const data = await api.exportData();
    assert.equal(data.sites[0]?.password, "", "显式 false 也应抹掉");
});

// ================= L1：导入备份图标清洗 =================
test("L1：sanitizeIconUrl 挡掉可执行/危险协议", () => {
    assert.equal(sanitizeIconUrl("javascript:alert(1)"), "");
    assert.equal(sanitizeIconUrl("vbscript:msgbox"), "");
    assert.equal(sanitizeIconUrl("file:///etc/passwd"), "");
    assert.equal(sanitizeIconUrl("data:text/html,<script>alert(1)</script>"), "");
});

test("L1：sanitizeIconUrl 放行正常图标（http/https/data:image/相对路径）", () => {
    assert.equal(sanitizeIconUrl("https://cdn.com/a.png"), "https://cdn.com/a.png");
    assert.equal(sanitizeIconUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
    assert.equal(sanitizeIconUrl("/api/icon?site=1"), "/api/icon?site=1");
    assert.equal(sanitizeIconUrl(""), "");
    assert.equal(sanitizeIconUrl("   "), "");
});

test("L1：normalizeImportData 对导入站点的图标同样清洗", () => {
    const data = normalizeImportData({
        sites: [
            {
                url: "https://a.com",
                icon: "javascript:fetch('//evil')",
                name: "x",
                group_id: 1,
                order_num: 1,
                description: "",
                notes: "",
                username: "",
                password: "",
            } as unknown as Site,
            {
                url: "https://b.com",
                icon: "https://b.com/fav.png",
                name: "y",
                group_id: 1,
                order_num: 2,
                description: "",
                notes: "",
                username: "",
                password: "",
            } as unknown as Site,
        ],
    });
    assert.equal(data.sites[0].icon, "", "危险图标应被清空");
    assert.equal(data.sites[1].icon, "https://b.com/fav.png", "正常图标保留");
    // url 仍走 normalizeUrl 规范化
    assert.equal(data.sites[0].url, "https://a.com");
});
