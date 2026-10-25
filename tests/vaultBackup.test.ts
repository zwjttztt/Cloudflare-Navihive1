// tests/vaultBackup.test.ts
// B6：导航全量备份/恢复现在包含保险库密文（keys + entries），且服务端永不解密。
//
// 为什么必须真 SQLite + 真 WebCrypto：保险库的“可恢复性”是安全核心 —— 光断言“密文被搬过去了”
// 不够，必须证明**导入后拿原始主密码还能解开**。用 FakeD1/MockD1 抓不到 SQL 隔离与事务回滚，
// 用内存传输层也证明不了“落库后再解锁”的真实链路，所以这里两套都上：
//   - 真实 node:sqlite 验证导出/导入的 SQL、账号隔离、事务原子性；
//   - 真实 vaultSession + vaultCrypto 验证“建库→导出→导入→再用原主密码解锁”端到端可恢复。
//
// 核心不变量：
//   1. 导出只出密文：主密码 / 条目明文密码绝不出现在导出 JSON 里。
//   2. 恢复后原主密码能解密（端到端可恢复），且恢复是整包 keys+entries 一起换，不会半残。
//   3. 与笔记同一套“字段缺失=不动本地”：备份没有 vault 字段时，本地保险库一根汗毛都不动。
//   4. 合并模式且本地已有保险库 → 整体跳过（保留本地，不动那把钥匙，否则本地条目永久解不开）。
//   5. 覆盖模式 → 整包替换成备份那一刻。
//   6. 条目 site_id 在导入后跟着站点重发号重映射，绑定不丢。
//   7. 账号隔离：导入写的是当前导入者 user_id，不会改写别人的保险库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";
import {
    setupVault,
    unlockVault,
    listDecryptedEntries,
    saveEncryptedEntry,
    type VaultTransport,
} from "../src/utils/vaultSession";

// ---- 真实 SQLite 适配器（与 vaultApi.test.ts 同款）----
function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) {
                bound = args as SQLInputValue[];
                return prepared;
            },
            all<T = Record<string, unknown>>() {
                return Promise.resolve({ results: stmt.all(...bound) as T[], success: true as const });
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return Promise.resolve((row ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({
                    success: true as const,
                    // 必须带 rows_written：claimIdempotencyDetailed（幂等锁）靠它区分
                    // acquired / busy / unavailable，生产 D1 的 run() 也回这个字段。
                    // 缺了它会被误判为「unavailable」，随后 readIdempotency 读到刚插入的
                    // 占位行就把导入当成「有别的恢复在跑」拒掉。node:sqlite 的
                    // run() 只给 changes（INSERT 成功=1、ON CONFLICT 不插=0），正好对应。
                    meta: {
                        changes: r.changes,
                        last_row_id: Number(r.lastInsertRowid),
                        rows_written: r.changes,
                    },
                });
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        // ⚠️ 与真实 D1 一致：batch 里既可能有 SELECT（导出 bundles）也可能有
        // INSERT/DELETE（导入整批提交）。真实 D1 会按语句类型返回 .results / .meta，
        // 这里统一用 .all() 执行并取结果 —— 非 SELECT 的 .all() 照样执行写入、
        // 只是 results 为空，调用方读不到 .results 也不受影响。若改成 .run()，
        // 导出那条 SELECT 的 .results 会被吞掉，导致备份里 groups/sites 全空、
        // 覆盖导入被「空备份闸门」误拒。
        batch: async (stmts: Array<{ all: () => Promise<unknown>; run: () => Promise<unknown> }>) =>
            Promise.all(stmts.map(s => s.all())),
        async exec(sql: string) {
            db.exec(sql);
        },
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

/** 把真实 NavigationAPI 适配成 VaultTransport：vaultSession 的加密编排直接落真实数据库 */
function apiTransport(api: NavigationAPI): VaultTransport {
    return {
        getVaultKeys: () => api.getVaultKeys(),
        saveVaultKeys: input => api.saveVaultKeys(input).then(() => true),
        listVaultEntries: () => api.listVaultEntries(),
        saveVaultEntry: input => api.saveVaultEntry(input),
        deleteVaultEntry: id => api.deleteVaultEntry(id).then(() => true),
    };
}

/** 直接插一条分组 + 站点（导出/导入链路需要真实表行；密码留空，导出时按“非密文”原样透传） */
async function seedSite(api: NavigationAPI, uid: number, siteId: number, groupId = 1): Promise<void> {
    await api.db
        .prepare("INSERT OR IGNORE INTO groups (id, user_id, name, order_num) VALUES (?,?,?,?)")
        .bind(groupId, uid, "g", 0)
        .run();
    await api.db
        .prepare(
            "INSERT INTO sites (id, group_id, user_id, name, url, icon, description, notes, username, password, order_num) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        )
        .bind(siteId, groupId, uid, `site-${siteId}`, "https://example.com", "", "", "", "", "", 0)
        .run();
}

interface SeedEntry {
    title: string;
    username: string;
    password: string;
    notes?: string;
    url?: string;
    siteId?: number | null;
}

/** 在指定账号下用真实 WebCrypto 建库并写入若干条目（落真实数据库） */
async function buildVault(
    api: NavigationAPI,
    uid: number,
    master: string,
    entries: SeedEntry[]
): Promise<void> {
    api.setCurrentUser(uid);
    const t = apiTransport(api);
    await setupVault(t, master);
    const session = await unlockVault(t, master);
    for (const e of entries) {
        await saveEncryptedEntry(t, session, {
            title: e.title,
            username: e.username,
            password: e.password,
            notes: e.notes ?? "",
            url: e.url ?? "",
            siteId: e.siteId ?? null,
        });
    }
}

test("导出含保险库密文，且主密码 / 条目明文绝不出现在导出 JSON", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    const MASTER = "top secret master password 2026";
    await buildVault(api, 1, MASTER, [
        { title: "GitHub", username: "me", password: "g#h-s3cret", notes: "", url: "https://github.com" },
        { title: "Mail", username: "x", password: "mail-pw", notes: "2FA app", url: "" },
    ]);

    const exported = await api.exportData();
    assert.ok(exported.vault, "导出应包含 vault");
    assert.equal(exported.vault!.keys.kdf_salt, (await api.getVaultKeys())!.kdf_salt);
    assert.equal(exported.vault!.entries.length, 2, "应导出 2 条条目");

    const dump = JSON.stringify(exported);
    assert.ok(!dump.includes(MASTER), "主密码不能出现在导出里");
    assert.ok(!dump.includes("g#h-s3cret"), "条目明文密码不能出现在导出里");
    assert.ok(!dump.includes("mail-pw"), "条目明文密码不能出现在导出里");
});

test("🔴 导入到另一个账号后，原主密码仍能解开（端到端可恢复）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    const MASTER = "recover me master 2026";
    await buildVault(api, 1, MASTER, [
        { title: "GitHub", username: "me", password: "g#h-s3cret", notes: "", url: "https://github.com" },
        { title: "Mail", username: "x", password: "mail-pw", notes: "2FA app", url: "" },
    ]);
    const exported = await api.exportData();

    // 以“另一个账号”（user 2，本地无任何保险库）身份导入同一份备份（同一份库、不同登录账号）
    api.setCurrentUser(2);
    const result = await api.importData(exported, { mode: "merge" });
    assert.equal(result.success, true, "导入应成功");
    assert.equal(result.vault?.action, "adopted", "另一账号（本地无库）应整包接纳");

    // 服务端密文逐字节搬过去（未被服务端改动）
    const dstKeys = await api.getVaultKeys();
    assert.equal(dstKeys!.kdf_salt, exported.vault!.keys.kdf_salt);
    const dstEntries = await api.listVaultEntries();
    assert.equal(dstEntries.length, 2);
    assert.deepEqual(
        dstEntries.map(e => e.ciphertext).sort(),
        exported.vault!.entries.map(e => e.ciphertext).sort(),
        "条目密文应原样搬过去"
    );

    // 客户端用原始主密码解锁并解密 —— 这才是“可恢复”的真正证明
    const t2 = apiTransport(api);
    const s2 = await unlockVault(t2, MASTER);
    const list2 = await listDecryptedEntries(t2, s2);
    assert.equal(list2.length, 2, "导入后两条都应能解开");
    const pwSet = new Set(list2.map(e => e.password));
    assert.ok(pwSet.has("g#h-s3cret") && pwSet.has("mail-pw"), "两条明文密码都应解出来");
});

test("合并模式：本地已有不同保险库 → 整体跳过，本地原样保留", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    await seedSite(api, 1, 100); // 让导出不是“空备份”，避免触发覆盖模式的空备份闸门

    // 账号 1 建库 + 2 条，导出
    const M1 = "master-one-111";
    await buildVault(api, 1, M1, [
        { title: "A1", username: "u", password: "p1", notes: "", url: "" },
        { title: "A2", username: "u", password: "p2", notes: "", url: "" },
    ]);
    const exported = await api.exportData();
    const keys1 = (await api.getVaultKeys())!;

    // 账号 2 已有一个“不同的”保险库
    const M2 = "master-two-222";
    await buildVault(api, 2, M2, [{ title: "B-only", username: "u", password: "b-pw", notes: "", url: "" }]);
    const keys2 = (await api.getVaultKeys())!;
    assert.notEqual(keys2.kdf_salt, keys1.kdf_salt, "两个账号的 keys 应不同");

    // 用账号 1 的备份，以合并模式导入到账号 2（导入者 = 当前账号 2）
    const result = await api.importData(exported, { mode: "merge" });
    assert.equal(result.success, true);
    assert.equal(result.vault?.action, "skipped", "合并模式且本地已有 → 跳过");

    // 账号 2 的库一字节未动
    const after = await api.getVaultKeys();
    assert.equal(after!.kdf_salt, keys2.kdf_salt, "账号 2 的 keys 应原封不动");
    const afterEntries = await api.listVaultEntries();
    assert.equal(afterEntries.length, 1, "账号 2 的条目应原封不动");
    const t2 = apiTransport(api);
    const s2 = await unlockVault(t2, M2);
    const list2 = await listDecryptedEntries(t2, s2);
    assert.equal(list2.length, 1);
    assert.equal(list2[0].password, "b-pw", "本地条目仍可被本地主密码解开，未被备份覆盖");
});

test("覆盖模式：整包替换成备份那一刻（原主密码能解、旧主密码失效）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    await seedSite(api, 1, 100);

    const M1 = "master-one-111";
    await buildVault(api, 1, M1, [
        { title: "A1", username: "u", password: "p1", notes: "", url: "" },
        { title: "A2", username: "u", password: "p2", notes: "", url: "" },
    ]);
    const exported = await api.exportData();

    const M2 = "master-two-222";
    await buildVault(api, 2, M2, [{ title: "B-only", username: "u", password: "b-pw", notes: "", url: "" }]);

    const result = await api.importData(exported, { mode: "overwrite" });
    assert.equal(result.success, true);
    assert.equal(result.vault?.action, "replaced", "覆盖模式应整包替换");

    // 账号 2 现在 = 备份里账号 1 的保险库，且能用 M1 解开、M2 失效
    const t2 = apiTransport(api);
    const sNew = await unlockVault(t2, M1);
    const listNew = await listDecryptedEntries(t2, sNew);
    assert.equal(listNew.length, 2, "覆盖后变成备份的 2 条");
    const pw = new Set(listNew.map(e => e.password));
    assert.ok(pw.has("p1") && pw.has("p2"));
    await assert.rejects(() => unlockVault(t2, M2), "旧的本地主密码应已失效");
});

test("🔴 备份没有 vault 字段（老备份 / 没建保险库）导入时，本地保险库绝不被清空", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();

    // 账号 1：有保险库
    const M = "local-master-333";
    await buildVault(api, 1, M, [{ title: "Keep", username: "u", password: "keep-pw", notes: "", url: "" }]);
    const keysBefore = (await api.getVaultKeys())!;

    // 账号 2：没保险库，导出一份“自然不含 vault”的备份
    api.setCurrentUser(2);
    const noVaultExport = await api.exportData();
    assert.equal(noVaultExport.vault, undefined, "没建保险库的账号导出不应含 vault");

    // 再以账号 1 身份导入这份没 vault 的备份（合并 / 覆盖都不应动账号 1 的保险库）
    api.setCurrentUser(1);
    const result = await api.importData(noVaultExport, { mode: "merge" });
    assert.equal(result.success, true);
    assert.equal(result.vault?.action, "none", "备份无 vault → 本地保险库不应被动");

    const keysAfter = await api.getVaultKeys();
    assert.equal(keysAfter!.kdf_salt, keysBefore.kdf_salt, "本地 keys 应原封不动");
    const entriesAfter = await api.listVaultEntries();
    assert.equal(entriesAfter.length, 1, "本地条目应保留");
    const t = apiTransport(api);
    const s = await unlockVault(t, M);
    assert.equal((await listDecryptedEntries(t, s))[0].password, "keep-pw", "本地条目仍可被解开");
});

test("🔴 条目 site_id 在导入后跟着站点重发号重映射，绑定不丢", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();
    // 站点 id 555（分组 1），保险库条目绑定到它
    await seedSite(api, 1, 555);
    const MASTER = "remap master 2026";
    await buildVault(api, 1, MASTER, [
        { title: "Linked", username: "u", password: "lpw", notes: "", url: "", siteId: 555 },
    ]);
    const exported = await api.exportData();
    assert.equal(exported.vault!.entries[0].site_id, 555, "源导出里条目应绑定到站点 555");

    // 导入到另一个账号（user 2）：源账号的站点 555 会被重发号（nextIdBase 用全局
    // MAX(id)，源库里 555 已被占，所以重映射后是个更大的新 id，绝不是 1 也不是 555）。
    api.setCurrentUser(2);
    const result = await api.importData(exported, { mode: "merge" });
    assert.equal(result.success, true);
    assert.equal(result.vault?.action, "adopted");
    const newSiteId = result.siteIdMap["555"];
    assert.ok(typeof newSiteId === "number", "站点 555 应被重映射到一个新 id");
    assert.notEqual(newSiteId, 555, "新 id 绝不能等于旧的源站点 id");

    const dstEntries = await api.listVaultEntries();
    assert.equal(dstEntries.length, 1);
    assert.equal(dstEntries[0].site_id, newSiteId, "导入后条目应绑定到重映射后的新站点 id，而非旧的 555");
    assert.notEqual(dstEntries[0].site_id, 555, "绝不能保留旧的源站点 id");

    // 端到端仍可解密
    const t2 = apiTransport(api);
    const s2 = await unlockVault(t2, MASTER);
    const list2 = await listDecryptedEntries(t2, s2);
    assert.equal(list2.length, 1);
    assert.equal(list2[0].password, "lpw");
});

test("🔴 账号隔离：导入写的是当前导入者 user_id，不会改写别人的保险库", async () => {
    resetMigrationCacheForTests();
    const api = makeApi(makeRealD1());
    await api.migrate();

    // 账号 1 建库 + 2 条，导出
    const M1 = "master-one-111";
    await buildVault(api, 1, M1, [
        { title: "U1a", username: "u", password: "u1a", notes: "", url: "" },
        { title: "U1b", username: "u", password: "u1b", notes: "", url: "" },
    ]);
    const exported = await api.exportData();
    const keys1 = (await api.getVaultKeys())!;

    // 账号 2 没有任何保险库 → 合并导入应“采纳”（整包搬过来，写在 user_id=2 下）
    api.setCurrentUser(2);
    const result = await api.importData(exported, { mode: "merge" });
    assert.equal(result.vault?.action, "adopted");

    // 账号 1 的保险库应原封不动（user_id=1 的行没被碰）
    api.setCurrentUser(1);
    const after1 = await api.getVaultKeys();
    assert.equal(after1!.kdf_salt, keys1.kdf_salt, "账号 1 的 keys 应原封不动");
    assert.equal((await api.listVaultEntries()).length, 2, "账号 1 仍有 2 条");

    // 账号 2 现在持有“一份写在 user_id=2 下”的备份副本，且能用 M1 解开
    api.setCurrentUser(2);
    const after2 = await api.getVaultKeys();
    assert.equal(after2!.kdf_salt, exported.vault!.keys.kdf_salt, "账号 2 拿到的是备份的 keys");
    const t2 = apiTransport(api);
    const s2 = await unlockVault(t2, M1);
    assert.equal((await listDecryptedEntries(t2, s2)).length, 2, "账号 2 能用原主密码解开导入的保险库");
});
