// tests/siteView.test.ts
// 分组视图派生逻辑的单测。这段原在 App.tsx 里（4000+ 行里最容易被改坏、又最难测的一块），
// 抽成纯函数后这里就能钉死行为。关键点：关掉「最近访问」或它没内容时，必须原样退回
// 原始分组，不能凭空塞一个空分组进去。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
import { buildFavoritesGroup, deriveDisplayedGroups, truncateSearchGroups, type VisitStat } from "../src/utils/siteView";

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

// ---- truncateSearchGroups：搜索结果的渲染上限 ----
// 这里钉的是「全局额度必须真的生效」：以前只按每组 24 条截，
// 五个分组各命中 24 条就会渲染 120 张卡片，60 的上限等于没写。

const many = (gid: number, n: number) =>
    group(
        gid,
        Array.from({ length: n }, (_, i) => site(gid * 100 + i, `s${gid}-${i}`))
    );

const countSites = (groups: GroupWithSites[]) =>
    groups.reduce((sum, g) => sum + g.sites.length, 0);

test("truncateSearchGroups：全局额度真的封顶（多分组各命中也不会超）", () => {
    // 五个分组各 24 条：各组都没超过 perGroup，但总数 120 远超总额度 60
    const input = [1, 2, 3, 4, 5].map(id => many(id, 24));
    const out = truncateSearchGroups(input, 60, 24, false);
    assert.equal(countSites(out), 60);
});

test("truncateSearchGroups：按分组顺序先到先得", () => {
    const input = [many(1, 30), many(2, 30), many(3, 30)];
    const out = truncateSearchGroups(input, 60, 24, false);
    // 第一组拿满 24（perGroup），第二组拿满 24，第三组拿到剩下的 12
    assert.deepEqual(out.map(g => g.sites.length), [24, 24, 12]);
});

test("truncateSearchGroups：额度在第一组就用完时不再输出后面的分组", () => {
    const input = [many(1, 30), many(2, 30)];
    const out = truncateSearchGroups(input, 10, 24, false);
    assert.equal(out.length, 1);
    assert.equal(out[0].sites.length, 10);
});

test("truncateSearchGroups：没超上限时原样返回同一个引用（不重建数组）", () => {
    const input = [many(1, 3), many(2, 4)];
    const out = truncateSearchGroups(input, 60, 24, false);
    assert.equal(out, input);
});

test("truncateSearchGroups：展开时不截断", () => {
    const input = [1, 2, 3, 4, 5].map(id => many(id, 24));
    const out = truncateSearchGroups(input, 60, 24, true);
    assert.equal(countSites(out), 120);
    assert.equal(out, input);
});

test("truncateSearchGroups：空分组不进结果（分组名不会因为截断而空占一行）", () => {
    const input = [many(1, 24), group(2, []), many(3, 24)];
    const out = truncateSearchGroups(input, 60, 24, false);
    assert.deepEqual(out.map(g => g.id), [1, 3]);
});

test("truncateSearchGroups：截断后保留原分组对象字段（只替换 sites）", () => {
    const input = [many(1, 30)];
    const out = truncateSearchGroups(input, 10, 24, false);
    assert.equal(out[0].id, 1);
    assert.equal(out[0].name, "g1");
    assert.equal(out[0].sites.length, 10);
    // 原数组不被改动
    assert.equal(input[0].sites.length, 30);
});
