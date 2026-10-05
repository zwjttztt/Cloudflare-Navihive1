// tests/noteRoutes.test.ts
// 记事本路由（worker/routes/data.ts 里的 notes 分支）的行为用例。
//
// routeCoverage 只证明「这些 path/method 有模块认领」，这里钉的是**认领之后做的事**，
// 而这一组最容易坏的地方有三处：
//   1. **请求体是用户可控的** —— 不能让它决定往哪几列写值。
//      写反了不会报错，只会把不该改的列改掉（或者把类型当 SQL 片段用）。
//   2. **`site_id: null` 与「不传」是两件事**：前者解除关联，后者不动它。
//      混了会把「没碰关联」的笔记全解绑。
//   3. **写操作必须过 writeGate**：漏掉就是限速形同虚设。
// 另外 `notes/count` 必须排在 `notes/:id` 前面 —— 后者会把 "count" 当 id 去 parseInt。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDataRoutes } from "../worker/routes/data";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";
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

const HOST = "https://nav.example.com";
const IP = "203.0.113.9";

interface Log {
    list: number;
    count: number;
    got: number[];
    created: unknown[];
    updated: Array<{ id: number; patch: unknown }>;
    deleted: number[];
    ordered: Array<{ id: number; order_num: number }[]>;
}

function makeApi(log: Log, opts: { note?: unknown } = {}): NavigationAPI {
    return {
        // writeGate 内部要问「当前是谁」才能按账号限速，stub 得给一个
        getCurrentUserId: () => 1,
        listNotes: async () => {
            log.list += 1;
            return [];
        },
        countNotes: async () => {
            log.count += 1;
            return 7;
        },
        getNote: async (id: number) => {
            log.got.push(id);
            return (opts.note as never) ?? null;
        },
        createNote: async (draft: unknown) => {
            log.created.push(draft);
            return { id: 1, title: "t", content: "c", ...(draft as object) };
        },
        updateNote: async (id: number, patch: unknown) => {
            log.updated.push({ id, patch });
            return { id, title: "t", content: "c", ...(patch as object) };
        },
        deleteNote: async (id: number) => {
            log.deleted.push(id);
            return { success: true, recycleId: 42 };
        },
        updateNoteOrder: async (orders: { id: number; order_num: number }[]) => {
            log.ordered.push(orders);
            return true;
        },
    } as unknown as NavigationAPI;
}

function ctx(api: NavigationAPI): RouteCtx {
    return {
        request: new Request(`${HOST}/api/notes`, { method: "GET" }),
        url: new URL(`${HOST}/api/notes`),
        path: "notes",
        method: "GET",
        api,
        ip: IP,
        writeGate: async () => null as Response | null,
        env: {} as never,
    } as unknown as RouteCtx;
}

async function call(
    api: NavigationAPI,
    path: string,
    method: string,
    body?: unknown
): Promise<Response> {
    const c = ctx(api);
    c.path = path;
    c.method = method;
    c.url = new URL(`${HOST}/api/${path}`);
    c.request = new Request(`${HOST}/api/${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    // handleDataRoutes 返回 null 表示「这个路由不归我管」；这里只喂 notes 的分支，
    // 拿到的不会是 null，所以断言一下免得将来用例拿 undefined 去读 .status。
    const res = await handleDataRoutes(c);
    assert.ok(res, `路由没有处理 ${method} ${path}`);
    return res;
}

function withLog(): Log {
    return { list: 0, count: 0, got: [], created: [], updated: [], deleted: [], ordered: [] };
}

test("GET notes 列出全部", async () => {
    const log = withLog();
    const res = await call(makeApi(log), "notes", "GET");
    assert.equal(res.status, 200);
    assert.equal(log.list, 1);
});

test("GET notes/count 返回条数（不能被 notes/:id 抢走）", async () => {
    const log = withLog();
    const res = await call(makeApi(log), "notes/count", "GET");
    assert.equal(res.status, 200);
    assert.equal(log.count, 1, "count 端点该走 countNotes");
    assert.deepEqual(log.got, [], "不该被当成 notes/count 这个 id 去查单条");
    assert.deepEqual(await res.json(), { count: 7 });
});

test("GET notes/:id 查不到就是 404，不该静默返回 200", async () => {
    const res = await call(makeApi(withLog()), "notes/9", "GET");
    assert.equal(res.status, 404);
});

test("POST notes 只把认识的字段交给 api", async () => {
    const log = withLog();
    await call(makeApi(log), "notes", "POST", {
        title: "标题",
        content: "# 内容",
        pinned: 1,
        site_id: 5,
        // 下面三个都不该被采纳
        id: 999,
        uuid: "伪造的",
        user_id: 4321,
        order_num: 8888,
    });
    assert.equal(log.created.length, 1);
    const draft = log.created[0] as Record<string, unknown>;
    assert.equal(draft.title, "标题");
    assert.equal(draft.content, "# 内容");
    // pinned 传的是 1，要归一成布尔（SQL 里存 0/1，但接口层给前端看到的是布尔）
    assert.equal(draft.pinned, true);
    assert.equal(draft.site_id, 5);
    assert.equal("id" in draft, false, "id 不能由请求体决定");
    assert.equal("user_id" in draft, false, "user_id 只能由服务端按登录态填");
    assert.equal("uuid" in draft, false, "uuid 由服务端生成");
    assert.equal("order_num" in draft, false, "排序由服务端接新行时自己算");
});

test("POST notes 忽略非字符串的 title/content（不把对象当文本存进去）", async () => {
    const log = withLog();
    await call(makeApi(log), "notes", "POST", {
        title: { evil: true },
        content: ["a", "b"],
    });
    const draft = log.created[0] as Record<string, unknown>;
    assert.equal(draft.title, "");
    assert.equal(draft.content, "");
});

test("PUT notes/:id 只带真正改了的字段", async () => {
    const log = withLog();
    await call(makeApi(log), "notes/3", "PUT", { title: "新标题" });
    assert.equal(log.updated.length, 1);
    assert.equal(log.updated[0].id, 3);
    const patch = log.updated[0].patch as Record<string, unknown>;
    assert.equal(patch.title, "新标题");
    assert.equal("content" in patch, false, "没传的字段不该出现在 patch 里");
    assert.equal("site_id" in patch, false, "没传 site_id 就该保持不动");
});

test("site_id 显式传 null 是「解除关联」，与「不传」区分得开", async () => {
    const log = withLog();
    // 传 null → 解除关联
    await call(makeApi(log), "notes/4", "PUT", { site_id: null });
    assert.equal(
        (log.updated[0].patch as Record<string, unknown>).site_id,
        null,
        "显式 null 应当被当作解除关联传下去"
    );
    // 不传 → 不动
    await call(makeApi(log), "notes/5", "PUT", { content: "x" });
    assert.equal(
        "site_id" in (log.updated[1].patch as Record<string, unknown>),
        false,
        "不传 site_id 就不该出现在 patch 里（否则会把关联误解除）"
    );
});

test("PUT note-orders 接受数组或 { orders } 两种形状", async () => {
    const log = withLog();
    const orders = [{ id: 1, order_num: 0 }];
    await call(makeApi(log), "note-orders", "PUT", orders);
    await call(makeApi(log), "note-orders", "PUT", { orders });
    assert.deepEqual(log.ordered, [orders, orders]);
});

test("PUT note-orders 形状不对要报 400，不能默默当空数组", async () => {
    const log = withLog();
    const res = await call(makeApi(log), "note-orders", "PUT", { nope: 1 });
    assert.equal(res.status, 400);
    assert.deepEqual(log.ordered, [], "形状不对时不该发出任何语句");
});

test("DELETE notes/:id 返回 recycleId（撤销要用）", async () => {
    const log = withLog();
    const res = await call(makeApi(log), "notes/6", "DELETE");
    assert.deepEqual(log.deleted, [6]);
    assert.deepEqual(await res.json(), { success: true, recycleId: 42 });
});

test("四个写分支都过限速闸（静态检查：漏了不会报错，只是限速形同虚设）", () => {
    // 为什么用静态检查而不是打桩：writeGate 是 data.ts **内部**定义的，
    // 它闭包引用了真实的 enforceWriteGuard（限速状态是模块级的），桩不掉。
    // 而漏掉限速闸的表现恰恰是「功能全都正常、只是限速没了」——
    // 那种缺陷只能靠数代码来钉。
    const source = readFileSync(
        join(findProjectDir(), "worker", "routes", "data.ts"),
        "utf-8"
    );
    const notesBlock = source.slice(
        source.indexOf("// ---- 记事本 ----"),
        source.indexOf("} else if (path === \"groups\"", source.indexOf("// ---- 记事本 ----")) > 0
            ? source.indexOf("} else if (path === \"groups\"", source.indexOf("// ---- 记事本 ----"))
            : source.length
    );
    const writeBranches = [
        'path === "notes" && method === "POST"',
        'path === "note-orders" && method === "PUT"',
        'path.startsWith("notes/") && method === "PUT"',
        'path.startsWith("notes/") && method === "DELETE"',
    ];
    for (const branch of writeBranches) {
        const at = notesBlock.indexOf(branch);
        assert.ok(at >= 0, `没找到写分支：${branch}`);
        // 从这个分支往后 200 字内必须有 writeGate
        assert.ok(
            notesBlock.slice(at, at + 200).includes("writeGate()"),
            `写分支 ${branch} 后面没有 writeGate() —— 限速被绕过了`
        );
    }
});

test("id 不是数字就报 400，不该拿 NaN 去查库", async () => {
    const log = withLog();
    for (const [path, method] of [
        ["notes/abc", "GET"],
        ["notes/abc", "PUT"],
        ["notes/abc", "DELETE"],
    ] as const) {
        const res = await call(makeApi(log), path, method, method === "PUT" ? {} : undefined);
        assert.equal(res.status, 400, `${method} ${path}`);
    }
    assert.deepEqual(log.got, [], "非法 id 不该打到 api 层");
    assert.deepEqual(log.deleted, []);
});

test("阶段三：路由层 PUT 必须放行 archived（漏了就是静默丢弃）", () => {
    // 实测踩过：notes.ts 认 archived、路由层白名单没认 →
    // PUT archived:true 返回 200 但回显 archived: 0，用户点归档没反应。
    const src = readFileSync(
        join(findProjectDir(), "src", "API", "methods", "notes.ts"),
        "utf-8"
    );
    void src;
    const routes = readFileSync(
        join(findProjectDir(), "worker", "routes", "data.ts"),
        "utf-8"
    );
    assert.ok(
        /data\.archived !== undefined\) patch\.archived = Boolean\(data\.archived\)/.test(routes),
        "路由层要把 archived 放进 patch，否则字段被静默丢掉"
    );
});
