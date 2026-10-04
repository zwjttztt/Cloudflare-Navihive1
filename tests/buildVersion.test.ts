// tests/buildVersion.test.ts
// 「我这一版是不是旧的」这个判断本身。
//
// 它守的是一类**没有任何报错**的故障：Service Worker 把上一版的 HTML 外壳喂给浏览器，
// 页面照常起来，一点开懒加载弹窗才 404（旧版引用的 chunk 在新版里已经删了）。
// 判断写反的后果有两种，都很难发现：
//   - 该刷的时候不刷（比较反了 / 版本号读不出来就算过期）：故障照旧，页面停在旧版；
//   - 不该刷的时候刷（两边永远不相等）：每次打开都重载一次，用户以为网站抽风。
// 所以「读不出来 → 不动作」和「相等 → 不动作」这两条都得钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    localBuildVersion,
    readServerVersion,
    isStaleBuild,
    fetchServerVersion,
    PRECACHE_MANIFEST_URL,
} from "../src/utils/buildVersion";

// ---------------- 本机版本号 ----------------

test("单测环境没有 define，本机版本号是空串（空串 = 不参与判断）", () => {
    assert.equal(localBuildVersion(), "");
});

// ---------------- 读服务端版本号 ----------------

test("清单里的字符串版本号照读", () => {
    assert.equal(readServerVersion({ version: "1696000000000" }), "1696000000000");
});

test("老清单里 version 是数字也认，转成字符串好比较", () => {
    assert.equal(readServerVersion({ version: 1696000000000 }), "1696000000000");
});

test("前后空白要去掉：比对时 ' 1 ' 与 '1' 是同一版", () => {
    assert.equal(readServerVersion({ version: " 1696000000000 " }), "1696000000000");
});

test("空串 / 纯空白不算版本号 —— 那是清单坏了，不能拿它去刷页面", () => {
    assert.equal(readServerVersion({ version: "" }), null);
    assert.equal(readServerVersion({ version: "   " }), null);
});

test("version 缺失或类型不对一律 null", () => {
    assert.equal(readServerVersion({ core: [], lazy: [] }), null);
    assert.equal(readServerVersion({ version: null }), null);
    assert.equal(readServerVersion({ version: { a: 1 } }), null);
    assert.equal(readServerVersion({ version: Number.NaN }), null);
});

test("payload 本身不是对象也一律 null（坏 JSON 解析出来可能是字符串/数组）", () => {
    assert.equal(readServerVersion(null), null);
    assert.equal(readServerVersion(undefined), null);
    assert.equal(readServerVersion("not json"), null);
    assert.equal(readServerVersion([1, 2]), null);
});

// ---------------- 是否过期 ----------------

test("两边一致：没过期，什么都不做", () => {
    assert.equal(isStaleBuild("1696000000000", "1696000000000"), false);
});

test("落后于服务端：过期 —— 这正是要自愈的那种情况", () => {
    assert.equal(isStaleBuild("1696000000000", "1696100000000"), true);
});

test("领先于服务端（服务端回滚了）也算过期：页面上的块和服务端的同样不是一套", () => {
    assert.equal(isStaleBuild("1696100000000", "1696000000000"), true);
});

test("任一边拿不到就不算过期：不确定时宁可不刷", () => {
    assert.equal(isStaleBuild("", "1696100000000"), false);
    assert.equal(isStaleBuild("1696000000000", null), false);
    assert.equal(isStaleBuild("", null), false);
});

// ---------------- 拉清单 ----------------

const jsonResponse = (status: number, body: string) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(body),
    }) as unknown as Response;

test("清单正常：拿到版本号", async () => {
    const impl = async () => jsonResponse(200, '{"version":"v1","core":[],"lazy":[]}');
    assert.equal(await fetchServerVersion(impl), "v1");
});

test("清单 404（老部署上还没这个文件）：返回 null 而不是抛", async () => {
    const impl = async () => jsonResponse(404, "Not Found");
    assert.equal(await fetchServerVersion(impl), null);
});

test("网络不通（fetch 直接抛）：返回 null", async () => {
    const impl = async (): Promise<Response> => {
        throw new TypeError("Failed to fetch");
    };
    assert.equal(await fetchServerVersion(impl), null);
});

test("响应体不是 JSON（网关/登录页被当成清单返回了）：返回 null 而不是抛", async () => {
    const impl = async () => jsonResponse(200, "<html>网关错误</html>");
    assert.equal(await fetchServerVersion(impl), null);
});

test("默认拉的是预缓存清单那一份（跟 Service Worker 读的必须是同一个文件）", () => {
    assert.equal(PRECACHE_MANIFEST_URL, "/precache-manifest.json");
});
