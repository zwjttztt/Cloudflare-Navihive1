// tests/bumpVersion.test.ts
// 版本号自动跳变的纯逻辑。
//
// 用户需求：「v0.1.0 随着更新部署自动变动，根据改动范围大小调整变动位数」——
// 档位边界写错的后果有两种，都不报错、只是数字难看：
//   - 该跳中位时跳了末位（阈值太松）：改了半天还是 v0.1.x，看不出这次动静大；
//   - 该跳末位时跳了中位（阈值太紧）：加一行注释就 v0.3.0，版本号变得没有信息量。
// 所以四条边界（patch 上下沿、minor 上下沿）和「低位归零」都得钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    levelOf,
    bumpSemver,
    applyVersionToPackageJson,
    THRESHOLDS,
} from "../script/bump-version-lib.mjs";

// ---------------- 档位：按改动规模 ----------------

test("小改（≤5 文件且 ≤200 行）→ 末位 patch", () => {
    assert.equal(levelOf(1, 1), "patch");
    assert.equal(levelOf(5, 200), "patch", "边界值算小的");
});

test("任一边界超一点就是中位 minor", () => {
    assert.equal(levelOf(6, 200), "minor", "文件多一个");
    assert.equal(levelOf(5, 201), "minor", "行数多一行");
});

test("中改（≤20 文件且 ≤1200 行）→ minor；再超就是首位 major", () => {
    assert.equal(levelOf(6, 285), "minor");
    assert.equal(levelOf(20, 1200), "minor", "边界值算中的");
    assert.equal(levelOf(21, 1200), "major", "文件超线");
    assert.equal(levelOf(20, 1201), "major", "行数超线");
    assert.equal(levelOf(100, 9999), "major");
});

test("空改动也算 patch（下限）", () => {
    assert.equal(levelOf(0, 0), "patch");
});

// ---------------- 跳变：低位归零 ----------------

test("patch：只动末位，不进位", () => {
    assert.equal(bumpSemver("0.1.0", "patch"), "0.1.1");
    assert.equal(bumpSemver("0.1.9", "patch"), "0.1.10");
    assert.equal(bumpSemver("2.5.7", "patch"), "2.5.8");
});

test("minor：中位 +1、末位归零", () => {
    assert.equal(bumpSemver("0.1.0", "minor"), "0.2.0");
    assert.equal(bumpSemver("0.1.9", "minor"), "0.2.0", "末位必须归零，不是 0.1.10");
    assert.equal(bumpSemver("0.9.3", "minor"), "0.10.0");
});

test("major：首位 +1、其余归零", () => {
    assert.equal(bumpSemver("0.1.0", "major"), "1.0.0");
    assert.equal(bumpSemver("2.5.7", "major"), "3.0.0");
});

test("版本号格式不认识就抛（别静默按 0.0.0 跳）", () => {
    assert.throws(() => bumpSemver("v0.1", "patch"), /看不懂的版本号/);
    assert.throws(() => bumpSemver("0.1.x", "patch"), /看不懂的版本号/);
    assert.throws(() => bumpSemver("", "patch"), /看不懂的版本号/);
});

// ---------------- 写回：只换 version 值，别动格式 ----------------

test("只替换 version 一行，其余内容字节不动", () => {
    const raw = `{
  "name": "navihive",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite"
  }
}
`;
    const out = applyVersionToPackageJson(raw, "0.2.0");
    assert.equal(out, raw.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    // 除版本行外逐字节相同：版本 diff 是审计轨迹，不能被格式噪声淹没
    assert.equal(out.split("\n").length, raw.split("\n").length);
    assert.ok(out.includes('"private": true'));
    assert.ok(out.includes('"dev": "vite"'));
});

test("没有 version 字段就抛（静默跳过会让推送不跳变，没人发现）", () => {
    assert.throws(() => applyVersionToPackageJson('{\n  "name": "x"\n}\n', "1.0.0"), /找不到 version/);
});

test("阈值常量与档位函数自洽（改阈值前先看这条）", () => {
    assert.equal(levelOf(THRESHOLDS.patch.files, THRESHOLDS.patch.lines), "patch");
    assert.equal(levelOf(THRESHOLDS.minor.files, THRESHOLDS.minor.lines), "minor");
});
