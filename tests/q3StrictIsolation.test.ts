// tests/q3StrictIsolation.test.ts
// Q-3（`noUncheckedIndexedAccess` 分批开启）的静态守卫。
//
// 它守的不是「有没有这个文件」，而是三件会**静默失效**的事：
//   1. tsconfig.shared.json 里的 flag 被顺手删掉 —— 于是 shared/ 其实没在严格层，
//      而 CI 依然全绿（tsc 只会在有报错时才红，而这个 flag 被删正是为了不红）。
//   2. shared/ 里出现相对 import —— 一旦有，shared 的检查闭包就不再是「按构造即干净」
//      的 6 个文件，会连带把 src 的文件拉进严格层，报错数突然涨一片。
//   3. 豁免清单变成「无限期免责」—— 没有 owner / due 的清单半年后就没人认了。
//
// 为什么用 JSONC 解析而不是 JSON.parse：这几个 tsconfig 里写了**解释为什么**的注释，
// 而注释恰恰是这个仓库最该保留的东西（见 tsconfig.app.json 的 lib 那段）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

/** 剥掉注释后再 JSON.parse。逐字符走，避免把字符串里的 `//` 当成注释起点 */
function parseJsonc(text: string): Record<string, unknown> {
    let out = "";
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (c === "\n") {
                inLine = false;
                out += c;
            }
            continue;
        }
        if (inBlock) {
            if (c === "*" && next === "/") {
                inBlock = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            out += c;
            if (c === "\\") {
                out += next ?? "";
                i += 1;
            } else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            continue;
        }
        if (c === "/" && next === "/") {
            inLine = true;
            i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            inBlock = true;
            i += 1;
            continue;
        }
        out += c;
    }
    return JSON.parse(out) as Record<string, unknown>;
}

const readJsonc = (relPath: string) => parseJsonc(readFileSync(resolve(projectDir(), relPath), "utf8"));

test("tsconfig.shared.json 真的开着 noUncheckedIndexedAccess（删掉 flag 就等于没开）", () => {
    const cfg = readJsonc("tsconfig.shared.json");
    const opts = cfg.compilerOptions as Record<string, unknown> | undefined;
    assert.equal(opts?.noUncheckedIndexedAccess, true, "shared 先行层必须开着这个 flag");
    assert.deepEqual(opts?.exclude, undefined, "不许用 exclude 做隔离：被 import 的豁免文件照样进程序");
});

test("tsconfig.shared.json 的 include 覆盖 shared 下全部 .ts（漏一个就等于没检查它）", () => {
    const cfg = readJsonc("tsconfig.shared.json");
    const include = cfg.include as string[] | undefined;
    assert.deepEqual(include, ["shared"], "严格层的根文件必须是整个 shared/");

    const root = projectDir();
    const files = readdirSync(resolve(root, "shared")).filter(f => f.endsWith(".ts"));
    assert.ok(files.length >= 6, `shared/ 只有 ${files.length} 个 .ts，比预期少 —— 目录结构变了？`);
    const roots = (include ?? []).map(entry => resolve(root, entry));
    for (const f of files) {
        const target = resolve(root, "shared", f);
        // include 是按目录收的，这里逐个文件核一遍：以后若改成白名单写法，漏人会被这条拦住
        assert.ok(
            roots.some(r => {
                const rel = relative(r, target);
                return !rel.startsWith("..") && !isAbsolute(rel);
            }),
            `shared/${f} 不在 include 覆盖范围内`
        );
    }
});

test("shared/ 内部没有相对 import（否则严格层的闭包会漏到 src，隔离就失效了）", () => {
    const root = projectDir();
    const files = readdirSync(resolve(root, "shared")).filter(f => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) {
        const src = readFileSync(resolve(root, "shared", f), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("\n")
            .filter(line => !line.trim().startsWith("//"))
            .join("\n");
        // 只看真正会拉进闭包的写法：`from "./x"` / `import("./x")` / `export * from "../x"`
        if (/from\s+["']\.{1,2}\//.test(src) || /import\(\s*["']\.{1,2}\//.test(src)) {
            offenders.push(`shared/${f}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        "shared/ 必须零相对 import：它是「按构造即干净」的前提，否则严格层会被 src 的报错淹没"
    );
});

test("根 tsconfig 把 shared 严格层接进了项目引用（不然 CI 的 tsc -b 根本不跑它）", () => {
    const root = readJsonc("tsconfig.json");
    const refs = (root.references ?? []) as Array<{ path: string }>;
    assert.ok(
        refs.some(r => r.path.replace(/^\.\//, "") === "tsconfig.shared.json"),
        "tsconfig.json 的 references 里必须有 tsconfig.shared.json"
    );
});

test("严格层的 src 配置不许靠 exclude「排掉」豁免文件", () => {
    const cfg = readJsonc("tsconfig.strict-idx.json");
    const opts = cfg.compilerOptions as Record<string, unknown> | undefined;
    assert.equal(opts?.noUncheckedIndexedAccess, true, "严格层要开 flag");
    // 这是本轮方案被更正的那一点：exclude 只影响根文件选择，被 import 的豁免文件
    // 仍在程序里、照样报错。所以真正的保证是「跑全量 src，再比对报错文件集合」。
    assert.equal(cfg.exclude, undefined, "不许 exclude 豁免文件 —— 那只是把守卫变成摆设");
    assert.equal(opts?.exclude, undefined, "compilerOptions 里也不许有 exclude");
});

test("豁免清单每条都有 owner / reason / due（没有期限的豁免等于永久免责）", () => {
    const list = readJsonc("script/strict-idx-exempt.json");
    const entries = list.entries as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(entries) && entries.length > 0, "豁免清单不能为空或不是数组");
    for (const e of entries) {
        assert.equal(typeof e.path, "string", `条目缺少 path：${JSON.stringify(e)}`);
        assert.ok(String(e.reason ?? "").trim().length > 0, `${String(e.path)} 缺少 reason`);
        assert.ok(String(e.owner ?? "").trim().length > 0, `${String(e.path)} 缺少 owner`);
        assert.match(String(e.due ?? ""), /^\d{4}-\d{2}-\d{2}$/, `${String(e.path)} 的 due 必须是 YYYY-MM-DD`);
    }
});

test("基线文件存在且条目数不超过基线（清单只许变短）", () => {
    const list = readJsonc("script/strict-idx-exempt.json");
    const baseline = readJsonc("script/.strict-idx-baseline");
    const entries = (list.entries as unknown[]).length;
    const max = Number(baseline.maxEntries);
    assert.ok(Number.isFinite(max), "基线里的 maxEntries 必须是数字");
    assert.ok(
        entries <= max,
        `豁免条目 ${entries} 已超过基线 ${max} —— 想加豁免就得显式调高基线并写明理由`
    );
});
