// tests/recycleThrottleGuard.test.ts
// 回收站「节流」三件套的守卫：列表截断、过期清理按保留期、清理链路还在 cron 上。
//
// 起因（2026-10-13 性能报告 → 2026-10-18 落地核对）：回收站条目只增不减，
// 列表接口若不截断，几年的软删除会让 GET /api/recycle 一次性拖回全部历史；
// 过期清理若被改成无条件 DELETE，保留期（默认 7 天，站点所有者可改）就失效了。
// LIMIT 200 与 purgeExpiredRecycle 已在 src/API/methods/recycle.ts 落地 ——
// 这里把它们钉住，防止日后重构时被静默删掉（文档不是代码，测试才是门槛）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

/** 剥掉块注释与整行行注释（仓库有「注释里写正确写法」的反面教材，不剥会被蒙混） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readRecycle = () => stripComments(readFileSync(resolve(projectDir(), "src/API/methods/recycle.ts"), "utf8"));

test("回收站列表查询必须带 LIMIT 截断（列表接口不拖全量历史）", () => {
    const src = readRecycle();
    const at = src.indexOf("listRecycleBin: async function");
    assert.ok(at > 0, "找不到 listRecycleBin 实现");
    const window = src.slice(at, at + 2500);
    assert.ok(/LIMIT\s+\d+/.test(window), "listRecycleBin 的 SQL 必须带 LIMIT 截断");
    assert.ok(/LIMIT\s+200/.test(window), "回收站列表截断阈值应为 200（与性能报告一致）");
});

test("过期清理必须按保留期条件删除（不许无条件 DELETE 全表）", () => {
    const src = readRecycle();
    const at = src.indexOf("purgeExpiredRecycle: async function");
    assert.ok(at > 0, "找不到 purgeExpiredRecycle 实现");
    const window = src.slice(at, at + 1800);
    assert.ok(
        /DELETE FROM recycle_bin WHERE deleted_at < \?/.test(window),
        "过期清理必须按 deleted_at < ?（保留期参数化）删除"
    );
    // 同一窗口内不允许出现不带 WHERE 的全表 DELETE
    assert.ok(!/DELETE FROM recycle_bin(?!\s+WHERE)[^;]*;/.test(window), "过期清理不允许出现无条件 DELETE");
});

test("cron 侧还在调用回收站过期清理（自动清理链路不断）", () => {
    const src = stripComments(readFileSync(resolve(projectDir(), "src/API/methods/recycle.ts"), "utf8"));
    assert.ok(src.includes("cleanupExpiredRows: async function"), "cleanupExpiredRows 实现要还在");
    const cron = stripComments(readFileSync(resolve(projectDir(), "worker/cron.ts"), "utf8"));
    assert.ok(cron.includes("runRetentionCleanup"), "cron 必须还在调用 runRetentionCleanup");
});

test("反向验证：守卫真的能红（只在注释里的规则必须被剥掉）", () => {
    const broken = stripComments(`
        // listRecycleBin: async function
        // LIMIT 200
        // DELETE FROM recycle_bin WHERE deleted_at < ?
    `);
    assert.equal(/LIMIT\s+200/.test(broken), false, "剥注释后不该再匹配到 LIMIT 200");
});
