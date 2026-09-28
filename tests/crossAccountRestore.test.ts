// tests/crossAccountRestore.test.ts
// 「A 账号的备份能不能恢复到 B 账号」的回归测试。
//
// 导出只带当前账号的数据（scopeSql 加 user_id 过滤），导入统一写 currentUserId ——
// 语义上「谁导入归谁」。但 groups / sites 的 id 是全局 AUTOINCREMENT，过去导入是
// **保留备份里的原 id** 写入，别的账号早占了同样的号（owner 先建的分组就是 1、2、3）
// 就会撞主键、整批失败。
//
// 现在的行为：导入一律由数据库重新发号，并把 旧id -> 新id 映射回传（前端的星标 /
// 标签记的是旧 id，要翻译一遍）。另外一个账号恢复备份不该改全站外观 —— 全站共享
// 配置（标题 / 主题 / 背景）只有站点所有者能写。

import test from "node:test";
import assert from "node:assert/strict";

import { NavigationAPI, type ExportData } from "../src/API/http";

interface GroupRow {
    id: number;
    user_id: number;
    name: string;
}
interface SiteRow {
    id: number;
    group_id: number;
    user_id: number;
    name: string;
}

/** 只实现导入/导出链路用到的语句：id 由「数据库」分配，撞号会真的抛错 */
class MockD1 {
    groups: GroupRow[] = [];
    sites: SiteRow[] = [];
    configs = new Map<string, string>();
    /** users 表：id -> role，用来验证「只有 owner 能改全站配置」 */
    users = new Map<number, { username: string; role: string }>();
    /** 记录导入时实际写进去的归属，用来验证「归导入者」 */
    written: { table: string; id: number; user_id: number }[] = [];

    private nextGroupId = 1;
    private nextSiteId = 1;

    private normalize(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    /** 返回新分配的 id（RETURNING id 要用） */
    private insert(sql: string, args: unknown[]): number | null {
        const s = this.normalize(sql);
        if (s.startsWith("INSERT INTO groups")) {
            // INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id
            const id = this.nextGroupId++;
            const userId = Number(args[2]);
            this.groups.push({ id, user_id: userId, name: String(args[0]) });
            this.written.push({ table: "groups", id, user_id: userId });
            return id;
        }
        if (s.startsWith("INSERT INTO sites")) {
            // INSERT INTO sites (group_id, name, url, icon, description, notes,
            //   username, password, order_num, user_id) VALUES (...10 个) RETURNING id
            const id = this.nextSiteId++;
            const groupId = Number(args[0]);
            const userId = Number(args[9]);
            this.sites.push({ id, group_id: groupId, user_id: userId, name: String(args[1]) });
            this.written.push({ table: "sites", id, user_id: userId });
            return id;
        }
        if (s.startsWith("INSERT INTO configs")) {
            this.configs.set(String(args[0]), String(args[1]));
        }
        return null;
    }

    private select(sql: string): unknown[] {
        const s = this.normalize(sql);
        if (s === "SELECT key, value FROM configs") {
            return [...this.configs.entries()].map(([key, value]) => ({ key, value }));
        }
        // 分组 / 站点列表：导出时按账号过滤
        if (s.startsWith("SELECT id, name, order_num") && s.includes("FROM groups")) {
            return this.groups.map(g => ({ ...g }));
        }
        if (s.startsWith("SELECT id, group_id") && s.includes("FROM sites")) {
            return this.sites.map(x => ({ ...x }));
        }
        return [];
    }

    private firstRow(sql: string, args: unknown[]): unknown | null {
        const s = this.normalize(sql);
        if (s.startsWith("SELECT id, username, role") && s.includes("FROM users")) {
            const id = Number(args[0]);
            const u = this.users.get(id);
            return u ? { id, username: u.username, role: u.role } : null;
        }
        return null;
    }

    prepare(sql: string) {
        const self = this;
        let args: unknown[] = [];
        const stmt = {
            _sql: sql,
            _args: args,
            bind(...a: unknown[]) {
                args = a;
                stmt._args = a;
                return stmt;
            },
            async run() {
                const s = self.normalize(sql);
                if (s.startsWith("INSERT")) self.insert(sql, args);
                return { success: true };
            },
            async all() {
                const s = self.normalize(sql);
                if (s.startsWith("INSERT")) {
                    const id = self.insert(sql, args);
                    return { results: id === null ? [] : [{ id }], success: true };
                }
                return { results: self.select(sql), success: true };
            },
            async first() {
                return self.firstRow(sql, args);
            },
        };
        return stmt;
    }

    async batch<T>(stmts: { _sql: string; _args: unknown[] }[]): Promise<
        { results: T[]; success: boolean }[]
    > {
        return Promise.all(
            stmts.map(s => {
                const sql = s._sql;
                const norm = this.normalize(sql);
                if (norm.startsWith("INSERT")) {
                    const id = this.insert(sql, s._args || []);
                    return { results: (id === null ? [] : [{ id }]) as T[], success: true };
                }
                return { results: this.select(sql) as T[], success: true };
            })
        );
    }

    async exec(): Promise<{ count: number }> {
        // 迁移里的建表 / 补列一律当成功
        return { count: 0 };
    }
}

function apiWith(db: MockD1, uid: number) {
    const api = new NavigationAPI({
        // @ts-expect-error 测试里用最小替身充当 D1
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-restore",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
    api.setCurrentUser(uid);
    return api;
}

const backup: ExportData = {
    groups: [
        { id: 1, name: "常用工具", order_num: 0 },
        { id: 2, name: "开发", order_num: 1 },
    ],
    sites: [{ id: 10, group_id: 1, name: "示例", url: "https://example.com", order_num: 0 }],
    configs: {},
    version: "1.3",
    exportDate: new Date().toISOString(),
};

test("跨账号恢复：目标库没人占着这些 id 时，数据归导入者名下", async () => {
    const db = new MockD1();
    // 库里只有一个别的账号占着 id 100、200
    db.groups.push({ id: 100, user_id: 1, name: "别人的分组" });
    db.sites.push({ id: 200, group_id: 100, user_id: 1, name: "别人的站点" });

    const api = apiWith(db, 2);
    const result = await api.importData(backup);
    assert.equal(result.success, true, "导入应该成功");

    // 归属全部落到 uid=2 名下
    assert.deepEqual(
        db.written.map(w => [w.table, w.user_id]),
        [
            ["groups", 2],
            ["groups", 2],
            ["sites", 2],
        ]
    );
    // 别人（uid=1）的数据没被清掉
    assert.ok(db.groups.some(g => g.id === 100 && g.user_id === 1), "不该误删其他账号的数据");
});

test("跨账号恢复：备份里的 id 被其他账号占着也能成功（重新发号 + 站点跟着重挂）", async () => {
    const db = new MockD1();
    // owner（uid=1）早就建了 id=1、2 的分组 —— 这是最典型的 id 撞车场景
    db.groups.push({ id: 1, user_id: 1, name: "owner 的分组" });
    db.groups.push({ id: 2, user_id: 1, name: "owner 的第二个分组" });
    db.sites.push({ id: 3, group_id: 1, user_id: 1, name: "owner 的站点" });
    db.nextGroupId = 4;
    db.nextSiteId = 4;

    const api = apiWith(db, 2);
    const result = await api.importData(backup);

    assert.equal(result.success, true, "id 撞车时也应该导入成功（不再保留原 id）");
    // 新号是数据库分配的：都不会是备份里的 1 / 2 / 10
    const newGroupIds = Object.values(result.groupIdMap);
    assert.equal(newGroupIds.length, 2);
    assert.ok(newGroupIds.every(id => id > 3), `分组应重新发号，实际 ${newGroupIds}`);

    // 站点跟着重挂到「旧 group_id=1 对应的新号」上，而不是原来那个 1
    const newSiteId = result.siteIdMap["10"];
    assert.equal(typeof newSiteId, "number");
    const site = db.sites.find(s => s.id === newSiteId);
    assert.equal(site?.user_id, 2, "站点应归导入者");
    assert.equal(site?.group_id, result.groupIdMap["1"], "站点应挂到重新发号后的分组");
    // owner 那条 id=1 的分组没被覆盖
    assert.ok(db.groups.some(g => g.id === 1 && g.user_id === 1), "不该动其他账号的分组");
});

test("普通账号恢复备份不改全站共享配置（老格式：全站设置混在 configs 里）", async () => {
    const db = new MockD1();
    db.users.set(2, { username: "u2", role: "user" });
    db.configs.set("site.title", "原来的站名");

    const api = apiWith(db, 2);
    const result = await api.importData({
        ...backup,
        configs: { "site.title": "别人的站名", "backup.includeCredentials": "true" },
    });

    assert.equal(result.success, true);
    assert.equal(db.configs.get("site.title"), "原来的站名", "普通账号恢复不该改全站标题");
    // backup.* 不是按账号隔离的键，同样属于「全站共享」，普通账号也改不动
    assert.equal(
        db.configs.get("backup.includeCredentials"),
        undefined,
        "共享配置一律不该被普通账号改"
    );
});

test("普通账号恢复备份不改全站共享配置（新格式：sharedConfigs）", async () => {
    const db = new MockD1();
    db.users.set(2, { username: "u2", role: "user" });
    db.configs.set("site.title", "原来的站名");

    const api = apiWith(db, 2);
    const result = await api.importData({
        ...backup,
        sharedConfigs: { "site.title": "别人的站名" },
    });

    assert.equal(result.success, true);
    assert.equal(db.configs.get("site.title"), "原来的站名");
});

test("owner 恢复备份才会带全站设置", async () => {
    const db = new MockD1();
    db.users.set(1, { username: "owner", role: "owner" });
    db.configs.set("site.title", "原来的站名");

    const api = apiWith(db, 1);
    const result = await api.importData({
        ...backup,
        sharedConfigs: { "site.title": "备份里的站名" },
    });

    assert.equal(result.success, true);
    assert.equal(db.configs.get("site.title"), "备份里的站名", "owner 恢复应还原全站标题");
});

test("导出：普通账号的备份里不带全站设置，owner 的才带", async () => {
    const db = new MockD1();
    db.users.set(1, { username: "owner", role: "owner" });
    db.users.set(2, { username: "u2", role: "user" });
    db.configs.set("site.title", "我的站");
    db.configs.set("webdav.password", "enc$xxx");

    const ownerExport = await apiWith(db, 1).exportData();
    assert.deepEqual(ownerExport.sharedConfigs, { "site.title": "我的站" }, "owner 导出应带全站设置");
    assert.deepEqual(ownerExport.configs, {}, "按账号配置里目前没有非敏感项");

    const userExport = await apiWith(db, 2).exportData();
    assert.equal(userExport.sharedConfigs, undefined, "普通账号导出不该带全站设置");
    assert.deepEqual(userExport.configs, {});
});
