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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
`;

const testsDir = path.join(ROOT, "tests");
const all = fs.existsSync(testsDir) ? fs.readdirSync(testsDir) : [];
const pureEntries = all
    .filter(f => f.endsWith(".test.ts"))
    .map(f => path.join(testsDir, f));
const domEntries = all
    .filter(f => f.endsWith(DOM_SUFFIX))
    .map(f => path.join(testsDir, f));

if (pureEntries.length === 0 && domEntries.length === 0) {
    console.error("tests/ 下没有 .test.ts / .dom.test.tsx");
    process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });

const shared = {
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "error",
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

console.log(
    `已打包 ${pureEntries.length} 个纯函数用例、${domEntries.length} 个组件用例，交给 node:test\n`
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
const child = spawn(process.execPath, ["--test", "--test-force-exit", ...bundles], {
    stdio: "inherit",
});
child.on("exit", code => {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    process.exit(code ?? 1);
});
