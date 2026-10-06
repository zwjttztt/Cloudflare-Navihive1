// tests/noteTransfer.test.ts
// 记事本随备份导入/导出的行为用例（transfer.ts）。
//
// 这一组钉的是**方案里定下的三条决策**，每一条写错了都不会报错，
// 只会让用户的笔记悄悄消失或凭空多出一份：
//
//   1. **备份里没有 notes 字段 → 本地笔记一根汗毛都不动**。
//      清空不可逆，宁可什么都不做。老备份（没有记事本）必须走这条路。
//   2. **合并（默认）按 uuid 识别同一条**：本地没有就插入；同 uuid 时比
//      updated_at，文件里较新才覆盖，本地较新就跳过。
//      没有 uuid 就会退化成「每次导入都多一份」。
//   3. **覆盖（replace）才清本地**，且清空与插入在同一次提交里 ——
//      中途失败不能出现「笔记全没了」。
//
// 另外两条硬要求：**user_id 只能写导入者自己**（那是唯一的账号隔离依据），
// **id 必须重分配**（备份里的 id 是对方库的，照搬必撞主键）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { transferImpl } from "../src/API/methods/transfer";
import { normalizeImportData } from "../src/API/methods/transfer";
import type { NavigationAPI } from "../src/API/navigationApi";
import type { ExportData, Note } from "../src/API/types";
import { extractNoteTags } from "../src/utils/markdownNoteTags";

interface NoteRow {
    id: number;
    user_id: number | null;
    uuid: string | null;
    title: string;
    content: string;
    pinned: number;
    order_num: number;
    site_id: number | null;
    folder_id?: number | null;
    archived?: number;
    updated_at: string;
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-06-01T00:00:00.000Z";

/** 只实现 importData / exportData 走到的语句。撞号会真的抛错（模拟主键冲突）。 */
class MockD1 {
    notes: NoteRow[] = [];
    /** 记录笔记相关的语句，用来验证「哪些表被动过」 */
    log: string[] = [];
    folders: { id: number; name: string; user_id: number | null; parent_id?: number | null }[] = [];
    tags: { id: number; name: string; user_id: number | null }[] = [];
    links: { note_id: number; tag_id: number }[] = [];
    writtenNotes: number[] = [];
    updatedNotes: number[] = [];
    deletedNotes: number[] = [];
    nextNoteAutoId = 1000;

    constructor(seed: NoteRow[] = []) {
        this.notes = [...seed];
        this.nextNoteAutoId = Math.max(0, ...this.notes.map(n => n.id)) + 1;
    }

    private norm(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    prepare(sql: string) {
        const s = this.norm(sql);
        return {
            first: async () => this.run(s, [], "first"),
            all: async () => this.run(s, [], "all"),
            run: async () => this.run(s, [], "run"),
            bind: (...args: unknown[]) => ({
                first: async () => this.run(s, args, "first"),
                all: async () => this.run(s, args, "all"),
                run: async () => this.run(s, args, "run"),
            }),
        };
    }

    /** 真实 D1 的 batch 会执行每条语句；这里必须真的跑，否则测的是「什么都没写」 */
    async batch(statements: { run: () => Promise<unknown> }[]) {
        const results = [];
        for (const st of statements) {
            results.push(await st.run());
        }
        return results;
    }

    private run(s: string, args: unknown[], mode: "first" | "all" | "run") {
        this.log.push(s);

        // ── notes 相关 ──
        if (s.startsWith("SELECT COALESCE(MAX(id), 0) AS m FROM notes")) {
            const m = Math.max(0, ...this.notes.map(n => n.id));
            return mode === "first" ? { m } : { results: [{ m }] };
        }
        if (s.startsWith("SELECT id FROM notes")) {
            const rows = this.notes.map(n => ({ id: n.id }));
            return mode === "first" ? (rows[0] ?? null) : { results: rows };
        }
        if (s.startsWith("SELECT id, uuid, title, content, pinned, order_num, site_id, updated_at FROM notes")) {
            return { results: this.notes.map(n => ({ ...n })) };
        }
        if (s.startsWith("INSERT INTO notes")) {
            const [id, userId, uuid, title, content, pinned, orderNum, siteId, folderId, archived] = args as [
                number,
                number | null,
                string,
                string,
                string,
                number,
                number,
                number | null,
                number | null,
                number,
            ];
            if (this.notes.some(n => n.id === id)) {
                throw new Error(`UNIQUE constraint failed: notes.id = ${id}`);
            }
            this.notes.push({
                id,
                user_id: userId,
                uuid,
                title,
                content,
                pinned,
                order_num: orderNum,
                site_id: siteId,
                folder_id: folderId,
                archived,
                updated_at: T0,
            });
            this.writtenNotes.push(id);
            return { success: true, results: [{ id }] };
        }
        if (s.startsWith("UPDATE notes SET uuid")) {
            const [uuid, title, content, pinned, orderNum, siteId, hasFolder, folderId, archived, id] = args as [
                string,
                string,
                string,
                number,
                number,
                number | null,
                number,
                number | null,
                number | null,
                number,
            ];
            const row = this.notes.find(n => n.id === id);
            if (row) {
                Object.assign(row, {
                    uuid,
                    title,
                    content,
                    pinned,
                    order_num: orderNum,
                    site_id: siteId,
                    ...(hasFolder ? { folder_id: folderId } : {}),
                    ...(archived !== null ? { archived } : {}),
                    updated_at: T0,
                });
                this.updatedNotes.push(id);
            }
            return { success: true };
        }
        if (s.startsWith("DELETE FROM notes WHERE id IN")) {
            // 前 N 个参数是 id 列表（N = 语句里问号的个数）
            const placeholders = (s.match(/\?/g) || []).length;
            const ids = (args as unknown[]).slice(0, placeholders);
            for (const raw of ids) {
                const id = Number(raw);
                this.deletedNotes.push(id);
                this.notes = this.notes.filter(n => n.id !== id);
            }
            return { success: true };
        }

        for (const [table, rows] of [["note_folder", this.folders], ["note_tag", this.tags]] as const) {
            if (s.startsWith(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)) return { m: Math.max(0, ...rows.map(r => r.id)) };
            if (s.startsWith(`SELECT id, name FROM ${table}`) || s.startsWith(`SELECT id, name, parent_id FROM ${table}`)) return { results: rows };
            if (s.startsWith(`INSERT INTO ${table} `)) {
                rows.push({ id: Number(args[0]), user_id: args[1] as number | null, name: String(args[2]),
                    ...(table === "note_folder" ? { parent_id: args[4] as number | null } : {}) });
                return { success: true };
            }
        }
        if (s.startsWith("DELETE FROM note_note_tag")) {
            this.links = this.links.filter(l => l.note_id !== args[0]);
            return { success: true };
        }
        if (s.startsWith("INSERT OR IGNORE INTO note_note_tag")) {
            this.links.push({ note_id: Number(args[0]), tag_id: Number(args[1]) });
            return { success: true };
        }
        // ── 其余表：只求「别把 importData 弄崩」 ──
        if (s.startsWith("SELECT COALESCE(MAX(id), 0) AS m FROM")) return { m: 0 };
        if (s.startsWith("SELECT id FROM")) return { results: [] };
        if (s.startsWith("SELECT key, value FROM configs")) return { results: [] };
        if (s.startsWith("SELECT")) return { results: [] };
        return { success: true, results: [] };
    }
}

function makeApi(db: MockD1, uid: number | null = 7): NavigationAPI {
    return {
        currentUserId: uid,
        db: db as never,
        migrate: async () => {},
        withSchemaRetry: async <T,>(fn: () => Promise<T>) => fn(),
        scopeSql: () => "",
        scopeParams: (p: unknown[]) => p,
        scopeFor: async () => uid,
        canManageSharedConfigs: async () => true,
        queryUserConfigs: async () => ({}),
        encryptSitePasswords: async (drafts: unknown[]) => drafts,
        decryptSitePasswords: async (sites: unknown[]) => sites,
        listOwnedIds: async (table: string) => {
            if (table !== "notes") return [];
            return db.notes.map(n => n.id);
        },
        nextIdBase: async (table: string) => {
            if (table !== "notes") return 0;
            return Math.max(0, ...db.notes.map(n => n.id));
        },
        writeAudit: async () => {},
        pushToRecycle: async () => undefined,
        getCurrentUserId: () => uid,
    } as unknown as NavigationAPI;
}

function note(over: Partial<Note> = {}): Note {
    return {
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        order_num: 0,
        site_id: null,
        updated_at: T0,
        ...over,
    };
}

function backup(notes?: Note[]): ExportData {
    return {
        groups: [],
        sites: [],
        configs: {},
        ...(notes ? { notes } : {}),
        version: "test",
        exportDate: T0,
    };
}

async function runImport(data: ExportData, uid: number | null = 7) {
    const db = new MockD1();
    const api = makeApi(db, uid);
    const result = await transferImpl.importData.call(api, data);
    return { db, result };
}

test("备份里没有 notes 字段 → 本地笔记一根汗毛都不动", async () => {
    const db = new MockD1([
        {
            id: 1,
            user_id: 7,
            uuid: "keep-me",
            title: "本地的笔记",
            content: "重要",
            pinned: 1,
            order_num: 0,
            site_id: null,
            updated_at: T1,
        },
    ]);
    const api = makeApi(db);
    const result = await transferImpl.importData.call(api, backup() /* 没有 notes */);

    assert.equal(db.notes.length, 1, "老备份导入后本地笔记必须还在");
    assert.equal(db.notes[0].title, "本地的笔记");
    assert.deepEqual(db.deletedNotes, [], "一条都不该被删");
    assert.deepEqual(db.writtenNotes, [], "一条都不该被插入");
    assert.equal(result.success, true);
    // 统计全 0 表示「这份备份与笔记无关」，不是「导入后笔记没了」
    assert.deepEqual(result.noteStats, { created: 0, updated: 0, skipped: 0, removed: 0 });
});

test("合并（默认）：本地没有的 uuid → 新增", async () => {
    const { db, result } = await runImport(backup([note({ uuid: "new-1" })]));
    assert.equal(db.notes.length, 1);
    assert.equal(db.writtenNotes.length, 1);
    assert.equal(result.noteStats?.created, 1);
    assert.equal(result.noteStats?.updated, 0);
    assert.equal(result.noteStats?.skipped, 0);
});

test("合并：同 uuid 且文件里更新 → 覆盖本地那条（UPDATE，不新建）", async () => {
    const db = new MockD1([
        {
            id: 5,
            user_id: 7,
            uuid: "same",
            title: "旧标题",
            content: "旧内容",
            pinned: 0,
            order_num: 0,
            site_id: null,
            updated_at: T0,
        },
    ]);
    const api = makeApi(db);
    const result = await transferImpl.importData.call(
        api,
        backup([note({ uuid: "same", title: "新标题", updated_at: T1 })])
    );

    assert.equal(db.notes.length, 1, "覆盖不该产生第二条");
    assert.equal(db.notes[0].title, "新标题");
    assert.deepEqual(db.writtenNotes, [], "覆盖是 UPDATE 不是 INSERT");
    assert.deepEqual(db.updatedNotes, [5], "要更新回原 id，新建再删会把 updated_at 弄丢");
    assert.equal(result.noteStats?.updated, 1);
});

test("合并：同 uuid 但本地更新 → 跳过，保留本地那份", async () => {
    const db = new MockD1([
        {
            id: 5,
            user_id: 7,
            uuid: "same",
            title: "本地较新",
            content: "本地内容",
            pinned: 1,
            order_num: 0,
            site_id: null,
            updated_at: T1,
        },
    ]);
    const api = makeApi(db);
    const result = await transferImpl.importData.call(
        api,
        backup([note({ uuid: "same", title: "文件里较旧", updated_at: T0 })])
    );

    assert.equal(db.notes[0].title, "本地较新", "本地较新时不该被文件里的旧版本盖掉");
    assert.deepEqual(db.writtenNotes, []);
    assert.deepEqual(db.updatedNotes, []);
    assert.equal(result.noteStats?.skipped, 1);
    assert.equal(result.noteStats?.updated, 0);
});

test("合并：本地多出来的笔记原样保留", async () => {
    const db = new MockD1([
        {
            id: 1,
            user_id: 7,
            uuid: "local-only",
            title: "只在本地的",
            content: "",
            pinned: 0,
            order_num: 0,
            site_id: null,
            updated_at: T0,
        },
    ]);
    const api = makeApi(db);
    await transferImpl.importData.call(api, backup([note({ uuid: "from-file" })]));

    assert.equal(db.notes.length, 2, "合并的意思就是不动本地多余的");
    assert.ok(db.notes.some(n => n.uuid === "local-only"));
    assert.ok(db.notes.some(n => n.uuid === "from-file"));
});

test("完全覆盖：先清本地再插备份里的，removed 统计本地条数", async () => {
    const db = new MockD1([
        {
            id: 1,
            user_id: 7,
            uuid: "old-1",
            title: "会被清掉",
            content: "",
            pinned: 0,
            order_num: 0,
            site_id: null,
            updated_at: T0,
        },
        {
            id: 2,
            user_id: 7,
            uuid: "old-2",
            title: "也会被清掉",
            content: "",
            pinned: 0,
            order_num: 1,
            site_id: null,
            updated_at: T0,
        },
    ]);
    const api = makeApi(db);
    const result = await transferImpl.importData.call(
        api,
        backup([note({ uuid: "from-file" })]),
        { notesMode: "replace" }
    );

    assert.equal(db.notes.length, 1, "只剩备份里那一条");
    assert.equal(db.notes[0].uuid, "from-file");
    assert.deepEqual(db.deletedNotes.sort(), [1, 2]);
    assert.equal(result.noteStats?.removed, 2);
    assert.equal(result.noteStats?.created, 1);
});

test("备份里没有 notes 字段时，即使选了「完全覆盖」也不清本地", async () => {
    const db = new MockD1([
        {
            id: 1,
            user_id: 7,
            uuid: "keep",
            title: "本地笔记",
            content: "",
            pinned: 0,
            order_num: 0,
            site_id: null,
            updated_at: T0,
        },
    ]);
    const api = makeApi(db);
    await transferImpl.importData.call(api, backup(), { notesMode: "replace" });
    assert.equal(db.notes.length, 1, "备份里没有笔记 ≠ 「备份里一条笔记都没有」");
    assert.deepEqual(db.deletedNotes, []);
});

test("user_id 写的是导入者，不是文件里的值", async () => {
    const { db } = await runImport(backup([note({ uuid: "u" })]), 7);
    assert.equal(
        db.notes[0].user_id,
        7,
        "笔记必须归导入者 —— 文件里那个 user_id 是导出方的，照抄就越权了"
    );
});

test("id 重分配：不沿用备份文件里的 id", async () => {
    // 备份里的笔记带一个 id（正常导出时会被抹掉，但手改的文件可能有）
    const { db } = await runImport(backup([note({ id: 42, uuid: "x" })]));
    assert.notEqual(db.notes[0].id, 42, "id 必须由数据库重新发号");
});

test("导出时抹掉 id / user_id，保留 uuid", () => {
    const raw = [
        {
            id: 9,
            user_id: 3,
            uuid: "keep-uuid",
            title: "t",
            content: "c",
            pinned: true,
            order_num: 2,
            site_id: 5,
            created_at: T0,
            updated_at: T0,
        },
    ];
    const normalized = normalizeImportData({
        groups: [],
        sites: [],
        configs: {},
        notes: raw,
    } as never);
    const n = normalized.notes![0];
    assert.equal(n.uuid, "keep-uuid", "uuid 必须保留 —— 合并导入全靠它");
    assert.equal("id" in n, false, "id 不能进备份");
    assert.equal("user_id" in n, false, "user_id 不能进备份");
    assert.equal(n.pinned, true);
    assert.equal(n.site_id, 5);
});

test("归一化：没有 uuid 的老笔记会被补一个（否则每次导入都多一份）", () => {
    const normalized = normalizeImportData({
        groups: [],
        sites: [],
        configs: {},
        notes: [
            { title: "老笔记", content: "x" },
            { title: "另一条", content: "y" },
        ],
    } as never);
    const uuids = normalized.notes!.map(n => n.uuid);
    assert.equal(normalized.notes!.length, 2);
    assert.ok(uuids[0] && uuids[1], "每条都要有 uuid");
    assert.notEqual(uuids[0], uuids[1], "补出来的 uuid 不能撞");
});

test("归一化：非字符串的 title / content 被压成空串，不当对象存进去", () => {
    const normalized = normalizeImportData({
        groups: [],
        sites: [],
        configs: {},
        notes: [{ uuid: "u", title: { evil: 1 }, content: ["a"] }],
    } as never);
    assert.equal(normalized.notes![0].title, "");
    assert.equal(normalized.notes![0].content, "");
});

test("分类备份恢复：文件夹和标签重新映射，归档与关联保留", async () => {
    const db = new MockD1();
    db.folders.push({ id: 50, name: "别的分类", user_id: 7 });
    db.tags.push({ id: 70, name: "旧标签", user_id: 7 });
    const api = makeApi(db);
    const result = await transferImpl.importData.call(api, {
        ...backup([note({ uuid: "mapped", folder_id: 3, archived: true })]),
        noteFolders: [{ id: 3, name: "学习" }],
        noteTags: [{ id: 4, name: "知识" }],
        noteTagLinks: [{ note_uuid: "mapped", tag_id: 4 }],
    });
    assert.equal(result.success, true);
    assert.equal(db.notes[0].folder_id, 51);
    assert.equal(db.notes[0].archived, 1);
    assert.deepEqual(db.links, [{ note_id: db.notes[0].id, tag_id: 71 }]);
    assert.equal(db.folders[1].user_id, 7);
    assert.equal(db.tags[1].user_id, 7);
});

test("正文标签识别忽略代码、转义、链接及标题语法", () => {
    assert.deepEqual(extractNoteTags("# 标题\n正文 #中文 #work-tag #中文\n`#代码` \\#转义 [#链接](https://example.com)\n```\n#块代码\n```"), ["中文", "work-tag"]);
});

test("子文件夹备份按父子路径恢复，同名不同父不合并", async () => {
    const db = new MockD1();
    const result = await transferImpl.importData.call(makeApi(db), {
        ...backup([note({ folder_id: 2 })]),
        noteFolders: [{ id: 2, name: "资料", parent_id: 1 }, { id: 1, name: "工作" }, { id: 3, name: "资料" }],
    });
    assert.equal(result.success, true);
    assert.equal(db.folders.length, 3);
    assert.equal(db.folders[1].parent_id, db.folders[0].id);
    assert.equal(db.notes[0].folder_id, db.folders[1].id);
});

test("老备份更新正文不覆盖本地归档和分类", async () => {
    const db = new MockD1([{ id: 5, user_id: 7, uuid: "same", title: "旧",
        content: "旧", pinned: 0, order_num: 0, site_id: null,
        folder_id: 19, archived: 1, updated_at: T0 }]);
    const result = await transferImpl.importData.call(makeApi(db), backup([note({ uuid: "same", updated_at: T1 })]));
    assert.equal(result.success, true);
    assert.equal(db.notes[0].folder_id, 19);
    assert.equal(db.notes[0].archived, 1);
});

test("归一化：notes 字段缺失 ≠ 空数组（这是两种语义）", () => {
    const withoutField = normalizeImportData({ groups: [], sites: [], configs: {} } as never);
    assert.equal("notes" in withoutField, false, "老备份不该凭空多出 notes 字段");

    const withEmpty = normalizeImportData({
        groups: [],
        sites: [],
        configs: {},
        notes: [],
    } as never);
    assert.deepEqual(withEmpty.notes, [], "显式空数组是「这份备份里一条笔记都没有」");
});
