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
    const result = await runNotesWebDavBackup(api, { url: "https://example.com", username: "", password: "", path: "notes" }, { mode: "manual" });
    assert.equal(result.success, false);
    assert.match(result.message ?? "", /正在进行/);
    assert.equal((await db.prepare("SELECT value FROM configs WHERE key = ?").bind("auth.notesBackup.lease.0").first<{ value: string }>())?.value, lease);
});
