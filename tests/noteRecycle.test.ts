// tests/noteRecycle.test.ts
// 回收站里**笔记**这条路径的形状守卫。
//
// 为什么单独一组：2026-10-06 查出三个静默损坏用户的点，全都是「HTTP 200，看不出错」那一类：
//   1. reinsertNote 的 INSERT 少写 folder_id / archived
//      → 归档笔记还原后回到「全部」视图、归了文件夹的笔记掉回「未归类」。
//      用户看着像还原成功，其实在丢状态。
//   2. deleteNote 不清 note_note_tag → 删完留下悬空关联行（笔记已经没了），
//      还原又换新 id，标签再也接不回来。
//   3. listNoteTags 直接 `SELECT … FROM note_note_tag` 全表扫，
//      既跨账号越权（那张表没有 user_id 列，归属只能靠 JOIN notes 判定），
//      又把上面那些悬空行一起算进左栏的标签计数。
//
// 这三个都不适合靠行为测试兜：真跑一遍要连库 + 建表 + 造数据，
// 而这里要盯的恰恰是「SQL 里写了哪些列 / 哪些表」这种静态形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const projectDir = findProjectDir();
const recycleSrc = readFileSync(join(projectDir, "src", "API", "methods", "recycle.ts"), "utf-8");
const notesSrc = readFileSync(join(projectDir, "src", "API", "methods", "notes.ts"), "utf-8");

/** 抠出某个方法体（从 `name: async` 到下一个同缩进的 `name: async`） */
function methodBody(src: string, name: string): string {
    const start = src.indexOf(name);
    assert.ok(start >= 0, `没找到 ${name}`);
    const rest = src.slice(start + name.length);
    const next = rest.search(/\n {4}\w+:/);
    return next < 0 ? src.slice(start) : src.slice(start, start + name.length + next);
}

test("reinsertNote 必须把 folder_id 和 archived 一起还原", () => {
    const body = methodBody(recycleSrc, "reinsertNote: async");
    const insert = body.slice(body.indexOf("INSERT INTO notes"));
    assert.ok(insert, "没找到 reinsertNote 的 INSERT");
    const cols = insert.slice(insert.indexOf("(") + 1, insert.indexOf(")"));
    for (const col of ["folder_id", "archived"]) {
        assert.ok(
            cols.includes(col),
            `还原时漏了 ${col} —— 删笔记时进回收站的是 SELECT * 的完整行（它在里面），` +
                "少写一列就是「还原时被静默清零」：归档笔记弹回全部、归类笔记掉回未归类"
        );
    }
    // 值这一侧也得真的绑上去，不能只把列名写上去
    assert.ok(
        /note\.folder_id/.test(body) && /note\.archived/.test(body),
        "bind 里要真的把 folder_id / archived 传进去"
    );
});

test("reinsertNote 必须把标签关联写回新 id（否则还原后标签全丢）", () => {
    const body = methodBody(recycleSrc, "reinsertNote: async");
    assert.ok(
        /note_note_tag/.test(body),
        "reinsertNote 里没有 note_note_tag —— 还原换了新 id，删笔记时清掉的关联接不回来，标签就没了"
    );
    // 写回前要确认标签还活着（删笔记到还原之间用户可能已经删了那个标签）
    assert.ok(
        /SELECT id FROM note_tag/.test(body),
        "写回关联前要查标签是否还存在，照写回去会造出新的悬空关联"
    );
});

test("deleteNote 要把标签关联一起搬进回收站，并在删行前清掉关联", () => {
    const body = methodBody(notesSrc, "deleteNote: async");
    assert.ok(
        /tagIds/.test(body),
        "deleteNote 必须在进回收站的数据里带上 tagIds（还原时靠它写回关联）"
    );
    assert.ok(
        /DELETE FROM note_note_tag/.test(body),
        "删笔记时必须清 note_note_tag —— 不清就留下指向不存在笔记的悬空行，" +
            "左栏的标签计数还会一直把它们算进去"
    );
    // 顺序：取关联 → 存回收站 → 清关联 → 删笔记
    const selLinks = body.indexOf("SELECT l.tag_id");
    const pushRecycle = body.indexOf("pushToRecycle");
    const delLinks = body.indexOf("DELETE FROM note_note_tag");
    const delNote = body.indexOf("DELETE FROM notes");
    assert.ok(
        selLinks >= 0 && selLinks < pushRecycle,
        "要先取到关联再进回收站（存进去的是那一份）"
    );
    assert.ok(pushRecycle < delLinks && delLinks < delNote, "顺序：存回收站 → 清关联 → 删笔记");
});

test("listNoteTags 必须 JOIN notes 限定账号（note_note_tag 没有 user_id 列）", () => {
    const body = methodBody(notesSrc, "listNoteTags: async");
    assert.ok(
        /JOIN\s+notes/.test(body),
        "listNoteTags 直接查 note_note_tag 是跨账号越权 + 悬空行全被算进去；" +
            "那张表没有 user_id 列，归属只能靠 JOIN notes 判定"
    );
    assert.ok(
        /scopeSql\(true\)/.test(body),
        "JOIN 出来的 user_id 条件要用 scopeSql(true)（它前面已经有 WHERE 了）"
    );
    assert.ok(
        /JOIN\s+notes\s+n\s+ON\s+n\.id\s*=\s*l\.note_id\s*\$\{this\.scopeSql\(true\)\}/.test(body) ||
            /JOIN\s+notes[\s\S]{0,80}scopeSql\(true\)/.test(body),
        "JOIN 后面要真的带账号条件 —— 只 JOIN 不筛等于没筛"
    );
});

test("deleteFolder 的「清关联 + 删文件夹」必须在同一个 batch 里", () => {
    const body = methodBody(notesSrc, "deleteFolder: async");
    assert.ok(
        /db\.batch\(/.test(body),
        "两条语句要放进同一个 db.batch（= 一个 D1 事务）。分开跑的话中途失败就留下" +
            "「文件夹没了、笔记还指着它」的悬空 folder_id，那几条笔记在左栏任何" +
            "文件夹视图里都点不出来，看着就像被删掉了"
    );
    const batchAt = body.indexOf("db.batch(");
    const updAt = body.indexOf("UPDATE notes SET folder_id = NULL");
    const delAt = body.indexOf("DELETE FROM note_folder");
    assert.ok(
        updAt < batchAt && delAt < batchAt,
        "UPDATE / DELETE 两条都要进 batch —— 现在至少有一条还在外面单发"
    );
    // 顺序：先摘关联再删文件夹（反过来会短暂留下指向不存在文件夹的关联）
    assert.ok(updAt < delAt, "先清 notes.folder_id，再删文件夹");
});
