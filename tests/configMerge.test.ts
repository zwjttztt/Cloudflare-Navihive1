// tests/configMerge.test.ts
// splitIncomingConfigs：服务端下发的一包配置怎么拆。
// 这里盯的是「写错了不报错、只是悄悄不对」的两条约定。

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftConfigs, splitIncomingConfigs } from "../src/utils/configMerge";
import { DEFAULT_CONFIGS, DEFAULT_WEBDAV_CONFIG } from "../src/appDefaults";

test("普通配置键原样进 configs，且始终以 DEFAULT_CONFIGS 打底", () => {
    const { configs } = splitIncomingConfigs({ "site.title": "我的导航" });
    assert.equal(configs["site.title"], "我的导航");
    // 没下发的键要留着默认值，否则界面上会出现 undefined
    for (const [k, v] of Object.entries(DEFAULT_CONFIGS)) {
        if (k !== "site.title") assert.equal(configs[k], v, `默认键 ${k} 丢了`);
    }
});

test("webdav. 前缀的键不会混进 configs —— 否则备份会把网盘口令上传上去", () => {
    const { configs, webdav } = splitIncomingConfigs({
        "webdav.url": "https://dav.example.com",
        "webdav.password": "secret",
        "site.title": "x",
    });
    assert.equal(Object.keys(configs).some(k => k.startsWith("webdav.")), false);
    assert.equal(webdav.url, "https://dav.example.com");
    assert.equal(webdav.password, "secret");
});

test("布尔按项目惯例存 1/0：只有 \"1\" 才是 true", () => {
    const on = splitIncomingConfigs({ "webdav.allowPrivateNetwork": "1" }).webdav;
    assert.equal(on.allowPrivateNetwork, true);

    for (const raw of ["0", "", "true", "false"]) {
        const off = splitIncomingConfigs({ "webdav.allowPrivateNetwork": raw }).webdav;
        assert.equal(off.allowPrivateNetwork, false, `"${raw}" 不该被当成 true`);
    }
});

test("拼错前缀的 webdav 字段被丢弃，不会把 undefined 写进配置", () => {
    const { webdav } = splitIncomingConfigs({
        "webdav.nonexistent": "x",
        "webdav.Url": "https://evil.example.com",
    });
    assert.equal(webdav.url, DEFAULT_WEBDAV_CONFIG.url);
    assert.equal(Object.values(webdav).includes(undefined as never), false);
});

test("null / undefined / 空对象都要能安全处理", () => {
    for (const input of [null, undefined, {}]) {
        const { configs, webdav } = splitIncomingConfigs(input);
        assert.deepEqual(configs, DEFAULT_CONFIGS);
        assert.deepEqual(webdav, DEFAULT_WEBDAV_CONFIG);
    }
});

test("DEFAULT_CONFIGS 里没有的键也要保留 —— 旧版本备份里的键不能被静默丢弃", () => {
    const { configs } = splitIncomingConfigs({ "some.legacy.key": "old-value" });
    assert.equal(configs["some.legacy.key"], "old-value");
});

test("拆分结果不共享引用：改返回值不该污染 DEFAULT_*", () => {
    const { configs, webdav } = splitIncomingConfigs({ "site.title": "a" });
    configs["site.title"] = "changed";
    webdav.url = "changed";
    assert.notEqual(DEFAULT_CONFIGS["site.title"], "changed");
    assert.notEqual(DEFAULT_WEBDAV_CONFIG.url, "changed");
});

test("draftConfigs 以当前生效配置为基础，且是副本", () => {
    const current = { ...DEFAULT_CONFIGS, "site.title": "当前" };
    const draft = draftConfigs(current);
    assert.equal(draft["site.title"], "当前");
    draft["site.title"] = "草稿改动";
    assert.equal(current["site.title"], "当前", "改草稿不该动到生效配置");
});
