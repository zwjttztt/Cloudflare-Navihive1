// src/utils/firstPaintCache.ts 的直测。
//
// 这个文件唯一值得钉的就是那条约束：**快照里不能留明文凭据**。
// 它写在注释里（「没必要也不该把一份明文凭据留在 sessionStorage」），
// 但没有任何用例守着 —— 哪天有人为了「复制密码开箱可用」把 stripCredentials 拿掉，
// 界面完全正常、白屏也没变长，只是全站密码开始往 sessionStorage 里躺，
// 同源 JS 和恶意扩展一伸手就能拿到。
//
// 其余用例是顺带把「什么时候该用缓存」的边界钉住（7 天过期 / 2000 站点上限 /
// 坏 JSON / 配额异常），这些错了不会报红，只会表现为「白屏反而更久」或「读到旧数据」。

import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapData, Site } from "../src/API/types";

// 纯函数用例的环境里只有 localStorage 替身，sessionStorage 得自己补一个
const store = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
    },
});

const { readBootstrapCache, writeBootstrapCache, clearBootstrapCache } = await import(
    "../src/utils/firstPaintCache"
);

const site = (over: Partial<Site> = {}): Site => ({
    group_id: 1,
    name: "示例",
    url: "https://example.com",
    icon: "",
    description: "",
    notes: "",
    order_num: 0,
    ...over,
});

const data = (sites: Site[] = []): BootstrapData => ({
    groups: [{ id: 1, name: "分组", order_num: 0 } as never],
    sites,
    configs: {},
});

test.beforeEach(() => {
    store.clear();
});

// ---------------- 核心：快照里不许有明文凭据 ----------------

test("写进 sessionStorage 的快照里，站点账号密码是空的", () => {
    writeBootstrapCache(
        data([
            site({ id: 1, username: "admin", password: "hunter2" }),
            site({ id: 2, username: "u2", password: "p2" }),
        ])
    );
    const raw = store.get("navihive:bootstrap-cache") ?? "";
    assert.ok(raw, "没写进缓存，这条断言就没意义了");
    assert.ok(!raw.includes("hunter2"), "明文密码进了 sessionStorage");
    assert.ok(!raw.includes("admin"), "明文账号进了 sessionStorage");
    assert.ok(!raw.includes("p2"));
});

test("读回来的快照：凭据是空串，其余字段照旧", () => {
    writeBootstrapCache(data([site({ id: 1, username: "admin", password: "hunter2", name: "保管库" })]));
    const cached = readBootstrapCache();
    assert.ok(cached);
    assert.equal(cached!.sites[0].username, "");
    assert.equal(cached!.sites[0].password, "");
    assert.equal(cached!.sites[0].name, "保管库", "非凭据字段不能被动到");
    assert.equal(cached!.sites[0].url, "https://example.com");
});

test("剔凭据不能改到原对象（否则界面上正在显示的密码会跟着消失）", () => {
    const original = data([site({ id: 1, username: "admin", password: "hunter2" })]);
    writeBootstrapCache(original);
    assert.equal(original.sites[0].password, "hunter2", "写缓存不该动到传入的对象");
    assert.equal(original.sites[0].username, "admin");
});

// ---------------- 什么时候该用缓存 ----------------

test("基本往返：写进去能原样读回来", () => {
    const input = data([site({ id: 1, name: "a" }), site({ id: 2, name: "b" })]);
    writeBootstrapCache(input);
    const cached = readBootstrapCache();
    assert.equal(cached?.sites.length, 2);
    assert.deepEqual(
        cached?.sites.map(s => s.name),
        ["a", "b"]
    );
    assert.equal(cached?.groups.length, 1);
});

test("超过 7 天的快照不再使用", () => {
    writeBootstrapCache(data([site()]));
    // 直接把时间戳往回拨 8 天
    const parsed = JSON.parse(store.get("navihive:bootstrap-cache")!);
    parsed.ts = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store.set("navihive:bootstrap-cache", JSON.stringify(parsed));
    assert.equal(readBootstrapCache(), null);
});

test("站点数超过 2000 的不写（免得 sessionStorage 被撑爆）", () => {
    const many = Array.from({ length: 2001 }, (_, i) => site({ id: i }));
    writeBootstrapCache(data(many));
    assert.equal(store.has("navihive:bootstrap-cache"), false, "超限时不该写");
});

test("刚好 2000 个站点要写（上限是「不超过」，别把边界那一户也挡掉）", () => {
    const many = Array.from({ length: 2000 }, (_, i) => site({ id: i }));
    writeBootstrapCache(data(many));
    assert.equal(readBootstrapCache()?.sites.length, 2000);
});

test("结构不完整的快照不用（缺 groups / sites 数组）", () => {
    store.set("navihive:bootstrap-cache", JSON.stringify({ ts: Date.now(), data: { configs: {} } }));
    assert.equal(readBootstrapCache(), null);
    store.set("navihive:bootstrap-cache", JSON.stringify({ ts: Date.now(), data: { groups: [], sites: {} } }));
    assert.equal(readBootstrapCache(), null);
});

// 这两条是「只校验存在、不校验是不是数组」的陷阱：字符串也有 .length，
// 光看 length <= 上限 会放行。而消费方直接 data.sites.map(...) ——
// 一旦缓存被别的东西写脏，首屏就白屏（连报错都在渲染最开始那一帧）。
test("sites 不是数组时判为不可用（字符串也有 length，别被蒙过去）", () => {
    store.set(
        "navihive:bootstrap-cache",
        JSON.stringify({ ts: Date.now(), data: { groups: [], sites: "abc" } })
    );
    assert.equal(readBootstrapCache(), null);
});

test("groups 不是数组时同样不可用", () => {
    store.set(
        "navihive:bootstrap-cache",
        JSON.stringify({ ts: Date.now(), data: { groups: "abc", sites: [] } })
    );
    assert.equal(readBootstrapCache(), null);
});

test("坏 JSON / 空值不抛异常，返回 null", () => {
    store.set("navihive:bootstrap-cache", "{不是 JSON");
    assert.equal(readBootstrapCache(), null);
    store.set("navihive:bootstrap-cache", "null");
    assert.equal(readBootstrapCache(), null);
});

test("没有缓存时返回 null", () => {
    assert.equal(readBootstrapCache(), null);
});

test("clearBootstrapCache 之后读不到东西", () => {
    writeBootstrapCache(data([site()]));
    clearBootstrapCache();
    assert.equal(readBootstrapCache(), null);
});

test("sessionStorage 不可用时（隐私模式/配额）静默跳过，不抛", () => {
    const real = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
            throw new Error("SecurityError: storage is disabled");
        },
    });
    try {
        writeBootstrapCache(data([site()]));
        assert.equal(readBootstrapCache(), null);
        clearBootstrapCache();
    } finally {
        Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: real });
    }
});
