import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { runNotesWebDavBackup } from "../worker/notesBackup";

test("真实 SQLite：备份租约拒绝重入且不覆盖现有持有者", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const lease = `${Date.now() + 600_000}:other-owner`;
    await db.prepare("INSERT INTO configs (key, value) VALUES (?, ?)").bind("auth.notesBackup.lease.0", lease).run();
    // 本条测的是租约互斥，与加密无关；但记事本备份现在是 fail-closed（拿不到口令就不传），
    // 不给口令会先抛「无法加密」而测不到租约，所以显式给一个口令。
    const result = await runNotesWebDavBackup(
        api,
        { url: "https://example.com", username: "", password: "", path: "notes" },
        { mode: "manual", password: "test-secret" }
    );
    assert.equal(result.success, false);
    assert.match(result.message ?? "", /正在进行/);
    assert.equal((await db.prepare("SELECT value FROM configs WHERE key = ?").bind("auth.notesBackup.lease.0").first<{ value: string }>())?.value, lease);
});
