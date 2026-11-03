// tests/packageScriptsExist.test.ts
// package.json 里写下的每条脚本，指向的文件必须真实存在。
//
// 来历：`"check:whitedot"` 曾经写成 `node script/white-dot-check.mjs` —— 仓库里没有这个文件
// （真正的脚本叫 `script/probe-white-dot.mjs`）。那处在 26.0.x 波次已被改对，**但没有任何东西
// 守着它**：当初能一直错下去，是因为这条命令不在 `ci` 链里、本地没人手敲、CI 也不跑它，
// 只有真去用它的人才会撞上 `MODULE_NOT_FOUND`。所以这里把「scripts 里的路径必须落得到实体」
// 钉成一条用例 —— 同类断链（改名 / 挪目录 / 手滑）今天再发生，单测当场红。
// 也就是说，一条坏掉的门禁命令可以安静地躺在 package.json 里几个月，谁想起来去用它，
// 谁就得到一句「Cannot find module」，然后开始怀疑是自己环境坏了。
//
// 同类的坑还有一个：`npm run <name>` 指向一个已经被改名/删掉的脚本键 ——
// 报错是 `Missing script: xxx`，看起来像「命令打错了」，实际是清单自己断了。
//
// 这两件事都不该靠人记：凡是 `scripts` 里出现的脚本路径 / 脚本名，都得能解析到实体。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
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

interface PackageJson {
    scripts?: Record<string, string>;
}

const projectDir = findProjectDir();
const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as PackageJson;
const scripts: Record<string, string> = pkg.scripts ?? {};
const entries: Array<[string, string]> = Object.entries(scripts);

/**
 * 从一条命令里抽出「被 node 执行的文件路径」。
 *
 * 只认 `node <path>` 这一种写法（中间可能夹 `--flag`）：`vite` / `tsc -b` / `eslint .` /
 * `wrangler` 这些由包的 bin 解析，路径不在本仓库里，不该由这条守卫管。
 */
function nodeFileRefs(command: string): string[] {
    const refs: string[] = [];
    const tokens = command.split(/\s+/);
    for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] !== "node") continue;
        for (let j = i + 1; j < tokens.length; j++) {
            const token = tokens[j];
            if (token.startsWith("-")) continue; // --disable-warning=… 之类
            if (token.includes("&&") || token.includes("||")) break; // 已经是下一条命令
            if (/\.(mjs|cjs|js|ts)$/.test(token)) refs.push(token);
            break;
        }
    }
    return refs;
}

/** `npm run X` 里的 X */
function npmRunRefs(command: string): string[] {
    return [...command.matchAll(/npm\s+run\s+([\w:.-]+)/g)].map(m => m[1]);
}

/** 仓库里必须存在的文件（构建产物 dist-server/ 由前置步骤生成，不在此列） */
function isRepoPath(rel: string): boolean {
    return !rel.startsWith("dist") && !rel.startsWith("node_modules");
}

test("scripts 里 node 执行的脚本文件都存在（check:whitedot 曾经指向不存在的文件）", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [name, command] of entries) {
        for (const rel of nodeFileRefs(command)) {
            if (!isRepoPath(rel)) continue;
            checked++;
            const abs = join(projectDir, rel);
            if (!existsSync(abs) || !statSync(abs).isFile()) missing.push(`${name} → ${rel}`);
        }
    }
    assert.ok(checked >= 15, `只解析出 ${checked} 个脚本文件引用，解析规则多半失效了`);
    assert.deepEqual(
        missing,
        [],
        `package.json 里有 ${missing.length} 条脚本指向不存在的文件：\n${missing.join("\n")}\n` +
            `改脚本文件名时，把 scripts 里的路径一起改掉；否则这条命令一跑就是 MODULE_NOT_FOUND。`
    );
});

test("scripts 之间互相调用的 npm run <name> 都有对应定义", () => {
    const missing: string[] = [];
    for (const [name, command] of entries) {
        for (const target of npmRunRefs(command)) {
            if (!(target in scripts)) missing.push(`${name} → npm run ${target}`);
        }
    }
    assert.deepEqual(
        missing,
        [],
        `有 ${missing.length} 处指向不存在的脚本键：\n${missing.join("\n")}\n` +
            `改名脚本键时，把调用它的地方一起改掉（\`npm run ci\` 是这类引用的最大一处）。`
    );
});

test("ci 这一条命令的整条链都能解析（合入门禁不能有一步指向空气）", () => {
    const ci = scripts.ci;
    assert.ok(ci, "package.json 里没有 ci 脚本 —— 合入门禁的唯一入口丢了");
    const steps = npmRunRefs(ci);
    // 不钉死步数（钉了就得手改，手改必然过时）：只要求「解析出一串」且「每步都能落到底」
    assert.ok(steps.length >= 10, `ci 只解析出 ${steps.length} 步，解析规则多半失效了`);
    assert.deepEqual(
        steps.filter(step => !(step in scripts)),
        [],
        "ci 引用了不存在的脚本键"
    );
    // 每条 step 展开后再看一层：ci → step → 脚本文件，任何一环断了都算链断
    const brokenFiles: string[] = [];
    for (const step of steps) {
        for (const rel of nodeFileRefs(scripts[step])) {
            if (!isRepoPath(rel)) continue;
            if (!existsSync(join(projectDir, rel))) brokenFiles.push(`ci → ${step} → ${rel}`);
        }
    }
    assert.deepEqual(brokenFiles, [], `ci 链上有脚本文件不存在：\n${brokenFiles.join("\n")}`);
});

test("每个脚本的命令都非空（防止改到一半留下空串，npm run 时才炸）", () => {
    for (const [name, command] of entries) {
        assert.ok(command.trim().length > 0, `脚本 ${name} 是空命令`);
    }
});
