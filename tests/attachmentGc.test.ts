import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { retryAttachmentDeletions } from "../worker/attachments";
import type { Env } from "../worker/types";

test("附件对象清理：元数据删除原子入队，失败保留，恢复后幂等清除", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await db.prepare("INSERT INTO attachments (id, user_id, storage, object_key, filename, mime, size, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
        .bind("gc-test", "kv", "notes/0/gc-test", "test.png", "image/png", 12).run();
    const deleted = await api.deleteAttachment("gc-test");
    assert.ok(deleted.ok);
    assert.equal(await db.prepare("SELECT id FROM attachments WHERE id = ?").bind("gc-test").first(), null);
    const queued = () => db.prepare("SELECT value FROM configs WHERE key = ?").bind("auth.attachment.gc.gc-test").first();
    assert.ok(await queued());
    assert.equal((await api.getConfigs())["auth.attachment.gc.gc-test"], undefined);
    await retryAttachmentDeletions({ DB: db } as unknown as Env);
    assert.ok(await queued(), "存储暂不可用不能丢掉任务");
    const keys: string[] = [];
    const env = { DB: db, FILES_KV: { delete: async (key: string) => { keys.push(key); } } } as unknown as Env;
    await retryAttachmentDeletions(env);
    assert.deepEqual(keys, ["notes/0/gc-test"]);
    assert.equal(await queued(), null);
    await retryAttachmentDeletions(env);
    assert.equal(keys.length, 1);
});
