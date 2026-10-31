// tests/readmeMenu.test.ts
// README 里写的菜单路径必须是界面上真实存在的那条。
//
// 起因：「设置」菜单做过一次重排，项名改了（数据备份 → 备份与恢复、
// 账号管理 → 账号与安全），README 里还留着旧名 —— 而这类漂移**没有任何东西会报错**：
// 文档不是代码，改菜单的人不会想到去搜 README，用户照着文档找又找不到入口。
//
// 这里只盯一件事：README 出现的每一条「设置 → X」，X 必须是菜单里真有的项。
// 反过来不做（不要求菜单项都写进 README）—— 帮助文档该写多少是另一件事，
// 写错了才是指向错误的入口。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
 * 界面上真实渲染出来的项名。
 *
 * 2026-10-29：下拉菜单（MoreMenu.tsx）已换成统一中心弹窗，项名的唯一真源
 * 挪到 `src/components/navigationCenter/model.ts` 的注册表里 —— 这里跟着改读
 * 注册表（`label: "…"`），不再扫 JSX。
 */
function menuLabels(): string[] {
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "navigationCenter", "model.ts"),
        "utf8"
    );
    const labels: string[] = [];
    for (const m of source.matchAll(/label:\s*"([^"]+)"/g)) {
        labels.push(m[1].trim());
    }
    return labels;
}

/**
 * README 里出现的所有「设置 → X」的第一段。
 * 写成「设置 → 账号与安全 → 恢复密钥」时只取「账号与安全」——
 * 再往里一层是弹窗里的分区，不在这个菜单里。
 */
function readmeEntries(readme: string): string[] {
    const entries: string[] = [];
    for (const m of readme.matchAll(/(?:设置|设置)\s*→\s*([^\s」→]+)/g)) {
        entries.push(m[1].trim());
    }
    return entries;
}

test("中心里确实取得到项名（守卫本身要站得住）", () => {
    const labels = menuLabels();
    assert.ok(labels.length >= 8, `只解析出 ${labels.length} 个条目，解析规则多半失效了`);
    assert.ok(labels.includes("备份与恢复"));
    assert.ok(labels.includes("账号与安全"));
});

test("README 里的每一条「设置 → X」都指向界面上真实存在的条目", () => {
    const readme = readFileSync(join(findProjectDir(), "README.md"), "utf8");
    const entries = [...new Set(readmeEntries(readme))];
    assert.ok(entries.length > 0, "README 里一条路径都没解析到，正则多半失效了");

    const labels = menuLabels();
    const unknown = entries.filter(e => !labels.includes(e));
    assert.deepEqual(
        unknown,
        [],
        `README 里这些路径在界面上找不到（条目改过名？）：\n` +
            `  界面现有：${labels.join(" / ")}`
    );
});

test("改名前的旧项名不该再出现在 README 里（改名要连文档一起改）", () => {
    const readme = readFileSync(join(findProjectDir(), "README.md"), "utf8");
    for (const stale of ["数据备份", "账号管理"]) {
        assert.ok(!readme.includes(stale), `README 里还留着改名前旧项名「${stale}」`);
    }
});
