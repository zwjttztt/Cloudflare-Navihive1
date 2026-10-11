import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { handleDataRoutes } from "../worker/routes/data";
import type { RouteCtx } from "../worker/routes/types";

test("重建索引：账号隔离、修复遗漏、保留并发保存的新索引", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(41);
    const a = await api.createNote({ title: "Alpha", content: "old" });
    api.setCurrentUser(42);
    const b = await api.createNote({ title: "Beta", content: "other" });
    api.setCurrentUser(41);
    await db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(a.id).run();
    const request = new Request("https://example.com/api/notes/reindex", { method: "POST" });
    const ctx = { request, url: new URL(request.url), method: "POST", path: "notes/reindex", api, env: { DB: db } } as unknown as RouteCtx;
    const first = await handleDataRoutes(ctx);
    assert.equal(first?.status, 200);
    assert.ok(await db.prepare("SELECT note_id FROM notes_fts WHERE note_id = ?").bind(a.id).first());
    assert.ok(await db.prepare("SELECT note_id FROM notes_fts WHERE note_id = ?").bind(b.id).first());
    const listNotes = api.listNotes.bind(api);
    api.listNotes = async () => {
        const snapshot = await listNotes();
        await api.updateNote(a.id!, { title: "AlphaNew", content: "latest", rev: snapshot[0].rev });
        return snapshot;
    };
    await handleDataRoutes(ctx);
    const indexed = await db.prepare("SELECT title, body FROM notes_fts WHERE note_id = ?").bind(a.id).first<{ title: string; body: string }>();
    assert.equal(indexed?.title, "AlphaNew");
    assert.equal(indexed?.body, "latest");
});
