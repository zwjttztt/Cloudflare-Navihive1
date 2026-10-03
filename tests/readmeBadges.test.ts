// tests/readmeBadges.test.ts
// README 顶上的版本徽章是手写的，跟 package.json 分处两个地方 —— 升级依赖的人
// 十有八九只改一处，徽章就永久停在旧版本上（体检时发现 TS 写着 5.7、实际跑 5.9）。
// 这里把徽章钉到**实际装上**的版本上（package.json 只是范围，锁文件才是真相）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const readme = readProjectFile("README.md");

/** `badge/React-19.3-61dafb` 里的 19.3 */
function badgeVersion(label: string): string | null {
    const m = readme.match(new RegExp(`badge/${label}-([0-9]+(?:\\.[0-9]+)*)-`));
    return m ? m[1] : null;
}

function installedVersion(pkg: string): string {
    return JSON.parse(readProjectFile(`node_modules/${pkg}/package.json`)).version as string;
}

/** 只比 major.minor：patch 天天变，徽章写三位数字纯属噪音 */
function majorMinor(v: string): string {
    const [major, minor] = v.split(".");
    return `${major}.${minor}`;
}

const CASES: [badgeLabel: string, pkg: string][] = [
    ["React", "react"],
    ["TypeScript", "typescript"],
    ["Material_UI", "@mui/material"],
];

for (const [label, pkg] of CASES) {
    test(`README 徽章 ${label} 与实际依赖版本一致`, () => {
        const badge = badgeVersion(label);
        assert.ok(badge, `README 里找不到 ${label} 徽章（格式：badge/${label}-<版本>-<颜色>）`);
        const actual = majorMinor(installedVersion(pkg));
        assert.equal(
            majorMinor(badge),
            actual,
            `徽章写着 ${badge}，实际装的是 ${installedVersion(pkg)}。` +
                `依赖升了 minor 就顺手把徽章一起改（package.json 是范围，锁文件才是真相）`
        );
    });
}

test("徽章比对本身是有效的（防正则写歪导致三条全跳过）", () => {
    // badgeVersion 若匹配不到会返回 null，上面的 assert.ok 会红；
    // 这里再确认一次它真能读出数字，而不是把整行 HTML 吞进来
    for (const [label] of CASES) {
        assert.match(badgeVersion(label) ?? "", /^[0-9]+(\.[0-9]+)*$/);
    }
});
