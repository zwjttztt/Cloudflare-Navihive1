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
// 两条断言分开钉，因为它们的失败含义不同：
//   1. 方法集合：新增接口时忘了在 mock 里实现 → 变红（本地开发直接会崩，属早期发现）
//   2. 形状一致：两边返回的**结构**不同 → 变红（测试全绿、线上崩的那条路）
import { test, afterEach } from "node:test";
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
// 纯函数：结构指纹（不含具体值）
// ---------------------------------------------------------------------------

/**
 * 把任意值压成「结构形状」：对象取键集合、数组只看首个元素、基本类型只看 typeof。
 * 比较两个实现时比的是这个 —— 值不同没关系（mock 造的数据和线上不一样是正常的），
 * 结构不同才是问题（前端少一层 / 多一层 / 数组变对象都会被抓到）。
 *
 * 约定：
 *   - `undefined` 的键直接丢掉：它和「键不存在」在 JSON 序列化后不可区分，
 *     算成差异只会制造噪音。
 *   - null 单独记成 `"null"`，不与 `{}` 混为一谈。
 *   - 深度封顶，防止自我引用的对象把递归带死。
 */
export function shapeOf(value: unknown, depth = 0): unknown {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) {
        return value.length === 0 ? "[]" : [shapeOf(value[0], depth + 1)];
    }
    if (typeof value === "object") {
        if (depth >= 4) return "…";
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const v = (value as Record<string, unknown>)[key];
            if (v === undefined) continue;
            out[key] = shapeOf(v, depth + 1);
        }
        return out;
    }
    return typeof value;
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
            "  补上之后记得让两边行为一致 —— 下一条用例就是管这个的。"
    );
});

// ---------------------------------------------------------------------------
// 形状一致：透传型接口
// ---------------------------------------------------------------------------

/**
 * 只挑「client 原样返回服务端 JSON」的接口。
 *
 * 不能对所有方法都这么比 —— 有些接口两边协议本来就不同：
 * `getConfig` 服务端回 `{ key, value }`，client 解包成 `value`，而 mock 直接给值。
 * 那是 client 的解包设计，不是 mock 的错。这类接口要比就得单独写死期望值，不在通用断言里。
 */
const PASSTHROUGH_CASES = ["bootstrap", "getGroups", "getConfigs", "aiStatus"] as const;

let restoreFetch: (() => void) | null = null;

function installFetch(payload: () => unknown) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => payload(),
    })) as unknown as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
});

test("透传型接口：mock 与 client 返回的结构一致", async () => {
    const mock = new MockNavigationClient();
    const client = new NavigationClient("/api");

    const diffs: string[] = [];
    for (const name of PASSTHROUGH_CASES) {
        const mockFn = mock[name] as () => Promise<unknown>;
        const clientFn = client[name] as () => Promise<unknown>;
        if (typeof mockFn !== "function" || typeof clientFn !== "function") {
            diffs.push(`${name}: 两边不是都有这个方法`);
            continue;
        }

        const mockResult = await mockFn.call(mock);
        // 把 mock 的返回值当作「服务端会返回的东西」喂给 client：
        // client 只做透传，于是它解出来的结构就该和 mock 的结构一样。
        restoreFetch = installFetch(() => mockResult);
        const clientResult = await clientFn.call(client);
        restoreFetch();
        restoreFetch = null;

        const a = JSON.stringify(shapeOf(mockResult));
        const b = JSON.stringify(shapeOf(clientResult));
        if (a !== b) {
            diffs.push(`${name}:\n    mock   = ${a}\n    client = ${b}`);
        }
    }

    assert.deepEqual(
        diffs,
        [],
        "两边的返回结构不一致 —— 用例全走 mock 所以现在是绿的，线上就会不一样。\n" +
            "  要么改 mock 对齐 client，要么改 client 对齐 mock；别在测试里绕过去。"
    );
});

test("形状指纹：null、空数组与缺失键要能区分（守卫本身的自检）", () => {
    // 这条是给上面那条用例的：形状比较很容易写得过松或者过紧，
    // 断言它本身能认出关键差异，才知道它靠不靠谱。
    assert.notDeepEqual(shapeOf(null), shapeOf({}), "null 不该和空对象同形");
    assert.notDeepEqual(shapeOf([]), shapeOf(["x"]), "空数组与单元素数组不该同形");
    assert.notDeepEqual(shapeOf({}), shapeOf([]), "对象与数组不该同形");
    assert.deepEqual(shapeOf({ a: undefined }), shapeOf({}), "undefined 的键应被丢掉");
    // 值不同不算差异，但**类型不同算** —— 前端拿到 number 而不是 string 是真问题，
    // 这种差异正是这条守卫该抓出来的，别把它抹平。
    assert.deepEqual(shapeOf({ a: 1 }), shapeOf({ a: 2 }), "同类型不同值不该算差异");
    assert.deepEqual(shapeOf([{ a: 1 }]), shapeOf([{ a: 2 }]), "数组同理只看首元素结构");
    assert.notDeepEqual(
        shapeOf({ a: 1 }),
        shapeOf({ a: "1" }),
        "类型不同必须算差异（前端拿到 number 而不是 string 会直接崩）"
    );
    assert.deepEqual(shapeOf({ a: 1, b: 2 }), shapeOf({ b: 2, a: 1 }), "键的顺序不该算差异");
});
