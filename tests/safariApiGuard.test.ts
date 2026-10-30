// tests/safariApiGuard.test.ts
// 浏览器兼容性静态守卫（T-4 降级版）：拦住「超出最低支持基线」的 API。
//
// 为什么是静态守卫而不是真机 WebKit：
//   本仓库的浏览器工具链全是**自研 CDP + 本机 Chrome**（ci-smoke / a11y / contrast / perf），
//   没有 playwright；加一个 WebKit job 要新增重依赖 + 独立 CI job（现有单 job 已 15 分钟
//   上限、串了 20 多步），而 Playwright 的 WebKit 也不等于真机 Safari。
//   真正会咬人的风险是「写代码时随手用了新 API」（toSorted / Object.groupBy / popover…），
//   这类回归用静态扫描能以近零成本覆盖大部分。
//
// 基线来源：package.json 的 browserslist（chrome>=111 / edge>=111 / firefox>=111 / safari>=16.4），
// 文档侧写在 docs/architecture.md §5（同一个数，别处再抄一遍就会漂移）。
//
// 判据：**出现即可疑，必须伴随特性探测**。因为「有探测」意味着老浏览器会走降级分支；
// 「没探测」意味着它在老浏览器里直接 TypeError，而 CI（只有 Chromium）永远发现不了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
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

/** 剥掉块注释与整行行注释（注释里写着「别用 toSorted」时不能算违规） */
function stripComments(src: string): string {
    return src
        // 块注释保留它的换行数，否则多行注释会把后面的行号整体前移
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ""))
        // ⚠️ 注释行替换成空行而**不是**过滤掉：过滤会让后面所有行号前移，
        // 守卫报出来的「第几行」就对不上真实文件了 —— 排障时那是第一个要看的信息。
        .split("\n")
        .map(line => (line.trim().startsWith("//") ? "" : line))
        .join("\n");
}

interface RiskApi {
    name: string;
    pattern: RegExp;
    /** 为什么它在基线内/外 —— 写清版本，专项期随基线一起改 */
    why: string;
}

/**
 * 风险 API 清单：**超出 browserslist 基线**的那些。
 *
 * 刻意不收的（已在基线内，收进来只会制造噪声）：`Array.prototype.at`（Chrome 92 / Safari 15.4）、
 * `Object.hasOwn`（93 / 15.4）、`structuredClone`（98 / 15.4）、`Array.prototype.findLast`、
 * `color-mix()`（Chrome 111 / Safari 16.2）、`:has()`（Chrome 105 / Safari 15.4）、
 * `crypto.randomUUID`（92 / 15.4，需安全上下文，本站本来就要求 HTTPS）。
 */
const RISK_APIS: RiskApi[] = [
    {
        name: "Array.prototype.toSorted / toReversed / toSpliced / with",
        // `with(` 单独匹配会撞上太多东西（with 语句、自定义方法），所以带上对象/数组前缀
        pattern: /\b(?:toSorted|toReversed|toSpliced)\s*\(|\.\s*with\s*\(/,
        why: "ES2023 数组复制方法：Chrome 110 / Firefox 115 / Safari 16.4 —— 基线 firefox>=111 不含",
    },
    {
        name: "Object.groupBy / Map.groupBy",
        pattern: /\b(?:Object|Map)\s*\.\s*groupBy\b/,
        why: "Chrome 117 / Firefox 119 / Safari 17.4 —— 基线全段不含",
    },
    {
        name: "Array.fromAsync",
        pattern: /\bArray\s*\.\s*fromAsync\b/,
        why: "Chrome 121 / Firefox 121 / Safari 16.4 —— 基线 chrome>=111 不含",
    },
    {
        name: "URL.canParse",
        pattern: /\bURL\s*\.\s*canParse\b/,
        why: "Chrome 120 / Safari 17 / Firefox 112 —— 基线不含",
    },
    {
        name: "Promise.withResolvers",
        pattern: /\bPromise\s*\.\s*withResolvers\b/,
        why: "Chrome 119 / Safari 17.4 —— 基线不含",
    },
    {
        name: "HTMLInputElement.showPicker",
        pattern: /\.\s*showPicker\s*\(/,
        why: "Chrome 99 / Firefox 101 / Safari 16 —— Safari 16.4 有，但调用即要求用户手势，且基线里 Firefox 110 才支持",
    },
    {
        name: "Popover API（popover 属性 / showPopover）",
        pattern: /\bshowPopover\s*\(|\bhidePopover\s*\(|\btogglePopover\s*\(|\bpopover\s*=\s*["']/,
        why: "Chrome 114 / Safari 17 —— 基线不含",
    },
    {
        name: "AbortSignal.any",
        // 只认 `.any`：`AbortSignal.timeout` 是 Chrome 103 / Firefox 100 / Safari 16，
        // 已经在基线内（仓库里有 3 处在用），把它算风险只会制造噪声。
        pattern: /\bAbortSignal\s*\.\s*any\b/,
        why: "Chrome 116 / Safari 17.4 —— 基线不含；要合并多个 signal 就先探测再退回手写 AbortController",
    },
    {
        name: "requestIdleCallback",
        pattern: /\brequestIdleCallback\s*\(/,
        why: "Safari 至今不支持 —— 必须特性探测 + setTimeout 降级（见 utils/lazyPrefetch.ts）",
    },
    {
        name: "navigator.storage.getDirectory（OPFS）",
        pattern: /\bstorage\s*\.\s*getDirectory\s*\(/,
        why: "Safari 15.2 才有、且要求安全上下文；本项目持久化走 localStorage / IndexedDB",
    },
];

/** 特性探测的写法：命中这几个就算「老浏览器有降级路径」 */
const DETECTION = [
    /typeof\s+[^;\n]{0,80}?(===|!==)\s*["'](?:function|undefined)["']/, // typeof x.foo === "function"
    /\bin\s+(?:globalThis|window|navigator|n)\b/, // "foo" in window
    /\?\.\s*[A-Za-z_$]*\s*\(/, // 可选调用：x.foo?.()
    /@supports/,
    /featureDetect|hasSupport|supports[A-Z]/,
];

/** 允许「裸用」的人工豁免：必须写明理由（专项期随基线更新一起复核） */
const ALLOWED_FILES = new Map<string, string>([
    // 目前为空。加条目之前先问：真的没有降级路径，还是我懒得写探测？
]);

/** 行内豁免标记：`// safari-baseline-ok: 理由` */
const INLINE_ALLOW = /safari-baseline-ok\s*:\s*\S/;

/** 需要扫描的源码目录（测试与第三方不在其中） */
const SCAN_DIRS = ["src", "worker", "server", "shared"];

function sourceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
        }
    };
    for (const d of SCAN_DIRS) {
        const abs = resolve(root, d);
        try {
            if (statSync(abs).isDirectory()) walk(abs);
        } catch {
            // 目录不存在就算了（扫描面按仓库现状列，不因缺目录而失败）
        }
    }
    return out;
}

/** 扫描结果是违规清单（`文件:行: API —— 上下文片段`）；纯函数，方便反向自测 */
function scan(source: string, relPath: string): string[] {
    const lines = stripComments(source).split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        for (const api of RISK_APIS) {
            if (!api.pattern.test(line)) continue;
            // 探测可能写在上下几行里（声明 + 使用分开是常见写法，见 lazyPrefetch）
            const context = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
            if (DETECTION.some(d => d.test(context))) continue;
            if (INLINE_ALLOW.test(line) || INLINE_ALLOW.test(lines[i - 1] ?? "")) continue;
            if (ALLOWED_FILES.has(relPath)) continue;
            hits.push(`${relPath}:${i + 1}: ${api.name} —— ${api.why}`);
        }
    }
    return hits;
}

test("源码里没有「超出浏览器基线且未做特性探测」的 API", () => {
    const root = projectDir();
    const files = sourceFiles(root);
    assert.ok(files.length > 100, `只扫到 ${files.length} 个源文件 —— 扫描面配置错了，这个守卫会变成摆设`);

    const violations: string[] = [];
    for (const abs of files) {
        const rel = abs.slice(root.length + 1).split("\\").join("/");
        violations.push(...scan(readFileSync(abs, "utf8"), rel));
    }

    assert.deepEqual(
        violations,
        [],
        "下面这些调用在老浏览器里会直接抛错，而 CI 只有 Chromium 永远发现不了：\n" +
            "修法：① 换成基线内写法；② 加 typeof 特性探测 + 降级路径；③ 确有理由就写 `// safari-baseline-ok: 理由`。\n" +
            violations.join("\n")
    );
});

test("守卫真的会红：未判探测的 toSorted / groupBy / popover 会被抓出来", () => {
    const bad = [
        "const sorted = [3, 1, 2].toSorted();",
        "const grouped = Object.groupBy([1, 2], n => String(n));",
        "el.showPopover();",
        "const ok = URL.canParse('https://x.test');",
        "requestIdleCallback(() => {});",
    ].join("\n");
    const hits = scan(bad, "src/__probe.ts");
    assert.equal(hits.length, 5, `应当抓到 5 处，实际 ${hits.length}：\n${hits.join("\n")}`);
    assert.ok(hits.some(h => h.includes("toSorted")), "必须报出 toSorted");
    assert.ok(hits.some(h => h.includes("groupBy")), "必须报出 groupBy");
});

test("守卫不会误报：有特性探测 / 注释掉的示例 / 行内豁免都不算违规", () => {
    const ok = [
        "// 以前这里是 [1].toSorted()，不要用",
        "/* Object.groupBy 也不能用 */",
        "const hasIdle = typeof window.requestIdleCallback === \"function\";",
        "if (typeof window.requestIdleCallback === \"function\") {",
        "    window.requestIdleCallback(() => {});",
        "}",
        "const sorted = list.slice().sort((a, b) => a - b);",
        "arr.toSorted(); // safari-baseline-ok: 内网项目，浏览器固定",
    ].join("\n");
    assert.deepEqual(scan(ok, "src/__probe.ts"), [], "这些写法都不该被判违规");
});

test("文档里写明了最低支持基线，且与 package.json 的 browserslist 一致", () => {
    const root = projectDir();
    const arch = readFileSync(resolve(root, "docs/architecture.md"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { browserslist?: string[] };
    const bl = pkg.browserslist ?? [];
    assert.ok(bl.length >= 4, "package.json 的 browserslist 至少要声明四档（chrome / edge / firefox / safari）");
    for (const entry of ["chrome >= 111", "edge >= 111", "firefox >= 111", "safari >= 16.4"]) {
        assert.ok(bl.includes(entry), `browserslist 少了 ${entry}`);
        assert.ok(arch.includes(entry), `docs/architecture.md 的兼容性小节必须写出 ${entry}（与 browserslist 同一份真话）`);
    }
    // 基线声明旁边必须说清「没做真机 Safari 验证」—— 否则读文档的人会以为测过
    assert.ok(/WebKit|Safari/.test(arch), "文档要提到 Safari / WebKit 的验证方式");
});
