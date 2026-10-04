// tests/configForm.test.ts
// 设置弹窗那几个「脏值也要活下来」的规整函数。
//
// 为什么值得测：主色是从数据库 / 备份文件 / 云端同步三条路进来的，写错的表现不是报错，
// 而是「主题悄悄变丑」或「整页白屏」。normalizeAccent 的返回值直接喂给 MUI 的
// createTheme —— 一个非法的颜色字符串进去，主题构建就炸了，而且是首屏炸。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccent, normalizeGlassBlur } from "../src/utils/configForm";

test("normalizeAccent：合法的 6 位与 3 位主色都原样保留", () => {
    assert.equal(normalizeAccent(null, "#ff0000"), "#ff0000");
    assert.equal(normalizeAccent(null, "#f00"), "#f00");
});

test("normalizeAccent：大小写都收（用户手输时不会特意小写）", () => {
    assert.equal(normalizeAccent(null, "#FFAA33"), "#FFAA33");
    assert.equal(normalizeAccent(null, "#AbC"), "#AbC");
});

test("normalizeAccent：前后空格先 trim 再校验，trim 后的值原样返回", () => {
    assert.equal(normalizeAccent(null, "  #ff0000  "), "#ff0000");
});

test("normalizeAccent：预览值优先于已保存值", () => {
    assert.equal(normalizeAccent("#00ff00", "#ff0000"), "#00ff00");
});

// 这条最容易写反：写成 || 的话，用户把预览清空（""）时会**回落**到库里那个旧的，
// 而「预览为空」的真正含义是「这次没在选色」。用 ?? 才对。
test("normalizeAccent：预览为空串时不回落到已保存值（跟「没有预览」不是一回事）", () => {
    assert.equal(normalizeAccent("", "#ff0000"), "");
});

test("normalizeAccent：没有预览时才用已保存值", () => {
    assert.equal(normalizeAccent(null, "#ff0000"), "#ff0000");
    assert.equal(normalizeAccent(undefined, "#ff0000"), "#ff0000");
});

test("normalizeAccent：非法写法一律按「没设」处理，绝不把脏值传给主题", () => {
    // 位数不对
    assert.equal(normalizeAccent(null, "#ff00"), "");
    assert.equal(normalizeAccent(null, "#ff00000"), "");
    assert.equal(normalizeAccent(null, "#ff"), "");
    // 少了 #
    assert.equal(normalizeAccent(null, "ff0000"), "");
    // 非十六进制
    assert.equal(normalizeAccent(null, "#ggg"), "");
    assert.equal(normalizeAccent(null, "#zzzzzz"), "");
    // CSS 注入类：少了 # 但带括号，绝不能放行
    assert.equal(normalizeAccent(null, "url(#x)"), "");
    assert.equal(normalizeAccent(null, "red; background: url(x)"), "");
});

test("normalizeAccent：两个都为空 / 都没设置时返回空串", () => {
    assert.equal(normalizeAccent(null, null), "");
    assert.equal(normalizeAccent(null, undefined), "");
    assert.equal(normalizeAccent(null, ""), "");
    assert.equal(normalizeAccent(null, "   "), "");
});

test("normalizeGlassBlur：空 / 非法 / 缺失都回落到默认 14", () => {
    assert.equal(normalizeGlassBlur(undefined), 14);
    assert.equal(normalizeGlassBlur(null), 14);
    assert.equal(normalizeGlassBlur(""), 14);
    assert.equal(normalizeGlassBlur("abc"), 14);
    assert.equal(normalizeGlassBlur("NaN"), 14);
});

test("normalizeGlassBlur：超出 0~24 的夹到边界上", () => {
    assert.equal(normalizeGlassBlur("30"), 24);
    assert.equal(normalizeGlassBlur("-5"), 0);
    assert.equal(normalizeGlassBlur("0"), 0);
    assert.equal(normalizeGlassBlur("24"), 24);
});

test("normalizeGlassBlur：小数与合法值原样保留", () => {
    assert.equal(normalizeGlassBlur("8"), 8);
    assert.equal(normalizeGlassBlur("12.5"), 12.5);
});
