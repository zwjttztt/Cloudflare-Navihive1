// 迁移 / 表结构：这类 bug 的后果不是报错，而是「用户一部署整站打不开」或者
// 「跑几个月后越来越慢」——单测跑不出来，只能靠把执行顺序和结果钉住。
//
// 这里用一个会**真的记表结构**的内存 D1 替身：CREATE TABLE / ALTER / CREATE INDEX
// 都照着改内存里的 schema，SELECT 也能回答 pragma_table_info。于是可以断言：
//   1. 八条索引最后都建出来了（以前是 try/catch 吞掉，建没建没人知道）；
//   2. 建索引时那张表、那一列**必须已经存在** —— 这正是踩过的坑：
//      sites.user_id 是 ALTER 补出来的，索引排在 ALTER 前面会因列不存在直接失败；
//   3. 索引建失败不影响启动（纯粹是性能优化）。

import assert from "node:assert/strict";
import test from "node:test";
import { resetMigrationCacheForTests } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { SCHEMA_VERSION } from "../src/API/methods/migration";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** 内存里的表结构：表名 → 列名集合 */
type Schema = Map<string, Set<string>>;

const CONSTRAINT_KEYWORDS = new Set(["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"]);

/** 按顶层逗号切分（括号内的逗号不算） */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of text) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current);
    return parts.map(part => part.trim());
}

class FakeD1 {
    schema: Schema = new Map();
    /** 执行过的 DDL，按发出顺序 */
    log: string[] = [];
    /** 建索引时「表或列还不存在」的记录 —— 正常应该永远是空的 */
    indexViolations: string[] = [];
    /** 让 CREATE INDEX 全部失败，用来验证不阻断启动 */
    failIndexes = false;

    apply(sql: string): void {
        const flat = sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
        this.log.push(flat);

        const createTable = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*)\)$/i.exec(flat);
        if (createTable) {
            const [, table, body] = createTable;
            const columns = new Set<string>();
            for (const part of splitTopLevel(body)) {
                const name = part.split(/\s+/)[0];
                if (!name || CONSTRAINT_KEYWORDS.has(name.toUpperCase())) continue;
                columns.add(name);
            }
            this.schema.set(table, columns);
            return;
        }

        const alter = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(flat);
        if (alter) {
            const [, table, column] = alter;
            if (!this.schema.has(table)) this.schema.set(table, new Set());
            this.schema.get(table)!.add(column);
            return;
        }

        const index = /^CREATE INDEX (?:IF NOT EXISTS )?(\w+) ON (\w+)\s*\(([^)]*)\)/i.exec(flat);
        if (index) {
            const [, name, table, cols] = index;
            if (this.failIndexes) throw new Error("模拟索引创建失败");
            const columns = this.schema.get(table);
            if (!columns) {
                this.indexViolations.push(`${name}: 表 ${table} 不存在`);
                return;
            }
            for (const column of cols.split(",").map(c => c.trim())) {
                // ⚠️ 要剥掉排序修饰：`id DESC` / `name ASC` 里真正的列名只是 `id`。
                //   不剥的话带 DESC 的索引会被误判成「列还不存在」——
                //   而 D1 / SQLite 接受这种写法（note_revision 的索引就用了 DESC）。
                const bare = column.replace(/\s+(ASC|DESC)$/i, "").replace(/["'`]/g, "");
                if (!columns.has(bare)) {
                    this.indexViolations.push(`${name}: ${table}.${bare} 列还不存在`);
                }
            }
        }
    }

    prepare(sql: string) {
        const args: unknown[] = [];
        const stmt = {
            bind: (...values: unknown[]) => {
                args.push(...values);
                return stmt;
            },
            all: async <T>(): Promise<{ results: T[]; success: boolean }> => ({
                results: this.queryAll(sql, args) as T[],
                success: true,
            }),
            first: async <T>(): Promise<T | null> =>
                (this.queryAll(sql, args)[0] as T) ?? null,
            run: async (): Promise<{ success: boolean }> => {
                this.apply(sql);
                return { success: true };
            },
        };
        return stmt;
    }

    async exec(sql: string): Promise<void> {
        this.apply(sql);
    }

    async batch(statements: Array<{ run: () => Promise<{ success: boolean }> }>): Promise<unknown[]> {
        // 一次 batch 里只要有一条炸了就整批失败（真实的 D1 也是这个语义），
        // 所以这里不吞异常 —— 调用方的回退逻辑才有机会被走到
        return Promise.all(statements.map(statement => statement.run()));
    }

    private queryAll(sql: string, args: unknown[]): unknown[] {
        const flat = sql.replace(/\s+/g, " ").trim();

        // hasColumn / findMissingSiteColumns：读表结构
        const pragma = /FROM pragma_table_info\((\?|'([^']+)')\)/i.exec(flat);
        if (pragma) {
            const table = String(pragma[2] ?? args[0] ?? "");
            return [...(this.schema.get(table) ?? [])].map(name => ({ name }));
        }

        // ensureOwnerUser：假装已经有一个 owner 账号，省掉后面读凭据的一串查询
        if (flat.includes("FROM users ORDER BY id LIMIT 1")) {
            return [{ id: 1, username: "root" }];
        }

        return [];
    }
}

function makeApi(db: FakeD1): NavigationAPI {
    return new NavigationAPI({
        DB: db as never,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

const EXPECTED_INDEXES = [
    "idx_sites_group_id",
    "idx_sites_user_id",
    "idx_groups_user_id",
    "idx_recycle_bin_owner",
    "idx_recycle_bin_deleted_at",
    "idx_audit_log_created_at",
    "idx_token_blacklist_exp",
    "idx_invites_expires_at",
    // 记事本（2026-10-05 新增）
    "idx_notes_user",
    "idx_notes_uuid",
    // 版本历史（2026-10-06）：按笔记查历史，没索引就是整表扫
    "idx_note_revision_note",
];

test("迁移建出全部 11 条索引，且每条索引建的时候表、列都已存在", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    await makeApi(db).migrate();

    for (const name of EXPECTED_INDEXES) {
        assert.ok(
            db.log.some(sql => sql.includes(`CREATE INDEX IF NOT EXISTS ${name}`)),
            `索引 ${name} 没有建 —— 迁移漏了还是被 try/catch 吞了？`,
        );
    }
    assert.deepEqual(db.indexViolations, [], "有索引建在了列还不存在的时候");
});

test("索引一定排在 user_id 补列之后（顺序错了在真实 D1 上会直接失败）", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    await makeApi(db).migrate();

    const idx = (needle: string) => db.log.findIndex(sql => sql.includes(needle));
    const sitesUserId = idx("ALTER TABLE sites ADD COLUMN user_id");
    const groupsUserId = idx("ALTER TABLE groups ADD COLUMN user_id");
    const firstIndex = db.log.findIndex(sql => sql.startsWith("CREATE INDEX"));

    assert.ok(sitesUserId >= 0, "sites 没有补 user_id 列");
    assert.ok(groupsUserId >= 0, "groups 没有补 user_id 列");
    assert.ok(firstIndex >= 0, "一条索引都没建");
    assert.ok(sitesUserId < firstIndex, "sites.user_id 的 ALTER 必须排在索引之前");
    assert.ok(groupsUserId < firstIndex, "groups.user_id 的 ALTER 必须排在索引之前");
});

test("建表语句覆盖所有被索引引用的表", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    await makeApi(db).migrate();

    for (const name of EXPECTED_INDEXES) {
        const sql = db.log.find(s => s.includes(`CREATE INDEX IF NOT EXISTS ${name}`))!;
        const table = /ON (\w+)\s*\(/.exec(sql)![1];
        assert.ok(db.schema.has(table), `索引 ${name} 指向的表 ${table} 从来没被建出来`);
    }
});

test("索引建失败只记日志，不阻断迁移", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    db.failIndexes = true;
    // 不该抛：索引只是性能优化，建不出来也得让站点起得来
    await assert.doesNotReject(makeApi(db).migrate());
});

test("迁移结果有缓存，同一 isolate 内不重复跑", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    const api = makeApi(db);
    await api.migrate();
    const after = db.log.length;
    await api.migrate();
    assert.equal(db.log.length, after, "第二次 migrate() 又跑了一遍建表");
});

test("版本号不等于旧值 —— 加了新表就必须 +1，否则线上那个表永远建不出来", () => {    // 这是一条真踩过的坑：`migrateIfNeeded` 读到与库里相同的版本号就**直接返回，
    // 连 CREATE TABLE 都不跑**。于是新表只在「全新迁移」的库里有（本地、新部署），
    // 已经部署过的实例上一律没有 → 那个表的接口全部 500。
    // 本地测试用 FakeD1，每次都是空库 + 全新迁移，所以**本地永远发现不了**。
    // 只能靠这条静态断言把「建表语句变过、版本号却没变」钉住。
    const source = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "internals.ts"),
        "utf-8"
    );
    const tables = [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);

    // 拿一张「只有老版本才会建的表」当锚点：它一定在，但它属于旧版本
    const ANCHOR = "invites";
    assert.ok(tables.includes(ANCHOR), `建表语句里连 ${ANCHOR} 都没了，测试本身该更新`);

    // 建表语句里有没有比锚点更新的表（notes 是 2026-10-05 加的，排在锚点之后）
    const newer = tables.filter(t => !["groups", "sites", "configs", ANCHOR].includes(t));
    assert.ok(
        newer.length > 0,
        "建表语句里没有「较新」的表了 —— 如果是有意回退，请同步更新这条用例的说明"
    );

    // 版本号必须够新：2026-10-05 加 notes 时是 3。这里用「数字不小于 3」而不是精确值，
    // 这样以后再加表（版本号继续 +1）这条用例仍然成立，也不会逼着每次都改它。
    const version = Number(SCHEMA_VERSION);
    assert.ok(
        Number.isFinite(version) && version >= 3,
        `SCHEMA_VERSION=${SCHEMA_VERSION} —— 2026-10-05 加了 notes 表，版本号至少要 3。` +
            "忘了 +1 的话，已部署的实例上 notes 表永远不会被建，接口一律 500。"
    );
});

// ---- 阶段三收尾踩到的真 bug（2026-10-05，线上「加载记事本失败: API 错误: 500」）----
//
// 现象：新表 note_folder / note_tag 建出来了，但 notes 表**没有 folder_id 列**，
// 而 NOTE_FIELDS 里已经带上了它 → 所有 notes 接口 500。
// 根因：migrateNoteColumns 写成
//     if (await hasColumn("notes", "archived")) return;   ← archived 早就有了
//     ... ALTER TABLE notes ADD COLUMN folder_id INTEGER
// 于是这个 return 把 folder_id 的 ALTER 一起跳过了。
// 换句话说：**「这一列不需要补」被误当成了「这个函数可以下班了」**。

test("notes.folder_id 会被补出来，哪怕 archived 列早就存在", async () => {
    resetMigrationCacheForTests();
    const db = new FakeD1();
    // 复刻线上现状：notes 表齐全，但只有 archived、**没有** folder_id
    db.schema.set(
        "notes",
        new Set([
            "id", "user_id", "uuid", "title", "content",
            "pinned", "order_num", "site_id", "created_at", "updated_at", "archived",
        ]),
    );
    await makeApi(db).migrate();

    assert.ok(
        db.schema.get("notes")!.has("folder_id"),
        "notes.folder_id 没被补上 —— 一旦缺这列，NOTE_FIELDS 里的 folder_id 会让所有 notes 接口 500"
    );
});

test("note_folder.parent_id 会被补出来（即便表是老版本建的、没有 parent_id）", async () => {
    // 复刻 2026-10-06 线上现状：note_folder 表存在，但只有老版本那几列、**没有** parent_id。
    // 根因：CREATE TABLE IF NOT EXISTS 对已存在的表不补列，而 migrateFolderTagTables
    // （负责 ALTER 补 parent_id）定义后没接进 runMigrations —— 于是老库上
    // createFolder(INSERT parent_id) / deleteFolder(UPDATE parent_id = NULL) 一律 500。
    // 这条用例把「老库 + 新代码」的状态钉住：一旦有人又把父级调用改掉，这里立刻红。
    resetMigrationCacheForTests();
    const db = new FakeD1();
    db.schema.set(
        "note_folder",
        new Set(["id", "user_id", "name", "order_num", "created_at", "updated_at"]),
    );
    await makeApi(db).migrate();

    assert.ok(
        db.schema.get("note_folder")!.has("parent_id"),
        "note_folder.parent_id 没被补上 —— 老库上「新建文件夹 / 删除文件夹」会 500"
    );
});

test("hasColumn 不能用绑定参数查 pragma_table_info（那样恒为 false，补列等于没做）", async () => {
    // pragma_table_info(?) 在 D1 上直接抛语法错，catch 掉之后 hasColumn 永远返回 false，
    // 于是每轮迁移都盲发一次 ALTER、失败还被静默吞掉 —— 列永远补不上。
    // 所以这里要求：表名是白名单校验后**插值**进去的，和 findMissingSiteColumns 一样。
    const source = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "migration.ts"),
        "utf-8"
    );
    const hasColumnBody = /hasColumn: async function[\s\S]*?\n {4}\},/.exec(source)?.[0] ?? "";
    assert.ok(hasColumnBody, "没找到 hasColumn 的实现，测试本身该更新");
    assert.ok(
        !/pragma_table_info\(\?\)/.test(hasColumnBody),
        "hasColumn 又用回 pragma_table_info(?) 了 —— 它在 D1 上抛错，恒返回 false"
    );
    assert.match(
        hasColumnBody,
        /pragma_table_info\(/,
        "hasColumn 应该用 pragma_table_info('表名') 的插值写法"
    );
});

test("migrateNoteColumns 里不能有「archived 已存在就 return」这种提前退出", async () => {
    // 静态守卫：两列必须**各判各的**。一旦有人图省事写回 early-return，
    // 下面那条「notes.folder_id 会被补出来」在全新库上依然会绿（全新库建表语句里
    // 本来就有 folder_id），只有线上那种「老表 + 新代码」才会炸 —— 纯靠运行测不出来。
    const source = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "migration.ts"),
        "utf-8"
    );
    const body = /migrateNoteColumns: async function[\s\S]*?\n {4}\},/.exec(source)?.[0] ?? "";
    assert.ok(body, "没找到 migrateNoteColumns 的实现，测试本身该更新");
    assert.ok(
        !/if \(await this\.hasColumn\([^)]*\)\) return;/.test(body),
        "migrateNoteColumns 里又有「hasColumn 为真就 return」—— 会把后面几列的 ALTER 一起跳过"
    );
    assert.match(body, /folder_id/, "migrateNoteColumns 里看不到 folder_id，补列逻辑不见了");
    assert.match(body, /archived/, "migrateNoteColumns 里看不到 archived");
});
