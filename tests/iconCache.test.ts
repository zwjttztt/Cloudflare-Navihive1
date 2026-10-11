// tests/iconCache.test.ts
// 第四章第 8 项「图标」的验收（审查报告原文）：
//   「已有 iconCache，下一步评估 TTL、失败负缓存、object URL 释放、CDN/代理缓存
//     而不是再造一份缓存。第三方图标请求泄露访问域名，应给隐私模式。」
//
// node 里没有 IndexedDB，走的是模块的内存兜底分支 —— 正好用来验「记事会不会过期」
// 和「objectURL 借了有没有还」这两件事（它们本来就都在内存分支上）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    ICON_FAIL_TTL,
    ICON_OK_TTL,
    acquireIconObjectUrl,
    iconCandidates,
    iconFallbackCandidates,
    isIconRecordFresh,
    readIconObjectUrl,
    readIconRecord,
    releaseIconObjectUrl,
    setIconObjectUrlFactoryForTest,
    writeIconRecord,
} from "../src/utils/iconCache";

/** 假 blob：这里只关心「有没有被交给 createObjectURL」，不需要真的字节 */
const fakeBlob = () => ({ size: 8, type: "image/png" }) as unknown as Blob;

/**
 * 把 objectURL 的创建 / 释放换成计数器。
 * node 没有真的 Blob URL，用计数就能看清「建了几个、撤了几个」。
 */
function installObjectUrlSpy(): { created: string[]; revoked: string[] } {
    const created: string[] = [];
    const revoked: string[] = [];
    let seq = 0;
    setIconObjectUrlFactoryForTest(() => {
        const url = `blob:test/${++seq}`;
        created.push(url);
        return url;
    });
    const holder = globalThis as unknown as {
        URL: { revokeObjectURL?: (u: string) => void } & Record<string, unknown>;
    };
    holder.URL.revokeObjectURL = (u: string) => {
        revoked.push(u);
    };
    return { created, revoked };
}

// ============ TTL：记事不能一条写到老 ============

test("成功记事：7 天内算数，到期当作没记过（站点换了图标能被看到）", async () => {
    const url = "https://icon.test/ok-a.png";
    await writeIconRecord(url, true);

    const fresh = await readIconRecord(url);
    assert.equal(fresh?.ok, true, "刚记下的应当算数");

    // 越过保质期再读：应当当作没记过，好让卡片重新走一次网络
    const stale = await readIconRecord(url, Date.now() + ICON_OK_TTL + 1);
    assert.equal(stale, null, "过期的成功记事必须失效，否则新图标永远看不到");
});

test("失败记事：24 小时内跳过（负缓存生效），到期给一次机会", async () => {
    const url = "https://icon.test/fail-a.png";
    await writeIconRecord(url, false);

    const now = await readIconRecord(url);
    assert.equal(now?.ok, false, "刚失败过的源这会儿应当被跳过");

    // 负缓存比成功那条短：一天后就该重新试一次，站点装上 favicon 时图标能回来
    assert.ok(
        ICON_FAIL_TTL < ICON_OK_TTL,
        "失败记事的保质期必须比成功的短 —— 一次失败不该判终身出局"
    );
    const later = await readIconRecord(url, Date.now() + ICON_FAIL_TTL + 1);
    assert.equal(later, null, "过期后的失败记事必须作废，给站点一次机会");
});

test("isIconRecordFresh：空记录不算数，过期一律作废", () => {
    assert.equal(isIconRecordFresh(null), false);
    assert.equal(isIconRecordFresh({ ok: true, ts: Date.now() }), true);
    assert.equal(isIconRecordFresh({ ok: false, ts: Date.now() }), true);
    assert.equal(isIconRecordFresh({ ok: false, ts: Date.now() - ICON_FAIL_TTL - 1 }), false);
    assert.equal(isIconRecordFresh({ ok: true, ts: Date.now() - ICON_OK_TTL - 1 }), false);
});

// ============ 第三方图标一律过本站代理 ============
// 隐私模式下 SiteCard 干脆不给候选（组件里 iconPrivacy 时 primaryIcons = []），
// 这里保证「默认路径下也没有任何一个候选是直连第三方的」。

test("图标候选与兜底源都不直连第三方（统一走 /api/icon 代理）", () => {
    const site = { icon: "https://cdn.example/logo.png", url: "https://example.com" };

    const normal = iconCandidates(site, "");
    assert.ok(normal.length > 0, "默认应当有候选源");
    assert.ok(
        normal.every(u => u.startsWith("/api/icon?u=")),
        `第三方图标一律走本站代理，实际 ${JSON.stringify(normal)}`
    );

    const fallback = iconFallbackCandidates(site);
    assert.ok(fallback.length > 0, "兜底源也应当存在");
    assert.ok(
        fallback.every(u => u.startsWith("/api/icon?u=")),
        `兜底源同样要过代理，实际 ${JSON.stringify(fallback)}`
    );
});

// ============ objectURL：借了必须还 ============

test("同一个图标地址只建一个 objectURL，重复借还不会提前撤掉", () => {
    const spy = installObjectUrlSpy();
    const url = "https://icon.test/pool-a.png";

    const first = acquireIconObjectUrl(url, fakeBlob());
    const second = acquireIconObjectUrl(url, fakeBlob());
    assert.equal(first, second, "同一个地址该复用同一个 objectURL");
    assert.equal(spy.created.length, 1, `只应创建一次，实际 ${spy.created.length} 次`);

    // 还一次还有人在用，不能撤 —— 撤了 <img> 会变成裂图
    releaseIconObjectUrl(url);
    assert.equal(spy.revoked.length, 0, "还有引用时不该 revoke");

    releaseIconObjectUrl(url);
    assert.equal(spy.revoked.length, 0, "刚归零也不急着撤：卡片来回切换时会马上再借");
});

test("没借过就还 / 多还几次都不该抛错（组件卸载顺序不保证）", () => {
    const spy = installObjectUrlSpy();
    releaseIconObjectUrl("https://icon.test/never-borrowed.png");
    releaseIconObjectUrl("https://icon.test/never-borrowed.png");
    assert.equal(spy.created.length, 0, "还回没借过的 URL 不该触发新的 objectURL 创建");
    assert.equal(spy.revoked.length, 0, "没借过就没有引用计数，不该 revoke 任何 URL");
});

test("空闲的 objectURL 攒太多会按最久没用的撤掉（不会无限涨）", () => {
    const spy = installObjectUrlSpy();
    const base = "https://icon.test/lru-";

    // 每张借一次就还，全部进入空闲池
    const urls: string[] = [];
    for (let i = 0; i < 160; i++) {
        const key = `${base}${i}.png`;
        urls.push(acquireIconObjectUrl(key, fakeBlob()));
        releaseIconObjectUrl(key);
    }
    assert.equal(spy.created.length, 160, "每张各建一次");
    assert.ok(
        spy.revoked.length > 0,
        "空闲数超过上限后必须开始回收，否则长会话里这些 blob 会一直占着内存"
    );
    const revokedSet = new Set(spy.revoked);
    // 被撤掉的应当是最早那批，最近用过的要留着
    assert.ok(revokedSet.has(urls[0]), "最久没用的那张该被撤掉");
    assert.ok(!revokedSet.has(urls[159]), "刚用过的那张不该被撤掉");
    assert.equal(
        spy.created.length - spy.revoked.length <= 120,
        true,
        `空闲池应收敛到上限以内，实际留了 ${spy.created.length - spy.revoked.length} 个`
    );
});

test("撤掉之后再借会重新建一个（不会拿已经失效的 URL 去渲染）", () => {
    const spy = installObjectUrlSpy();
    const key = "https://icon.test/revived.png";

    const first = acquireIconObjectUrl(key, fakeBlob());
    releaseIconObjectUrl(key);
    // 用一批新图标把它挤出去
    for (let i = 0; i < 160; i++) {
        const other = `https://icon.test/evict-${i}.png`;
        acquireIconObjectUrl(other, fakeBlob());
        releaseIconObjectUrl(other);
    }
    const revived = acquireIconObjectUrl(key, fakeBlob());
    assert.notEqual(revived, first, "被回收过的地址要重新建 URL");
    assert.ok(spy.revoked.includes(first), "旧的那张确实被撤掉了");
});

test("IndexedDB 不可用时读图标本体返回 null（调用方继续用原地址）", async () => {
    installObjectUrlSpy();
    const got = await readIconObjectUrl("https://icon.test/no-idb.png");
    assert.equal(got, null, "拿不到本地副本就该回退到网络地址，而不是返回一个坏 URL");
});
