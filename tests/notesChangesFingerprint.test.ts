// tests/notesChangesFingerprint.test.ts
//
// 跨设备轮询的「变更指纹」（2026-10-28），在**真 SQLite** 上验证。
//
// 背景：`notes/changes` 每 30 秒一轮，原来每轮都把「文件夹 + 标签 + 标签关联」
// 整份倒给客户端，客户端再 JSON.stringify 比对形状 —— 上千条笔记时那是几十 KB，
// 而且**绝大多数轮询在传与上一轮完全相同的数据**。
//
// 这个文件要钉住三件事，每一件用错都会变成「静默的错」：
//   1. 指纹相同 → 回 `unchanged: true` 且三个快照字段为空（省流量）。
//   2. 指纹必须**真的跟着数据变**，包括那些「不写 updated_at」的改动：
//      `updateFolder` 改 order_num / icon / color 时**不碰 updated_at**，
//      `note_note_tag` 连时间戳列都没有。用「便宜的近似量」（比如 MAX(updated_at)）
//      做指纹就会漏判 —— 表现是「别的设备改了标签/文件夹，本机一直不刷新」。
//   3. 老客户端（不传指纹）永远拿全量，行为与改造前逐字一致。
import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { notesSnapshotFingerprint } from "../src/API/methods/notes/notesShared";

async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

test("真实 SQLite：首次轮询回全量 + 指纹；带同一个指纹再问 → unchanged 且快照为空", async () => {
    const { api } = await fresh();
    await api.createNote({ title: "甲", content: "x" });
    const folder = await api.createFolder({ name: "工作" });

    const first = await api.notesChanges();
    assert.equal(first.unchanged, false, "没有基线时必须回全量");
    assert.equal(first.folders.length, 1);
    assert.ok(typeof first.fingerprint === "string" && first.fingerprint.length > 0, "必须给指纹");

    const again = await api.notesChanges(first.now, first.fingerprint);
    assert.equal(again.unchanged, true, "指纹没变 → 只回 unchanged");
    assert.deepEqual(again.folders, [], "unchanged 时快照字段必须是空的（客户端沿用手里那份）");
    assert.deepEqual(again.tags, []);
    assert.deepEqual(again.noteTags, {});
    assert.equal(again.fingerprint, first.fingerprint, "指纹要原样回给客户端，下一轮继续用");
    assert.ok(again.now.length >= 19, "游标照常推进");

    // 空快照**不代表**数据没了：不带指纹再问一次，快照还是完整的
    const full = await api.notesChanges();
    assert.equal(full.folders.length, 1);
    assert.equal(full.folders[0].id, folder.id);
});

test("真实 SQLite：改文件夹顺序（不写 updated_at）也必须让指纹变", async () => {
    // 这是本文件的核心：updateFolder 只 UPDATE order_num / icon / color，
    // 语句里**没有** updated_at = CURRENT_TIMESTAMP（见 notesFolder.ts）。
    // 所以任何基于 MAX(updated_at) 的「便宜指纹」在这里都会漏判 ——
    // 那样手机上拖一下文件夹顺序，电脑上永远看不到。
    const { api } = await fresh();
    const folder = await api.createFolder({ name: "工作" });
    const before = await api.notesChanges();
    await api.updateFolder(folder.id!, { order_num: 42 });
    const after = await api.notesChanges(before.now, before.fingerprint!);
    assert.notEqual(after.fingerprint, before.fingerprint, "order_num 变了，指纹必须跟着变");
    assert.equal(after.unchanged, false, "不能误报 unchanged");
    assert.equal(after.folders[0].order_num, 42, "变了就要真的把快照带回来");
});

test("真实 SQLite：标签关联互换（行集合变、计数不变）也要让指纹变", async () => {
    // note_note_tag 没有时间戳列，也没有 count 变化：
    // 笔记 A [标签1] / 笔记 B [标签2] 互换之后，两张表的行数、SUM 都没变多少。
    // 这正是「近似指纹」最容易翻车的地方，必须真的读到行内容才发现。
    const { api } = await fresh();
    const a = await api.createNote({ title: "甲", content: "x" });
    const b = await api.createNote({ title: "乙", content: "x" });
    const t1 = await api.createTag({ name: "待办" });
    const t2 = await api.createTag({ name: "想法" });
    await api.setNoteTags(a.id!, [t1.id!]);
    await api.setNoteTags(b.id!, [t2.id!]);
    const before = await api.notesChanges();
    // 互换
    await api.setNoteTags(a.id!, [t2.id!]);
    await api.setNoteTags(b.id!, [t1.id!]);
    const after = await api.notesChanges(before.now, before.fingerprint!);
    assert.notEqual(after.fingerprint, before.fingerprint, "标签归属互换之后指纹必须变");
    assert.equal(after.unchanged, false);
    assert.deepEqual(after.noteTags[a.id!], [t2.id!], "变了就要把新的关联带回来");
});

test("真实 SQLite：不传指纹（老客户端）永远回全量，行为与改造前一致", async () => {
    const { api } = await fresh();
    await api.createFolder({ name: "工作" });
    const a = await api.notesChanges();
    const b = await api.notesChanges(a.now);
    assert.equal(b.unchanged, false, "没带指纹就没有基线，必须回全量");
    assert.equal(b.folders.length, 1, "老客户端依赖这份快照做形状比对，不能给它空数组");
});

test("真实 SQLite：传了一个对不上的指纹 → 回全量（不是「无条件 unchanged」）", async () => {
    const { api } = await fresh();
    await api.createFolder({ name: "工作" });
    const r = await api.notesChanges(undefined, "deadbeef");
    assert.equal(r.unchanged, false, "指纹对不上时必须回全量");
    assert.equal(r.folders.length, 1);
});

test("真实 SQLite：笔记增删改仍然通过 notesChanged 上报（指纹只覆盖快照，不能把它吞掉）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "x" });
    const first = await api.notesChanges();
    await api.updateNote(note.id!, { content: "改过了" });
    const second = await api.notesChanges(first.now, first.fingerprint!);
    // ⚠️ 这里 unchanged **允许是 true**：指纹只覆盖「文件夹/标签/标签关联」这份快照，
    // 不含笔记正文（正文的体积和「变没变」由 notes_changed 那条 updated_at 计数负责）。
    // 客户端两条信号是**并列**的：`shouldReload = notesChanged > 0 || structural`。
    // 真正要守的是「笔记变了必须报出来」—— 报了就不能丢。
    assert.ok(second.notesChanged >= 1, "改了笔记必须报变更（这条走 updated_at 计数，与指纹无关）");
    assert.deepEqual(second.changedNoteIds, [note.id], "要能定位到具体是哪一条");
});

test("指纹函数：无关于顺序（标签 id 排序），但关于内容", async () => {
    // 规范化那几句（排序 / 字段拼接）如果写错，会出现「数据没变但指纹变了」——
    // 表现是每一轮都白刷一次列表，比漏报更容易被当成「轮询本来就该刷」而放过。
    const folders = [{ id: 1, parent_id: null, name: "工作", order_num: 0, icon: null, color: null }];
    const tags = [{ id: 2, name: "待办", color: "#fff" }];
    const base = notesSnapshotFingerprint(folders, tags, { 10: [1, 2] });
    assert.equal(
        notesSnapshotFingerprint(folders, tags, { 10: [2, 1] }),
        base,
        "标签 id 顺序不影响指纹（后端返回顺序不该被当成变更）"
    );
    assert.notEqual(notesSnapshotFingerprint(folders, tags, { 10: [1] }), base);
    assert.notEqual(
        notesSnapshotFingerprint([{ ...folders[0], name: "生活" }], tags, { 10: [1, 2] }),
        base,
        "改名字必须变"
    );
    assert.notEqual(
        notesSnapshotFingerprint([{ ...folders[0], color: "red" }], tags, { 10: [1, 2] }),
        base,
        "改颜色必须变"
    );
    // 键的顺序不影响（对象整数键本来就升序，这里显式倒着构造一次）
    assert.equal(
        notesSnapshotFingerprint(folders, tags, { 10: [1, 2], 3: [9] }),
        notesSnapshotFingerprint(folders, tags, { 3: [9], 10: [1, 2] })
    );
    // 指纹是定长十六进制串，方便直接进日志
    assert.match(base, /^[0-9a-f]{8}$/);
});
