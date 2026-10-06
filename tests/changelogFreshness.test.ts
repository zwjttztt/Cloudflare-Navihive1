// tests/changelogFreshness.test.ts
// CHANGELOG 的最新一段，日期不能落后于最近一次提交。
//
// 起因：远端连着两天的提交（10-03 的依赖四档升级、10-04 的补网与搬家）一条都没记，
// CHANGELOG 停在 10-02 —— 期间有 35 个提交。而这件事**没有任何东西会报错**：
// CHANGELOG 不是代码，写提交的人不会想到去翻它，等想起来已经攒了一大批，
// 只能靠回忆补（补出来的还容易漏）。
//
// 判据取「日期」而不是「提交数」：不是每个提交都值得单独记，
// 但**当天有提交、当天就该有那一段** —— 这条线清楚，也不会逼着人写流水账。
// 拿不到 git（不是仓库 / 没装 git）时跳过：这条守卫不该因为环境问题把人拦住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/**
 * `## YYYY-MM-DD` 那几行；取字典序最大的就是最新一段。
 *
 * ⚠️ 标题后面**允许带后缀**（`## 2026-10-06 · 记事本阶段四：…`、`## 2026-10-05（十六续）· …`
 * 都是本仓库的写法），用 `\b` 断掉日期即可，别要求「日期后面直接是行尾」。
 * 之前写成 `(\d{4}-\d{2}-\d{2})\s*$`：文件本身是 CRLF，靠 `\s*` 吞掉 `\r` 才勉强匹配
 * 纯日期标题，凡带后缀的一段**一个都数不进来**（实测 12 段里全是没后缀的老段落，
 * 最新一段还显示成 10-05，守卫等于摆设）。
 */
function changelogDates(readme: string): string[] {
    const dates: string[] = [];
    for (const m of readme.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\b/gm)) {
        dates.push(m[1]);
    }
    return dates;
}

/**
 * 判据：CHANGELOG 最新一段的日期早于最近提交日期 = 过期。
 *
 * 单独抽出来是因为「取最近提交日期」要靠 git，而有些环境（含本机）里
 * node 起不了子进程 —— 那条用例只能跳过。判据本身必须仍然被钉住，
 * 否则它就是一句没人验证过的空话。
 */
export function isChangelogStale(newest: string, commitDate: string): boolean {
    return newest < commitDate;
}

function latestCommitDate(projectDir: string): string | null {
    const proc = spawnSync("git", ["log", "-1", "--format=%cs"], {
        cwd: projectDir,
        encoding: "utf8",
    });
    if (proc.status !== 0 || !proc.stdout) return null;
    const out = proc.stdout.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

test("判据本身：最新一段早于提交日期就是过期，同一天不算", () => {
    assert.equal(isChangelogStale("2026-10-02", "2026-10-04"), true);
    assert.equal(isChangelogStale("2026-10-04", "2026-10-04"), false);
    assert.equal(isChangelogStale("2026-10-05", "2026-10-04"), false);
});

test("CHANGELOG 里解析得到日期分段（守卫本身要站得住）", () => {
    const text = readFileSync(join(findProjectDir(), "CHANGELOG.md"), "utf8");
    const dates = changelogDates(text);
    assert.ok(dates.length >= 3, `只解析出 ${dates.length} 段，解析规则多半失效了`);
    // 格式按日期倒序（文件头就是这么写的），最新一段应该是字典序最大的那个
    assert.equal(dates.slice().sort().at(-1), dates[0], "CHANGELOG 不是按日期倒序排的");
});

test("CHANGELOG 最新一段不落后于最近一次提交", t => {
    const projectDir = findProjectDir();
    const commitDate = latestCommitDate(projectDir);
    if (!commitDate) {
        t.skip("拿不到 git 提交日期（不是仓库 / 没装 git），跳过");
        return;
    }
    const text = readFileSync(join(projectDir, "CHANGELOG.md"), "utf8");
    const dates = changelogDates(text);
    assert.ok(dates.length > 0, "CHANGELOG 里一个日期分段都没有");

    const newest = dates.slice().sort().at(-1)!;
    assert.ok(
        !isChangelogStale(newest, commitDate),
        `最近一次提交是 ${commitDate}，但 CHANGELOG 最新一段还停在 ${newest}。` +
            `当天有提交就该有当天那一段 —— 补上之后再提交。`
    );
});
