// 单测运行器：把 tests/ 下的用例用 esbuild 打成临时 bundle，再交给 node:test。
//
// 为什么不直接 `node --test tests/`：
// Node 22 能剥掉 TS 类型，但源码里的 import 是**无扩展名**的（`from "./search"`），
// 那是 Vite / TS 的写法，Node 的 ESM 解析器不认。用 esbuild 过一道既解决了扩展名，
// 又顺手把类型导入、路径解析都处理掉了（esbuild 本来就是这套工具链的依赖）。
//
// 两类用例：
//   tests/*.test.ts       纯函数，只补一个 localStorage 替身
//   tests/*.dom.test.tsx  需要 DOM 的组件测试，补一整套 jsdom 环境（依赖 jsdom，devDependency）
//
// 用法：npm test   （等价于 node script/unit-tests.mjs）
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(HERE, "tmp-tests");
const DOM_SUFFIX = ".dom.test.tsx";

const require = createRequire(`${ROOT}/package.json`);
const esbuild = require("esbuild");

// 纯函数用例的最小替身：放在 bundle 最前面执行，保证模块初始化时就能拿到。
// 目前只用到 localStorage（失效记录、星标标签都存在那儿）。
const BANNER_PURE = `
const __store = new Map();
globalThis.localStorage = {
    getItem: k => (__store.has(k) ? __store.get(k) : null),
    setItem: (k, v) => void __store.set(k, String(v)),
    removeItem: k => void __store.delete(k),
    clear: () => __store.clear(),
    key: i => [...__store.keys()][i] ?? null,
    get length() { return __store.size; },
};
`;

// 组件用例的环境替身。必须在 bundle 的**最前面**跑完，因为 react-dom 之类的库在
// 模块初始化时就会去读 window / document，晚一步就落到「无 DOM」分支上了。
//
// 几个必须手动补的坑：
//   - Node 22 的 globalThis.navigator 是 getter-only，直接赋值会抛，只能用 defineProperty
//   - jsdom 不实现 matchMedia / ResizeObserver，MUI 会用到，得给替身
//   - act() 需要 IS_REACT_ACT_ENVIRONMENT 才认账，否则会有 console 噪音
const BANNER_DOM = `
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
});
const win = dom.window;

const define = (key, value) => {
    try {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
        // 少数全局量是只读的，跳过即可
    }
};

define("window", win);
define("document", win.document);
define("navigator", win.navigator);
define("location", win.location);
define("history", win.history);
// jsdom 的 localStorage 挂在 window 上，globalThis 上没有 —— 而业务代码里写的
// 是裸的 localStorage.xxx（如 utils/undoPersist），漏了这行会静默读写失败
// （那些地方都包了 try/catch，表现为「存了但读不出来」，很难查）
if (typeof globalThis.localStorage === "undefined") define("localStorage", win.localStorage);
// sessionStorage 同理（jsdom 挂在 window 上，全局没有）。main.tsx 的「只重载一次」
// 令牌就存在这儿，缺了它那条逻辑在测试里静默失效。
if (typeof globalThis.sessionStorage === "undefined") define("sessionStorage", win.sessionStorage);
define("getComputedStyle", win.getComputedStyle.bind(win));
define("requestAnimationFrame", win.requestAnimationFrame.bind(win));
define("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));

for (const key of [
    "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "SVGElement",
    "Element", "Node", "NodeList", "Text", "Comment", "DocumentFragment",
    "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
    "FocusEvent", "InputEvent", "DOMRect", "DOMParser", "MutationObserver",
]) {
    if (win[key] !== undefined) define(key, win[key]);
}

// 再兜一遍 jsdom 上其余构造函数：只补 globalThis 里**还没有**的，
// 免得把 Node 自带的 URL / Blob / Event / performance 这些覆盖掉。
// （上面那份手写白名单漏了 ShadowRoot，react-dom 一加载就 ReferenceError，
//  这行泛化补齐省得以后一个个撞。）
for (const key of Object.getOwnPropertyNames(win)) {
    if (!/^[A-Z]/.test(key)) continue;
    if (key in globalThis) continue;
    if (win[key] === undefined) continue;
    define(key, win[key]);
}

// jsdom 没有 matchMedia：MUI 的响应式与 useMediaQuery 都会调它
if (!win.matchMedia) {
    win.matchMedia = query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
    });
}
define("matchMedia", win.matchMedia.bind(win));

// 这两个 jsdom 也没实现，给个永不触发的替身（用例里不会真的等它回调）
for (const key of ["ResizeObserver", "IntersectionObserver"]) {
    if (win[key] === undefined) {
        define(key, class {
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() { return []; }
        });
    }
}

// CodeMirror 测量文本 Range；jsdom 无布局，仅提供空测量结果，像素由真浏览器验收。
win.Range.prototype.getClientRects = function() { return []; };
win.Range.prototype.getBoundingClientRect = function() { return new win.DOMRect(); };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
`;

// 用法：npm test               跑全部
//      npm test -- public     只跑文件名含 public 的用例（可给多个关键词，任一命中即可）
const filters = process.argv.slice(2);
const match = f =>
    filters.length === 0 ||
    filters.some(k => f.toLowerCase().includes(k.toLowerCase()));

const testsDir = path.join(ROOT, "tests");
const all = fs.existsSync(testsDir) ? fs.readdirSync(testsDir) : [];
const pureEntries = all
    .filter(f => f.endsWith(".test.ts") && match(f))
    .map(f => path.join(testsDir, f));
const domEntries = all
    .filter(f => f.endsWith(DOM_SUFFIX) && match(f))
    .map(f => path.join(testsDir, f));

if (filters.length > 0 && pureEntries.length === 0 && domEntries.length === 0) {
    console.error(`tests/ 下没有匹配 ${filters.join(" / ")} 的用例`);
    process.exit(1);
}

if (pureEntries.length === 0 && domEntries.length === 0) {
    console.error("tests/ 下没有 .test.ts / .dom.test.tsx");
    process.exit(1);
}

/**
 * 独占锁：同一时间只允许一个运行器用 OUT_DIR。
 *
 * ⚠️ 为什么要锁：下面「进来先 rm -rf OUT_DIR、跑完再 rm -rf」这套是**共享目录**，
 * 两个运行器并发时后一个把前一个刚打好的 bundle 删掉，node:test 那边就报
 * MODULE_NOT_FOUND —— 表面是「152 条用例失败」，其实一条都没真跑，是**假红**。
 * 实测踩到过：把 `npm test` 与 `npm run check:budget`（同一个脚本的另一个入口）
 * 并行跑，就能稳定复现。用 O_EXCL 建文件拿锁：内核保证只有一个进程建得成。
 */
const LOCK_FILE = path.join(HERE, ".unit-tests.lock");
const takeLock = () => {
    try {
        fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: "wx" });
        return true;
    } catch {
        return false;
    }
};

if (!takeLock()) {
    let holder = "";
    let readable = false;
    try {
        holder = fs.readFileSync(LOCK_FILE, "utf8").trim();
        readable = true;
    } catch {
        /* 锁文件刚好被对方删了：算并发，照样退出 */
    }
    // ⚠️ 锁文件可能是**死的**：SIGINT/SIGTERM 有 handler 会放锁，SIGKILL 抓不到 ——
    // kill -9、OOM killer、IDE 的停止按钮、任务管理器的结束进程、CI 的
    // timeout-minutes 强杀，全都会把锁留在盘上。此时如果只照着锁文件报
    // 「已有运行器在跑」，说的与事实正好相反，下一次运行会被一句假话挡住，
    // 只能人工去删文件（项目历史上真实发生过）。
    // 所以拿不到锁时先做一次活性探测：那个 pid 还在不在？
    const pid = Number(holder);
    let alive = false;
    if (readable && Number.isInteger(pid) && pid > 0) {
        try {
            // 信号 0 不真发信号，只做存在性检查：成功 = 活着
            process.kill(pid, 0);
            alive = true;
        } catch (err) {
            // ESRCH = 进程已不存在（僵死锁）；EPERM = 存在但无权发信号（也算活着）
            alive = err.code === "EPERM";
        }
    }
    const giveUp = () => {
        console.error(
            `已有单测运行器在跑${holder ? `（pid ${holder}）` : ""}：` +
                `两份运行器共用 ${path.relative(ROOT, OUT_DIR)}，并发会互相删产物、` +
                `报出一堆并不存在的失败。等它跑完再试。\n` +
                `如果确认没有别的运行器（上次是被强杀的），删掉 ${path.relative(ROOT, LOCK_FILE)} 再来。`
        );
        process.exit(1);
    };

    // 读不到内容（刚被放锁）或持有者确实活着：走原来的报错
    if (!readable || alive) giveUp();

    console.warn(
        `发现僵死锁（pid ${holder || "未知"} 已不存在），已自动回收 ${path.relative(ROOT, LOCK_FILE)}`
    );
    try {
        fs.rmSync(LOCK_FILE, { force: true });
    } catch {
        /* 删不掉就交给下面的重抢失败分支报错 */
    }
    // 竞态：删掉的一瞬间另一个运行器可能正好抢到锁，那就真的回到「已有运行器在跑」
    if (!takeLock()) giveUp();
}
const releaseLock = () => {
    try {
        fs.rmSync(LOCK_FILE, { force: true });
    } catch {
        /* 退出路上清不掉就算了，下次靠上面那句提示人工处理 */
    }
};
// 被 Ctrl+C / 信号打断也要放锁，否则下一次运行会一直被一句「已有运行器在跑」挡住
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        releaseLock();
        process.exit(1);
    });
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });

// 覆盖率模式（由 script/coverage.mjs 打开）：多生成一份 sourcemap，并保留打包产物。
// 两个动作必须一起做 —— c8 是在**本进程退出之后**才去读 bundle 与 .map 做重映射的，
// 只开 sourcemap 却把产物删了，看到的还是打包产物的覆盖率。
//
// ⚠️ 必须是 **inline** 而不是 external（2026-10-28 实测）：本项目打包时带了
// `outExtension: { ".js": ".mjs" }`，配 `sourcemap: "external"` 时 esbuild **不会**
// 往 bundle 末尾写 `//# sourceMappingURL=xxx.mjs.map` 注释（实测产物里该字符串出现 0 次，
// 尽管同目录 .map 确实生成了）。c8 认 sourcemap 全靠那条注释，找不到就不做重映射 ——
// 于是 V8 覆盖率整份记在 `script/tmp-tests/**` 的 bundle 上，再被 coverage.mjs 的
// `--exclude script/**` 排除干净，最后只剩 `--all` 列出的 src 空壳：386 个文件、98620 行、
// **covered 全 0**。inline 把 map 嵌进注释里，注释必然存在，c8 才重映射得回去。
const coverageMode = !!process.env.NAVIHIVE_COVERAGE;

const shared = {
    bundle: true,
    jsx: "automatic",
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "error",
    // ⚠️ 字体 / 样式必须给 loader：单测的某些依赖会带 CSS（比如公式用的
    // katex.min.css，里面 url() 指向十几张 woff2/ttf）。esbuild 默认不认这些后缀，
    // 一碰就 "No loader is configured for .woff2 files" 把整批用例都拖死 ——
    // 而测试环境根本不去取字体（CSS 用 empty loader 丢掉即可）。
    loader: { ".css": "empty", ".woff": "file", ".woff2": "file", ".ttf": "file" },
    external: ["react-dom/server"],
    // import.meta.env 平时由 Vite 在构建时注入；单测是 esbuild 直接打包，
    // 不定义就是 undefined，一读 .DEV 就炸（App.tsx 的 api 单例在模块加载时读它）。
    // 语义对齐「被测的就是构建产物」：DEV=false → api 走 "/api" 真实客户端，
    // 用例里用 fetch 桩接住；VITE_USE_REAL_API 空串 → 不切 mock。
    define: {
        "import.meta.env.DEV": "false",
        "import.meta.env.PROD": "true",
        "import.meta.env.SSR": "false",
        "import.meta.env.MODE": '"test"',
        "import.meta.env.VITE_USE_REAL_API": '""',
        // ⚠️ 这两个平时由 vite.config.ts 的 define 烘进产物，单测是 esbuild 直接打包，
        // 不定义就是 undefined —— 于是 localBuildVersion() 恒为空串，
        // 「本机版本 vs 服务端版本」这类判断被整条跳过（main.tsx 的版本漂移自愈
        // 就是这么一直没被单测覆盖的）。给一个固定值，让那套逻辑在测试里真的跑起来。
        "__NAVIHIVE_BUILD_VERSION__": '"test-build-0001"',
        "__NAVIHIVE_APP_VERSION__": '"v9.9.9+test"',
    },
    ...(coverageMode ? { sourcemap: "inline" } : {}),
};

const builds = [];

if (pureEntries.length > 0) {
    builds.push(
        esbuild.build({
            ...shared,
            entryPoints: pureEntries,
            outdir: path.join(OUT_DIR, "pure"),
            outExtension: { ".js": ".mjs" },
            banner: { js: BANNER_PURE },
        })
    );
}

if (domEntries.length > 0) {
    builds.push(
        esbuild.build({
            ...shared,
            entryPoints: domEntries,
            outdir: path.join(OUT_DIR, "dom"),
            outExtension: { ".js": ".mjs" },
            banner: { js: BANNER_DOM },
            jsx: "automatic",
            // jsdom 是 Node 侧的原生库，不能打进 bundle
            external: ["jsdom"],
        })
    );
}

await Promise.all(builds);

const scope =
    filters.length > 0 ? `（只跑匹配 ${filters.join(" / ")} 的）` : "";
console.log(
    `已打包 ${pureEntries.length} 个纯函数用例、${domEntries.length} 个组件用例${scope}，交给 node:test\n`
);

// 显式列出产物再交给 --test：直接把目录丢给 --test 时，
// Node 会把它当成模块路径去 require，报 MODULE_NOT_FOUND
const bundles = [];
for (const group of ["pure", "dom"]) {
    const dir = path.join(OUT_DIR, group);
    if (!fs.existsSync(dir)) continue;
    bundles.push(
        ...fs
            .readdirSync(dir)
            .filter(f => f.endsWith(".mjs"))
            .map(f => path.join(dir, f))
    );
}

// --test-force-exit 是必需的：jsdom 用了 pretendToBeVisual，会一直跑 rAF 循环，
// 测例跑完事件循环也空不下来（碰到 FileReader 这类异步更明显），不加就永远不退。
const child = spawn(
    process.execPath,
    [
        "--test",
        "--test-force-exit",
        // ⚠️ 默认 --test-timeout 是 Infinity：一条永不 resolve 的用例会让整个 CI job
        // 一直挂到 timeout-minutes 兜底，日志里只剩「job cancelled」，查不出是哪条。
        //
        // ⚠️ 但它**不是**「单条用例的上限」，而是把**文件级那条**也一起管住（node 把每个
        // 文件包成一个顶层 subtest，时长算的是整个文件）。所以这个值必须大于「最慢的那个
        // 文件跑完的时长」，否则健康的文件会被当成挂死杀掉 —— 2026-10-28 用 60000 就踩了：
        // notes.dom.test.tsx（6802 行 / 226 例）单跑 120s、全过，被砍在 60003ms，
        // 整个文件的 115 条用例连带报 cancelled，看起来像 7 条失败 + 一堆用例消失。
        //
        // 10 分钟的依据：CI job 的 timeout-minutes 是 15，留 5 分钟足够把这条失败报出来
        // （带文件名与 duration_ms），而不是等到 job 被砍只剩 cancelled。实测最慢文件
        // 120s，这里有 5 倍余量 —— 想在 CI 上误伤它基本不可能。
        // ⚠️ 别再往下调。要收紧就先拆 notes.dom.test.tsx；把数字调小只是把假红换个位置。
        "--test-timeout=600000",
        // ⚠️ 不设时 node 按核数起进程：16 核开发机上会同时跑 15 个 jsdom 进程，
        // 每个都加载一份 React/MUI，本地和 CI 的调度压力完全不可比。钉成 4 让两边一致。
        "--test-concurrency=4",
        ...bundles,
    ],
    { stdio: "inherit", cwd: ROOT }
);
child.on("exit", code => {
    if (!coverageMode) fs.rmSync(OUT_DIR, { recursive: true, force: true });
    releaseLock();
    process.exit(code ?? 1);
});
child.on("error", () => {
    releaseLock();
    process.exit(1);
});
