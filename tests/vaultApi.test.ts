// tests/vaultApi.test.ts
// 保险库服务端方法在**真实 SQLite** 里跑一遍：CRUD + 每账号一行 + **账号隔离**。
//
// 隔离是这里最要紧的一条：vault_* 全靠 user_id + scopeSql 分账号，写错一条就是把
// 别家账号的密文漏过去。FakeD1/MockD1 不执行 SQL、抓不到这种错，所以用 node:sqlite 真库验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";

function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) { bound = args as SQLInputValue[]; return prepared; },
            all<T = Record<string, unknown>>() {
                return Promise.resolve({ results: stmt.all(...bound) as T[], success: true as const });
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return Promise.resolve((row ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({ success: true as const, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } });
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        batch: async (stmts: Array<{ run: () => Promise<{ success: boolean }> }>) =>
            Promise.all(stmts.map(s => s.run())),
        async exec(sql: string) { db.exec(sql); },
    };
}

function makeApi(db: ReturnType<typeof makeRealD1>): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

const KEYS_A = {
    kdf_salt: "c2FsdC1h", // base64("salt-a")
    kdf_iterations: 600000,
    wrapped_dek_iv: "aXYtZGVrLWE",
    wrapped_dek: "Y3QtZGVrLWE",
    wrapped_dek_recovery_iv: "aXYtcmVjLWE",
    wrapped_dek_recovery: "Y3QtcmVjLWE",
};
const KEYS_B = { ...KEYS_A, kdf_salt: "c2FsdC1i", wrapped_dek: "Y3QtZGVrLWI" };

test("vault keys：建库写入 + 读回 + 改主密码是更新同一行（不叠行）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    api.setCurrentUser(1);

    assert.equal(await api.getVaultKeys(), null, "没建库前应为 null");
    await api.saveVaultKeys(KEYS_A);
    const got = await api.getVaultKeys();
    assert.equal(got?.kdf_salt, KEYS_A.kdf_salt);
    assert.equal(got?.kdf_iterations, 600000);
    assert.equal(got?.wrapped_dek, KEYS_A.wrapped_dek);

    // 改主密码：重裹 wrapped_dek，仍是同一行
    await api.saveVaultKeys({ ...KEYS_A, wrapped_dek: "Y3QtZGVrLUEy" });
    const got2 = await api.getVaultKeys();
    assert.equal(got2?.wrapped_dek, "Y3QtZGVrLUEy", "应更新成新包的 DEK");
});

test("vault entries：建/改/列/删 全链路", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    api.setCurrentUser(1);

    assert.deepEqual(await api.listVaultEntries(), []);
    const created = await api.saveVaultEntry({ ciphertext: "ct-1", iv: "iv-1", site_id: 7 });
    assert.ok(Number.isInteger(created.id) && created.id > 0, "新建应回 id");
    assert.equal(created.ciphertext, "ct-1");
    assert.equal(created.site_id, 7);

    const updated = await api.saveVaultEntry({ id: created.id, ciphertext: "ct-1b", iv: "iv-1b" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.ciphertext, "ct-1b");
    assert.equal(updated.site_id, null, "没传 site_id 应置空（显式解绑）");

    const list = await api.listVaultEntries();
    assert.equal(list.length, 1);
    assert.equal(list[0].ciphertext, "ct-1b");

    assert.deepEqual(await api.deleteVaultEntry(created.id), { success: true });
    assert.deepEqual(await api.listVaultEntries(), [], "删完应为空");
});

test("🔴 账号隔离：换账号看不到别人的 keys/entries，改不动别人的条目", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();

    // 账号 1 建库 + 存一条
    api.setCurrentUser(1);
    await api.saveVaultKeys(KEYS_A);
    const e1 = await api.saveVaultEntry({ ciphertext: "ct-user1", iv: "iv-1" });

    // 账号 2：什么都看不到
    api.setCurrentUser(2);
    assert.equal(await api.getVaultKeys(), null, "账号 2 不该看到账号 1 的 keys");
    assert.deepEqual(await api.listVaultEntries(), [], "账号 2 不该看到账号 1 的条目");

    // 账号 2 建自己的库，互不干扰
    await api.saveVaultKeys(KEYS_B);
    assert.equal((await api.getVaultKeys())?.wrapped_dek, KEYS_B.wrapped_dek);
    assert.deepEqual(await api.listVaultEntries(), [], "账号 2 仍是空");

    // 账号 2 改/删账号 1 的条目 id → 改不到（更新 0 行抛错；删除不影响）
    await assert.rejects(() => api.saveVaultEntry({ id: e1.id, ciphertext: "hacked", iv: "x" }), /不存在|不属于/);
    await api.deleteVaultEntry(e1.id); // 带 scope，删的是账号 2 视野里 id=e1 的行 → 没有，安全
    api.setCurrentUser(1);
    assert.equal((await api.listVaultEntries())[0]?.ciphertext, "ct-user1", "账号 1 的条目应原封不动");
    assert.equal((await api.getVaultKeys())?.wrapped_dek, KEYS_A.wrapped_dek, "账号 1 的 keys 应原封不动");
});

test("单账号部署（uid=null）：keys/entries 正常存取，与登录账号互相隔离", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();

    api.setCurrentUser(null); // 单账号部署
    await api.saveVaultKeys(KEYS_A);
    const e = await api.saveVaultEntry({ ciphertext: "ct-solo", iv: "iv-solo" });
    assert.equal((await api.getVaultKeys())?.kdf_salt, KEYS_A.kdf_salt);
    assert.equal((await api.listVaultEntries())[0]?.ciphertext, "ct-solo");

    // 登录一个账号后，看不到单账号那份（NULL != 整数）
    api.setCurrentUser(9);
    assert.equal(await api.getVaultKeys(), null);
    assert.deepEqual(await api.listVaultEntries(), []);
    // 删不到单账号那条
    await api.deleteVaultEntry(e.id);
    api.setCurrentUser(null);
    assert.equal((await api.listVaultEntries())[0]?.ciphertext, "ct-solo", "单账号那条应删不掉");
});
