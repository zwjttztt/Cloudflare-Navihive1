// tests/docsIndex.test.ts
// 文档的两条底线：**每份都被索引登记**，**链接都指向真实文件**。
//
// 起因（2026-11 文档整理时实测）：
//   1. `docs/README.md` 的三张索引表**同时漏掉** `api.md` / `architecture.md` / `codes.md` ——
//      恰好是新读者最该先读的三份。没有索引的那份文档，等于没写：没人会去 `ls docs/` 逐个猜。
//   2. 根 `README.md` 里写着 `deploy/selfhost.md`、`docs/architecture.md` 这类相对链接，
//      但**没有任何东西验证它们**。文档挪个位置、改个名，GitHub 只会给你一个 404 页面 ——
//      不报错、不进 CI、作者也看不到。
//
// 这两件事的共同点：出错时**静默**。所以放进单测，改了文档结构就会红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, sep } from "node:path";

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

const projectDir = findProjectDir();
const docsDir = join(projectDir, "docs");
const indexPath = join(docsDir, "README.md");
const readText = (abs: string): string => readFileSync(abs, "utf8");

/** 递归收集某个目录下的全部 .md（含子目录：deploy/、archive/） */
function collectMarkdown(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
            collectMarkdown(abs, out);
        } else if (name.endsWith(".md")) {
            out.push(abs);
        }
    }
    return out;
}

const indexText = readText(indexPath);
const allDocs = collectMarkdown(docsDir);
// 索引文件自己不需要登记自己
const listedDocs = allDocs.filter(abs => abs !== indexPath);

test("docs/README.md 登记了 docs 下每一份 md（含 archive/，递归）", () => {
    const unlisted: string[] = [];
    for (const abs of listedDocs) {
        const relFromDocs = relative(docsDir, abs).split(sep).join("/");
        const basename = relFromDocs.split("/").pop() as string;
        // 顶层文档按文件名出现即可；archive/ 下的必须带上 `archive/` 前缀 ——
        // 否则「归档里的 changelog-2026-10a.md」和「顶层的某份」在索引里分不清谁是谁
        const needle = relFromDocs.includes("/") ? relFromDocs : basename;
        if (!indexText.includes(needle)) unlisted.push(relFromDocs);
    }
    assert.deepEqual(
        unlisted,
        [],
        `有 ${unlisted.length} 份文档没出现在 docs/README.md 的索引里：\n${unlisted.join("\n")}\n` +
            `新增文档要顺手登记；不登记就等于没写（下一个人找不到它，也不会知道自己漏了）。`
    );
});

test("索引里必须显眼地列出 api.md / architecture.md / codes.md 这三份", () => {
    // 这三份曾经被三张表同时漏掉 —— 而它们恰好是「要查的东西」的三个入口
    for (const name of ["api.md", "architecture.md", "codes.md"]) {
        assert.ok(indexText.includes(name), `索引里找不到 ${name}`);
    }
});

/**
 * 抽出全部 markdown 链接的目标。
 *
 * 只管 `[文字](目标)` 与 `![图片](目标)`；跳过外链、锚点、以及非 .md 的目标
 * （图片、LICENSE 这类由 GitHub 自己处理）。带 `#锚点` 的去掉锚点再判文件是否存在。
 */
function markdownLinkTargets(text: string): string[] {
    const targets: string[] = [];
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        let target = m[1].trim();
        if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue; // http(s): / mailto: / 纯锚点 / 绝对路径
        target = target.split("#")[0];
        if (!target.endsWith(".md")) continue;
        targets.push(target);
    }
    return targets;
}

test("根文档里的相对 .md 链接都指向真实存在的文件", () => {
    // 这四份是「入口文档」：读者从这里出发，第一条链接断了，他就走不下去了
    const entryDocs = ["docs/README.md", "README.md", "SECURITY.md", "CONTRIBUTING.md"];
    const broken: string[] = [];
    let checked = 0;
    for (const rel of entryDocs) {
        const abs = join(projectDir, rel);
        assert.ok(existsSync(abs), `入口文档 ${rel} 不存在`);
        const baseDir = dirname(abs);
        for (const target of markdownLinkTargets(readText(abs))) {
            checked++;
            const resolved = resolve(baseDir, target);
            if (!existsSync(resolved)) broken.push(`${rel} → ${target}`);
        }
    }
    assert.ok(checked >= 20, `只解析出 ${checked} 条相对链接，解析规则多半失效了`);
    assert.deepEqual(
        broken,
        [],
        `有 ${broken.length} 条相对链接指向不存在的文件：\n${broken.join("\n")}\n` +
            `挪动/改名文档时，同一批把引用它的地方改掉（\`grep -rn "<旧文件名>" .\`）。`
    );
});

test("归档文件都在 docs/archive/ 下（顶层只留当前有效的文档）", () => {
    // 反向守卫：防止「归档了，但老路径又被人复制回来一份」
    const topLevel = readdirSync(docsDir).filter(name => name.endsWith(".md") && name !== "README.md");
    const snapshots = topLevel.filter(name => /20\d{2}-\d{2}-\d{2}/.test(name));
    // 这五份是有意留在顶层的，各有各的理由：
    //   前三份（site-audit / dialogs-audit ×2）被 src/** 的注释按原路径引用，挪走会把注释变成死路径；
    //   mobile-touch-audit 是目前有效的移动端触控规范（a11y-audit 的分档照它实现）；
    //   dual-deploy-arch 是架构决策记录，日期是「决策日」不是「过期日」（与 docs/README.md §1 同口径）。
    // 想加新的，先在 docs/README.md 里说明理由。
    const allowed = new Set([
        "site-audit-2026-10-15.md",
        "dialogs-audit-2026-10-16.md",
        "dialogs-audit-2026-10-23.md",
        "mobile-touch-audit-2026-11-02.md",
        "dual-deploy-arch-2026-10-14.md",
    ]);
    const unexpected = snapshots.filter(name => !allowed.has(name));
    assert.deepEqual(
        unexpected,
        [],
        `这些带日期的文档留在了 docs/ 顶层却没有豁免理由：\n${unexpected.join("\n")}\n` +
            `一次性报告请放 docs/archive/ 并在索引的归档表里登记。`
    );
});
