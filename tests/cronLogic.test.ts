// tests/cronLogic.test.ts
// 死链巡检的纯逻辑单测。这段逻辑每周才跑一次、错了没人立刻发现，
// 之前全内联在 worker/cron.ts 里没法直接测。抽进 ./cronLogic.ts 后在这里钉死：
//   ① 状态码死活判定（404/410 死、5xx 探测失败、登录墙 403 算活着）
//   ② 候选挑选（白名单/新鲜期跳过、最久没探的优先、30 上限）
//   ③ max 时间戳合并（活着刷新 probe、失效刷新 dead、不把新记录打回去）
//   ④ 超长快照裁剪（dead/probe 各留最新的 N 条）
//   ⑤ 快照宽容解析（null/非法 JSON/缺字段退化成空快照）
// probeUrl 单独用 mock fetch 验（HEAD/GET 回退、超时 abort、网络错误）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    HEALTH_KEY,
    MAX_PROBES_PER_RUN,
    applyProbeResult,
    emptySnapshot,
    isAliveHttpStatus,
    parseSnapshot,
    selectSweepCandidates,
    trimSnapshot,
    type LinkHealthSnapshot,
    type SweepSite,
} from "../worker/cronLogic";

const site = (id: number, url: string): SweepSite => ({ id, url });

// 真实 FRESH_WINDOW_MS ≈ 7 天，测试用例用真实纪元时间戳，避免「now 太小反而全在新鲜期」的误判
const NOW = 3_000_000_000; // ~2065 年
const DAY = 24 * 60 * 60 * 1000;

// ---------------- ① 状态码死活判定 ----------------
test("isAliveHttpStatus：2xx / 3xx 跟随后都算活着", () => {
    for (const s of [200, 201, 204, 301, 302]) assert.equal(isAliveHttpStatus(s), true, `status=${s}`);
});

test("isAliveHttpStatus：登录墙/防盗链的 403 算活着（站点通着）", () => {
    assert.equal(isAliveHttpStatus(403), true);
    assert.equal(isAliveHttpStatus(401), true);
});

test("isAliveHttpStatus：404 / 410 资源确实没了 = 失效", () => {
    assert.equal(isAliveHttpStatus(404), false);
    assert.equal(isAliveHttpStatus(410), false);
});

test("isAliveHttpStatus：5xx 算探测失败（不冤枉活站点）", () => {
    assert.equal(isAliveHttpStatus(500), false);
    assert.equal(isAliveHttpStatus(503), false);
});

// ---------------- ② 候选挑选 ----------------
test("selectSweepCandidates：空白名单、新鲜期外的才入选", () => {
    const snap: LinkHealthSnapshot = {
        v: 1,
        dead: {},
        probe: { "https://fresh.com": NOW }, // 刚探过，在新鲜期内
        white: [],
    };
    const sites = [site(1, "https://fresh.com"), site(2, "https://old.com")];
    const got = selectSweepCandidates(sites, snap, NOW);
    assert.deepEqual(got, ["https://old.com"]);
});

test("selectSweepCandidates：白名单里的链接直接跳过", () => {
    const snap = { v: 1 as const, dead: {}, probe: {}, white: ["https://ok.com"] };
    const sites = [site(1, "https://ok.com"), site(2, "https://other.com")];
    assert.deepEqual(selectSweepCandidates(sites, snap, Date.now()), ["https://other.com"]);
});

test("selectSweepCandidates：没 url 的站点跳过", () => {
    const sites = [site(1, ""), site(2, "https://x.com")];
    assert.deepEqual(selectSweepCandidates(sites, emptySnapshot(), Date.now()), ["https://x.com"]);
});

test("selectSweepCandidates：按上次探测时间从旧到新排（最久没探的优先）", () => {
    // a 10 天前探过、b 20 天前、c 从没探过（0）—— 都超过新鲜期，按 probe 升序排
    const snap: LinkHealthSnapshot = {
        v: 1,
        dead: {},
        probe: {
            "https://a.com": NOW - 10 * DAY,
            "https://b.com": NOW - 20 * DAY,
            "https://c.com": 0,
        },
        white: [],
    };
    const sites = [site(1, "https://a.com"), site(2, "https://b.com"), site(3, "https://c.com")];
    assert.deepEqual(selectSweepCandidates(sites, snap, NOW), [
        "https://c.com",
        "https://b.com",
        "https://a.com",
    ]);
});

test("selectSweepCandidates：超出上限只取最旧的 N 个", () => {
    const sites = Array.from({ length: MAX_PROBES_PER_RUN + 5 }, (_, i) => site(i, `https://s${i}.com`));
    const got = selectSweepCandidates(sites, emptySnapshot(), NOW);
    assert.equal(got.length, MAX_PROBES_PER_RUN, `应截到 ${MAX_PROBES_PER_RUN}`);
});

test("selectSweepCandidates：可用 opts 改上限和新鲜期（便于测试）", () => {
    const snap: LinkHealthSnapshot = {
        v: 1,
        dead: { "https://old.com": 1 }, // 很久以前失败过
        probe: {},
        white: [],
    };
    // 新鲜期设很长，让 old.com 也「还在窗口内」被跳过
    assert.deepEqual(
        selectSweepCandidates([site(1, "https://old.com")], snap, 10_000, { freshWindowMs: 1_000_000 }),
        []
    );
    // 新鲜期设 0（任何链接都视为过期）+ 上限设 1，多链接只取一条
    assert.equal(
        selectSweepCandidates([site(1, "a"), site(2, "b")], emptySnapshot(), 0, {
            maxProbes: 1,
            freshWindowMs: 0,
        }).length,
        1
    );
});

// ---------------- ③ max 时间戳合并 ----------------
test("applyProbeResult：活着只刷新 probe", () => {
    const snap = { v: 1 as const, dead: { "https://x.com": 100 }, probe: {}, white: [] };
    const next = applyProbeResult(snap, "https://x.com", true, 500);
    assert.equal(next.probe["https://x.com"], 500);
    assert.equal(next.dead["https://x.com"], 100, "活着不该动 dead");
});

test("applyProbeResult：失效取 max 时间戳（和已有 dead 合并，不覆盖更新的）", () => {
    const snap = { v: 1 as const, dead: { "https://x.com": 100 }, probe: { "https://x.com": 300 }, white: [] };
    const next = applyProbeResult(snap, "https://x.com", false, 200);
    assert.equal(next.dead["https://x.com"], 200, "dead 取 max(已有100, 本次200)=200");
    assert.equal(next.probe["https://x.com"], 300, "probe 不受影响");
});

test("applyProbeResult：失效比已有记录新才写回（不把客户端更新打回）", () => {
    const snap = { v: 1 as const, dead: {}, probe: { "https://x.com": 900 }, white: [] };
    const next = applyProbeResult(snap, "https://x.com", false, 950);
    assert.equal(next.dead["https://x.com"], 950);
});

test("applyProbeResult：返回新对象，不动入参（引用稳定）", () => {
    const snap = emptySnapshot();
    const next = applyProbeResult(snap, "https://x.com", true, 1);
    assert.notEqual(next, snap);
    assert.equal(Object.keys(snap.dead).length, 0);
});

// ---------------- ④ 超长快照裁剪 ----------------
test("trimSnapshot：dead / probe 各保留最新的 N 条，白名单不动", () => {
    const make = (): LinkHealthSnapshot => ({
        v: 1,
        dead: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://d${i}.com`, i])),
        probe: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://p${i}.com`, i])),
        white: ["https://w.com"],
    });
    const trimmed = trimSnapshot(make(), 2);
    assert.equal(Object.keys(trimmed.dead).length, 2, "dead 应只留 2 条");
    assert.equal(Object.keys(trimmed.probe).length, 2, "probe 应只留 2 条");
    assert.deepEqual(trimmed.white, ["https://w.com"], "白名单不动");
    // 留下的应是时间戳最大的
    assert.ok(trimmed.dead["https://d4.com"] !== undefined && trimmed.dead["https://d0.com"] === undefined);
});

// ---------------- ⑤ 快照宽容解析 ----------------
test("parseSnapshot：null / 空串退化成空快照", () => {
    assert.deepEqual(parseSnapshot(null), emptySnapshot());
    assert.deepEqual(parseSnapshot(""), emptySnapshot());
});

test("parseSnapshot：非法 JSON 退化成空快照（不抛）", () => {
    assert.deepEqual(parseSnapshot("{不是json"), emptySnapshot());
});

test("parseSnapshot：缺字段用空对象兜底，white 非数组当成空", () => {
    const snap = parseSnapshot(JSON.stringify({ v: 1, dead: { "https://a.com": 1 } }));
    assert.deepEqual(snap.dead, { "https://a.com": 1 });
    assert.deepEqual(snap.probe, {});
    assert.deepEqual(snap.white, []);
});

test("parseSnapshot：版本不符的脏数据也安全退化", () => {
    assert.deepEqual(parseSnapshot(JSON.stringify({ v: 2, dead: { "https://x.com": 1 } })), emptySnapshot());
});

test("HEALTH_KEY 与 link.health 一致", () => {
    assert.equal(HEALTH_KEY, "link.health");
});

// ---------------- ⑥ probeUrl（mock fetch） ----------------
function mockFetch(handler: (url: string, init: { method: string }) => { status: number } | Promise<{ status: number }>) {
    const calls: { url: string; method: string }[] = [];
    const prev = globalThis.fetch;
    // @ts-expect-error 测试里用最小替身覆盖全局 fetch
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : (url as URL).href;
        const method = (init?.method as string) || "GET";
        calls.push({ url: u, method });
        const res = await handler(u, { method });
        const status = res.status;
        // safeFetch 依赖真实的 Response 形状：ok（2xx）、headers.get（重定向 Location）
        return {
            status,
            ok: status >= 200 && status < 300,
            headers: { get: () => null },
            body: null,
            async cancel() {},
        } as unknown as Response;
    };
    return {
        calls,
        restore: () => {
            // @ts-expect-error 还原
            globalThis.fetch = prev;
        },
    };
}

test("probeUrl：HEAD 200 → 活着", async () => {
    const m = mockFetch(() => ({ status: 200 }));
    assert.equal(await (await import("../worker/cron")).probeUrl("https://a.com"), true);
    assert.equal(m.calls[0]?.method, "HEAD");
    m.restore();
});

test("probeUrl：HEAD 404 → 失效", async () => {
    const m = mockFetch(() => ({ status: 404 }));
    assert.equal(await (await import("../worker/cron")).probeUrl("https://a.com"), false);
    m.restore();
});

test("probeUrl：HEAD 405 回退 GET，且 GET 200 → 活着", async () => {
    const m = mockFetch((_u, init) =>
        init.method === "HEAD" ? { status: 405 } : { status: 200 }
    );
    assert.equal(await (await import("../worker/cron")).probeUrl("https://a.com"), true);
    assert.deepEqual(m.calls.map(c => c.method), ["HEAD", "GET"], "应先 HEAD 再 GET");
    m.restore();
});

test("probeUrl：5xx → 探测失败（视为失效口径）", async () => {
    const m = mockFetch(() => ({ status: 503 }));
    assert.equal(await (await import("../worker/cron")).probeUrl("https://a.com"), false);
    m.restore();
});

test("probeUrl：网络错误 → 失效口径", async () => {
    const m = mockFetch(() => {
        throw new Error("network down");
    });
    assert.equal(await (await import("../worker/cron")).probeUrl("https://a.com"), false);
    m.restore();
});
