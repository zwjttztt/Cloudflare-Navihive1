// tests/vaultSchema.test.ts
// 保险库（方案 B）两张表必须在**真实 SQLite** 里被 migrate() 建出来。
//
// 为什么必须真跑：vault_keys / vault_entries 是「老库上根本不存在」的新表，
// 靠 CREATE_STATEMENTS 那个首建 batch 建不出来（已部署实例走「版本号对得上就跳过」的快路径），
// 必须像 note_folder / attachments 那样在 migrateVaultTables 里显式建 —— 这正是 2026-10-06
// 「文件夹表没建出来 → 接口全 500」的同款坑。FakeD1/MockD1 不执行 SQL，抓不到这种错，
// 所以这里用 node:sqlite 起真库跑一遍 migrate()，再查 sqlite_master 确认表真的在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";
import { SCHEMA_VERSION } from "../src/API/methods/migration";

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
        db,
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

test("保险库：migrate() 在真实 SQLite 里建出 vault_keys / vault_entries", async () => {
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();

    const tables = (realDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vault_%'")
        .all() as { name: string }[]).map(r => r.name).sort();
    assert.deepEqual(tables, ["vault_entries", "vault_keys"], `应有这两张表，实际 ${JSON.stringify(tables)}`);

    // vault_keys 的关键列必须在（少一列，客户端包/解 DEK 就无处存/读）
    const keyCols = (realDb.db.prepare("PRAGMA table_info(vault_keys)").all() as { name: string }[]).map(c => c.name);
    for (const col of ["kdf_salt", "kdf_iterations", "wrapped_dek", "wrapped_dek_iv", "wrapped_dek_recovery", "wrapped_dek_recovery_iv"]) {
        assert.ok(keyCols.includes(col), `vault_keys 少了列 ${col}`);
    }
    const entryCols = (realDb.db.prepare("PRAGMA table_info(vault_entries)").all() as { name: string }[]).map(c => c.name);
    for (const col of ["ciphertext", "iv", "site_id"]) {
        assert.ok(entryCols.includes(col), `vault_entries 少了列 ${col}`);
    }
});

test("保险库：SCHEMA_VERSION 已升到 28（新步骤吃快路径，不升号老库永远建不出来）", () => {
    // 2026-10-25：迁移改成「已执行 step 集合」后版本串升到 27，
    // 为的是让老库跑一遍并拿到新增的两条索引（idx_notes_user_updated / idx_notes_site_recent）。
    // 2026-10-28：再加 `notes-fts-rowid` 这一步（把 FTS 行的 rowid 对齐到 notes.id，
    // 详见 notesNote.ts 的 FTS 定位改造），同样吃快路径，版本串必须走到 28，
    // 否则老库的 FTS 永远不会按 rowid 重建、写入路径与重建路径 rowid 语义不一致。
    assert.equal(SCHEMA_VERSION, "28");
});
