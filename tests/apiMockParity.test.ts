// tests/apiMockParity.test.ts
// 「mock 与真机同源」的守卫（2026-10-22，3.3 第二批）。
//
// 3.3 的思路不是把 1500 行 mock 删掉，而是：**规则只准有一份实现**，两边都调它。
// 第一批做的是「文件夹防环」（folderRuleParity.test.ts），这批做了三处：
//
//   1. SQLite 时间格式 —— 原先 4 处手写、3 种写法（带毫秒 / 秒级）。
//      这些字符串是**拿来比较和排序的**（墓碑游标、审计 since），精度混进同一列，
//      同秒内的先后就分不出来，而且不会报错。
//   2. 前端错误归并 —— 真机版收集 paths（最多 3 条），mock 版压根没收集。
//      本地看着一切正常，其实少了一整列信息；source 的类型防御也不一致。
//   3. 笔记规则值 —— REVISION_KEEP_PER_NOTE mock 里硬编码 60（靠注释维系），
//      摘要截断一边 `>=` 一边 `>`，恰好等于上限时判断相反。
//
// 守卫钉两件事：规则真的只有一份（静态）+ 共享那份的行为对（行为）。
//
// ⚠️ 只断言字符串与数字：断言失败路径里不放 DOM 元素（node:assert 会 util.inspect 它）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectDir as findProjectDir } from "./helpers/notesSource";
import { sqlNow, sqlNowMs, toSqlTime, toSqlTimeLoose, sqlDay } from "../src/utils/sqlTime";
import { CLIENT_ERROR_MAX_PATHS, groupClientErrors } from "../src/utils/clientErrorGroups";
import { NOTE_SUMMARY_CHARS, REVISION_KEEP_PER_NOTE, needsSummary, summarizeContent } from "../src/utils/noteLimits";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);
const read = (rel: string) => readFileSync(resolve(projectDir(), rel), "utf8");

// ---------------- 静态：规则只有一份 ----------------

test("三处规则：两侧都 import 共享模块", () => {
    const pairs: Array<[string, string][]> = [
        [
            ["src/API/methods/audit.ts", "src/API/mock.ts"],
            ["utils/clientErrorGroups", "groupClientErrors"],
        ],
        [
            ["src/API/methods/notes/notesNote.ts", "src/API/mock.ts"],
            ["utils/noteLimits", "needsSummary"],
        ],
        [
            ["src/API/methods/internals.ts", "src/API/mock.ts"],
            ["utils/sqlTime", "sqlNow"],
        ],
    ];
    for (const [files, [mod, fn]] of pairs) {
        for (const f of files) {
            const src = read(f);
            assert.match(src, new RegExp(mod), `${f} 要引 ${mod}`);
            assert.match(src, new RegExp(fn), `${f} 要调 ${fn}`);
        }
    }
});

test("不再有内联手写的时间格式 / 硬编码的版本上限 / 自写的错误归并", () => {
    const mock = read("src/API/mock.ts");
    const notes = read("src/API/methods/notes.ts");
    // 反向验证：正则本身要能抓到旧写法（否则守卫是假的）
    assert.equal(/slice\(0, 19\)\.replace/.test("new Date().toISOString().slice(0, 19).replace"), true);
    assert.equal(/length > 200/.test("(x).length > 200"), true);

    assert.equal(/slice\(0, 19\)\.replace/.test(mock), false, "mock 里不该再手写时间格式");
    assert.equal(/mine\.length - 60/.test(mock), false, "mock 里不该再硬编码版本上限 60");
    assert.equal(/length > 200/.test(mock), false, "mock 里不该再自己比 200");
    assert.equal(/slice\(0, 19\)\.replace/.test(notes), false, "notes 里不该再手写时间格式");
});

// ---------------- 行为：时间格式 ----------------

test("sqlNow 是 SQLite 的秒级形状，且与 CURRENT_TIMESTAMP 一致（UTC）", () => {
    const s = sqlNow();
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `实际 ${s}`);
    const d = new Date("2026-10-22T10:45:33.987Z");
    assert.equal(toSqlTime(d), "2026-10-22 10:45:33", "毫秒要截掉");
    assert.equal(toSqlTime(d, true), "2026-10-22 10:45:33.987", "毫秒版要带三位");
});

test("墓碑用毫秒版：同一秒里连续产生两条也能分出先后", () => {
    const a = sqlNowMs();
    assert.match(a, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/, `实际 ${a}`);
    // 秒级会相等，毫秒级能比较 —— 这正是墓碑需要精度的那条理由
    const d1 = new Date("2026-10-22T10:45:33.100Z");
    const d2 = new Date("2026-10-22T10:45:33.900Z");
    assert.equal(toSqlTime(d1), toSqlTime(d2), "秒级分不出同一秒里的两条");
    assert.ok(toSqlTime(d1, true) < toSqlTime(d2, true), "毫秒级能分出先后");
});

test("toSqlTimeLoose：客户端传什么形状都收，进 SQL 前拉齐", () => {
    assert.equal(toSqlTimeLoose("2026-10-22T10:45:33Z"), "2026-10-22 10:45:33");
    assert.equal(toSqlTimeLoose("2026-10-22T10:45:33.123Z"), "2026-10-22 10:45:33");
    assert.equal(toSqlTimeLoose("2026-10-22 10:45:33"), "2026-10-22 10:45:33", "本来就对的不动");
    assert.equal(toSqlTimeLoose(""), "");
    assert.equal(sqlDay(new Date("2026-10-22T23:59:59Z")), "2026-10-22");
});

// ---------------- 行为：错误归并（paths 是分叉点） ----------------

test("错误归并：同一 source|message 折起来计数，最近时间取最大", () => {
    const groups = groupClientErrors([
        { detail: '{"source":"save-error","message":"失败"}', created_at: "2026-10-22 10:00:00" },
        { detail: '{"source":"save-error","message":"失败"}', created_at: "2026-10-22 11:00:00" },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].lastAt, "2026-10-22 11:00:00", "取最近一次");
});

test("错误归并：paths 要被收集（mock 原先漏了这一列）", () => {
    const groups = groupClientErrors([
        { detail: '{"source":"s","message":"m","path":"/a"}', created_at: "2026-10-22 10:00:00" },
        { detail: '{"source":"s","message":"m","path":"/b"}', created_at: "2026-10-22 10:01:00" },
        { detail: '{"source":"s","message":"m","path":"/c"}', created_at: "2026-10-22 10:02:00" },
        { detail: '{"source":"s","message":"m","path":"/d"}', created_at: "2026-10-22 10:03:00" },
    ]);
    assert.deepEqual(groups[0].paths, ["/a", "/b", "/c"], "最多记 3 条，按出现顺序");
    assert.equal(groups[0].paths.length, CLIENT_ERROR_MAX_PATHS);
});

test("错误归并：非 JSON 的 detail 整条当消息，不抛", () => {
    const groups = groupClientErrors([{ detail: "裸文本错误", created_at: "2026-10-22 10:00:00" }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source, "unknown");
    assert.equal(groups[0].message, "裸文本错误");
});

test("错误归并：source 不是字符串时按 unknown（两侧原来不一致）", () => {
    const groups = groupClientErrors([{ detail: '{"source":123,"message":"m"}', created_at: "2026-10-22 10:00:00" }]);
    assert.equal(groups[0].source, "unknown", "数字不该被当成来源名");
});

test("错误归并：次数多的排前面", () => {
    const rows = [
        { detail: '{"source":"a","message":"x"}', created_at: "2026-10-22 10:00:00" },
        { detail: '{"source":"b","message":"y"}', created_at: "2026-10-22 11:00:00" },
        { detail: '{"source":"b","message":"y"}', created_at: "2026-10-22 11:01:00" },
    ];
    const groups = groupClientErrors(rows);
    assert.equal(groups[0].source, "b", "刷得多的先看到");
});

// ---------------- 行为：笔记规则值 ----------------

test("版本上限只有一份：60，且 mock 与真机用的是同一个常量", () => {
    assert.equal(REVISION_KEEP_PER_NOTE, 60);
    assert.equal(NOTE_SUMMARY_CHARS, 200);
});

test("摘要判定用 >=：恰好等于上限时也算被截断（mock 原先是 >）", () => {
    assert.equal(needsSummary("x".repeat(NOTE_SUMMARY_CHARS - 1)), false);
    assert.equal(needsSummary("x".repeat(NOTE_SUMMARY_CHARS)), true, "恰好等于上限要算截断");
    assert.equal(needsSummary("x".repeat(NOTE_SUMMARY_CHARS + 50)), true);
    assert.equal(needsSummary(null), false, "空/未定义不能抛");
    assert.equal(summarizeContent("y".repeat(500)).length, NOTE_SUMMARY_CHARS);
});

// ---------------- 备份范围：mock 与真实链路同一道关（2026-10-24） ----------------

test("备份范围：mock 的导出导入与真实链路共用 backupScope", () => {
    // 2026-10-24 之前 mock 的 exportData 是 {...mockConfigs} 全量吐、importData
    // 全量收 —— 演示模式下「敏感键不进备份」这条规则形同虚设，备份范围的改动
    // （AI 整组进备份、webdav 不进）在演示模式验证不到。现在两侧共用同一判定。
    const mock = read("src/API/mock.ts");
    assert.match(mock, /pickExportConfigs\(mockConfigs/, "mock 导出必须走 pickExportConfigs");
    assert.match(mock, /pickImportConfigEntries\(/, "mock 导入必须走 pickImportConfigEntries");
    // 真实链路两侧也都在用同一份（防将来某边又抄一份自己的）
    const scope = read("src/utils/backupScope.ts");
    assert.match(scope, /export function pickExportConfigs/);
    assert.match(scope, /export function pickImportConfigEntries/);
});
