// tests/swCache.test.ts
// Service Worker 的缓存治理。public/sw.js 是**经典脚本**（没有 export、跑在 worker 上下文里），
// 没法直接 import，这里用 node:vm 把它整个跑起来，再用假的 Cache Storage 触发 fetch 事件。
//
// 钉的是两条曾经写错、又极难从界面上看出来的规则：
//   1. 图标配额（120）与总配额（300）必须**各自独立成立** ——
//      以前「总数没超就直接 return」会让图标配额永远不生效。
//   2. 超龄回收要在「缓存命中」那条路上也跑得到 ——
//      以前只在 miss 路径调用，天天命中的图标永远不过期。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * 找到仓库根目录。
 *
 * 不能用 `__dirname + ".."`：单测会被 esbuild 打进 script/tmp-tests/ 再跑，
 * 那时 __dirname 指的是产物目录，拼出来的是 script/public/sw.js。
 * 这里改成一路向上找「同时有 package.json 和 public/sw.js」的那一层。
 */
function findRepoRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (
            fs.existsSync(path.join(dir, "package.json")) &&
            fs.existsSync(path.join(dir, "public", "sw.js"))
        ) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

const SW_PATH = path.resolve(findRepoRoot(), "public", "sw.js");
const SW_SRC = fs.readFileSync(SW_PATH, "utf8");

/** 缓存里的一条：只保留测试要观测的字段 */
type Entry = { res: Response; cachedAt: number };

class FakeCache {
    entries = new Map<string, Entry>();
    putCalls = 0;

    async put(req: { url: string }, res: Response) {
        this.entries.set(req.url, { res, cachedAt: Date.now() });
        this.putCalls++;
    }
    async match(req: { url: string }) {
        const hit = this.entries.get(req.url);
        return hit ? hit.res : undefined;
    }
    async delete(req: { url: string }) {
        return this.entries.delete(req.url);
    }
    async keys() {
        return [...this.entries.keys()].map(url => ({ url }));
    }
    async add(url: string) {
        this.entries.set(url, { res: new Response("x"), cachedAt: Date.now() });
    }
    async addAll(urls: string[]) {
        for (const u of urls) await this.add(u);
    }
}

/**
 * 把 sw.js 跑起来，返回它注册的 fetch handler。
 * self / caches / fetch 都换成假的，唯一保留真的 Response / Headers / URL。
 */
/**
 * 把 sw.js 跑起来，返回它注册的 fetch handler。
 * self / caches / fetch 都换成假的，唯一保留真的 Response / Headers / URL。
 *
 * `targets` 之外的一切请求默认返回一张 200 的图：
 * 如果上游返回 404，sw.js 既不写缓存也不整理，测试就变成了空跑。
 */
function bootServiceWorker(targets: Record<string, Response>) {
    const handlers = new Map<string, (e: unknown) => void>();
    const cache = new FakeCache();
    const caches = {
        async open() {
            return cache;
        },
        async keys() {
            return [];
        },
    } as unknown as CacheStorage;

    const sandbox = {
        // sw.js 顶层就调 self.addEventListener
        self: {
            addEventListener: (type: string, fn: (e: unknown) => void) =>
                handlers.set(type, fn),
            skipWaiting: () => {},
            clients: { claim: () => {} },
        },
        caches,
        // 只有 precache-manifest 与目标静态资源两种请求
        fetch: async (input: string | { url: string }) => {
            const url = typeof input === "string" ? input : input.url;
            if (url.includes("precache-manifest.json")) {
                return new Response(JSON.stringify({ version: "test", core: [], lazy: [] }), {
                    headers: { "Content-Type": "application/json" },
                });
            }
            return (
                targets[url] ??
                iconResponse() ??
                new Response("not found", { status: 404 })
            );
        },
        Request: class {
            url: string;
            method: string;
            destination: string;
            mode: string;
            constructor(url: string, init: Record<string, unknown> = {}) {
                this.url = url;
                this.method = "GET";
                this.destination = String(init.destination ?? "");
                this.mode = String(init.mode ?? "no-cors");
            }
        },
        Response,
        Headers,
        URL,
        Date,
        console,
        setTimeout,
        Promise,
        Math,
        JSON,
        Number,
        String,
        Array,
        Object,
        AbortSignal,
        FetchEvent: class {},
    };
    vm.createContext(sandbox);
    vm.runInContext(SW_SRC, sandbox, { filename: "sw.js" });

    return { handlers, cache };
}

/** 触发一次 fetch 事件，把 waitUntil 里的尾巴也跑完 */
async function fireFetch(
    handlers: Map<string, (e: unknown) => void>,
    req: Record<string, unknown>
) {
    const handler = handlers.get("fetch");
    assert.ok(handler, "sw.js 必须注册 fetch handler");

    let responded: Promise<Response> | null = null;
    const tails: Promise<unknown>[] = [];
    handler({
        request: req,
        respondWith: (p: Promise<Response>) => {
            responded = p;
        },
        waitUntil: (p: Promise<unknown>) => tails.push(p),
    });
    await responded;
    // waitUntil 是在好几层 .then() 里才被调用的（putWithTimestamp → trim 各有一次），
    // 一次 await 收不全；多转几圈事件循环把尾巴排干净。
    for (let i = 0; i < 6; i++) {
        await Promise.all(tails);
        await new Promise(r => setTimeout(r, 0));
    }
}

const iconUrl = (i: number) => `https://cdn.example.com/i${i}.png`;
/** 造一张能进缓存的图（ok + 有 body） */
const iconResponse = () =>
    new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
    });

test("sw：总数没超但图标超配额时，图标配额照样生效（以前会被提前 return 挡掉）", async () => {
    const { handlers, cache } = bootServiceWorker({});
    // 150 张图 + 50 个别的资源 = 200 条，总数没到 MAX_ENTRIES(300)，
    // 但图标 150 已经超过 MAX_ICON_ENTRIES(120) —— 这一档必须自己清出来
    for (let i = 0; i < 150; i++) {
        cache.entries.set(iconUrl(i), { res: iconResponse(), cachedAt: Date.now() });
    }
    for (let i = 0; i < 50; i++) {
        cache.entries.set(`https://app.example.com/a${i}.js`, {
            res: new Response("js"),
            cachedAt: Date.now(),
        });
    }
    assert.equal(cache.entries.size, 200);

    // 再取一张新图：走 miss → 写入 → trimCache
    cache.entries.set("__marker__", { res: new Response("x"), cachedAt: Date.now() });
    const target = iconUrl(999);
    await fireFetch(handlers, {
        url: target,
        method: "GET",
        destination: "image",
        mode: "no-cors",
    });
    cache.entries.delete("__marker__");

    const icons = [...cache.entries.keys()].filter(u => /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u));
    assert.ok(
        icons.length <= 120,
        `图标应被回收到 120 以内，实际 ${icons.length}`
    );
});

test("sw：总配额超限时先砍超额图标，再砍其它条目", async () => {
    const { handlers, cache } = bootServiceWorker({});
    for (let i = 0; i < 200; i++) {
        cache.entries.set(iconUrl(i), { res: iconResponse(), cachedAt: Date.now() });
    }
    for (let i = 0; i < 200; i++) {
        cache.entries.set(`https://app.example.com/b${i}.js`, {
            res: new Response("js"),
            cachedAt: Date.now(),
        });
    }
    assert.equal(cache.entries.size, 400);

    const target = iconUrl(1000);
    await fireFetch(handlers, {
        url: target,
        method: "GET",
        destination: "image",
        mode: "no-cors",
    });

    assert.ok(cache.entries.size <= 300, `总量应回到 300 以内，实际 ${cache.entries.size}`);
    const icons = [...cache.entries.keys()].filter(u => /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u));
    assert.ok(icons.length <= 120, `图标不应拖过 120，实际 ${icons.length}`);
});

test("sw：缓存命中也会比对着把超龄图标清掉（以前只有 miss 路径会清）", async () => {
    const { handlers, cache } = bootServiceWorker({});
    // 一张 40 天前的老图 —— 超过 MAX_AGE_MS(30 天)
    const staleUrl = iconUrl(1);
    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const staleRes = new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "Content-Type": "image/png", "sw-cached-at": String(oldTime) },
    });
    cache.entries.set(staleUrl, { res: staleRes, cachedAt: oldTime });
    // 一张新的，不该被误删
    const freshUrl = iconUrl(2);
    cache.entries.set(freshUrl, { res: new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "Content-Type": "image/png", "sw-cached-at": String(Date.now()) },
    }), cachedAt: Date.now() });

    await fireFetch(handlers, {
        url: freshUrl,
        method: "GET",
        destination: "image",
        mode: "no-cors",
    });

    assert.equal(
        cache.entries.has(staleUrl),
        false,
        "超龄图标在命中路径上也应被回收"
    );
    assert.equal(cache.entries.has(freshUrl), true, "新鲜的图标不该被删");
});

test("sw：API 请求一律走网络，不进缓存", async () => {
    const { handlers, cache } = bootServiceWorker({});
    await fireFetch(handlers, {
        url: "https://app.example.com/api/bootstrap",
        method: "GET",
        destination: "empty",
        mode: "cors",
    });
    assert.equal(cache.putCalls, 0);
    assert.equal(cache.entries.size, 0);
});
