// tests/rememberedLogin.test.ts
// 「记住登录名」只记账号名，密码一律不落盘（持续登录靠服务端 HttpOnly Cookie）。
//
// 安全关键的一条是**旧版本曾经把密码一起存进去过**：早先的实现存的是
// { username, password }，后来才改。所以读的时候必须顺手把历史记录里的密码字段洗掉，
// 否则旧数据会一直躺在本机存储里 —— 升级了代码，脏数据却没清。这两条用例钉的就是它。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    readRememberedLogin,
    saveRememberedLogin,
    clearRememberedLogin,
} from "../src/utils/rememberedLogin";

const STORAGE_KEY = "navihive:rememberedLogin";

/** 内存版 localStorage；`throwOnWrite` 模拟隐私模式 */
function installStorage(throwOnWrite = false): Map<string, string> {
    const map = new Map<string, string>();
    const stub = {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => {
            if (throwOnWrite) throw new Error("QuotaExceededError");
            map.set(k, v);
        },
        removeItem: (k: string) => {
            map.delete(k);
        },
        clear: () => map.clear(),
        key: () => null,
        length: 0,
    } as unknown as Storage;
    Object.defineProperty(globalThis, "localStorage", {
        value: stub,
        configurable: true,
        writable: true,
    });
    return map;
}

function uninstallStorage(): void {
    delete (globalThis as { localStorage?: Storage }).localStorage;
}

afterEach(() => {
    uninstallStorage();
});

test("没记录过时读到 null", () => {
    installStorage();
    assert.equal(readRememberedLogin(), null);
});

test("只带回 username", () => {
    const map = installStorage();
    map.set(STORAGE_KEY, JSON.stringify({ username: "admin" }));
    assert.deepEqual(readRememberedLogin(), { username: "admin" });
});

test("旧版记录里的密码会被洗掉，且落盘内容同步改写", () => {
    const map = installStorage();
    map.set(STORAGE_KEY, JSON.stringify({ username: "admin", password: "hunter2" }));

    assert.deepEqual(readRememberedLogin(), { username: "admin" });

    const rewritten = JSON.parse(map.get(STORAGE_KEY)!) as Record<string, unknown>;
    assert.equal("password" in rewritten, false, "读完之后本机存储里不该再留着密码");
    assert.equal(map.get(STORAGE_KEY)!.includes("hunter2"), false);
});

test("坏 JSON / 结构不对的记录会被清掉而不是留着", () => {
    const map = installStorage();
    for (const raw of ["{oops", "null", "[]", "\"admin\"", "{}", JSON.stringify({ user: "admin" })]) {
        map.set(STORAGE_KEY, raw);
        assert.equal(readRememberedLogin(), null, `这段不该被接受：${raw}`);
        assert.equal(map.has(STORAGE_KEY), false, `读不出来就该顺手删掉：${raw}`);
    }
});

test("username 不是字符串时不接受", () => {
    const map = installStorage();
    map.set(STORAGE_KEY, JSON.stringify({ username: 123 }));
    assert.equal(readRememberedLogin(), null);
});

test("保存时只写 username，多传的字段不会落盘", () => {
    const map = installStorage();
    saveRememberedLogin({ username: "admin", password: "hunter2" } as never);
    const saved = JSON.parse(map.get(STORAGE_KEY)!) as Record<string, unknown>;
    assert.deepEqual(saved, { username: "admin" });
});

test("clear 之后读不到", () => {
    const map = installStorage();
    saveRememberedLogin({ username: "admin" });
    clearRememberedLogin();
    assert.equal(map.has(STORAGE_KEY), false);
    assert.equal(readRememberedLogin(), null);
});

test("隐私模式下读写都不抛", () => {
    installStorage(true);
    assert.doesNotThrow(() => saveRememberedLogin({ username: "admin" }));
    assert.doesNotThrow(() => clearRememberedLogin());
});

test("完全拿不到存储时不抛（业务代码写的是裸 localStorage）", () => {
    uninstallStorage();
    assert.equal(readRememberedLogin(), null);
    assert.doesNotThrow(() => saveRememberedLogin({ username: "admin" }));
    assert.doesNotThrow(() => clearRememberedLogin());
});
