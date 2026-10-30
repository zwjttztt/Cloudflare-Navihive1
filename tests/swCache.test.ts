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

/**
 * Cache Storage 的键：sw.js 既传 Request 也传**裸字符串**（`cache.put("/")`），
 * 真 Cache API 会把字符串按 SW 作用域解析成 URL；替身里统一按字符串键存，
 * 否则 `put("/")` 存进去的是 `"/".url`（undefined），离线回落永远取不回来。
 */
const keyOf = (req: unknown): string => (typeof req === "string" ? req : String((req as { url: string }).url));

class FakeCache {
    entries = new Map<string, Entry>();
    putCalls = 0;

    async put(req: unknown, res: Response) {
        this.entries.set(keyOf(req), { res, cachedAt: Date.now() });
        this.putCalls++;
    }
    async match(req: unknown) {
        const hit = this.entries.get(keyOf(req));
        return hit ? hit.res : undefined;
    }
    async delete(req: unknown) {
        return this.entries.delete(keyOf(req));
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
function bootServiceWorker(
    targets: Record<string, Response>,
    options: { failUrls?: string[]; namedCaches?: boolean } = {}
) {
    const failUrls = options.failUrls ?? [];
    /**
     * 每次 fetch 收到的请求（可能是 Request，也可能是字符串），用来核对 cache 模式。
     * ⚠️ `mode` 也要记：外壳那条路必须从 **URL** 重建请求，不能从 navigate 请求继承 ——
     * 继承下来的 mode 是 "navigate"，而 navigate + 非空 init 在 Chrome 上直接抛 TypeError。
     * 光看 cache 模式看不出这件事，所以断言里两个都要查。
     */
    const seen: Array<{ url: string; cache?: string; mode?: string }> = [];
    const handlers = new Map<string, (e: unknown) => void>();
    const cache = new FakeCache();
    /** `namedCaches` 模式下按名字分缓存：用来验证「离线回落不跨缓存捞旧版外壳」 */
    const stores = new Map<string, FakeCache>();
    const openStore = (name: string): FakeCache => {
        const key = String(name ?? "");
        let hit = stores.get(key);
        if (!hit) {
            hit = new FakeCache();
            stores.set(key, hit);
        }
        return hit;
    };
    const caches = {
        async open(name?: string) {
            return options.namedCaches ? openStore(String(name ?? "")) : cache;
        },
        async keys() {
            return [];
        },
        async match(req: unknown) {
            return cache.match(req);
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
        fetch: async (input: string | { url: string; cache?: string }) => {
            const req = typeof input === "string" ? { url: input } : input;
            seen.push({
                url: req.url,
                cache: (req as { cache?: string }).cache,
                mode: (req as { mode?: string }).mode,
            });
            if (failUrls.some(u => String(req.url).includes(u))) {
                // 离线 / 源站挂了：fetch reject，sw.js 必须走缓存兜底
                throw new TypeError("Failed to fetch");
            }
            const url = req.url;
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
            cache: string;
            /**
             * ⚠️ 必须支持 `new Request(已有的 req, init)` 这种形态：
             * sw.js 的外壳分支就是这么把 `cache: "no-cache"` 加进去的。
             * 老替身只认 `(url, init)`，传个 Request 进来会把 url 变成对象。
             */
            constructor(input: string | Record<string, unknown>, init: Record<string, unknown> = {}) {
                const src = typeof input === "string" ? { url: input } : (input ?? {});
                this.url = String(init.url ?? src.url ?? "");
                this.method = String(init.method ?? src.method ?? "GET");
                this.destination = String(init.destination ?? src.destination ?? "");
                this.mode = String(init.mode ?? src.mode ?? "no-cors");
                this.cache = String(init.cache ?? src.cache ?? "default");
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

    return { handlers, cache, seen, openStore };
}

/**
 * 触发一次 fetch 事件，把 waitUntil 里的尾巴也跑完。
 *
 * 返回值可能是 undefined：sw.js 对「不归它管」的请求（非 GET、不匹配的 destination）
 * 根本不调 respondWith。调用方要先用 `assert.ok(res)` 收窄再取 `.text()`。
 */
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
    // ⚠️ 必须断言类型：responded 是在回调里被赋值的，TS 的控制流分析看不到那次赋值，
    // 会把这里当成恒为 null；不断言的话返回类型被推成 undefined，
    // 调用方 assert.ok 之后再取 .text() 就落到 never 上。
    const res = (await responded) as Response | null;
    // waitUntil 是在好几层 .then() 里才被调用的（putWithTimestamp → trim 各有一次），
    // 一次 await 收不全；多转几圈事件循环把尾巴排干净。
    for (let i = 0; i < 6; i++) {
        await Promise.all(tails);
        await new Promise(r => setTimeout(r, 0));
    }
    // ⚠️ 返回值可以是 undefined：sw.js 对不归它管的请求（/api/*、非 GET）根本不调
    // respondWith。调用方要断言响应用 `assert.ok(res)`，别直接 `.text()`。
    return res ?? undefined;
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

// ---------------- 外壳（HTML）：网络优先，且必须绕开 HTTP 缓存 ----------------
//
// 这一组盯的是线上「界面一直不动」那条成因链：缓存里的旧 index.html 引用了已被新版
// 删掉的 chunk → chunk 404 → 主模块不执行 → React 从不挂载 → 骨架永久停留。
// 光在 sw.js 里写 `fetch(req)` 是不够的：那取的是**浏览器 HTTP 缓存**里的那份
// （`/` 与 `/index.html` 带 max-age=60 + stale-while-revalidate=60，CF 边缘还有 2 分钟），
// 发版后那几分钟里拿回的仍是旧外壳。所以下面第一条钉的是「缓存里有旧外壳时也不吃它」。

const APP = "https://app.example.com";
/** 一张「真的是页面」的响应：content-type 必须带 text/html，否则 sw.js 不把它当外壳存 */
const htmlResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });

const navRequest = (url = `${APP}/`) => ({
    url,
    method: "GET",
    destination: "document",
    mode: "navigate",
});

test("sw：导航请求走网络优先 —— 缓存里有旧外壳时也不吃它（否则发版后就是死骨架）", async () => {
    const { handlers, cache } = bootServiceWorker({ [`${APP}/`]: htmlResponse("<html>NEW</html>") });
    // 上一版留下的外壳：引用的是已经被删掉的 chunk
    cache.entries.set("/", { res: htmlResponse("<html>OLD</html>"), cachedAt: Date.now() });

    const res = await fireFetch(handlers, navRequest());
    assert.ok(res, "导航请求必须被 sw.js 接住并回一个响应");

    assert.equal(
        await res.text(),
        "<html>NEW</html>",
        "网络可用时必须拿网络上的外壳，不能拿缓存里那份旧的"
    );
});

test("sw：外壳请求必须绕开 HTTP 缓存的读取（cache: reload）", async () => {
    const { handlers, seen } = bootServiceWorker({ [`${APP}/`]: htmlResponse("<html>NEW</html>") });
    await fireFetch(handlers, navRequest());

    const nav = seen.find(r => r.url === `${APP}/`);
    assert.ok(nav, "外壳请求必须真的发出去");
    assert.equal(
        nav!.cache,
        "reload",
        "外壳必须回源：缺省会命中 max-age=60 + stale-while-revalidate=60 + CF 边缘 2 分钟，发版后就是旧外壳 → 死骨架"
    );
});

test("sw：外壳请求按 URL 重建，mode 不能是 navigate（否则 Chrome 直接抛 TypeError）", async () => {
    // 这一条盯的是「单测全绿、线上照挂」那一类错：
    // `new Request(req, {cache: ...})` / `fetch(req, {cache: ...})` 在 req.mode 是
    // "navigate" 时，Chrome 会抛
    //   "Cannot construct a Request with a Request whose mode is 'navigate' and a non-empty RequestInit"
    // 而**页面导航恰恰就是 navigate** —— 于是 respondWith 根本没被调用，外壳既不回源
    // 也不入缓存，离线能力一起丢，控制台每导航抛一次而页面看着是好的。
    // 沙箱里的 Request 是假的（不抛），所以只能靠「合成请求的 mode 不该是 navigate」来钉。
    const { handlers, seen } = bootServiceWorker({ [`${APP}/`]: htmlResponse("<html>NEW</html>") });
    await fireFetch(handlers, navRequest());

    const nav = seen.find(r => r.url === `${APP}/`);
    assert.ok(nav, "外壳请求必须真的发出去");
    assert.notEqual(
        nav!.mode,
        "navigate",
        "外壳请求不能从 navigate 请求上继承 mode —— 继承了就带不上 cache 模式（Chrome 直接抛）"
    );
});

test("sw：网络失败时回落到缓存里的外壳（离线仍然打得开）", async () => {
    const { handlers, cache } = bootServiceWorker({}, { failUrls: ["app.example.com"] });
    cache.entries.set("/", { res: htmlResponse("<html>CACHED</html>"), cachedAt: Date.now() });

    const res = await fireFetch(handlers, navRequest(`${APP}/notes`));
    assert.ok(res, "离线时也要回一个响应（缓存里的外壳），不能是 undefined");

    assert.equal(
        await res.text(),
        "<html>CACHED</html>",
        "离线时必须用缓存里的外壳把页面撑起来（离线能力不能因为改网络优先而丢）"
    );
});

test("sw：网络成功时顺手把新外壳写进缓存，供下一次离线用", async () => {
    const { handlers, cache } = bootServiceWorker({ [`${APP}/`]: htmlResponse("<html>NEW</html>") });
    await fireFetch(handlers, navRequest());

    const cached = cache.entries.get("/");
    assert.ok(cached, "拿到新外壳要写进缓存，否则下次离线就没得回落");
    assert.equal(await cached!.res.text(), "<html>NEW</html>");
});

test("sw：destination 是 document 但 mode 不是 navigate 时，同样走网络优先", async () => {
    // 只认 `mode === "navigate"` 会漏掉这一类（预取 / iframe / 某些浏览器直接请求
    // /index.html）：漏掉的后果不是「多一次网络」，而是掉进下面静态资源那条
    // **缓存优先**的分支 —— HTML 走缓存优先正是这次要修的东西。
    const { handlers, cache } = bootServiceWorker({
        [`${APP}/index.html`]: htmlResponse("<html>NEW</html>"),
    });
    cache.entries.set("/index.html", {
        res: htmlResponse("<html>OLD</html>"),
        cachedAt: Date.now(),
    });

    const res = await fireFetch(handlers, {
        url: `${APP}/index.html`,
        method: "GET",
        destination: "document",
        mode: "no-cors",
    });
    assert.ok(res, "文档请求必须被外壳那一支接管（没接管 = SW 根本没拦，离线兜底也就不存在）");

    assert.equal(
        await res.text(),
        "<html>NEW</html>",
        "文档请求不能漏判成静态资源（漏了就走缓存优先，喂的还是旧外壳）"
    );
});

test("sw：离线回落只认本版本缓存里的外壳，不从别的缓存捞上一版的 HTML", async () => {
    const { handlers, openStore } = bootServiceWorker(
        {},
        { failUrls: ["app.example.com"], namedCaches: true }
    );
    // 上一版留下的缓存：那份外壳引用的是已经被删掉的 chunk
    openStore("navihive-shell-v4").entries.set("/", {
        res: htmlResponse("<html>OLD</html>"),
        cachedAt: Date.now(),
    });
    // 本版本那份（manifest 里的 version 是 "test"）
    openStore("navihive-test").entries.set("/", {
        res: htmlResponse("<html>THIS-VERSION</html>"),
        cachedAt: Date.now(),
    });

    const res = await fireFetch(handlers, navRequest());
    assert.ok(res, "离线时外壳那一支必须给出响应（给不出来说明兜底路径没接上）");

    assert.equal(
        await res.text(),
        "<html>THIS-VERSION</html>",
        "离线时只能回落到本版本那份外壳（跨缓存捞到上一版 = 引用已删 chunk = 死骨架）"
    );
});

test("sw：本版本缓存里没有外壳时，宁可报错也不拿上一版的 HTML 顶上", async () => {
    const { handlers, openStore } = bootServiceWorker(
        {},
        { failUrls: ["app.example.com"], namedCaches: true }
    );
    openStore("navihive-shell-v4").entries.set("/", {
        res: htmlResponse("<html>OLD</html>"),
        cachedAt: Date.now(),
    });

    const res = await fireFetch(handlers, navRequest());
    assert.ok(res, "外壳那一支必须给出响应");

    assert.equal(res.type, "error", "没有本版本的外壳时不该拿旧版顶上 —— 旧外壳是死骨架，不是兜底");
});

test("sw：非 HTML 的静态资源仍然是缓存优先（外壳收紧没有误伤加速路径）", async () => {
    const { handlers, cache } = bootServiceWorker({});
    const scriptUrl = `${APP}/assets/index-abc.js`;
    cache.entries.set(scriptUrl, { res: new Response("cached-js"), cachedAt: Date.now() });

    const res = await fireFetch(handlers, {
        url: scriptUrl,
        method: "GET",
        destination: "script",
        mode: "no-cors",
    });
    assert.ok(res, "静态资源请求必须被 sw.js 接住");

    assert.equal(await res.text(), "cached-js", "带指纹的 chunk 必须继续走缓存优先");
});
