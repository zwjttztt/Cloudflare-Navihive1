// tests/secretInput.test.ts
// 卡片上的「登录凭据」不能被浏览器当成导航站的登录表单。
//
// 这里守的是那个反直觉的坑：为了让浏览器认不出密码字段，输入框的 name 从
// password 改成了 site-secret —— 但表单状态里的键还得是 password。
// 中间少做一次映射，用户敲键盘就「打不出字」（值写进了 formData["site-secret"]，
// 而 value 绑的是 formData.password）。这个 bug 真的出现过。

import { test } from "node:test";
import assert from "node:assert/strict";
import { formDataKey, secretInputType, SECRET_IGNORE_ATTRS } from "../src/utils/secretInput";

test("账号/密码框的别名 name 要映射回真实字段名", () => {
    assert.equal(formDataKey("site-account"), "username");
    assert.equal(formDataKey("site-secret"), "password");
});

test("其它字段原样返回，不能被误伤", () => {
    assert.equal(formDataKey("url"), "url");
    assert.equal(formDataKey("name"), "name");
    assert.equal(formDataKey("notes"), "notes");
});

test("点「显示密码」一定是 text（要看得见明文）", () => {
    assert.equal(secretInputType(true), "text");
});

test("不支持 CSS 遮蔽的浏览器（Firefox）回退成 password，不能裸奔明文", () => {
    // Node 里没有 CSS 全局对象，正好等价于 Firefox 那条分支
    assert.equal(typeof CSS, "undefined");
    assert.equal(secretInputType(false), "password");
});

test("第三方密码管理器的忽略标记要带上", () => {
    assert.equal(SECRET_IGNORE_ATTRS["data-lpignore"], "true");
    assert.equal(SECRET_IGNORE_ATTRS["data-1p-ignore"], "true");
});
