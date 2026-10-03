// tests/accountScope.test.ts
// 浏览器本地数据（离线队列 / 撤销快照 / 偏好）的账号边界。
//
// 这里最要紧的一条是**换人的判定**：A 登出、B 登入之后，如果 setActiveAccount 没有
// 如实报告「换人了」，调用方就不会清内存，A 的待同步操作会在 B 的会话里被重放 ——
// 把一个人的编辑写进另一个人的账号。所以 `prev !== uid` 的返回值必须钉死，
// 尤其是 uid 为 0 这种 falsy 但不能当成「没账号」的边界。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    scopedKey,
    readActiveAccount,
    setActiveAccount,
    clearActiveAccount,
} from "../src/utils/accountScope";

/**
 * 内存版 localStorage。node 环境没有 DOM，accountScope 只用到 get / set / remove 三个方法。
 * `throwOnWrite` 用来模拟隐私模式（setItem 直接抛），验证降级路径不会把异常抛给调用方。
 */
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

test("scopedKey: 没账号归到 anon，有账号带 u 前缀", () => {
    assert.equal(scopedKey("navihive:queue", null), "navihive:queue:anon");
    assert.equal(scopedKey("navihive:queue", 7), "navihive:queue:u7");
});

test("scopedKey: uid 为 0 是合法账号，不能当成没登录", () => {
    // 写成 `!uid ? anon : ...` 就会掉进这个坑：0 会被判成匿名档，
    // 于是 id=0 的账号和匿名时期共用一份存储。
    assert.equal(scopedKey("navihive:undo", 0), "navihive:undo:u0");
});

test("readActiveAccount: 没记录过 / 空串 / 非数字一律当没账号", () => {
    installStorage();
    assert.equal(readActiveAccount(), null);

    const map = installStorage();
    map.set("navihive:activeAccount", "");
    assert.equal(readActiveAccount(), null);

    map.set("navihive:activeAccount", "abc");
    assert.equal(readActiveAccount(), null);
});

test("readActiveAccount: 小数与超安全整数范围的值不算账号 id", () => {
    const map = installStorage();
    map.set("navihive:activeAccount", "1.5");
    assert.equal(readActiveAccount(), null);

    map.set("navihive:activeAccount", "9007199254740992");
    assert.equal(readActiveAccount(), null);
});

test("readActiveAccount: 正常数字读回来", () => {
    const map = installStorage();
    map.set("navihive:activeAccount", "12");
    assert.equal(readActiveAccount(), 12);
    map.set("navihive:activeAccount", "0");
    assert.equal(readActiveAccount(), 0);
});

test("setActiveAccount: 第一次落账号算换人，同一个账号再设一次不算", () => {
    const map = installStorage();
    assert.equal(setActiveAccount(7), true);
    assert.equal(map.get("navihive:activeAccount"), "7");
    assert.equal(setActiveAccount(7), false);
});

test("setActiveAccount: A 换成 B 必须报告换人（否则 A 的队列会在 B 的会话里重放）", () => {
    installStorage();
    setActiveAccount(1);
    assert.equal(setActiveAccount(2), true);
});

test("setActiveAccount: 登出（传 null）也算换人，落盘值是空串", () => {
    const map = installStorage();
    setActiveAccount(3);
    assert.equal(setActiveAccount(null), true);
    assert.equal(map.get("navihive:activeAccount"), "");
    assert.equal(readActiveAccount(), null);
});

test("setActiveAccount: 隐私模式写不进去也不抛，返回值照样按 prev !== uid 算", () => {
    installStorage(true);
    assert.doesNotThrow(() => setActiveAccount(5));
    // 写失败了，下一次读还是 null，所以「从无到有」依旧判断为换人
    assert.equal(setActiveAccount(5), true);
});

test("clearActiveAccount: 清掉之后读不到账号", () => {
    const map = installStorage();
    setActiveAccount(9);
    clearActiveAccount();
    assert.equal(map.has("navihive:activeAccount"), false);
    assert.equal(readActiveAccount(), null);
});

test("存储完全不可用时读不会抛", () => {
    uninstallStorage();
    assert.equal(readActiveAccount(), null);
    assert.doesNotThrow(() => clearActiveAccount());
});
