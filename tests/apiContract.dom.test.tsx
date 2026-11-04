// mock 与真实 client 的契约守卫。
//
// 为什么需要（2026-10-05 复查 A2）：用例几乎全走 `MockNavigationClient`，
// 而线上跑的是 `NavigationClient`。两边只要有一处不一致，表现就是
// **上千条用例全绿、线上一个接口报错就白屏** —— 而且 TypeScript 不会说：
// `MockNavigationClient` 没有 `implements NavigationAPI`（接口靠 mixin 声明合并
// 补签名，mock 不在其列），所以「mock 少实现 / 实现得不一样」没有任何拦截。
//
// 实测基线（main @ affaf2b）：前端实际调用 40 个方法，mock 一个不缺；
// 接口 148 个方法，client 缺 0 个。所以现在**没有缺口** ——
// 这个用例的价值是让「缺口」以后再也不能悄悄出现。
//
// ⚠️ 这里只剩「方法集合」这一条断言（新增接口时忘了在 mock 里实现 → 变红）。
// 以前还有一条「透传型接口 mock 与 client 返回结构一致」，2026-11 复查时删掉了：
// 它把 `mock.aiStatus()` 的返回值同时当成「假 fetch 返回的响应」和「期望值」，
// 而 `client.request()` 在 `response.ok` 时直接 `return response.json()` ——
// 桩 `json()` 返回的就是**同一个对象引用**，于是断言退化成
// `assert(shapeOf(x) === shapeOf(x))`，恒等，什么都没验。
// 已知的真实漂移（真实 GET /api/ai/status 比 mock 多一个 `success: true`）
// 就在它底下一直绿着。
// 「返回结构对不对」现在由 **tests/apiContractReal.test.ts** 在真 SQLite + 真
// `NavigationAPI` 上钉（不碰 fetch 桩，期望值写成独立事实）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { NavigationClient } from "../src/API/client";
import { MockNavigationClient } from "../src/API/mock";

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

// ---------------------------------------------------------------------------
// 静态扫描：前端真正调用了 api 的哪些方法
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

/**
 * 扫出前端（src/ 下、但不含 API/ 目录）里所有 `api.xxx(` 调用。
 * API 目录本身要排除 —— 那是实现，不是消费方。
 */
function frontendApiCalls(root: string): Map<string, string[]> {
    const calls = new Map<string, string[]>();
    const srcDir = join(root, "src");
    for (const file of walk(srcDir)) {
        if (relative(srcDir, file).split(/[\\/]/)[0] === "API") continue;
        const source = readFileSync(file, "utf-8");
        for (const m of source.matchAll(/\bapi\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
            const name = m[1];
            const at = `${relative(root, file)}`;
            if (!calls.has(name)) calls.set(name, []);
            calls.get(name)!.push(at);
        }
    }
    return calls;
}

test("前端调用的每个 api 方法，mock 与 client 都实现了（缺一即红）", () => {
    const root = findProjectDir();
    const calls = frontendApiCalls(root);
    assert.ok(calls.size >= 20, `只扫到 ${calls.size} 个调用，口径坏了`);

    const mock = new MockNavigationClient() as unknown as Record<string, unknown>;
    const client = new NavigationClient("/api") as unknown as Record<string, unknown>;

    const missingInMock: string[] = [];
    const missingInClient: string[] = [];
    for (const [name, where] of calls) {
        if (typeof mock[name] !== "function") missingInMock.push(`${name}（${where[0]}）`);
        if (typeof client[name] !== "function") missingInClient.push(`${name}（${where[0]}）`);
    }

    assert.deepEqual(
        missingInClient,
        [],
        "真实 client 缺方法：类型系统本该拦住它，出现这条说明声明合并没生效"
    );
    assert.deepEqual(
        missingInMock,
        [],
        "mock 缺方法：本地开发（默认走 mock）会直接报 undefined is not a function。\n" +
            "  补上之后记得让两边行为一致 —— 返回**结构**是不是也对，见 tests/apiContractReal.test.ts。"
    );
});

// ---------------------------------------------------------------------------
// 透传型接口的「形状一致」去哪了（2026-11 复查 R11）
// ---------------------------------------------------------------------------
// 这里原本有一条 `test("透传型接口：mock 与 client 返回的结构一致")`，配一个
// `shapeOf()` 指纹函数和一条它自己的自检。整段删了，因为它是个恒等断言：
//
//   const mockResult = await mock.aiStatus();               // ① mock 的返回值
//   restoreFetch = installFetch(() => mockResult);          // ② 拿①当 fetch 的响应
//   const clientResult = await client.aiStatus();           // ③ client.request() 里
//                                                          //    `return response.json()`
//                                                          //    → 桩返回的还是①那个引用
//   assert.equal(shapeOf(mockResult), shapeOf(clientResult)); // ⇒ shapeOf(x) === shapeOf(x)
//
// 恒等，没有任何信息量。已知的真实漂移就在它底下活着：真实 `GET /api/ai/status`
// 回的是 `{ success: true, enabled, provider, textModel, embedModel, embedded, problem }`，
// mock 里没有 `success` 字段 —— 一直是绿的。
//
// 删掉之后「结构对不对」由 **tests/apiContractReal.test.ts** 接管：那边用
// `makeRealApi(makeRealD1())` 拿真实现，直接调真方法（不碰 fetch 桩），
// 期望值写成独立事实（字段存在 / 类型 / 具体值），真实实现漂了就会红。

test("记事本模拟契约：层级防环、删除父升根、正文标签只追加且忽略代码", async () => {
    const api = new MockNavigationClient();
    const parent = await api.createFolder("契约父");
    const child = await api.createFolder("契约子", parent.id!);
    await assert.rejects(api.updateFolder(parent.id!, { parent_id: child.id }), /自身或子文件夹/);
    const note = await api.createNote({ content: "正文 #契约标签 `#不应关联`", folder_id: child.id });
    const tags = await api.listTags();
    const tag = tags.find(t => t.name === "契约标签");
    assert.ok(tag);
    assert.ok(!tags.some(t => t.name === "不应关联"));
    assert.ok((await api.listNoteTags())[note.id!].includes(tag.id!));
    await api.updateNote(note.id!, { content: "正文标签已移除" });
    assert.ok((await api.listNoteTags())[note.id!].includes(tag.id!), "不撤销手工/已有标签");
    await api.deleteFolder(parent.id!);
    assert.equal((await api.listFolders()).find(f => f.id === child.id)?.parent_id, null);
    assert.equal((await api.getNote(note.id!))?.folder_id, child.id);
    await api.deleteNote(note.id!);
    await api.deleteFolder(child.id!);
    await api.deleteTag(tag.id!);
});
