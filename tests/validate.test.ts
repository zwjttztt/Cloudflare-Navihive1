// tests/validate.test.ts
// worker/validate.ts 单测：所有写路由的请求体校验
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    validateLogin,
    validateGroup,
    validateSite,
    validateConfig,
} from "../worker/validate";

// ============ validateLogin ============

test("validateLogin 接受合法的 username/password", () => {
    const r = validateLogin({ username: "alice", password: "secret123" });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
});

test("validateLogin 缺 username 报错", () => {
    const r = validateLogin({ username: "", password: "x" });
    assert.equal(r.valid, false);
    assert.ok(r.errors?.some((e) => /用户名/.test(e)));
});

test("validateLogin username 非字符串报错", () => {
    const r = validateLogin({ username: 123 as unknown as string, password: "x" });
    assert.equal(r.valid, false);
});

test("validateLogin 缺 password 报错", () => {
    const r = validateLogin({ username: "alice", password: "" });
    assert.equal(r.valid, false);
    assert.ok(r.errors?.some((e) => /密码/.test(e)));
});

// ============ validateGroup ============

test("validateGroup 接受合法数据", () => {
    const r = validateGroup({ name: "常用", order_num: 0 });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.name, "常用");
    assert.equal(r.sanitizedData?.order_num, 0);
});

test("validateGroup 名字 trim + 截断 100 字符", () => {
    const r = validateGroup({ name: "  " + "a".repeat(150) + "  ", order_num: 0 });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.name.length, 100);
    assert.equal(r.sanitizedData?.name.startsWith("a"), true);
});

test("validateGroup 名字为空报错", () => {
    const r = validateGroup({ name: "", order_num: 0 });
    assert.equal(r.valid, false);
});

test("validateGroup order_num 缺/非数字报错", () => {
    const r1 = validateGroup({ name: "x" });
    assert.equal(r1.valid, false);
    const r2 = validateGroup({ name: "x", order_num: "0" as unknown as number });
    assert.equal(r2.valid, false);
});

// ============ validateSite ============

test("validateSite 最小必填字段", () => {
    const r = validateSite({ group_id: 1, name: "Google", url: "https://google.com", order_num: 0 });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.name, "Google");
    assert.equal(r.sanitizedData?.url, "https://google.com");
    assert.equal(r.sanitizedData?.description, undefined);
});

test("validateSite URL 不合法报错", () => {
    const r = validateSite({ group_id: 1, name: "x", url: "not-a-url", order_num: 0 });
    assert.equal(r.valid, false);
    assert.ok(r.errors?.some((e) => /URL/.test(e)));
});

test("validateSite 描述/备注/账号/密码都被截断到各自上限", () => {
    const r = validateSite({
        group_id: 1,
        name: "x",
        url: "https://x.com",
        order_num: 0,
        description: "d".repeat(1000),
        notes: "n".repeat(2000),
        username: "u".repeat(500),
        password: "p".repeat(1000),
    });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.description?.length, 500);
    assert.equal(r.sanitizedData?.notes?.length, 1000);
    assert.equal(r.sanitizedData?.username?.length, 200);
    assert.equal(r.sanitizedData?.password?.length, 500);
});

test("validateSite 密码不做 trim（保留用户输入的前后空格）", () => {
    const r = validateSite({
        group_id: 1,
        name: "x",
        url: "https://x.com",
        order_num: 0,
        password: "  secret  ",
    });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.password, "  secret  ");
});

test("validateSite 图标 URL 不合法报错", () => {
    const r = validateSite({
        group_id: 1,
        name: "x",
        url: "https://x.com",
        order_num: 0,
        icon: "not-a-url",
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors?.some((e) => /图标URL/.test(e)));
});

test("validateSite icon 为空串合法", () => {
    const r = validateSite({
        group_id: 1,
        name: "x",
        url: "https://x.com",
        order_num: 0,
        icon: "",
    });
    assert.equal(r.valid, true);
    assert.equal(r.sanitizedData?.icon, "");
});

test("validateSite 多个字段同时报错都被收集", () => {
    const r = validateSite({ group_id: "x" as unknown as number, name: "", url: "bad", order_num: "y" as unknown as number });
    assert.equal(r.valid, false);
    assert.ok((r.errors?.length || 0) >= 3);
});

// ============ validateConfig ============

test("validateConfig 接受非空字符串", () => {
    const r = validateConfig({ key: "site.theme", value: "dark" });
    assert.equal(r.valid, true);
});

test("validateConfig value 为空报错", () => {
    const r = validateConfig({ key: "x", value: "" });
    assert.equal(r.valid, false);
});

test("validateConfig value 非字符串报错", () => {
    const r = validateConfig({ key: "x", value: 123 as unknown as string });
    assert.equal(r.valid, false);
});