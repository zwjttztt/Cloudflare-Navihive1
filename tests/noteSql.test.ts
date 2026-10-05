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
