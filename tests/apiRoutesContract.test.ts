// tests/apiRoutesContract.test.ts
//
// shared/apiRoutes.ts 是**前后端共用**的端点清单：前端拿它定超时档位，worker 侧的路由表
// 从它派生。它坏掉的方式全是静默的 —— 端点多一条少一条，代码都照样编译、页面照样能开。
// 所以这里钉四件事：
//
//   1. **反向覆盖**：src/API/clientMethods/*.ts 里出现的每个端点，resolveRouteTier 都要
//      认得（known=true）。这条是为了让「新端点忘了登记」变成一条会红的断言，
//      而不是静默退化到默认档 —— 后者意味着「这个端点该等多久」这个判断没做过。
//   2. **正向覆盖**：API_ROUTES 里每个 key（每个方法各跑一次）worker 侧确实有人认领。
//      清单里留一条服务端根本没有的路由，等于给了一份会骗人的文档。
//   3. **`recycle/restore` 必须是默认档**：这是本次改造顺手修掉的真实缺陷，见下方注释。
//   4. **key 的形状**：小写、无反斜杠、无前后斜杠、无 query。
//
// 判据沿用 tests/routeCoverage.test.ts 那一套（替身 api + 「能抛错就说明 path/method
// 那个判断已经进去了，仍然算认领」），那边有详细说明，这里不重复。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ROUTES, NO_TIMEOUT_ROUTES, RETIRED_ROUTES, resolveRouteTier } from "../shared/apiRoutes";
import { PROTECTED_ROUTES } from "../worker/index";
import { handlePublicRoutes } from "../worker/routes/public";
import type { RouteCtx } from "../worker/routes/types";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被打包到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

// ---------------------------------------------------------------------------
// 反向覆盖：从源码里把端点字面量抽出来
// ---------------------------------------------------------------------------

/** 五个客户端方法文件。⚠️ 新增文件要加进来，否则它的端点不受这条用例保护 */
const CLIENT_METHOD_FILES = ["auth", "notes", "sites", "system", "vault"].map(
    (name) => `src/API/clientMethods/${name}.ts`,
);

/**
 * 抽出一个 `this.request<…>(<第一个参数>)` 的端点。
 *
 * 为什么不写一条正则了事：泛型参数里什么都有（对象字面量、`Record<number, number[]>`、
 * 跨行的字段列表），`this\.request<[^>]*>\("([^"]*)"\)` 这种写法必挂。
 * 所以逐字符扫一遍：先找 `this.request`，再从它往后数尖括号深度、深度归零后
 * 那个 `(` 就是参数表的开头。`=>` 里的 `>` 要跳过（它不是泛型闭合）。
 */
function endpointsIn(source: string): string[] {
    const found: string[] = [];
    const NEEDLE = "this.request";
    let from = 0;
    for (;;) {
        const at = source.indexOf(NEEDLE, from);
        if (at < 0) break;
        from = at + NEEDLE.length;

        let i = from;
        let depth = 0;
        // 找参数表的 `(`
        for (; i < source.length; i++) {
            const c = source[i];
            if (c === "<") depth++;
            else if (c === ">") {
                if (source[i - 1] !== "=") depth--;
            } else if (c === "(" && depth <= 0) break;
        }
        i++; // 跳过 `(`
        while (i < source.length && /\s/.test(source[i] ?? "")) i++;

        const quote = source[i];
        if (quote !== '"' && quote !== "'" && quote !== "`") continue; // 第一个参数不是字面量（如变量 endpoint）
        i++;
        let literal = "";
        for (; i < source.length; i++) {
            const c = source[i];
            // 模板串：`notes/${id}/share` 这类只取固定前缀（`$` 之前）
            if (quote === "`" ? c === "$" || c === "`" : c === quote) break;
            literal += c;
        }
        if (literal) found.push(literal);
    }
    return found;
}

/** 把抽出来的字面量归一成「表里的 key 形状」：剥 query、剥尾部斜杠 */
function toPathKey(literal: string): string {
    const q = literal.indexOf("?");
    const noQuery = q < 0 ? literal : literal.slice(0, q);
    return noQuery.replace(/\/+$/, "");
}

test("clientMethods 里的每个端点都在 API_ROUTES / RETIRED_ROUTES 里登记过（known=true）", () => {
    const root = projectDir();
    const unknown: string[] = [];
    let total = 0;

    for (const rel of CLIENT_METHOD_FILES) {
        const source = readFileSync(resolve(root, rel), "utf8");
        const literals = endpointsIn(source);
        total += literals.length;
        for (const literal of literals) {
            const path = toPathKey(literal);
            const { known } = resolveRouteTier(path);
            if (!known) unknown.push(`${rel}: ${literal}（归一成 "${path}"）`);
        }
    }

    // ⚠️ 这不是「端点应该有 60 个」的规格，是「抽取逻辑本身坏了」的探测器：
    // 正则/扫描一旦抽不到东西，上面那条断言会变成永真的空转，那才是最坏的结果。
    assert.ok(total >= 60, `只从 clientMethods 里抽到 ${total} 个端点字面量 —— 抽取逻辑坏了？`);
    assert.deepEqual(
        unknown,
        [],
        `这些端点没在 shared/apiRoutes.ts 里登记："${unknown.join("、")}" —— ` +
            "登记它，并顺手回答一次「这个端点该等多久」",
    );
});

test("抽取逻辑本身能认出跨行泛型、模板串前缀与带 query 的写法", () => {
    const sample = [
        'return this.request<NoteAttachment[]>("notes/attachments/list");',
        "return this.request<{ id: string; url: string; filename: string }>(",
        '    "notes/attachments/prune",',
        '    { method: "POST" }',
        ");",
        "return this.request<Site>(`sites/${id}`);",
        'return this.request<{ id: string }>(`notes/attachments/${id}/content`, {',
        '    method: "PUT",',
        "});",
        'return this.request<AuditLogResponse>(`audit?${params.toString()}`);',
        'return this.request("notes/reindex", { method: "POST" });',
        'return this.request<SiteListResponse>(endpoint);',
    ].join("\n");
    assert.deepEqual(endpointsIn(sample), [
        "notes/attachments/list",
        "notes/attachments/prune",
        "sites/",
        "notes/attachments/",
        "audit?",
        "notes/reindex",
    ]);
    assert.equal(toPathKey("sites/"), "sites");
    assert.equal(toPathKey("audit?"), "audit");
    assert.equal(toPathKey("notes/attachments?"), "notes/attachments");
});

// ---------------------------------------------------------------------------
// 正向覆盖：表里的每条路由 worker 侧都得有人认领
// ---------------------------------------------------------------------------

/** 替身 api：方法一律存在，返回值一律 undefined。分支只看 path/method，够用了。 */
function fakeApi(): unknown {
    return new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
            if (prop === "isAuthEnabled") return () => false;
            return async () => undefined;
        },
    });
}

type Handler = (ctx: RouteCtx) => Promise<Response | null>;

/** 公开路由在前（`icon` 在这里），之后是 index.ts 里真实的受保护路由链 */
const CHAIN: Array<[string, Handler]> = [
    ["public", handlePublicRoutes as Handler],
    ...PROTECTED_ROUTES.map((fn): [string, Handler] => [fn.name, fn as Handler]),
];

async function isClaimed(path: string, method: string): Promise<boolean> {
    for (const [, fn] of CHAIN) {
        const request = new Request(`https://nav.example.com/api/${path}`, {
            method,
            headers: method === "GET" ? {} : { "Content-Type": "application/json" },
            body: method === "GET" || method === "HEAD" ? undefined : "{}",
        });
        const ctx = {
            request,
            env: {},
            url: new URL(request.url),
            path,
            method,
            api: fakeApi(),
            ip: "203.0.113.1",
            trustXFF: false,
            trustXRealIp: false,
            secureCookie: true,
            currentJti: "",
            currentTokenExp: 0,
        } as unknown as RouteCtx;
        try {
            if ((await fn(ctx)) !== null) return true;
        } catch {
            // 分支命中了，只是替身 api 给不出后面要的数据 —— 仍然算认领
            return true;
        }
    }
    return false;
}

/** 表里的 value 是逗号分隔的方法清单（`"GET,POST"`） */
function methodsOf(value: string): string[] {
    return value.split(",").filter(Boolean);
}

// 分支里若有外网调用（图标代理），让它拿到一个空响应就好 —— 我们只关心「有没有被认领」
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("{}", { status: 200 });

test("API_ROUTES 里的每条 path+method 都有 worker 模块认领", async () => {
    const unclaimed: string[] = [];
    for (const [path, value] of Object.entries(API_ROUTES)) {
        for (const method of methodsOf(value)) {
            if (!(await isClaimed(path, method))) unclaimed.push(`${method} /api/${path}`);
        }
    }
    assert.deepEqual(
        unclaimed,
        [],
        `清单里有服务端没人认领的路由："${unclaimed.join("、")}" —— ` +
            "要么端点已下线（该删/该挪进 RETIRED_ROUTES），要么 worker 分支掉了",
    );
});

// ---------------------------------------------------------------------------
// 具体档位的回归断言
// ---------------------------------------------------------------------------

test("recycle/restore 与 recycle/restore-batch 走默认档，不是「不限时」", () => {
    // 由来：超时档位以前是 `/restore/i` 靠**端点名**猜出来的，于是这两个端点
    // （回收站恢复，一次普通 DB 操作，几十毫秒该回来）被划进了「不设超时」那一档。
    // 它们真要卡死，前端就**永远等下去** —— 没有超时、没有报错、只有一个转不完的圈。
    // 档位改成显式数据之后这条必须钉住，否则哪天有人「顺手」把它们加回 none 档，
    // 界面上看不出任何区别。
    assert.equal(resolveRouteTier("recycle/restore").tier, "default");
    assert.equal(resolveRouteTier("recycle/restore-batch").tier, "default");
    assert.equal(resolveRouteTier("recycle/purge").tier, "default");
    // 对照：真正「耗时由数据量决定」的那几个仍在不限时档（不然上面两条可能只是「都没登记」）
    assert.equal(resolveRouteTier("export").tier, "none");
    assert.equal(resolveRouteTier("notes/import").tier, "none");
});

test("没登记的端点 known=false（否则「忘了登记」永远不会被发现）", () => {
    const { tier, known } = resolveRouteTier("definitely-not-a-route/1");
    assert.equal(known, false);
    // 运行时按默认档走：不认识的端点不能变成「不限时」—— 那是最危险的退化方向
    assert.equal(tier, "default");
});

test("API_ROUTES 的 key 形状：小写、无反斜杠、无前后斜杠、无 query", () => {
    for (const key of Object.keys(API_ROUTES)) {
        assert.equal(key, key.toLowerCase(), `"${key}" 不是小写`);
        assert.ok(!key.includes("\\"), `"${key}" 里有反斜杠`);
        assert.ok(!key.startsWith("/"), `"${key}" 有前导斜杠`);
        assert.ok(!key.endsWith("/"), `"${key}" 有尾部斜杠（前缀语义靠最长匹配表达，不靠斜杠）`);
        assert.ok(!key.includes("?"), `"${key}" 里带了 query`);
        assert.ok(key.length > 0, "空 key");
    }
});

test("RETIRED_ROUTES 与 API_ROUTES 不重叠，且都停在「不限时」档", () => {
    // RETIRED_ROUTES 是「服务端早已没有的旧路径」，只为钉住历史档位而留（见该表注释）。
    // 重叠 = 同一个路径两处定义，将来改一处忘另一处。
    const overlap = RETIRED_ROUTES.filter((k) => k in API_ROUTES);
    assert.deepEqual(overlap, [], `这些 key 同时出现在两张表里："${overlap.join("、")}"`);
    for (const key of RETIRED_ROUTES) {
        assert.ok(
            NO_TIMEOUT_ROUTES.includes(key),
            `"${key}" 当年是不限时档，得留在 NO_TIMEOUT_ROUTES 里，否则旧断言会失真`,
        );
        assert.equal(resolveRouteTier(key).tier, "none", `"${key}" 必须解析成不限时`);
    }
});

test("例外清单（NO_TIMEOUT_ROUTES）里每条路径都真的存在", () => {
    // timeoutTierOf 是**精确匹配**，所以例外清单里写错一个字母不会有任何报错 ——
    // 那条端点只是静默退回默认 30 秒，然后在真·大文件上传时超时。
    const known = new Set<string>([...Object.keys(API_ROUTES), ...RETIRED_ROUTES]);
    const unknown = NO_TIMEOUT_ROUTES.filter((p) => !known.has(p));
    assert.deepEqual(unknown, [], `例外清单里这些路径在端点清单里找不到："${unknown.join("、")}"`);
});

test("例外路径都没有子路径（否则精确匹配会静默漏掉它们）", () => {
    // timeoutTierOf 不做前缀匹配 —— 这是刻意的（`notes/attachments` 一旦按前缀放宽，
    // 整个附件 CRUD 都会拿到 240 秒）。代价是：万一将来给某条例外端点加了子路径，
    // 子路径会静默落在默认档。这条用例把那个「将来」提前变成红色。
    const withChildren: string[] = [];
    const all = [...Object.keys(API_ROUTES), ...RETIRED_ROUTES];
    for (const exception of NO_TIMEOUT_ROUTES) {
        for (const path of all) {
            if (path.startsWith(`${exception}/`)) withChildren.push(`${exception} → ${path}`);
        }
    }
    assert.deepEqual(
        withChildren,
        [],
        `这些例外端点有了子路径，子路径会静默退回默认档（要么把子路径也列进例外，要么改成分档前缀匹配）："${withChildren.join("、")}"`,
    );
});

test.after(() => {
    globalThis.fetch = realFetch;
});
