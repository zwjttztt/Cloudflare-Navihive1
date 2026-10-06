// tests/noteRevision.test.ts
// 版本历史的判据。
//
// 这里盯三件最容易出事的事：
//   1. **只在真的改了内容时留快照** —— 自动保存 3 秒一触发，
//      不判「变了没变」的话一分钟能堆几十条一模一样的版本。
//   2. **裁剪真的生效** —— 不裁的话这张表随时间无限增长，D1 迟早撑爆。
//   3. **跨账号拿不到别人的快照**（归属靠 JOIN notes 判定）。
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExportData } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";

interface NoteRow {
    id: number;
    user_id: number;
    title: string;
    content: string;
    archived?: number;
    folder_id?: number | null;
}
interface RevisionRow {
    id: number;
    note_id: number;
    user_id: number | null;
    title: string;
    content: string;
}

/** 只实现版本历史用到的那几条语句，带真实的事务语义与账号过滤 */
class MockD1 {
    notes: NoteRow[] = [];
    revisions: RevisionRow[] = [];
    seq = 0;

    private norm(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    private run(sql: string, args: unknown[]): void {
        const s = this.norm(sql);
        if (s.startsWith("INSERT INTO note_revision")) {
            this.revisions.push({
                id: ++this.seq,
                note_id: Number(args[0]),
                user_id: args[1] === null || args[1] === undefined ? null : Number(args[1]),
                title: String(args[2]),
                content: String(args[3]),
            });
            return;
        }
        if (s.startsWith("DELETE FROM note_revision")) {
            // args: noteId, userId, noteId, userId, keep
            const noteId = Number(args[0]);
            const keep = Number(args[4]);
            const mine = this.revisions.filter(r => r.note_id === noteId);
            const doomed = new Set(mine.slice(0, Math.max(0, mine.length - keep)).map(r => r.id));
            this.revisions = this.revisions.filter(r => !doomed.has(r.id));
            return;
        }
        if (s.startsWith("UPDATE notes SET")) {
            // ⚠️ 两个必须按 SQL 推、不能写死的位置：
            //   1) 参数是**动态**的 —— updateNote 只把 patch 里出现的字段拼进 SET，
            //      所以 `只传 content` 是 [content, id]，而 restore 传的是
            //      [title, content, id]。写死下标必然对不上（症状是「正文变成标题」）。
            //   2) id 是 `WHERE id = ? AND user_id = ?` 的第一个，**倒数第二个**参数。
            //   3) SET 里混着**不占参数**的列（`updated_at = CURRENT_TIMESTAMP`），
            //      按下标一一对应会整体错位 —— 症状是「正文变成了序号 1」。
            //      所以只统计带 `?` 的赋值，再按它们的出现顺序对应参数。
            const setPart = s.slice(s.indexOf(" SET ") + 5, s.indexOf(" WHERE "));
            const columns = setPart
                .split(",")
                .map(part => part.trim())
                .filter(part => part.includes("?"))
                .map(part => part.split(/\s+/)[0]);
            const id = Number(args[args.length - 2]);
            const note = this.notes.find(n => n.id === id);
            if (note) {
                columns.forEach((col, i) => {
                    if (col in note) (note as unknown as Record<string, unknown>)[col] = args[i];
                });
            }
            return;
        }
        if (s.startsWith("INSERT INTO note_note_tag") || s.startsWith("INSERT INTO note_tag")) return;
    }

    private select(sql: string, args: unknown[]): unknown[] {
        const s = this.norm(sql);
        if (s.startsWith("SELECT id FROM notes WHERE id = ?")) {
            const uid = Number(args.at(-1));
            const note = this.notes.find(n => n.id === Number(args[0]) && n.user_id === uid);
            return note ? [{ id: note.id }] : [];
        }
        if (s.startsWith("SELECT title, content FROM notes")) {
            const uid = Number(args.at(-1));
            const note = this.notes.find(n => n.id === Number(args[0]) && n.user_id === uid);
            return note ? [{ title: note.title, content: note.content }] : [];
        }
        if (s.startsWith("SELECT id, uuid, title, content")) {
            const uid = Number(args.at(-1));
            const note = this.notes.find(n => n.id === Number(args[0]) && n.user_id === uid);
            return note ? [note] : [];
        }
        if (s.startsWith("SELECT r.id, r.note_id")) {
            // args: uid(JOIN), noteId, revisionId
            const uid = Number(args[0]);
            const note = this.notes.find(n => n.id === Number(args[1]) && n.user_id === uid);
            if (!note) return [];
            const rev = this.revisions.find(r => r.id === Number(args[2]) && r.note_id === note.id);
            return rev ? [rev] : [];
        }
        if (s.startsWith("SELECT id, note_id, title, length(content)")) {
            const noteId = Number(args[0]);
            const uid = Number(args[1]);
            return this.revisions
                .filter(r => r.note_id === noteId && (uid === 0 || r.user_id === uid))
                .sort((a, b) => b.id - a.id)
                .map(r => ({ id: r.id, note_id: r.note_id, title: r.title, size: r.content.length }));
        }
        return [];
    }

    prepare(sql: string) {
        const self = this;
        let args: unknown[] = [];
        const stmt = {
            _sql: sql,
            get _args() { return args; },
            bind(...a: unknown[]) { args = a; return stmt; },
            async first() { return self.select(sql, args)[0] ?? null; },
            async all() {
                // all() 既可能是查询，也可能是 INSERT…RETURNING
                if (/^\s*(INSERT|UPDATE|DELETE)/i.test(self.norm(sql))) {
                    self.run(sql, args);
                    return { results: [], success: true };
                }
                return { results: self.select(sql, args), success: true };
            },
            async run() { self.run(sql, args); return { success: true, results: [] }; },
        };
        return stmt;
    }

    async batch(stmts: { _sql: string; _args?: unknown[] }[]) {
        return stmts.map(s => { this.run(s._sql, s._args ?? []); return { results: [], success: true }; });
    }

    async exec() { return { count: 0 }; }
    first() { return null; }
}

function apiWith(db: MockD1, uid: number) {
    const api = new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-revision",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
    api.setCurrentUser(uid);
    return api;
}

test("改了内容才留快照，内容没变不留", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 2, title: "标题", content: "原文" });
    const api = apiWith(db, 2);

    await api.updateNote(1, { content: "改过的" });
    assert.equal(db.revisions.length, 1, "真改动要留一份改动前的内容");
    assert.equal(db.revisions[0].content, "原文");

    // 再存一次**同样**的内容：不该再堆一份一模一样的
    await api.updateNote(1, { content: "改过的" });
    assert.equal(db.revisions.length, 1, "内容没变就不该再存一版（自动保存会疯狂触发）");
});

test("只改置顶/归档这类元数据不产生快照", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 2, title: "标题", content: "原文" });
    const api = apiWith(db, 2);
    await api.updateNote(1, { pinned: true, archived: false });
    assert.equal(db.revisions.length, 0, "正文没动就不该占历史记录");
});

test("快照数量有上限，超出从最旧开始裁", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 2, title: "标题", content: "v0" });
    const api = apiWith(db, 2);
    // 连改 80 次，超过了后端的 60 条上限
    for (let i = 1; i <= 80; i++) {
        await api.updateNote(1, { content: `v${i}` });
    }
    assert.ok(db.revisions.length <= 60, `不该超过 60 条，实际 ${db.revisions.length}`);
    assert.equal(db.revisions.length, 60);
    // 留的是**最近**的 60 条（最新的快照对应最后一次改动前的内容）
    assert.equal(db.revisions.at(-1)!.content, "v79");
});

test("跨账号拿不到别人的笔记与快照", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 1, title: "别人的", content: "x" });
    db.revisions.push({ id: 9, note_id: 1, user_id: 1, title: "别人的", content: "秘密" });
    const api = apiWith(db, 2);
    assert.deepEqual(await api.listNoteRevisions(1), [], "别人的笔记不该列出历史");
    assert.equal(await api.getNoteRevision(1, 9), null, "不该读到别人的快照正文");
    assert.equal(await api.restoreNoteRevision(1, 9), null);
});

test("拿 A 笔记的快照 id 读 B 笔记要读不到", async () => {
    const db = new MockD1();
    db.notes.push(
        { id: 1, user_id: 2, title: "甲", content: "甲正文" },
        { id: 2, user_id: 2, title: "乙", content: "乙正文" }
    );
    db.revisions.push({ id: 5, note_id: 2, user_id: 2, title: "乙旧版", content: "乙旧正文" });
    const api = apiWith(db, 2);
    assert.equal(await api.getNoteRevision(1, 5), null, "note_id 对不上必须读不到");
});

test("列表不返回正文全文（省得一次拉几十份），单取才有", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 2, title: "标题", content: "现在" });
    db.revisions.push({ id: 3, note_id: 1, user_id: 2, title: "标题", content: "很久以前" });
    const api = apiWith(db, 2);
    const list = await api.listNoteRevisions(1);
    assert.equal(list.length, 1);
    assert.equal((list[0] as { content?: string }).content, undefined, "列表里不该带正文");
    const one = await api.getNoteRevision(1, 3);
    assert.equal(one?.content, "很久以前");
});

test("恢复某版会把它写回正文，并给恢复前的内容再留一份快照", async () => {
    const db = new MockD1();
    db.notes.push({ id: 1, user_id: 2, title: "标题", content: "现在的正文" });
    db.revisions.push({ id: 4, note_id: 1, user_id: 2, title: "标题", content: "旧版正文" });
    const api = apiWith(db, 2);
    const note = await api.restoreNoteRevision(1, 4);
    assert.equal(note?.content, "旧版正文", "恢复后正文要真的换回去");
    assert.equal(db.notes[0].content, "旧版正文");
    assert.ok(
        db.revisions.some(r => r.content === "现在的正文"),
        "恢复前的正文也要留档 —— 恢复这个动作本身要能撤回"
    );
});

// 类型守卫：ExportData 不该被这次改动带偏（顺带确保 import 仍可用）
test("导出类型未被版本历史影响", () => {
    const data: ExportData = { groups: [], sites: [], configs: {}, version: "1.4", exportDate: "" };
    assert.equal(data.version, "1.4");
});
