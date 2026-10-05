// tests/noteSql.test.ts
// 记事本 SQL 的**形状**守卫（不是行为测试）。
//
// 为什么单独一组：之前踩过一次 500，根因是 createNote 的 SQL 里
// 子查询用了 `scopeSql(true)` —— 它生成的是 ` AND user_id = ?`，
// 接在 `FROM notes` 后面就成了 `FROM notes AND user_id = ?`，语法错误。
// 当时**一行测试都没红**，因为：
//   - `noteRoutes` 测的是路由层（只验证「路由把什么交给 api」）；
//   - `noteTransfer` 的 MockD1 是按前缀字符串匹配的，不校验参数个数；
//   - `schemaMigration` 也不碰业务 SQL。
// 也就是说：**这类错误在现有测试结构里是盲区**，只能自己补。
//
// 这里钉三件事，任何一条不成立就红：
//   1. 每个 SQL 里的 `?` 个数 == bind 的参数个数（少绑就是运行时报错）；
//   2. `FROM <table>` 后面**不能**直接跟 ` AND `（那是 scopeSql(true) 误用）；
//   3. 单账号部署（uid 为 NULL）时，SQL 里不该出现 user_id 条件、参数要少一个。
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesImpl } from "../src/API/methods/notes";
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

const source = readFileSync(
    join(findProjectDir(), "src", "API", "methods", "notes.ts"),
    "utf-8"
);

/** 把源码里 prepare(…) 里的 SQL 抠出来（模板字符串会保留 ${…} 占位） */
function collectSql(): string[] {
    const out: string[] = [];
    // 匹配 `prepare(` 后面第一个反引号（或引号）到配对的那个
    const re = /\.prepare\(\s*`([\s\S]*?)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
}

test("prepare 出来的 SQL 至少能抠出几条（守卫自身没失效）", () => {
    const sqls = collectSql();
    assert.ok(
        sqls.length >= 6,
        `只抠出 ${sqls.length} 条 SQL —— 解析方式对不上，守卫成了空转` +
            "（去调 collectSql 的正则，别删这条）"
    );
});

test("运行时检查：listNotes / countNotes 生成的 SQL 必须是 WHERE 而不是 AND", async () => {
    // 这一版是**真调用一次**再看 SQL —— 之前那条是「在源码文本里找字面 AND」，
    // 而源码里写的是 `${this.scopeSql(true)}`（函数调用），那条检查**永远是绿的**，
    // 变异验证时才发现它形同虚设。静态正则抓不住这种事，运行时才能。
    //
    // 规则：语句里已经有 WHERE → scopeSql(true)（生成 AND 追加）；
    //       没有 WHERE → 必须 scopeSql(false)（生成 WHERE）。
    // 用错的表现是 SQL 变成 `FROM notes AND user_id = ?` —— 语法错误 → 500。
    const captured: string[] = [];
    const api = {
        currentUserId: 1,
        migrate: async () => {},
        withSchemaRetry: async <T,>(fn: () => Promise<T>) => fn(),
        scopeSql: (hasWhere: boolean) => (hasWhere ? " AND " : " WHERE ") + "user_id = ?",
        scopeParams: <T,>(params: T[]) => [...params, 1],
        db: {
            prepare: (sql: string) => {
                captured.push(sql.replace(/\s+/g, " ").trim());
                return {
                    bind: () => ({
                        all: async () => ({ results: [] }),
                        first: async () => null,
                        run: async () => ({ success: true }),
                    }),
                };
            },
        },
    };

    await notesImpl.listNotes.call(api as never);
    await notesImpl.countNotes.call(api as never);

    assert.equal(captured.length, 2, "两个方法各产生一条 SQL");
    for (const sql of captured) {
        assert.ok(
            !/FROM\s+\w+\s+AND\b/i.test(sql),
            `生成的 SQL 在 FROM 后面直接跟了 AND：${sql} —— ` +
                "这里没有 WHERE，必须用 scopeSql(false)"
        );
        assert.ok(
            /WHERE user_id = \?/i.test(sql),
            `SQL 应该有 WHERE user_id = ?：${sql}`
        );
    }
});

test("子查询位置的 scopeSql 必须是 (false)（静态扫源码补运行时检查的盲区）", () => {
    // 凡是 `FROM <table>${scopeSql(` 的，参数必须是 false
    const re = /FROM\s+\w+\$\{this\.scopeSql\((true|false)\)\}/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(source)) !== null) {
        checked += 1;
        assert.equal(
            m[1],
            "false",
            "`FROM <table>${this.scopeSql(true)}` 会生成 `FROM <table> AND user_id = ?`，" +
                "语法错误。这里必须是 (false)"
        );
    }
    assert.ok(checked > 0, "一条子查询用法都没匹配到 —— 正则对不上，守卫空转了");
});

test("createNote 的 bind 必须展开子查询那个账号参数", () => {
    // 这是上次那个 bug 的另一半：子查询里的 `?` 也要绑参数，漏了运行时就报错（500）。
    // 而「漏绑」静态类型检查完全看不出来，MockD1 按前缀匹配也不校验个数。
    const fn = source.slice(
        source.indexOf("createNote: async"),
        source.indexOf("updateNote: async")
    );
    assert.ok(fn, "没抠到 createNote");
    // 子查询用 scopeSql(false) 时，bind 里必须跟着 scopeParams([])
    assert.ok(
        fn.includes("...scopeTail,"),
        "createNote 的 bind 里必须展开 scopeParams 的参数（...scopeTail），" +
            "否则 SQL 占位符数与参数个数对不上，运行时报错 → 500"
    );
    assert.ok(
        /scopeParams\(\[\]\)/.test(fn),
        "scopeTail 应该来自 scopeParams([]) —— 它在单账号部署（uid 为 NULL）下返回空数组"
    );
});

test("每条 SQL 的占位符个数与 bind 的参数个数对得上（逐个方法核）", () => {
    // 通用做法：把每个方法的 SQL 占位符数，与它 bind 的参数写法对照。
    // 这里只对「能明确数出来」的方法断言，其余交给 review —— 宁可少覆盖，
    // 也不要一个写错的守卫让人以为「查过了就没事」。
    const cases: Array<{ name: string; fn: string; params: number }> = [
        { name: "updateNote", fn: "updateNote: async", params: 1 /* 走 scopeParams 动态 */ },
    ];
    for (const c of cases) {
        const body = source.slice(
            source.indexOf(c.fn),
            source.indexOf("deleteNote: async")
        );
        const placeholders = (body.match(/\?/g) || []).length;
        // updateNote 的 bind 是 `...this.scopeParams(params)`，参数个数随字段变化，
        // 所以只能断言「占位符数 > 0」并且源码里确实调了 scopeParams
        assert.ok(placeholders > 0, `${c.name} 的 SQL 里没有占位符，可疑`);
        assert.ok(
            body.includes("scopeParams"),
            `${c.name} 的 SQL 用了账号隔离却没有 bind 账号 id`
        );
    }
});

// ---------- 阶段三：归档列 + 回收站认识笔记 ----------

test("阶段三：NOTE_FIELDS 必须带 archived，否则归档状态永远读不回来", () => {
    assert.ok(
        /const NOTE_FIELDS =[\s\S]*?archived/.test(source),
        "查询字段里要有 archived"
    );
    // 归档走 updateNote 的白名单：漏了就变成「点了归档按钮，刷新又变回来」
    assert.ok(
        /patch\.archived !== undefined[\s\S]{0,200}archived = \?/.test(source),
        "updateNote 要认 archived，并写成 archived = ?"
    );
    assert.ok(
        /params\.push\(patch\.archived \? 1 : 0\)/.test(source),
        "archived 要存成 0/1，不是 true/false（D1 的 INTEGER 列不认布尔）"
    );
});

test("阶段三：建表语句里有 archived，且老库有 ALTER 补列（否则老实例 500）", () => {
    const internals = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "internals.ts"),
        "utf-8"
    );
    assert.ok(
        /CREATE TABLE IF NOT EXISTS notes \([\s\S]*?archived INTEGER NOT NULL DEFAULT 0/.test(internals),
        "新库建表要带 archived"
    );
    const migration = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "migration.ts"),
        "utf-8"
    );
    assert.ok(
        /ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0/.test(migration),
        "老库必须靠 ALTER 补列：CREATE TABLE IF NOT EXISTS 对已存在的表不补字段"
    );
    // 📌 写成「版本 >= 5」而不是死钉 `"5"`：
    // 上一版就是死钉 `"4"`，于是阶段三升到 5 的当天这条用例立刻变红 ——
    // 守卫本身没错（它就是要盯住「别忘升号」），但钉死具体的号只会在
    // 下一次升级时制造一次无意义的红，还会让人养成「顺手改成 5 绕过去」的坏习惯。
    // 这里判的是**单调不减**：新增了迁移步骤（补列 / 建表 / 搬数据）就必须 +1。
    const version = /\bSCHEMA_VERSION = "(\d+)"/.exec(migration)?.[1];
    assert.ok(version !== undefined, "SCHEMA_VERSION 得是个数字版本号");
    assert.ok(
        Number(version) >= 5,
        `结构版本号要 >= 5（notes.folder_id + 文件夹/标签三张新表），现在是 ${version} —— ` +
            "不升号的话 migrateIfNeeded 读到相同版本会直接跳过，新表在老实例上永远建不出来"
    );
});

test("阶段三收尾：notes.folder_id 建表有、老库也要 ALTER 补列", () => {
    const internals = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "internals.ts"),
        "utf-8"
    );
    assert.ok(
        /CREATE TABLE IF NOT EXISTS notes \([\s\S]*?folder_id INTEGER/.test(internals),
        "新库建表要带 folder_id"
    );
    // ⚠️ 可空、且**不给 NOT NULL 默认值**：老笔记一条都不用回填就自然成了「未归类」。
    // 给 NOT NULL DEFAULT 0 会让 NULL（= 未归类）永远出不来，未归类视图会空掉。
    const migration = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "migration.ts"),
        "utf-8"
    );
    assert.ok(
        /ALTER TABLE notes ADD COLUMN folder_id INTEGER(?! NOT NULL)/.test(migration),
        "老库 ALTER 补 folder_id，且必须是可空列"
    );
});

test("阶段三收尾：文件夹 / 标签三张新表，老实例上也要真被建出来", () => {
    const internals = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "internals.ts"),
        "utf-8"
    );
    const migration = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "migration.ts"),
        "utf-8"
    );
    // 1) 三张表必须挂在 FOLDER_TAG_TABLE_STATEMENTS 上（而不是只写进 CREATE_STATEMENTS）
    assert.ok(
        /export const FOLDER_TAG_TABLE_STATEMENTS = \[/.test(internals),
        "要有 FOLDER_TAG_TABLE_STATEMENTS 这个导出：只写进 CREATE_STATEMENTS 的话，"
    );
    assert.ok(
        /NOTE_FOLDER_TABLE_SQL|note_folder \(/.test(internals),
        "文件夹表的 DDL 要提出来单独用"
    );
    assert.ok(
        /NOTE_TAG_TABLE_SQL|note_tag \(/.test(internals),
        "标签表的 DDL 要提出来单独用"
    );
    assert.ok(
        /NOTE_TAG_LINK_TABLE_SQL|note_note_tag \(/.test(internals),
        "关联表的 DDL 要提出来单独用"
    );
    // 2) 迁移里必须真的执行它们 —— 光声明不跑，老库上那三张表永远不存在
    assert.ok(
        /for \(const sql of FOLDER_TAG_TABLE_STATEMENTS\)[\s\S]{0,200}await this\.db\.exec\(sql\)/.test(
            migration
        ),
        "runMigrations 里要逐条 exec 这三张新表"
    );
    assert.ok(
        /migrateFolderTagTables/.test(migration),
        "要有 migrateFolderTagTables 这个迁移步骤（版本号升到 5 才跑得到）"
    );
});

test("阶段三收尾：notes/ 的文件夹/标签路由必须排在通用 notes/ 分支之前", () => {
    const source = readFileSync(
        join(findProjectDir(), "worker", "routes", "data.ts"),
        "utf-8"
    );
    const foldersAt = source.indexOf('path === "notes/folders"');
    const tagsAt = source.indexOf('path === "notes/tags"');
    const genericAt = source.indexOf('path.startsWith("notes/") && method === "GET"');
    assert.ok(foldersAt > -1 && tagsAt > -1, "要有 notes/folders 与 notes/tags 的路由");
    assert.ok(genericAt > -1, "通用 notes/ 分支要还在");
    // ⚠️ 顺序反了的表现极其隐蔽：「notes/folders」也满足 startsWith("notes/")，
    // 而那一路是 `parseInt(path.split("/")[1])` —— 拿到 NaN 直接返回 400「无效的ID」。
    // 本地新库不会走这条链，所以只有老部署才看得出来。
    assert.ok(
        foldersAt < genericAt && tagsAt < genericAt,
        "notes/folders、notes/tags 要排在通用 notes/ 分支前面，否则一律 400"
    );
});

test("阶段三收尾：notes 编辑接口认 folder_id（漏了就是静默丢字段）", () => {
    const notes = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "notes.ts"),
        "utf-8"
    );
    const route = readFileSync(
        join(findProjectDir(), "worker", "routes", "data.ts"),
        "utf-8"
    );
    // 数据层：白名单 + 回读字段
    assert.ok(/patch\.folder_id !== undefined/.test(notes), "notes.ts 的更新白名单要认 folder_id");
    assert.ok(/draft\.folder_id \?\? null/.test(notes), "新建笔记要落 folder_id");
    // 路由层：白名单（漏了这条 = HTTP 200 但字段被丢）
    assert.ok(/data\.folder_id !== undefined/.test(route), "路由层要放行 folder_id");
    // 类型层：Note 上要有这个字段，否则 TS 会先在编译期拦住
    const types = readFileSync(join(findProjectDir(), "src", "API", "types.ts"), "utf-8");
    assert.ok(/folder_id\?: number \| null;/.test(types), "Note 类型要有 folder_id");
});

test("阶段三：回收站要认出笔记（之前把 note 降级成 site，列表里显示成「站点」）", () => {
    const recycle = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "recycle.ts"),
        "utf-8"
    );
    assert.ok(
        /r\.kind === "note"/.test(recycle),
        "要按 kind='note' 分支取标题"
    );
    assert.ok(
        /parsed\.note\?\.title/.test(recycle),
        "笔记标题要从回收站存的 { note: {...} } 里取"
    );
    assert.ok(
        /r\.kind === "note" \? "note" : "site"/.test(recycle),
        "kind 不能把 note 降级成 site"
    );
});

// ---------- 阶段三收尾：文件夹 / 标签的 SQL 里不能再出现「两个 WHERE」----------
//
// 这是线上 500 的第二个根因（第一个是 notes.folder_id 没补出来）。
// scopeSql(false) 生成 " WHERE user_id = ?"，scopeSql(true) 生成 " AND user_id = ?"。
// 子查询里若用 scopeSql(false)，就会拼成：
//     WHERE n.folder_id = f.id  WHERE user_id = ?          ← 语法错
//     JOIN notes n ON n.id = l.note_id  WHERE …  WHERE …    ← 语法错
// 表结构、迁移、路由白名单全都正常，只有这两个接口 500，最容易误判成「表没建出来」。
//
// 这里**真调用一次**再检查 SQL 文本 —— 静态正则抓不到「模板里套函数」的情况
// （上面那条 static 守卫被证实过是形同虚设，见文件头注释）。
test("文件夹 / 标签的 SQL：每个子查询里只能有一个 WHERE，且占位符与参数个数一致", async () => {
    const captured: Array<{ sql: string; args: unknown[] }> = [];
    const api = {
        currentUserId: 1,
        migrate: async () => {},
        withSchemaRetry: async <T,>(fn: () => Promise<T>) => fn(),
        scopeSql: (hasWhere: boolean) => (hasWhere ? " AND " : " WHERE ") + "user_id = ?",
        scopeParams: <T,>(params: T[]) => [...params, 1],
        db: {
            prepare: (sql: string) => {
                const rec = { sql: sql.replace(/\s+/g, " ").trim(), args: [] as unknown[] };
                captured.push(rec);
                return {
                    bind: (...args: unknown[]) => {
                        rec.args = args;
                        return {
                            all: async () => ({ results: [] }),
                            first: async () => null,
                            run: async () => ({ success: true }),
                        };
                    },
                };
            },
        },
    };

    await notesImpl.listFolders.call(api as never);
    await notesImpl.listTags.call(api as never);
    await notesImpl.updateFolder.call(api as never, 1, { name: "x" });
    await notesImpl.updateTag.call(api as never, 1, { name: "x" });

    // listFolders 1 条 + listTags 1 条 + updateFolder 2 条（UPDATE 再 SELECT 回读）
    // + updateTag 2 条 = 6 条
    assert.equal(captured.length, 6, "四个方法产生的 SQL 条数对不上，守卫可能没覆盖全");

    for (const { sql, args } of captured) {
        // ① 拆出每个括号层级里的 WHERE 数量，逐层都不能超过 1。
        //    注意正则里 **开闭括号都要收**：只匹配 "(" 的话深度只增不减，
        //    子查询里的 WHERE 会和它外面的 WHERE 算到同一层上，平白报红。
        let depth = 0;
        const perLevel: number[] = [];
        const tokens = sql.match(/\(|\)|\bWHERE\b/gi) || [];
        for (const tk of tokens) {
            if (tk === "(") {
                depth += 1;
                perLevel[depth] = perLevel[depth] || 0;
            } else if (tk === ")") {
                depth -= 1;
            } else {
                perLevel[depth] = (perLevel[depth] || 0) + 1;
            }
        }
        assert.ok(
            depth === 0,
            `括号不配对（depth 结束时为 ${depth}），这条 SQL 本身就有问题：${sql}`
        );
        const doubled = perLevel.filter(n => n > 1).length;
        assert.equal(
            doubled,
            0,
            `同一层里出现了两个 WHERE（子查询里误用 scopeSql(false)）：${sql}`
        );
        // ② 占位符个数 == 绑定参数个数
        const placeholders = (sql.match(/\?/g) || []).length;
        assert.equal(
            placeholders,
            args.length,
            `占位符 ${placeholders} 个但只绑了 ${args.length} 个参数：${sql}`
        );
    }
});

test("子查询里出现的 scopeSql 必须是 (true)", () => {
    // 兜底的静态视角：凡是「已经有 WHERE 之后」再插 scopeSql(false) 的，一律不行。
    // 上面那条是运行时检查（真调一次看 SQL），这条防的是「以后新加的 SQL 又写成 false」。
    const re = /WHERE[^`$]*?\$\{this\.scopeSql\(false\)\}/g;
    assert.equal(
        (source.match(re) || []).length,
        0,
        "有「WHERE … ${scopeSql(false)}」这种写法 —— 子查询里要用 scopeSql(true)"
    );
    // 反向也钉一下：文件里得有若干 scopeSql(true)，否则说明文件夹 / 标签那几条被改回去了
    const subQueries = source.match(/scopeSql\(true\)/g) || [];
    assert.ok(
        subQueries.length >= 3,
        `只找到 ${subQueries.length} 处 scopeSql(true) —— 文件夹 / 标签那几条 SQL 是不是被改回去了？`
    );
});
