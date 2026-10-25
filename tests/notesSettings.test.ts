// tests/notesSettings.test.ts
// 记事本 UI 设置的读取清洗 + 强调色默认值的迁移。
//
// 为什么要专门钉这件事：`accent` 的**过去默认值是 #b0433a**，它在暖白底上
// 只有 4.18:1、暗底上 3.19:1 —— 两头都不到 WCAG AA 的 4.5。
// 也就是说「默认外观本身就是不达标的」（2026-10-24 把审计面扩到记事本时抓出来的）。
//
// 修法是把默认值改成**空串 = 跟随主题**，由 index.css 的 --notes-accent 按亮/暗分态给值。
// 但存量用户的 localStorage 里存着 #b0433a（那不是他们挑的，是当年的默认值被写进去了），
// 所以读取时要把这个值**视同没设过**，否则升级之后他们仍然是那个不达标的红。
//
// 这里同时钉住「用户自己挑的颜色不能被动」—— 迁移只针对那一个历史默认值。

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NOTES_SETTINGS, loadNotesSettings } from "../src/utils/notesSettings";

const KEY = "notes.uiSettings";

function readWith(raw: unknown) {
    localStorage.clear();
    if (raw !== undefined) {
        localStorage.setItem(KEY, typeof raw === "string" ? raw : JSON.stringify(raw));
    }
    return loadNotesSettings();
}

test("默认强调色是空串（= 跟随主题，不是某个写死的色）", () => {
    assert.equal(
        DEFAULT_NOTES_SETTINGS.accent,
        "",
        "默认值必须是空串：具体色值没法在亮/暗两态同时达 AA，交给 --notes-accent 分态"
    );
});

test("什么都没存过：强调色为空（跟随主题）", () => {
    assert.equal(readWith(undefined).accent, "");
});

test("存量里是历史默认值 #b0433a：视同没设过，跟着升级", () => {
    assert.equal(
        readWith({ accent: "#b0433a" }).accent,
        "",
        "这个值不是用户挑的，是当年默认值被写进 localStorage 的 —— 必须一起升级"
    );
});

test("用户自己挑的颜色原样保留（迁移只针对那一个历史默认值）", () => {
    for (const color of ["#3b82f6", "#22c55e", "#8b5cf6", "#fff", "#AABBCC"]) {
        assert.equal(readWith({ accent: color }).accent, color, `${color} 不该被改动`);
    }
});

test("脏值一律回落到默认（空串），不能把非法色塞进 CSS 变量", () => {
    for (const bad of ["javascript:alert(1)", "red", "#12345", "url(x)", 42, null, {}]) {
        assert.equal(
            readWith({ accent: bad }).accent,
            "",
            `${JSON.stringify(bad)} 应回落到空串`
        );
    }
});

test("整个存的不是对象：所有字段回落默认，不抛异常", () => {
    for (const bad of ["not-json", "[1,2,3]", '"a string"', "null"]) {
        const s = readWith(bad);
        assert.equal(s.accent, "");
        assert.equal(s.bgcolor, DEFAULT_NOTES_SETTINGS.bgcolor);
        assert.equal(s.editorFontSize, DEFAULT_NOTES_SETTINGS.editorFontSize);
    }
});

test("其它字段的清洗不受强调色改动影响（回归）", () => {
    const s = readWith({ accent: "#3b82f6", bgcolor: "pure", density: "compact", editorFontSize: 18 });
    assert.equal(s.bgcolor, "pure");
    assert.equal(s.density, "compact");
    assert.equal(s.editorFontSize, 18);
    // 越界值回落
    assert.equal(readWith({ editorFontSize: 999 }).editorFontSize, DEFAULT_NOTES_SETTINGS.editorFontSize);
});

// ---- 「列表样式」三档（2026-10-25 笔记美化新增字段）----
// 老用户的 localStorage 里没有 listStyle，读取必须落到默认「分隔线」；
// 脏值（任意字符串 / 数字）一律回落，不能把它塞进 sx 的条件分支里 ——
// 那会让三档判断全部落空，行样式变成「既不无线也不分隔也不卡片」。

test("列表样式：默认「分隔线」，老数据（没有这个字段）也落到默认", () => {
    assert.equal(DEFAULT_NOTES_SETTINGS.listStyle, "divider");
    assert.equal(readWith({}).listStyle, "divider", "缺字段 → 默认");
    assert.equal(readWith({ accent: "#3b82f6" }).listStyle, "divider", "有别的字段但没这个 → 默认");
});

test("列表样式：三档合法值原样保留", () => {
    for (const v of ["plain", "divider", "card"]) {
        assert.equal(readWith({ listStyle: v }).listStyle, v);
    }
});

test("列表样式：脏值回落默认（不让非法值进 sx 分支）", () => {
    for (const bad of ["grid", "", "CARD", 1, null, {}, []]) {
        assert.equal(
            readWith({ listStyle: bad }).listStyle,
            DEFAULT_NOTES_SETTINGS.listStyle,
            `${JSON.stringify(bad)} 应回落默认`
        );
    }
});
