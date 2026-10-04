// tests/localAppData.test.ts
// 「本机数据里哪些是本站的」以及「怎么清」。
//
// 两条不能动的规矩：
// 1. clearLocalAppData 是**不可逆**的（设置里那个「清空本机数据」就走它）。列出哪些
//    key 属于本站的规则一旦写错，要么是用户以为清干净了其实没清（坏数据还在，
//    排障时最折磨人），要么是误删了别的键。
// 2. auth_token **不能**被当成普通本机数据对待 —— 它曾经是登录票据，虽然现在已经改用
//    httpOnly cookie、旧值会在启动时清掉，但把它列进「本机数据清单」就等于让它有机会
//    被原样上报进错误报告。这条在 listLocalAppKeys 的注释里写着，测试替它盯着。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

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

const { clearLocalAppData, listLocalAppKeys } = await import("../src/utils/localAppData");

const set = (k: string, v: string) => localStorage.setItem(k, v);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

// ---------- 清单 ----------

test("带 navihive: 前缀的都算本站数据", () => {
    set("navihive:deadLinks", "{}");
    set("navihive:starred", "[]");
    assert.deepEqual(listLocalAppKeys().sort(), ["navihive:deadLinks", "navihive:starred"]);
});

test("几个没有前缀但也是本机状态的 key 也要算进来", () => {
    for (const k of ["theme", "collapsedGroups", "rememberedLogin"]) set(k, "x");
    const keys = listLocalAppKeys();
    for (const k of ["theme", "collapsedGroups", "rememberedLogin"]) {
        assert.ok(keys.includes(k), `${k} 是本机状态，漏了就清不干净`);
    }
});

test("别的网站的 key 不能碰", () => {
    set("otherapp:settings", "1");
    set("theme", "dark"); // 这个算我们的
    assert.deepEqual(listLocalAppKeys(), ["theme"]);
});

test("auth_token 不进清单 —— 它不能被当普通本机数据上报出去", () => {
    set("auth_token", "eyJhbGciOi...");
    set("navihive:deadLinks", "{}");
    assert.ok(
        !listLocalAppKeys().includes("auth_token"),
        "登录票据一旦进了清单，就有机会被原样带进错误报告"
    );
});

test("没存过的 key 不出现在清单里（按存在性判断，不是照抄固定名单）", () => {
    set("navihive:deadLinks", "{}");
    assert.deepEqual(listLocalAppKeys(), ["navihive:deadLinks"]);
});

test("同一把 key 只列一次", () => {
    set("theme", "dark");
    set("navihive:theme", "dark"); // 前缀不同，是两把
    assert.equal(listLocalAppKeys().filter(k => k === "theme").length, 1);
});

// ---------- 清理 ----------

test("清空后本站数据一个不剩", () => {
    set("navihive:deadLinks", "{}");
    set("navihive:starred", "[1,2]");
    set("theme", "dark");
    clearLocalAppData(true);
    assert.deepEqual(listLocalAppKeys(), []);
});

test("清空不碰别的网站的数据", () => {
    set("otherapp:settings", "1");
    clearLocalAppData(true);
    assert.equal(localStorage.getItem("otherapp:settings"), "1");
});

test("不开 includeAuth 时，登录票据要留着", () => {
    set("navihive:deadLinks", "{}");
    set("auth_token", "keep-me");
    clearLocalAppData(false);
    assert.equal(localStorage.getItem("auth_token"), "keep-me");
    assert.equal(localStorage.getItem("navihive:deadLinks"), null, "其它本机数据照清");
});

test("顺手清掉会话级的首屏缓存，否则重载后又拿到同一份坏数据", () => {
    sessionStorage.setItem("navihive:bootstrap", '{"groups":[]}');
    clearLocalAppData(true);
    assert.equal(sessionStorage.getItem("navihive:bootstrap"), null);
});

test("隐私模式下 localStorage 写不进去也不该炸（只吞掉写入错误）", () => {
    set("navihive:deadLinks", "{}");
    const real = localStorage.removeItem;
    // 模拟 Safari 无痕模式：removeItem 会抛
    (localStorage as { removeItem: (k: string) => void }).removeItem = () => {
        throw new Error("SecurityError");
    };
    try {
        assert.doesNotThrow(() => clearLocalAppData(true));
    } finally {
        (localStorage as { removeItem: (k: string) => void }).removeItem = real;
    }
});

test("rememberedLogin 只在 includeAuth 时才清", () => {
    // 错误边界上那两个按钮（「清缓存重载」/「清缓存含登录重载」）就是靠这个参数
    // 区分的。参数要是没作用，两个按钮就长得不一样、干的事却一模一样。
    set("rememberedLogin", "admin");
    clearLocalAppData(false);
    assert.equal(
        localStorage.getItem("rememberedLogin"),
        "admin",
        "只是清缓存不该顺手把「记住登录」也清了"
    );
    clearLocalAppData(true);
    assert.equal(localStorage.getItem("rememberedLogin"), null);
});

test("auth_token 不在清单里，所以两种模式都删不到它", () => {
    // 令牌早已改用 httpOnly cookie，localStorage 里那份是历史遗留、由启动时的清理
    // 逻辑负责。clearLocalAppData 里那段 `if (!includeAuth && k === "auth_token")`
    // 是纯防御：清单里根本不会出现它。留着是怕哪天又有人把它加回清单。
    set("auth_token", "tok");
    set("navihive:deadLinks", "{}");
    assert.ok(!listLocalAppKeys().includes("auth_token"));
    clearLocalAppData(true);
    clearLocalAppData(false);
    assert.equal(localStorage.getItem("auth_token"), "tok");
});
