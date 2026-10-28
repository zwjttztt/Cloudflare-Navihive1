// tests/backupVersionGate.test.ts
// 备份导入的**版本闸门**。
//
// 钉住的问题：导入侧过去是 `version: raw.version || EXPORT_VERSION` —— 读进来就丢，
// 一个字都不校验。于是「新版导出的备份在老版本上导入」时，老代码不认识新字段，
// 静默丢掉一部分内容，而用户看到的是「恢复成功」。数据缺失比报错难查得多。
//
// 三条不可退让的规则：
//   1. 备份比当前版本**新** → 明确拒绝，并说清是哪个版本、支持到哪个版本、该怎么升；
//   2. 备份比当前版本**旧** → 允许导入（存量文件必须能导回来），但要留兼容提示；
//   3. **缺 version 字段**的老备份 → 照常导入（不能把存量用户堵死）。
//
// 另外钉住「按数字段比版本」：字符串比较里 "1.10" < "1.9"，
// 那会让 1.10 的备份在只认到 1.9 的旧版本上顺利通过闸门。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BackupVersionError,
    EXPORT_VERSION,
    checkBackupVersion,
    compareBackupVersion,
    normalizeImportData,
    parseBackupVersion,
    transferImpl,
} from "../src/API/methods/transfer";
import type { NavigationAPI } from "../src/API/navigationApi";
import type { ExportData } from "../src/API/types";

/** 只够跑「版本闸门」那一步的替身：任何一次 db 访问都直接炸，用来证明闸门在写库之前。 */
function stubApi(): NavigationAPI {
    return {
        currentUserId: 7,
        migrate: async () => {},
        db: {
            prepare() {
                throw new Error("版本闸门应当在碰数据库之前就作出决定");
            },
        },
    } as unknown as NavigationAPI;
}

function backup(version?: string): ExportData {
    return {
        groups: [{ id: 1, name: "分组", order_num: 0 } as never],
        sites: [],
        configs: {},
        ...(version === undefined ? {} : { version }),
        exportDate: "2026-01-01T00:00:00.000Z",
    } as ExportData;
}

// ---------------- 版本号解析与比较 ----------------

test("版本号按数字段比较：1.10 比 1.9 新（字符串比较会得出相反结论）", () => {
    assert.equal(compareBackupVersion("1.10", "1.9"), 1, "1.10 必须大于 1.9");
    assert.equal(compareBackupVersion("1.9", "1.10"), -1);
    assert.equal(compareBackupVersion("1.4", "1.4.0"), 0, "末尾补 0 算同一版");
    assert.equal(compareBackupVersion("2", "1.99"), 1);
    assert.equal(compareBackupVersion("1.4", "1.4"), 0);
    // 反向验证：字符串比较确实是错的，这条用例存在的前提不能被删掉
    assert.equal("1.10" < "1.9", true, "字符串比较的顺序正好相反，所以不能用它");
});

test("解析：只认纯数字段，其余一律按「未知版本」处理", () => {
    assert.deepEqual(parseBackupVersion("1.10"), [1, 10]);
    assert.deepEqual(parseBackupVersion(" 1.4 "), [1, 4], "两端空白要容忍（手改过的文件常见）");
    assert.deepEqual(parseBackupVersion(2), [2], "数字也认");
    for (const bad of ["", "test", "1.4-beta", "v1.4", "1..4", null, undefined, {}]) {
        assert.equal(parseBackupVersion(bad), null, `${JSON.stringify(bad)} 应当解析失败`);
    }
});

// ---------------- 规则 1：更新版本被拒 ----------------

test("更新版本的备份被拒绝，且说清「哪个版本 / 支持到哪个版本 / 该升级」", () => {
    const check = checkBackupVersion("1.5");
    assert.equal(check.ok, false);
    assert.equal(check.status, "newer");
    assert.equal(check.backupVersion, "1.5");
    assert.equal(check.supportedVersion, EXPORT_VERSION);

    const message = check.message || "";
    assert.match(message, /1\.5/, "必须告诉用户备份是哪个版本的");
    assert.match(message, new RegExp(EXPORT_VERSION.replace(/\./g, "\\.")), "必须告诉用户当前支持到哪个版本");
    assert.match(message, /升级/, "必须给出升级路径，否则用户只知道失败不知道怎么救");
});

test("normalizeImportData：更新的备份直接抛 BackupVersionError，且不动任何数据", () => {
    assert.throws(
        () => normalizeImportData(backup("1.5")),
        (error: unknown) => {
            assert.ok(error instanceof BackupVersionError, "必须是可识别的错误类型，调用方才能给准确文案");
            assert.equal(error.code, "BACKUP_VERSION_TOO_NEW");
            assert.equal(error.backupVersion, "1.5");
            assert.equal(error.supportedVersion, EXPORT_VERSION);
            assert.match(error.message, /请先升级再导入/);
            return true;
        }
    );
});

test("1.10 的备份在 1.4 上同样被拒（这条是字符串比较会漏掉的那一条）", () => {
    const check = checkBackupVersion("1.10");
    assert.equal(check.ok, false, "1.10 > 1.4，必须拒绝");
    assert.throws(() => normalizeImportData(backup("1.10")), BackupVersionError);
});

test("importData：拒绝发生在写库之前，用户拿到的是明确原因而不是「导入失败」", async () => {
    // db.prepare 一被调用就抛 —— 闸门如果排在写库之后，这条用例会红
    const result = await transferImpl.importData.call(stubApi(), backup("1.5"));
    assert.equal(result.success, false);
    assert.match(result.message || "", /1\.5/);
    assert.match(result.message || "", /升级/);
});

// ---------------- 规则 2：更旧版本可导入 ----------------

test("更旧版本的备份允许导入，并留下兼容提示", () => {
    const check = checkBackupVersion("1.3");
    assert.equal(check.ok, true, "旧备份必须能导 —— 拒绝等于把用户的数据锁在文件里");
    assert.equal(check.status, "older");
    assert.match(check.message || "", /较旧的版本/);

    const normalized = normalizeImportData(backup("1.3"));
    assert.equal(normalized.version, "1.3", "版本号如实回传，不能被悄悄改写成当前版本");
    assert.match(normalized.versionNotice || "", /较旧的版本（1\.3）/);
    assert.equal(normalized.groups.length, 1, "数据照常归一化，不受版本提示影响");
});

test("旧备份里的老字段照常可用（版本闸门不改变归一化结果）", () => {
    // 1.2 时代的形状：sites 嵌在 groups 里
    const normalized = normalizeImportData({
        version: "1.2",
        groups: [{ id: 3, name: "老分组", sites: [{ id: 9, name: "老卡片", url: "a.com" }] }],
        configs: {},
    } as never);
    assert.equal(normalized.sites.length, 1);
    assert.equal(normalized.sites[0].url, "https://a.com", "URL 归一化照旧生效");
    assert.ok(normalized.versionNotice, "旧版本导入要能被提示到");
});

test("同版本导入：不产生多余提示", () => {
    const check = checkBackupVersion(EXPORT_VERSION);
    assert.equal(check.ok, true);
    assert.equal(check.status, "current");
    assert.equal(check.message, undefined);

    const normalized = normalizeImportData(backup(EXPORT_VERSION));
    assert.equal(normalized.version, EXPORT_VERSION);
    assert.equal("versionNotice" in normalized, false, "当前版本不该多出一个提示字段");
});

// ---------------- 规则 3：缺字段 / 不认识的版本 ----------------

test("缺 version 字段的老备份照常导入（存量用户不能被堵死）", () => {
    const check = checkBackupVersion(undefined);
    assert.equal(check.ok, true);
    assert.equal(check.status, "unknown");
    assert.match(check.message || "", /没有版本号/);

    const normalized = normalizeImportData(backup());
    assert.equal(normalized.version, EXPORT_VERSION, "缺字段时才补成当前版本（与旧行为一致）");
    assert.ok(normalized.versionNotice, "要说清这是按兼容模式导入的");
});

test("解析不了的 version（手改过的文件）不构成拒绝理由", () => {
    for (const odd of ["test", "1.4-beta", "v2.0", ""]) {
        const check = checkBackupVersion(odd);
        assert.equal(check.ok, true, `"${odd}" 不能把用户挡在门外`);
        const normalized = normalizeImportData(backup(odd));
        assert.equal(normalized.version, odd || EXPORT_VERSION, "原样保留用户文件里的版本号");
    }
});
