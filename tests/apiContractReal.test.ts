// tests/apiContractReal.test.ts
//
// API 契约测试的**真底座**：直接拿 `NavigationAPI`（真实现）在真 SQLite 上跑，
// 断言「前端确实会读取的字段」在真实返回里存在、类型对得上、不是 undefined。
//
// 为什么需要它（2026-11 复查 R11）：
// 同目录的 `apiContract.dom.test.tsx` 里那组「透传型接口」用例是**自己比自己** ——
// 它把 `mock.aiStatus()` 的返回值既当成「假 fetch 返回的响应」喂给 client，
// 又把同一个值当成期望值，最后断言 `shapeOf(a) === shapeOf(b)`。恒等，什么都没验。
// 已知的真实漂移就在那条用例底下活着：`GET /api/ai/status` 的真实响应比 mock 多一个
// `success: true`，而测试一直是绿的。
//
// 这一组换个底座：不碰 fetch 桩，直接调真实方法，期望值写成**独立的事实**
// （字段存在 / 类型 / 具体值），所以真实实现漂了就会红。
//
// ⚠️ 这条用例只覆盖「读」与「负例」，不覆盖前端组件的渲染 —— 后者是 .dom.test.tsx 的事。
// 文件名刻意不加 `.dom.` 后缀：这是纯函数用例，不需要 jsdom。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { handleAiRoutes } from "../worker/routes/ai";
import type { RouteCtx } from "../worker/routes/types";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";

type RealApi = ReturnType<typeof makeRealApi>;

// ---------------------------------------------------------------------------
// 断言小工具：把「前端会读什么」写成可复用的形状检查
// ---------------------------------------------------------------------------

const describe = (v: unknown): string => (v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 非空字符串（前端会直接 `.length` / 拼 className，空串与 undefined 都要能区分出来） */
function assertNonEmptyString(value: unknown, label: string): void {
    assert.equal(typeof value, "string", `${label} 应该是字符串，实际 ${describe(value)}`);
    assert.ok((value as string).length > 0, `${label} 不该是空串`);
}

function assertInteger(value: unknown, label: string, min = 0): void {
    assert.equal(typeof value, "number", `${label} 应该是数字，实际 ${describe(value)}`);
    assert.ok(Number.isInteger(value), `${label} 应该是整数，实际 ${describe(value)}`);
    assert.ok((value as number) >= min, `${label} 应 >= ${min}，实际 ${describe(value)}`);
}

/**
 * 「前端当布尔用」的字段。
 *
 * ⚠️ 真实现返回的是 SQLite 的 **0 / 1 整数**（`pinned` / `starred` / `archived` 都是
 * `INTEGER NOT NULL DEFAULT 0`），而 `Note` 类型上标的是 `boolean`。前端一律写
 * `note.pinned ? …`，两种都能用，所以这里按「真假可比」判定 —— 不强行要求 boolean，
 * 也不放宽到「随便什么真值都行」（`"0"` / `"false"` 字符串就是真 bug）。
 */
function assertBoolLike(value: unknown, label: string): void {
    const ok = value === true || value === false || value === 0 || value === 1;
    assert.ok(ok, `${label} 应是 true/false/0/1，实际 ${describe(value)}`);
}

/** 可空数字（`site_id` / `folder_id` / `parent_id` 用的是 NULL 表示「没有」） */
function assertNullableInteger(value: unknown, label: string): void {
    if (value === null) return;
    assertInteger(value, label, 0);
}

/**
 * 一条笔记的「前端读的字段」全检。
 *
 * 字段清单照 NOTE_FIELDS（id, uuid, title, content, pinned, starred, rev, order_num,
 * site_id, archived, folder_id, link_count, created_at, updated_at）—— 少一个前端就会
 * 拿到 undefined：列表排序读 order_num、卡片显示读 title/content、乐观并发读 rev、
 * 「这个文件夹几条」读 folder_id，都在这份清单里。
 */
function assertNoteRow(note: Record<string, unknown>, label: string): void {
    assertInteger(note.id, `${label}.id`, 1);
    assertNonEmptyString(note.uuid, `${label}.uuid`);
    assert.equal(typeof note.title, "string", `${label}.title 应该是字符串，实际 ${describe(note.title)}`);
    assert.equal(typeof note.content, "string", `${label}.content 应该是字符串，实际 ${describe(note.content)}`);
    assertBoolLike(note.pinned, `${label}.pinned`);
    assertBoolLike(note.starred, `${label}.starred`);
    // rev 从 1 起：乐观并发拿它做 `AND rev = ?`，0 会让「第一版」永远匹配不上
    assertInteger(note.rev, `${label}.rev`, 1);
    assertInteger(note.order_num, `${label}.order_num`, 0);
    assertNullableInteger(note.site_id, `${label}.site_id`);
    assertBoolLike(note.archived, `${label}.archived`);
    assertNullableInteger(note.folder_id, `${label}.folder_id`);
    assertInteger(note.link_count, `${label}.link_count`, 0);
    assertNonEmptyString(note.created_at, `${label}.created_at`);
    assertNonEmptyString(note.updated_at, `${label}.updated_at`);
}

// ---------------------------------------------------------------------------
// 每个用例一套独立的真库，避免互相看见对方的数据
// ---------------------------------------------------------------------------

function freshApi(): RealApi {
    // 迁移缓存是模块级的（真跑时一个 isolate 只迁移一次），用例之间必须重置，
    // 否则第二个用例拿到的是「上一轮已经迁移过」的缓存，见 realSqliteD1 的头注释。
    resetMigrationCacheForTests();
    const db = makeRealD1();
    return makeRealApi(db);
}

// ---------------------------------------------------------------------------
// 读：notes
// ---------------------------------------------------------------------------

test("真实 API：notes 列表与单条笔记，前端读的字段一个不少", async () => {
    const api = freshApi();
    await api.migrate();
    const created = await api.createNote({ title: "契约", content: "正文 [[双链]] #契约标签" });
    assertInteger(created.id, "createNote().id", 1);

    const list = await api.listNotes();
    assert.ok(Array.isArray(list), "listNotes 必须返回数组");
    assert.equal(list.length, 1, `列表应该有 1 条，实际 ${list.length}`);
    const fromList = list[0] as unknown as Record<string, unknown>;
    assertNoteRow(fromList, "listNotes()[0]");

    // 单条：内容必须与列表一致（列表走 ?fields=list 会截断，这里不传 summary 就是全文）
    const one = await api.getNote(created.id!);
    assert.ok(one, "getNote 应该取到刚建的那条");
    const row = one as unknown as Record<string, unknown>;
    assertNoteRow(row, "getNote()");
    assert.equal(row.id, created.id, "getNote 取回来的 id 必须是自己那条");
    assert.equal(row.content, "正文 [[双链]] #契约标签", "getNote 的 content 必须是全文，不能被截断");
    assertInteger(row.link_count, "getNote().link_count", 0);
    assert.equal(row.link_count, 1, "正文里有 1 条 [[双链]]，link_count 必须当场算好");
});

test("真实 API：摘要模式下 content 被截短且带 content_truncated 标记", async () => {
    const api = freshApi();
    await api.migrate();
    const long = "长".repeat(400);
    await api.createNote({ title: "长笔记", content: long });
    await api.createNote({ title: "短笔记", content: "短" });

    const summary = await api.listNotes({ summary: true });
    assert.equal(summary.length, 2);
    const longRow = summary.find(n => n.title === "长笔记") as unknown as Record<string, unknown>;
    const shortRow = summary.find(n => n.title === "短笔记") as unknown as Record<string, unknown>;
    assert.ok(longRow && shortRow, "两条都该在列表里");
    assert.equal(longRow.content_truncated, true, "超长笔记在摘要模式下必须带 content_truncated 标记");
    assert.ok((longRow.content as string).length < long.length, "摘要模式的 content 必须比全文短");
    assert.equal(shortRow.content_truncated, undefined, "短笔记本来就是全文，不该带截断标记");
});

// ---------------------------------------------------------------------------
// 读：folders / tags
// ---------------------------------------------------------------------------

test("真实 API：folders 与 tags 列表的字段（含 UI 要显示的 count）", async () => {
    const api = freshApi();
    await api.migrate();
    const folder = await api.createFolder({ name: "契约文件夹" });
    assertInteger(folder.id, "createFolder().id", 1);
    const tag = await api.createTag({ name: "契约标签" });
    assertInteger(tag.id, "createTag().id", 1);
    // 建一条挂在该文件夹下、且正文带 #契约标签 的笔记：两个 count 才有意义
    await api.createNote({ title: "在文件夹里", content: "正文 #契约标签", folder_id: folder.id });

    const folders = await api.listFolders();
    assert.ok(Array.isArray(folders), "listFolders 必须返回数组");
    assert.equal(folders.length, 1);
    const f = folders[0] as unknown as Record<string, unknown>;
    assertInteger(f.id, "listFolders()[0].id", 1);
    assertNonEmptyString(f.name, "listFolders()[0].name");
    assert.equal(f.parent_id, null, "根文件夹的 parent_id 必须是 null（不是 0 / undefined）");
    assertInteger(f.order_num, "listFolders()[0].order_num", 0);
    // count 是查询时算出来的列，前端侧边栏直接显示它
    assertInteger(f.count, "listFolders()[0].count", 0);
    assert.equal(f.count, 1, "文件夹里有 1 条笔记，count 必须是 1");
    assertNonEmptyString(f.created_at, "listFolders()[0].created_at");

    const tags = await api.listTags();
    assert.equal(tags.length, 1);
    const t = tags[0] as unknown as Record<string, unknown>;
    assertInteger(t.id, "listTags()[0].id", 1);
    assertNonEmptyString(t.name, "listTags()[0].name");
    assert.equal(t.color, null, "没指定颜色的标签，color 必须是 null");
    assertInteger(t.count, "listTags()[0].count", 0);
    // 那篇正文里带 #契约标签，自动标签会把它挂上去
    assert.equal(t.count, 1, "正文里的 #契约标签 应该已经挂到这条标签上");

    // 笔记 → 标签 id 的映射：前端「标签筛选」直接读它
    const map = await api.listNoteTags();
    assert.equal(typeof map, "object", "listNoteTags 必须返回对象（noteId → tagId[]）");
    const noteIds = Object.keys(map);
    assert.ok(noteIds.length >= 1, "刚建的笔记应该出现在映射里");
    const first = map[Number(noteIds[0])];
    assert.ok(Array.isArray(first), "映射的值必须是 tagId 数组");
    assert.ok(first.includes(tag.id as number), "自动标签的 id 应该在映射里");
});

// ---------------------------------------------------------------------------
// 设置：ai/status —— 以**真实实现**为准，把已知漂移钉死
// ---------------------------------------------------------------------------

/** 给 ai 路由造一个最小 ctx（与 tests/aiTest.test.ts 同一套形状） */
function aiCtx(api: RealApi, path: string, method: string): RouteCtx {
    const url = `https://nav.example/api/${path}`;
    return {
        request: new Request(url, { method }),
        path,
        method,
        api,
        env: {} as RouteCtx["env"],
        url: new URL(url),
        ip: "127.0.0.1",
        trustXFF: false,
        trustXRealIp: false,
        secureCookie: true,
        currentJti: "jti",
        currentTokenExp: 0,
    };
}

test("真实 ai/status：响应体必带 success: true（真实实现多出来的那个字段）", async () => {
    const api = freshApi();
    await api.migrate();

    const res = await handleAiRoutes(aiCtx(api, "ai/status", "GET"));
    assert.ok(res, "ai/status 应该被 ai 路由认领");
    assert.equal(res.status, 200, "ai/status 是只读状态接口，默认必须是 200（AI 没开也是 200 + enabled:false）");

    const body = (await res.json()) as Record<string, unknown>;

    // ⚠️ 关键：`success: true` 是**真实实现**的行为（worker/routes/ai.ts 的
    // `Response.json({ success: true, enabled, … })`），而旧的 mock 里没有这个字段，
    // 所以「mock 与 client 结构一致」那条用例一直是绿的、线上却多一个字段。
    // 这里以真实实现为准钉死它 —— 别为了让旧 mock 过得去而把断言放宽。
    assert.equal(
        body.success,
        true,
        "真实 ai/status 必须带 success: true；丢了说明路由改回裸对象了，前端的统一响应体约定会漂"
    );

    // 其余字段是前端真正读的（AiAssistantDialog / App 拿它们决定按钮置不置灰）
    assertBoolLike(body.enabled, "ai/status.enabled");
    assert.equal(body.enabled, false, "没配过 AI 时必须默认关（服务端不许偷偷打开）");
    assert.equal(typeof body.provider, "string", "ai/status.provider 应该是字符串");
    assert.equal(typeof body.textModel, "string", "ai/status.textModel 应该是字符串");
    assert.equal(typeof body.embedModel, "string", "ai/status.embedModel 应该是字符串");
    assertInteger(body.embedded, "ai/status.embedded", 0);
    assert.ok(
        body.problem === null || typeof body.problem === "string",
        `ai/status.problem 应该是 string | null（null = 可以正常调用），实际 ${describe(body.problem)}`
    );
    assert.equal(typeof body.problem, "string", "AI 没开时 problem 必须说明原因，不能是 null");
});

// ---------------------------------------------------------------------------
// mutation 负例 (a)：缺必填参数 —— 必须明确报错，不能静默成功
// ---------------------------------------------------------------------------

test("mutation 负例：缺必填参数必须明确报错，不能静默成功", async () => {
    const api = freshApi();
    await api.migrate();
    const note = await api.createNote({ title: "被误改的对象", content: "原文" });

    // id 缺失（undefined 直接当 id 传进来）：不能「查到点什么」也不能静默成功 ——
    // 要么明确抛错，要么明确返回空。这里真实实现是抛 TypeError（绑参就失败），
    // 属于「明确报错」，可以接受；不可接受的是返回一条笔记或返回 true。
    await assert.rejects(
        () => Promise.resolve(api.getNote(undefined as unknown as number)),
        (e: unknown) => {
            assert.ok(e instanceof Error, "缺 id 时应该抛 Error");
            assert.ok((e as Error).message.length > 0, "抛出来的 Error 要有信息，不能是空消息");
            return true;
        },
        "getNote(undefined) 必须明确报错"
    );

    // 批量排序元素缺 order_num：路由层对它回 400，方法层必须同样不静默吞掉
    await assert.rejects(
        () =>
            Promise.resolve(
                api.updateNoteOrder([
                    { id: note.id as number, order_num: undefined as unknown as number },
                ])
            ),
        (e: unknown) => {
            assert.ok(e instanceof Error, "缺 order_num 时应该抛 Error");
            return true;
        },
        "updateNoteOrder 缺 order_num 必须明确报错，不能静默返回 true"
    );

    // 反向确认：上面的失败**没有**把库写坏
    const after = await api.getNote(note.id!);
    assert.ok(after, "笔记还在");
    assert.equal((after as unknown as Record<string, unknown>).content, "原文", "报错的那两次不该改动正文");
});

// ---------------------------------------------------------------------------
// mutation 负例 (b)：不存在的 id —— 返回空 / 明确失败，不许抛未捕获异常
// ---------------------------------------------------------------------------

test("mutation 负例：不存在的 id 返回空或明确失败，不抛未捕获异常", async () => {
    const api = freshApi();
    await api.migrate();
    const tag = await api.createTag({ name: "真实标签" });
    const ghost = 999_999;

    // 读：必须是 null（前端判 `if (!note)`），不能是 undefined
    const missing = await api.getNote(ghost);
    assert.equal(missing, null, "getNote(不存在的 id) 必须返回 null，不能是 undefined");

    // 写：必须明确返回「没改成」而不是抛异常、也不是假装成功
    const updated = await api.updateNote(ghost, { title: "幽灵" });
    assert.equal(updated, null, "updateNote(不存在的 id) 必须返回 null（= 没命中任何行）");

    const deleted = await api.deleteNote(ghost);
    assert.equal(typeof deleted, "object", "deleteNote 必须返回对象");
    assert.equal(
        (deleted as { success?: unknown }).success,
        false,
        "deleteNote(不存在的 id) 必须明确 success:false，不能假装删掉了"
    );

    // 关联写：必须返回空数组（前端据此判断「这条笔记不归我 / 不存在」）
    const tagged = await api.setNoteTags(ghost, [tag.id as number]);
    assert.ok(Array.isArray(tagged), "setNoteTags 必须返回数组");
    assert.equal(tagged.length, 0, "setNoteTags(不存在的 id) 必须返回空数组，不能抛异常");

    // 最后确认一次：以上四步都没在库里留下东西
    assert.equal(await api.getNote(ghost), null, "幽灵笔记不该被任何一步创建出来");
    const tags = await api.listTags();
    assert.equal(tags.length, 1, "标签数没变（那次 setNoteTags 没有任何副作用）");
});

test("mutation 负例：把笔记移进不存在的文件夹必须明确拒绝（引用完整性）", async () => {
    const api = freshApi();
    await api.migrate();
    const note = await api.createNote({ title: "正常笔记", content: "" });

    await assert.rejects(
        () => Promise.resolve(api.updateNote(note.id!, { folder_id: 999_999 })),
        /文件夹/,
        "移进不存在的文件夹必须明确报错（错误消息里要说明是文件夹的问题）"
    );

    // 拒绝之后这条笔记的归属没被改坏
    const after = (await api.getNote(note.id!)) as unknown as Record<string, unknown>;
    assert.equal(after.folder_id, null, "被拒的那次改动不该留下痕迹");
});
