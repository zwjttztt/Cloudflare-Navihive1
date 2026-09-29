// tests/backupIntegrity.test.ts
// 备份文件完整性校验的单测。
// 重点不是「算得对」，而是**别误伤**：老备份没有校验字段要放行、字段顺序变了不能误报，
// 真改了内容必须报出来。误报比漏报更糟 —— 好文件被拦等于数据恢复不了。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stableStringify,
    computeBackupIntegrity,
    withBackupIntegrity,
    verifyBackupIntegrity,
    BACKUP_INTEGRITY_ALGO,
} from "../src/utils/backupIntegrity";

const sample = () => ({
    groups: [{ id: 1, name: "常用", order_num: 0 }],
    sites: [{ id: 1, group_id: 1, name: "A", url: "https://a.example" }],
    configs: { theme: "dark" },
    version: "1.3",
    exportDate: "2026-09-29T00:00:00.000Z",
});

test("stableStringify：键顺序不同，序列化结果一致", () => {
    const a = { version: "1.3", groups: [1, 2], configs: { a: 1, b: 2 } };
    const b = { configs: { b: 2, a: 1 }, groups: [1, 2], version: "1.3" };
    assert.equal(stableStringify(a), stableStringify(b));
});

test("stableStringify：数组顺序不同必须算出不同结果（顺序也是内容）", () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test("stableStringify：undefined 与 null 都稳定输出，不产生无效的 JSON 片段", () => {
    assert.equal(stableStringify({ a: undefined }), '{"a":null}');
    assert.equal(stableStringify({ a: null }), '{"a":null}');
});

test("导出后原样导入：校验通过", async () => {
    const data = await withBackupIntegrity(sample());
    assert.ok(data.integrity);
    assert.equal(data.integrity.algo, BACKUP_INTEGRITY_ALGO);
    assert.match(data.integrity.value, /^[0-9a-f]{64}$/);

    const check = await verifyBackupIntegrity(data);
    assert.equal(check.ok, true);
});

test("内容被改动：校验失败并给出可读原因", async () => {
    const data = await withBackupIntegrity(sample());
    const tampered = {
        ...data,
        sites: [{ id: 1, group_id: 1, name: "被改过的名字", url: "https://a.example" }],
    };

    const check = await verifyBackupIntegrity(tampered);
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /损坏|不一致/);
});

test("老备份没有 integrity 字段：一律放行", async () => {
    const legacy = sample();
    const check = await verifyBackupIntegrity(legacy);
    assert.equal(check.ok, true);
});

test("算法标记不认识：放行（不该因为看不懂就拦住恢复）", async () => {
    const data = { ...sample(), integrity: { algo: "MD5", value: "whatever" } };
    const check = await verifyBackupIntegrity(data);
    assert.equal(check.ok, true);
});

test("integrity 形状不对（不是对象 / value 不是字符串）：放行", async () => {
    assert.equal((await verifyBackupIntegrity({ ...sample(), integrity: "x" })).ok, true);
    assert.equal((await verifyBackupIntegrity({ ...sample(), integrity: { value: 1 } })).ok, true);
});

test("数据本身不是对象：放行，交给别的校验去报错", async () => {
    assert.equal((await verifyBackupIntegrity(null)).ok, true);
    assert.equal((await verifyBackupIntegrity("not a backup")).ok, true);
    assert.equal((await verifyBackupIntegrity([])).ok, true);
});

test("withBackupIntegrity 覆盖旧的摘要（前端补 localPrefs 后重算）", async () => {
    const first = await withBackupIntegrity(sample());
    const withPrefs = await withBackupIntegrity({
        ...first,
        localPrefs: { starred: [1], tags: {} },
    });

    assert.notEqual(withPrefs.integrity?.value, first.integrity?.value);
    assert.equal((await verifyBackupIntegrity(withPrefs)).ok, true);
    // 只补了 localPrefs 却还拿旧摘要去验，必须报出来 —— 这正是导出时要在最后一刻重算的原因
    assert.equal((await verifyBackupIntegrity({ ...withPrefs, integrity: first.integrity })).ok, false);
});

test("computeBackupIntegrity：同样的内容两次算出同样的摘要", async () => {
    const a = await computeBackupIntegrity(sample());
    const b = await computeBackupIntegrity(sample());
    assert.equal(a?.value, b?.value);
});
