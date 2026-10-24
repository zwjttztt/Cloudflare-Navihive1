// tests/jsonBodyGuard.test.ts
// 「写接口的请求体必须过 readJsonBody / readJsonArray」的守卫。
//
// 背景（2026-10-23 全站复查实测）：各路由原本直接 `const data = await request.json() as X`
// 然后就去读 `data.title`。HTTP 客户端想发什么就发什么，于是 body 是 `null` 时
// `null.title` 抛 TypeError、冒泡到入口变成 **500**；body 是 `"字符串"` / `123` 时
// 属性访问会装箱、逐个字段都取到 undefined，于是**静默建出一条全空的笔记**。
// 首次落地那轮探针命中 9 处 500（POST /api/notes、/api/login、/api/groups、/api/sites、
// /api/notes/folders、/api/notes/tags、PUT /api/:id、PUT /api/configs …）。
//
// 修完就完了吗？不 —— 下一个人新写一个写接口时，最自然的写法还是 `await request.json()`。
// 所以这里钉住：worker/ 下除了 jsonBody.ts 自己，不许再有**裸解析**的请求体读取。
//
// ⚠️ 2026-10-24 收紧：第一版守卫曾把 `.catch(() => ({}))` / `.catch(() => null)` 当
// 「有兜底」放行 —— 那是**制度性漏洞**：兜底只挡住了「解析失败 → 500」那一半，
// 「解析成功但不是对象」（字符串 / 数字 / 布尔）照样静默流过，逐个字段取到
// undefined，与没守是一样的。19 处路由就是钻这个豁免写下来的（全站复查 P1）。
// 现在豁免只剩一种：util.ts 的 safeJson —— 它的调用方含 GET（无 body 是合法输入），
// 且它自己判 `typeof body === "object"`。

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ApiError } from "../worker/lib/apiError";

function findProjectDir(): string {
    for (let dir = process.cwd(), i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const root = findProjectDir();

/** 递归收集 worker/ 下的 .ts（跳过 d.ts 与测试） */
function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            out.push(...tsFiles(full));
            continue;
        }
        if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
}

/** 剥掉块注释与行注释：注释里会解释这些写法，不该被当成违规代码 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const at = line.indexOf("//");
            return at === -1 ? line : line.slice(0, at);
        })
        .join("\n");
}

const offenders: string[] = [];
for (const file of tsFiles(path.join(root, "worker"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "worker/routes/jsonBody.ts") continue; // 就是那个入口
    const code = stripComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((line, i) => {
        if (!line.includes("request.json()")) return;
        // 唯一豁免：util.ts 的 safeJson —— 调用方含 GET（无 body 合法），
        // 且函数体紧跟着就判「必须是对象」，不会把垃圾喂给下游。
        if (rel === "worker/util.ts" && code.includes('typeof body === "object"')) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
}

test("写接口的请求体不许裸解析：一律走 readJsonBody / readJsonArray / readJsonValue", () => {
    assert.deepEqual(
        offenders,
        [],
        `以下位置直接 await request.json() —— 非对象 body（字符串/数字/布尔）会静默流过，\n` +
            `逐个字段取到 undefined。写接口请用 readJsonBody，两种形状都收的老接口用 readJsonValue：\n` +
            offenders.join("\n")
    );
});

test("readJsonBody 拒绝 null 与非对象，readJsonArray 拒绝非数组", () => {
    const src = stripComments(readFileSync(path.join(root, "worker/routes/jsonBody.ts"), "utf8"));
    // null 必须被挡：这是「500 → 400」的那一半
    assert.match(src, /parsed === null/, "readJsonBody 必须显式挡 null");
    assert.match(src, /typeof parsed !== "object"/, "readJsonBody 必须挡非对象（字符串/数字/布尔）");
    assert.match(src, /Array\.isArray\(parsed\)/, "readJsonBody 必须挡数组");
    assert.match(src, /!Array\.isArray\(parsed\)/, "readJsonArray 必须要求数组");
    // 解析失败要回 400 而不是让 SyntaxError 冒出去
    assert.match(src, /请求体不是合法的 JSON/, "解析失败要给明确的 400");
});

test("readJsonBody 行为：坏 JSON / null / 字符串 / 数字 / 数组全部抛 400", async () => {
    const { readJsonBody, readJsonValue, readJsonArray } = await import("../worker/routes/jsonBody");
    const post = (body: string) =>
        new Request("http://nav.example.com/api/notes", { method: "POST", body });

    // 会被 .catch(() => ({})) 静默吞掉、从而漏进业务层的五种形态
    for (const body of ["not-json", "null", '"字符串"', "123", "true", "[1,2]"]) {
        await assert.rejects(
            readJsonBody(post(body)),
            (error: unknown) => error instanceof ApiError && error.status === 400,
            `body=${body} 必须 400`
        );
    }
    // readJsonValue 只挡 null / 字符串 / 数字 / 布尔，两种形状都放行
    await assert.rejects(readJsonValue(post('"str"')), (e: unknown) => e instanceof ApiError && e.status === 400);
    assert.deepEqual(await readJsonValue(post('{"a":1}')), { a: 1 });
    assert.deepEqual(await readJsonValue(post("[1,2]")), [1, 2]);
    // readJsonArray 反过来：只收数组
    await assert.rejects(readJsonArray(post('{"a":1}')), (e: unknown) => e instanceof ApiError && e.status === 400);
    assert.deepEqual(await readJsonArray(post("[1,2]")), [1, 2]);
});
