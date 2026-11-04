// tests/apiEdgeProbeSpec.test.ts
//
// `script/api-edge-probe.mjs` 的 case 表守卫。
//
// 为什么需要（2026-11 复查）：探针以前的唯一判据是 `status >= 500` 才算坏 ——
// 于是 401 / 404 全算「好」。实际后果是探针**绿不绿和能力对不对无关**：
//   · 登录没成功 → 写接口全 401 → 全绿
//   · 路由写错成 404 → 全绿
//   · `note-orders` 两条**有效**请求被挡成 400 → 全绿（这正是「改错过一次」的那条）
// 更糟的是 case 表写在脚本里，只能在起服务、跑完 60 多个请求之后才知道表长什么样，
// 想提前拦住「新加的 case 忘了写期望」根本没有落点。
//
// 所以 case 表抽成了纯数据模块 `script/api-edge-probe-cases.mjs`，
// 这里直接 import 结构来断言 —— **不拿正则扫源码**（改个引号就假绿，等于没守卫）。
//
// 这一组用例只管「表本身说不说得清」，不执行任何 HTTP 请求：真跑要起服务，
// 是 `npm run probe:edge` 的事。
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_NONE, LONG_INPUT, MIN_CASES, buildCases } from "../script/api-edge-probe-cases.mjs";
import type { ProbeCase } from "../script/api-edge-probe-cases.mjs";

/** 桩上下文：表里的运行期值都能缺省，测试不需要起服务也能拿到全量 case */
const STUB_CTX = {};

const CASES: ProbeCase[] = buildCases(STUB_CTX);

/** 5xx 在探针里**永远**判失败（服务端崩了），所以任何 case 都不许把 5xx 写进期望 */
const isServerError = (status: number) => status >= 500;

test("case 表条数不低于原脚本的 59 条（抽表时一条都不许丢）", () => {
    assert.ok(
        CASES.length >= MIN_CASES,
        `case 表只有 ${CASES.length} 条，低于下限 ${MIN_CASES} —— 抽表时丢用例了`
    );
    assert.ok(MIN_CASES >= 59, `下限常量本身被改小了（${MIN_CASES}），守卫就失效了`);
});

test("每条 case 都显式声明了 expect：非空、纯整数、不含 5xx", () => {
    const problems: string[] = [];
    for (const [i, c] of CASES.entries()) {
        const at = `#${i + 1} ${c.method} ${c.path}`;
        // 旧语义就是「不写期望，只看是不是 5xx」。缺 expect 等于退回旧语义。
        if (!Array.isArray(c.expect) || c.expect.length === 0) {
            problems.push(`${at}: 没有 expect（等于退回「只找 5xx」的旧判据）`);
            continue;
        }
        for (const status of c.expect) {
            if (!Number.isInteger(status)) problems.push(`${at}: expect 里有非整数 ${String(status)}`);
            else if (status < 100 || status > 599) problems.push(`${at}: expect 里有非法状态码 ${status}`);
            // 5xx 由探针的 judge() 直接判失败，写进期望只会自相矛盾
            else if (isServerError(status)) problems.push(`${at}: expect 里写了 5xx(${status}) —— 服务端崩了不能算通过`);
        }
    }
    assert.deepEqual(problems, [], "case 表的期望声明有问题：\n" + problems.join("\n"));
});

test("每条 case 都说清了「在探什么」，方法和路径都非空", () => {
    const problems: string[] = [];
    for (const [i, c] of CASES.entries()) {
        const at = `#${i + 1}`;
        if (typeof c.method !== "string" || !c.method.trim()) problems.push(`${at}: method 为空`);
        if (typeof c.path !== "string" || !c.path.startsWith("/api/")) {
            problems.push(`${at}: path 必须以 /api/ 开头，实际 ${String(c.path)}`);
        }
        // why 是失败时唯一的上下文：没有它，红了只能回去猜这条想验什么
        if (typeof c.why !== "string" || !c.why.trim()) problems.push(`${at}: why 为空`);
    }
    assert.deepEqual(problems, [], "case 元信息不全：\n" + problems.join("\n"));
});

test("期望集合覆盖了「该拒」和「该过」两侧，且显式探了未鉴权", () => {
    const all = CASES.flatMap(c => c.expect);
    assert.ok(all.some(s => s >= 200 && s < 300), "没有任何 case 期望 2xx —— 等于只验「坏的被拒」，漏掉「好的也被拒」");
    assert.ok(all.some(s => s >= 400 && s < 500), "没有任何 case 期望 4xx —— 边界输入该被拒的没验");
    assert.ok(all.includes(401), "没有任何 case 期望 401 —— 未鉴权这条路完全没探（旧判据把 401 当「好」的老毛病）");

    const unauth = CASES.filter(c => c.auth === AUTH_NONE);
    assert.ok(unauth.length >= 1, "至少要有 1 条故意不带会话的 case");
    for (const c of unauth) {
        assert.deepEqual(c.expect, [401], `未鉴权 case ${c.method} ${c.path} 必须只期望 401（实际写了 [${c.expect.join("/")}]）`);
    }
});

test("既探「不存在 / 无意义」的读，也探「有效请求必须成功」的写", () => {
    // (1) 不存在的 id：显式 404，不许用「非 5xx 就算过」蒙
    const notFound = CASES.filter(c => c.method === "GET" && c.expect.includes(404));
    assert.ok(notFound.length >= 2, `期望 404 的 GET case 只有 ${notFound.length} 条，太薄`);

    // (2) note-orders 的两种有效形状（顶层数组 / { orders }）都必须钉成 2xx。
    //     这两条以前只被「非 5xx 就算过」放过去 —— 被挡成 400 也是绿的。
    const noteOrdersOk = CASES.filter(
        c => c.method === "PUT" && c.path === "/api/note-orders" && c.expect.every(s => s >= 200 && s < 300)
    );
    assert.equal(noteOrdersOk.length, 2, "note-orders 的两种有效形状必须各有一条「期望 2xx」的 case");
    for (const c of noteOrdersOk) {
        assert.deepEqual(c.expect, [200], `note-orders 有效请求应钉成 [200]（真实实现是 Response.json），实际 [${c.expect.join("/")}]`);
        assert.ok(Array.isArray(c.body) || Array.isArray((c.body as { orders?: unknown })?.orders), "有效形状只能有两种：顶层数组或 { orders }");
    }

    // (3) 畸形请求体（null / 字符串 / 数字）打到**写接口**必须被 400 挡住，不许静默建出空记录。
    //     例外：`POST /api/notes/search` 名字是 POST、语义是只读，`null` 体能安全地当成
    //     「空查询」处理（实测 200 + 空结果），所以它不在这一条的口径里。
    const READ_ONLY_POST = new Set(["/api/notes/search"]);
    const badBodies = CASES.filter(
        c => c.body === null && c.method !== "GET" && !READ_ONLY_POST.has(c.path)
    );
    assert.ok(badBodies.length >= 10, `空体探测只有 ${badBodies.length} 条，太薄`);
    for (const c of badBodies) {
        assert.ok(c.expect.includes(400), `${c.method} ${c.path} 的空体应期望 400，实际 [${c.expect.join("/")}]`);
    }
});

test("超长输入确实超长（探针里那条 10 万字符不是摆设）", () => {
    assert.ok(LONG_INPUT.length >= 100_000, `LONG_INPUT 只有 ${LONG_INPUT.length} 字符`);
    const usedLong = CASES.filter(c => JSON.stringify(c.body ?? null).includes(LONG_INPUT));
    assert.ok(usedLong.length >= 3, `只有 ${usedLong.length} 条 case 用了超长输入`);
});

test("工厂能接受桩上下文，且带 noteId 时不改变 case 条数", () => {
    const withCtx = buildCases({ longInput: "y".repeat(100_000), noteId: 42 });
    assert.equal(withCtx.length, CASES.length, "注入上下文不该改变 case 条数");
    const rewritten = withCtx.filter(c => JSON.stringify(c.body ?? null).includes("42"));
    assert.ok(rewritten.length >= 1, "ctx.noteId 没被用上（工厂签名是空的）");
});
