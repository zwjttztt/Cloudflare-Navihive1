// script/bump-version.mjs
// 每次推送（= 每次部署）前自动给 package.json 的 version 跳变一次。
//
// 用户要的效果：「v0.1.0 随着更新部署自动变动，根据改动范围大小调整变动位数」——
//   小改 → 末位动（v0.1.1）；中改 → 中位动、末位归零（v0.2.0）；大改 → 首位动（v1.0.0）。
// 纯函数（档位/跳变/写回）在 bump-version-lib.mjs，单测在 tests/bumpVersion.test.ts。
//
// 为什么在推送时算、而不是构建时算：
//   - 版本要**落在 commit 里**（package.json 的 diff 就是审计轨迹），构建只是读它；
//   - Docker 构建上下文没有 .git（.dockerignore 排除），构建时想算改动规模根本算不了；
//   - Cloudflare 自动部署与 VPS docker build 都从同一个 commit 构建，读到同一个版本。
//
// 用法（rest-push-*.py 在 git add 之后调用）：
//   node script/bump-version.mjs
// 幂等：这一轮已经 bump 过（package.json 已暂存且版本已变）就直接跳过，
// 所以推送脚本里连着调用两次、或推送失败后重跑，都不会跳两档。
//
// ⚠️ Windows 下 node 的 execSync 走的是 cmd.exe：git 命令里的路径规格必须用
// **双引号**（`":(exclude)package.json"`）。单引号在 cmd.exe 里不是引号，
// 会被原样传给 git → fatal、exit 128（Git Bash 里手动跑反而正常，极易漏掉）。

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { levelOf, bumpSemver, applyVersionToPackageJson } from "./bump-version-lib.mjs";

function git(cmd) {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** HEAD 里 committed 的版本号（不是工作副本：上次推送失败留下的 bump 要能复位） */
function committedVersion() {
    try {
        const raw = git("git show HEAD:package.json");
        const parsed = JSON.parse(raw);
        if (typeof parsed.version === "string" && parsed.version) return parsed.version;
    } catch {
        /* 没有 HEAD 或读不到：落到默认值 */
    }
    return "0.0.0";
}

/** 这一轮已暂存的改动规模（行数按 numstat 的增+删合计，二进制记 0 行） */
function stagedScope() {
    const out = git('git diff --cached --numstat HEAD -- . ":(exclude)package.json"');
    let files = 0;
    let lines = 0;
    for (const row of out.split("\n")) {
        if (!row.trim()) continue;
        files += 1;
        const [add, del] = row.split("\t");
        const a = Number(add);
        const d = Number(del);
        if (Number.isFinite(a)) lines += a;
        if (Number.isFinite(d)) lines += d;
    }
    return { files, lines };
}

function main() {
    const pkgPath = path.join(process.cwd(), "package.json");
    const base = committedVersion();

    // 幂等：这一轮已经 bump 过就别再跳（推送脚本会调用两次：探一次版本 + 正式推送）
    const stagedPkg = git("git diff --cached --name-only HEAD -- package.json");
    if (stagedPkg) {
        const working = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (working.version && working.version !== base) {
            console.log(`版本已跳变过：v${base} -> v${working.version}，跳过`);
            return;
        }
    }

    const { files, lines } = stagedScope();
    const level = levelOf(files, lines);
    const next = bumpSemver(base, level);
    if (next === base) {
        console.log("版本无变化，跳过");
        return;
    }

    const raw = readFileSync(pkgPath, "utf8");
    writeFileSync(pkgPath, applyVersionToPackageJson(raw, next));
    git("git add package.json");
    console.log(`版本跳变：v${base} -> v${next}（${level}：${files} 文件 / ${lines} 行）`);
}

// 只有被直接执行才跑主流程。这个守卫挡不住「被 esbuild 内联进测试 bundle」那种情况
// （那时 argv[1] 恰好等于 bundle 路径）—— 所以纯函数才要单独放在 lib 文件里，
// 测试只 import lib，这个带 git 副作用的主文件谁都不 import。
const invokedDirectly =
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
