// tests/backupScope.test.ts
// 备份「什么进文件 / 什么能写回」的判定用例。
//
// 备份文件是会传到网盘、会发给别人的，这两条规则写错的后果都不轻：
//
// 1. **带多了** —— WebDAV 凭据 / AI 密钥跟着文件走 = 把别人的网盘和付费额度一起交出去；
//    普通账号把整站外观带出去 = 恢复时把整站长什么样改掉。
// 2. **带少了** —— 恢复完发现主题、背景、自定义 CSS 全没了，白备份一次。
//
// 而且导出与导入是**两个方向**：同一个「敏感键不进备份」的判定，只在导出处写了、
// 导入处漏了，就成了「备份文件里没有，但别人的备份里可以有」—— 所以两边共用
// 一份判定（utils/backupScope），这里同时对两个方向下断言。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    canWriteSharedConfigs,
    pickCronError,
    pickExportConfigs,
    pickImportConfigEntries,
    remapLocalPrefs,
} from "../src/utils/backupScope";

const OWNER: { role: "owner" } = { role: "owner" };
const USER: { role: "user" } = { role: "user" };

// ==================== 谁能改全站 ====================

test("未启用登录（单账号部署）：那人对整站有全权", () => {
    assert.equal(canWriteSharedConfigs(null), true);
});

test("站点所有者能改全站外观", () => {
    assert.equal(canWriteSharedConfigs(OWNER), true);
});

test("普通账号不能改全站外观", () => {
    assert.equal(canWriteSharedConfigs(USER), false);
});

// ==================== 导出：什么进备份文件 ====================

const FULL_CONFIGS = {
    "site.title": "我的导航",
    "site.theme": "dark",
    "webdav.url": "https://dav.example.com",
    "webdav.password": "dav-secret",
    "auth.password": "admin-secret",
    "ai.apiKey": "sk-xxx",
    "link.health": '{"dead":[]}',
    "link.healthSync": "true",
    "pref.tags": "{}",
};

test("导出（所有者）：全站配置进 shared，但不带任何敏感键", () => {
    const { shared, own } = pickExportConfigs(FULL_CONFIGS, OWNER);
    assert.equal(shared["site.title"], "我的导航");
    assert.equal(shared["link.healthSync"], "true", "开关要跟着备份走，换设备也保持原样");

    const secretPrefixes = ["webdav.", "auth.", "ai."];
    const secretExact = ["link.health", "pref.tags"];
    for (const key of Object.keys(shared)) {
        assert.equal(
            secretPrefixes.some(p => key.startsWith(p)) || secretExact.includes(key),
            false,
            `${key} 是敏感键，不该进备份文件`
        );
    }
    assert.deepEqual(own, {}, "所有者那份直接在全站 configs 里，不重复抄一遍");
});

test("导出：WebDAV 凭据绝不能进备份（文件会传到网盘、会发给别人）", () => {
    const { shared, own } = pickExportConfigs(FULL_CONFIGS, OWNER);
    assert.equal("webdav.password" in shared, false);
    assert.equal("webdav.url" in shared, false);
    assert.equal("webdav.password" in own, false);
    const dumped = JSON.stringify({ shared, own });
    assert.equal(dumped.includes("dav-secret"), false, "网盘口令不能出现在备份文件里");
    assert.equal(dumped.includes("admin-secret"), false, "管理员口令更不能");
});

test("导出（普通账号）：只带自己那份外观，且不带全站共享键", () => {
    const { shared, own } = pickExportConfigs(FULL_CONFIGS, USER);
    assert.deepEqual(shared, {}, "普通账号无权把整站配置带出去");
    assert.equal(own["site.title"], "我的导航");
    assert.equal(own["site.theme"], "dark");
    assert.equal(
        "link.healthSync" in own,
        false,
        "全站开关不属于个人外观，普通账号不该带"
    );
});

test("导出（普通账号）：外观一个都不落 —— 否则恢复完主题背景全没了，等于白备份", () => {
    const configs = {
        "site.title": "T",
        "site.background": "B",
        "site.customCss": "C",
        "site.themeColor": "#fff",
    };
    const { own } = pickExportConfigs(configs, USER);
    assert.deepEqual(
        Object.keys(own).sort(),
        ["site.background", "site.customCss", "site.themeColor", "site.title"],
        "site.* 前缀下的外观都要带上"
    );
});

test("导出：link.health 不能把 link.healthSync 一起吃掉（前缀匹配的经典坑）", () => {
    const { shared } = pickExportConfigs(
        { "link.health": "{}", "link.healthSync": "true" },
        OWNER
    );
    assert.equal("link.health" in shared, false, "失效记录是可重测的临时数据，不进备份");
    assert.equal(shared["link.healthSync"], "true", "开关要留着");
});

// ==================== 导入：什么能写回库 ====================

test("导入（普通账号）：全站键一律不写 —— 不能拿备份改掉整站的行为设置", () => {
    // backup.includeCredentials 是「既非按账号隔离、也非外观」的全站键：
    // 普通账号拿别人的备份恢复时，不该顺手决定全站备份带不带网站密码
    const entries = pickImportConfigEntries(
        { configs: { "backup.includeCredentials": "true" }, sharedConfigs: { "link.healthSync": "true" } },
        USER
    );
    assert.deepEqual(entries, []);
});

test("导入（普通账号）：site.* 可以写回 —— 那是他自己那份外观", () => {
    // site.* 属「每人一份的外观」：后端 setConfig 会按 isUserScopedConfigKey 分流到
    // user_configs，所以他改的是自己那份，不会把整站长什么样改掉。
    // 前端这里放行是对的，挡住反而会让他恢复完发现主题背景全没了。
    const entries = pickImportConfigEntries(
        { sharedConfigs: { "site.title": "我的标题" } },
        USER
    );
    assert.deepEqual(entries, [["site.title", "我的标题"]]);
});

test("导入（所有者）：全站外观可以写回", () => {
    const entries = pickImportConfigEntries(
        { sharedConfigs: { "site.title": "T", "site.theme": "dark" } },
        OWNER
    );
    assert.equal(entries.length, 2);
});

test("导入：老备份与新版备份的两堆配置都过一遍（老的全混在 configs 里）", () => {
    const entries = pickImportConfigEntries(
        { configs: { "site.title": "老格式" }, sharedConfigs: { "site.theme": "dark" } },
        OWNER
    );
    assert.deepEqual(entries, [
        ["site.title", "老格式"],
        ["site.theme", "dark"],
    ]);
});

test("导入：DB_INITIALIZED 永远不写回（写回去服务端会以为库已经建好了）", () => {
    const entries = pickImportConfigEntries(
        { configs: { DB_INITIALIZED: "1", "site.title": "T" } },
        OWNER
    );
    assert.deepEqual(entries, [["site.title", "T"]]);
});

test("导入：备份文件里的敏感键不能拿来覆盖服务端的网盘凭据", () => {
    // 备份文件可能被别人改过 —— 拿它覆盖 webdav.* 等于让别人设置你的网盘
    const entries = pickImportConfigEntries(
        {
            configs: {
                "webdav.url": "https://attacker.example.com",
                "webdav.password": "attacker-secret",
                "auth.password": "attacker-admin",
                "ai.apiKey": "attacker-key",
                "site.title": "T",
            },
        },
        OWNER
    );
    assert.deepEqual(entries, [["site.title", "T"]]);
});

test("导入：空数据返回空数组，不抛异常", () => {
    assert.deepEqual(pickImportConfigEntries({}, OWNER), []);
    assert.deepEqual(pickImportConfigEntries({ configs: undefined }, OWNER), []);
});

// ==================== 星标 / 标签的 id 翻译 ====================

test("重映射：服务端重新发号后，星标与标签都要跟着翻到新 id", () => {
    const out = remapLocalPrefs(
        { starred: [1, 2, 3], tags: { "1": ["常用"], "3": ["工具"] } },
        new Map([
            [1, 101],
            [2, 102],
            [3, 103],
        ])
    );
    assert.deepEqual(out?.starred, [101, 102, 103]);
    assert.deepEqual(out?.tags, { "101": ["常用"], "103": ["工具"] });
});

test("重映射：映射里没有的 id 要丢掉（那张卡片在备份里本来就不存在）", () => {
    const out = remapLocalPrefs({ starred: [1, 999] }, new Map([[1, 101]]));
    assert.deepEqual(out?.starred, [101]);
});

test("重映射：映射为空时照原样写回 —— 老备份宁可星标错位，也不能整份丢掉", () => {
    const prefs = { starred: [7, 8], tags: { "7": ["常用"] } };
    const out = remapLocalPrefs(prefs, new Map());
    assert.deepEqual(out, prefs);
    assert.equal(out, prefs, "空映射时直接返回原对象，不要复制一份");
});

test("重映射：没有 localPrefs 就返回 undefined（不该拿空对象去覆盖本机）", () => {
    assert.equal(remapLocalPrefs(undefined, new Map([[1, 2]])), undefined);
});

// ==================== cron 失败留痕 ====================

test("cron 留痕：取到第一条有 message 的失败", () => {
    const out = pickCronError(
        { "cron.lastError.backup": JSON.stringify({ task: "backup", message: "网盘写不进去" }) },
        "cron.lastError"
    );
    assert.deepEqual(out?.task, "backup");
    assert.equal(out?.message, "网盘写不进去");
});

test("cron 留痕：备份没失败时继续看巡检", () => {
    const out = pickCronError(
        { "cron.lastError.linkSweep": JSON.stringify({ message: "巡检超时" }) },
        "cron.lastError"
    );
    assert.equal(out?.task, "linkSweep", "task 字段缺失时按键名兜底");
    assert.equal(out?.message, "巡检超时");
});

test("cron 留痕：坏 JSON 当没留过，不能因为一行坏数据把弹窗搞崩", () => {
    const out = pickCronError(
        { "cron.lastError.backup": "{不是 JSON" },
        "cron.lastError"
    );
    assert.equal(out, null);
});

test("cron 留痕：message 是空串也当没留过（空提示比没有提示更糟）", () => {
    assert.equal(
        pickCronError({ "cron.lastError.backup": JSON.stringify({ message: "" }) }, "cron.lastError"),
        null
    );
});

test("cron 留痕：什么都没有就返回 null", () => {
    assert.equal(pickCronError({}, "cron.lastError"), null);
});
