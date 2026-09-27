// tests/siteView.test.ts
// 分组视图派生逻辑的单测。这段原在 App.tsx 里（4000+ 行里最容易被改坏、又最难测的一块），
// 抽成纯函数后这里就能钉死行为。关键点：关掉「最近访问」或它没内容时，必须原样退回
// 原始分组，不能凭空塞一个空分组进去。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
import { buildFavoritesGroup, deriveDisplayedGroups, type VisitStat } from "../src/utils/siteView";

const site = (id: number, name: string, extra: Partial<Site> = {}): Site =>
    ({ id, name, url: `https://s${id}.com`, group_id: 1, order_num: id, ...extra } as Site);

const group = (id: number, sites: Site[]): GroupWithSites => ({
    id,
    name: `g${id}`,
    order_num: id,
    sites,
});

test("buildFavoritesGroup：按访问次数取前 N 个，且标记为虚拟分组", () => {
    const visits: Record<string, VisitStat | undefined> = {
        "1": { count: 5, last: Date.now() },
        "2": { count: 2, last: Date.now() },
        "3": { count: 9, last: Date.now() },
        "4": { count: 0, last: Date.now() }, // 没访问过，不该进
    };
    const groups = [group(1, [site(1, "A"), site(2, "B"), site(3, "C"), site(4, "D")])];
    const fav = buildFavoritesGroup(groups, visits);
    assert.equal(fav.id, -1);
    assert.equal(fav.name, "最近访问");
    // 按次数降序：3(9) > 1(5) > 2(2)，4 没访问过被过滤
    assert.deepEqual(fav.sites.map(s => s.id), [3, 1, 2]);
});

test("buildFavoritesGroup：没人访问时返回空 sites 的虚拟分组（不是 null）", () => {
    const groups = [group(1, [site(1, "A")])];
    const fav = buildFavoritesGroup(groups, {});
    assert.equal(fav.id, -1);
    assert.equal(fav.sites.length, 0);
});

test("deriveDisplayedGroups：关掉「最近访问」时原样退回原始分组", () => {
    const render = [group(1, [site(1, "A")])];
    const fav = group(-1, [site(9, "Fav")]);
    const out = deriveDisplayedGroups(render, false, fav, "", () => true, false);
    assert.equal(out, render); // 同一个引用，没新建数组
});

test("deriveDisplayedGroups：最近访问为空时原样退回", () => {
    const render = [group(1, [site(1, "A")])];
    const fav = group(-1, []);
    const out = deriveDisplayedGroups(render, true, fav, "", () => true, false);
    assert.equal(out, render);
});

test("deriveDisplayedGroups：开启且有内容时，把命中筛选的最近访问置前", () => {
    const render = [group(1, [site(1, "A")]), group(2, [site(2, "B")])];
    const fav = group(-1, [site(9, "Fav")]);
    const out = deriveDisplayedGroups(render, true, fav, "", () => true, false);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, -1); // 虚拟分组在最前
    assert.deepEqual(out.slice(1).map(g => g.id), [1, 2]);
});

test("deriveDisplayedGroups：当前搜索词不过滤掉所有最近访问时，分组退回原始", () => {
    const render = [group(1, [site(1, "Apple")])];
    // 虚拟分组里的站点名字匹配不到搜索词「zzz」→ 过滤后为空 → 退回原始
    const fav = group(-1, [site(9, "Fav9")]);
    const out = deriveDisplayedGroups(render, true, fav, "zzz", () => true, false);
    assert.equal(out, render);
});
