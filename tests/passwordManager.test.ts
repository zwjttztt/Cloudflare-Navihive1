// tests/passwordManager.test.ts
// 方案 A「收纳增强」两个纯函数的守卫：passwordGenerator（生成 + 强度）与
// passwordHealth（重复 / 弱 / 久未改分析）。
//
// 生成器是**随机**的，所以测**不变量**（长度、字符集、类别覆盖、去易混），
// 不测具体字节；强度与健康分析是确定性的，测具体输入 → 具体输出。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    generatePassword,
    passwordStrength,
    type GenerateOptions,
} from "../src/utils/passwordGenerator";
import { analyzeCredentials, type CredentialEntry } from "../src/utils/passwordHealth";

const AMBIGUOUS = /[0O1lI|]/;

function sample(n: number, opts: GenerateOptions = {}): string[] {
    return Array.from({ length: n }, () => generatePassword(opts));
}

// ---------------- 生成器 ----------------

test("生成器：默认长度 20，且只用合法字符集", () => {
    for (const pw of sample(50)) {
        assert.equal(pw.length, 20);
        assert.match(pw, /^[a-zA-Z0-9!@#$%^&*()\-_=+[\]{};:,.<>?/~]+$/, `含非法字符：${pw}`);
    }
});

test("生成器：默认去易混字符（看不到 0 O 1 l I |）", () => {
    for (const pw of sample(100)) {
        assert.equal(AMBIGUOUS.test(pw), false, `出现了易混字符：${pw}`);
    }
});

test("生成器：avoidAmbiguous=false 时不再过滤", () => {
    // 关掉过滤后，样本里应能同时见到数字与大写（池变大的证据）
    const all = sample(80, { length: 24, avoidAmbiguous: false }).join("");
    assert.match(all, /[0-9]/);
    assert.match(all, /[A-Z]/);
});

test("生成器：长度可设且被夹在 [4,128]", () => {
    assert.equal(generatePassword({ length: 32 }).length, 32);
    assert.equal(generatePassword({ length: 2 }).length, 4, "太短夹到 4");
    assert.equal(generatePassword({ length: 999 }).length, 128, "太长夹到 128");
    assert.equal(generatePassword({ length: 12.9 }).length, 12, "小数向下取整");
});

test("生成器：每个启用的字符类都保证出现（洗牌后不固定在开头）", () => {
    // 全开 + 足够长：每个样本四类齐全
    for (const pw of sample(60, { length: 16 })) {
        assert.match(pw, /[a-z]/, "缺小写");
        assert.match(pw, /[A-Z]/, "缺大写");
        assert.match(pw, /[0-9]/, "缺数字");
        assert.match(pw, /[^a-zA-Z0-9]/, "缺符号");
    }
});

test("生成器：关掉某类就真的不出现", () => {
    const noUpper = sample(40, { length: 20, upper: false }).join("");
    assert.equal(/[A-Z]/.test(noUpper), false, "关了大写却仍出现");
    const noSym = sample(40, { length: 20, symbols: false }).join("");
    assert.equal(/[^a-zA-Z0-9]/.test(noSym), false, "关了符号却仍出现");
    const noDigits = sample(40, { length: 20, digits: false }).join("");
    assert.equal(/[0-9]/.test(noDigits), false, "关了数字却仍出现");
});

// ---------------- 强度 ----------------

test("强度：空密码最弱", () => {
    const s = passwordStrength("");
    assert.equal(s.score, 0);
    assert.equal(s.label, "很弱");
});

test("强度：常见弱口令被压到最低档并给出原因", () => {
    for (const pw of ["password", "123456", "qwerty", "admin", "P@ssw0rd"]) {
        const s = passwordStrength(pw);
        assert.ok(s.score <= 1, `${pw} 不该高分（${s.score}）`);
        assert.ok(s.warnings.some(w => w.includes("常见弱口令")), `${pw} 应提示常见弱口令`);
    }
});

test("强度：纯数字 / 太短 有对应提示", () => {
    assert.ok(passwordStrength("0928374650").warnings.some(w => w.includes("纯数字")));
    assert.ok(passwordStrength("Ab3").warnings.some(w => w.includes("偏短")));
});

test("强度：长且杂的随机串得分高、无告警", () => {
    const s = passwordStrength(generatePassword({ length: 24 }));
    assert.ok(s.score >= 3, `24 位随机串应强（实际 ${s.score}）`);
    assert.equal(s.warnings.length, 0, "不该有告警");
});

test("强度：连续序列被点名", () => {
    assert.ok(passwordStrength("abcd1234").warnings.some(w => w.includes("序列")));
    assert.ok(passwordStrength("Zx!9876").warnings.some(w => w.includes("序列")));
});

test("强度：熵随长度/字符类增长", () => {
    const short = passwordStrength("Ab1!").entropyBits;
    const long = passwordStrength("Ab1!Cd2@Ef3#Gh4$").entropyBits;
    assert.ok(long > short, "更长的密码熵应更高");
});

// ---------------- 健康分析 ----------------

const DAY = 86_400_000;
// 固定「现在」，让久未改判定确定
const NOW = Date.parse("2026-10-25T00:00:00Z");

function entry(p: Partial<CredentialEntry>): CredentialEntry {
    return { id: 0, name: "?", ...p };
}

test("健康：同一密码用在多个站点 → 归为一组、数量对、多的在前", () => {
    const r = analyzeCredentials(
        [
            entry({ id: 1, name: "A", password: "same", updated_at: "2026-10-20 00:00:00" }),
            entry({ id: 2, name: "B", password: "same", updated_at: "2026-10-20 00:00:00" }),
            entry({ id: 3, name: "C", password: "same", updated_at: "2026-10-20 00:00:00" }),
            entry({ id: 4, name: "D", password: "uniq", updated_at: "2026-10-20 00:00:00" }),
        ],
        { now: NOW }
    );
    assert.equal(r.total, 4);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].count, 3);
    assert.deepEqual(r.duplicates[0].sites.map(s => s.id), [1, 2, 3]);
});

test("健康：弱口令被挑出（含原因）", () => {
    const r = analyzeCredentials(
        [
            entry({ id: 1, name: "A", password: "123456" }),
            entry({ id: 2, name: "B", password: generatePassword({ length: 24 }) }),
        ],
        { now: NOW }
    );
    assert.equal(r.weak.length, 1);
    assert.equal(r.weak[0].id, 1);
    assert.ok(r.weak[0].reasons.length > 0);
});

test("健康：久未改按阈值判定，越久越靠前", () => {
    const r = analyzeCredentials(
        [
            entry({ id: 1, name: "新", password: "x", updated_at: new Date(NOW - 10 * DAY).toISOString() }),
            entry({ id: 2, name: "旧", password: "y", updated_at: new Date(NOW - 800 * DAY).toISOString() }),
            entry({ id: 3, name: "更旧", password: "z", updated_at: new Date(NOW - 1200 * DAY).toISOString() }),
        ],
        { now: NOW, staleDays: 365 }
    );
    assert.equal(r.stale.length, 2, "只有超 365 天的两条");
    assert.deepEqual(r.stale.map(s => s.id), [3, 2], "越旧越靠前");
});

test("健康：updated_at 是 SQLite 无时区串也按 UTC 正确解析", () => {
    // 380 天前的 SQLite 串（UTC）。若被当本地时间会算成 388 小时偏差，依旧 > 阈值，
    // 这里用一个刚过阈值的边界值更能暴露 8 小时误差：366 天前应算陈旧。
    const r = analyzeCredentials(
        [entry({ id: 1, name: "边界", password: "x", updated_at: "2025-10-24 00:00:00" })],
        { now: NOW, staleDays: 365 }
    );
    // 2025-10-24 → 2026-10-25 = 366 天 > 365，应陈旧
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0].daysSince, 366);
});

test("健康：填了用户名没填密码 → 计入 usernameOnly，不进其它统计", () => {
    const r = analyzeCredentials(
        [
            entry({ id: 1, name: "半条", username: "bob" }),
            entry({ id: 2, name: "空", password: "" }),
            entry({ id: 3, name: "完整", username: "amy", password: "good-Passw0rd!x" }),
        ],
        { now: NOW }
    );
    assert.equal(r.usernameOnly, 1, "只有 bob 那条算");
    assert.equal(r.total, 1, "只统计有密码的");
});

test("健康：没有 updated_at 不武断判陈旧", () => {
    const r = analyzeCredentials([entry({ id: 1, name: "无时间", password: "x" })], { now: NOW });
    assert.equal(r.stale.length, 0);
});

test("健康：空列表 / 非数组不抛，全零", () => {
    const r = analyzeCredentials([]);
    assert.equal(r.total, 0);
    assert.equal(r.duplicates.length, 0);
    // 故意传 undefined（强转绕过类型），验证运行时的 Array.isArray 防御
    assert.equal(analyzeCredentials(undefined as unknown as CredentialEntry[]).total, 0);
});
