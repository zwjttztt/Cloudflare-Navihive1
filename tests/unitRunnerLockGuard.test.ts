// tests/unitRunnerLockGuard.test.ts
// 单测运行器（script/unit-tests.mjs）独占锁的守卫。
//
// 为什么值得单独钉一条：这个运行器进来先 `rm -rf script/tmp-tests`、跑完再删一次，
// 两份运行器并发时后一个把前一个刚打好的 bundle 删掉，node:test 报 MODULE_NOT_FOUND
// —— 表面是「一百多条用例失败」，其实一条都没真跑，是**假红**。
// 实测踩到过：`npm test` 与 `npm run check:budget`（同一个脚本的另一个入口）并行跑
// 就能稳定复现（3061 → 1211 条、152 失败）。
//
// 假红比没门禁更糟：它会训练人忽略红灯。所以锁本身要有守卫，
// 免得哪天有人重构脚本时把它当成「临时目录的清理逻辑」顺手删掉。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function findProjectDir(): string {
    for (let dir = process.cwd(), i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const src = readFileSync(path.join(findProjectDir(), "script", "unit-tests.mjs"), "utf8");
// 注释里会解释「为什么要锁」，只扫真正会执行的部分
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => {
        const at = line.indexOf("//");
        return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

test("单测运行器：用 O_EXCL 拿独占锁，拿不到就退出而不是硬跑", () => {
    // flag: "wx" 是唯一能表达「已存在则失败」的写法；少了它就成了覆盖写，锁不住
    assert.match(code, /writeFileSync\(\s*LOCK_FILE[\s\S]*?flag:\s*"wx"/, "拿锁必须用 wx（O_EXCL）");
    // 拿不到锁必须退出：硬跑下去还是会撞目录，等于没锁
    assert.match(code, /process\.exit\(1\)/, "拿不到锁时要退出");
});

test("单测运行器：正常结束与被信号打断都会放锁", () => {
    // 子进程跑完那条路上的放锁（覆盖率模式保留产物，但锁必须照样放）
    assert.match(code, /child\.on\(\s*"exit"[\s\S]*?releaseLock\(\)/, "child exit 后要放锁");
    assert.match(code, /child\.on\(\s*"error"[\s\S]*?releaseLock\(\)/, "子进程起不来时也要放锁");
    // Ctrl+C 不放锁的话，下一次运行会一直被「已有运行器在跑」挡住，只能手工删文件
    assert.match(code, /"SIGINT"[\s\S]*?releaseLock\(\)/, "SIGINT 要放锁");
    assert.match(code, /"SIGTERM"[\s\S]*?releaseLock\(\)/, "SIGTERM 要放锁");
});
