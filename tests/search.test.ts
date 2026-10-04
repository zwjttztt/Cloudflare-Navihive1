// tests/search.test.ts
// 搜索与查重的单测。这里不 load 拼音词典（那是有副作用的一次性加载，
// 放在 tests/pinyin.test.ts 里单独测），所以下面涉及拼音的用例一律不传 usePinyin。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildSearchIndex,
    matchesGroupQuery,
    matchesPrepared,
    matchesSiteQuery,
    normalizeSearchText,
    prepareQuery,
    siteHaystack,
    siteSearchText,
} from "../src/utils/search";
import { findDuplicateSite, groupByUrlKey, urlKey } from "../src/utils/duplicate";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";

const site = (over: Partial<Site> = {}): Site => ({
    id: 1,
    group_id: 1,
    name: "",
    url: "",
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: 0,
    ...over,
});

test("归一化把协议头、www、标点差异抹平", () => {
    assert.equal(normalizeSearchText("https://www.YunSo.net/"), "yunso net");
    assert.equal(normalizeSearchText("http://yunso.net"), "yunso net");
    assert.equal(normalizeSearchText("yunso_net"), "yunso net");
    assert.equal(normalizeSearchText("  云设  "), "云设");
});

test("中文按字符直接命中，多词要全部出现", () => {
    const s = site({ name: "云设", url: "https://yunso.net", description: "在线设计工具" });
    assert.equal(matchesSiteQuery(s, "云设"), true);
    assert.equal(matchesSiteQuery(s, "设计"), true);
    assert.equal(matchesSiteQuery(s, "云设 设计"), true);
    assert.equal(matchesSiteQuery(s, "云设 不存在的词"), false);
});

test("空关键词一律命中（等于没筛选）", () => {
    const s = site({ name: "随便" });
    assert.equal(matchesSiteQuery(s, ""), true);
    assert.equal(matchesSiteQuery(s, "   "), true);
    assert.equal(matchesGroupQuery("常用工具", ""), true);
});

test("搜域名能搜到卡片（用户经常直接粘网址）", () => {
    const s = site({ name: "云设", url: "https://www.yunso.net/path?a=1" });
    assert.equal(matchesSiteQuery(s, "yunso"), true);
    assert.equal(matchesSiteQuery(s, "yunso.net"), true);
    assert.equal(matchesSiteQuery(s, "https://www.yunso.net/path?a=1"), true);
});

test("searchText 包含名称 / 链接 / 描述三段", () => {
    const s = site({ name: "A", url: "https://b.com", description: "C" });
    const text = siteSearchText(s);
    assert.ok(text.includes("A") && text.includes("b.com") && text.includes("C"));
});

test("分组名支持「常用 工具」这种带空格的输入", () => {
    assert.equal(matchesGroupQuery("常用工具", "常用 工具"), true);
    assert.equal(matchesGroupQuery("常用工具", "开发"), false);
});

test("urlKey 抹掉协议、www、大小写与末尾斜杠的差异", () => {
    const key = urlKey("https://www.A.com/Path/");
    assert.equal(key, urlKey("a.com/path"));
    assert.equal(key, urlKey("http://A.com/path"));
    assert.equal(urlKey(""), "");
    assert.equal(urlKey(null), "");
});

test("urlKey 保留查询串：不同参数算不同地址，但协议/www 差异仍归一", () => {
    assert.notEqual(urlKey("https://a.com/p?x=1"), urlKey("https://a.com/p?x=2"));
    assert.equal(urlKey("https://a.com/p?x=1"), urlKey("https://www.a.com/p?x=1"));
});

// 归一化只能抹「协议/www/大小写/末尾斜杠」这些**差异**，不能把路径层级一起抹掉：
// 早先的实现先把所有非字母数字换成空格、再把空格删掉，于是下面三个不同的地址
// 算出同一个 key —— 表现为「新增一个链接，被提示和已有的某张卡重复」，拦住正常操作。
test("urlKey 留住路径分隔符：/a/b 与 /ab 不是同一个地址", () => {
    assert.notEqual(urlKey("https://a.com/a/b"), urlKey("https://a.com/ab"));
    assert.notEqual(urlKey("https://a.com/a-b"), urlKey("https://a.com/ab"));
    assert.notEqual(urlKey("https://a.com/a.b"), urlKey("https://a.com/ab"));
    // 同一条路径的不同写法仍然归一
    assert.equal(urlKey("https://a.com/a/b"), urlKey("http://www.A.com/a/b/"));
});

test("查询串 / 锚点不会和路径层级混在一起", () => {
    assert.notEqual(urlKey("https://a.com/p?x=1"), urlKey("https://a.com/p/x/1"));
    assert.notEqual(urlKey("https://a.com/p#frag"), urlKey("https://a.com/p/frag"));
    assert.equal(urlKey("https://a.com/p?x=1/"), urlKey("https://a.com/p?x=1"));
});

test("查重能找出别的分组里的同链接卡片", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "常用工具", order_num: 0, sites: [site({ id: 11, url: "https://a.com" })] },
        { id: 2, name: "开发", order_num: 1, sites: [site({ id: 21, url: "https://b.com/", group_id: 2 })] },
    ];
    const hit = findDuplicateSite(groups, "http://www.B.com");
    assert.ok(hit);
    assert.equal(hit!.site.id, 21);
    assert.equal(hit!.groupName, "开发");
});

test("查重时能排除「正在编辑的这张卡自己」", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "常用工具", order_num: 0, sites: [site({ id: 11, url: "https://a.com" })] },
    ];
    assert.ok(findDuplicateSite(groups, "https://a.com"), "不排除时应该能查到自己");
    assert.equal(findDuplicateSite(groups, "https://a.com", 11), null, "排除自己后不该再报重复");
    assert.ok(findDuplicateSite(groups, "https://a.com", 99));
});

test("groupByUrlKey 把同链接的卡片归到一起，空链接跳过", () => {
    const list = [
        site({ id: 1, url: "https://a.com" }),
        site({ id: 2, url: "http://www.A.com/" }),
        site({ id: 3, url: "" }),
    ];
    const map = groupByUrlKey(list);
    assert.equal(map.size, 1);
    assert.equal([...map.values()][0].length, 2);
});

test("excludeId 传字符串也能排除自己（id 从 URL 参数来的时候是字符串）", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "常用工具", order_num: 0, sites: [site({ id: 11, url: "https://a.com" })] },
    ];
    // 库里 id 是数字、传进来是字符串：两边都得 String() 过一遍再比，否则排除不掉，
    // 表现为「编辑一张卡，一保存就提示链接重复」
    assert.equal(findDuplicateSite(groups, "https://a.com", "11"), null);
    assert.ok(findDuplicateSite(groups, "https://a.com", "12"));
});

test("分组还没带 sites（初始化中途）时不炸，只是查不到", () => {
    const groups = [
        { id: 1, name: "常用工具", order_num: 0, sites: undefined },
    ] as unknown as GroupWithSites[];
    assert.equal(findDuplicateSite(groups, "https://a.com"), null);
});

test("分组没名字时报「未命名分组」而不是 undefined", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "", order_num: 0, sites: [site({ id: 11, url: "https://a.com" })] },
    ];
    const hit = findDuplicateSite(groups, "https://a.com");
    assert.equal(hit?.groupName, "未命名分组");
});

test("待查链接是空的：不查重（一堆都没填链接的卡片不能互相判重复）", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "常用工具", order_num: 0, sites: [site({ id: 11, url: "" })] },
    ];
    assert.equal(findDuplicateSite(groups, ""), null);
    assert.equal(findDuplicateSite(groups, undefined), null);
});

// ============ 检索索引：结果与「逐个现算」必须完全一致 ============
// 索引是纯性能优化，命中结果**一个都不许变**。下面每条都跑两遍：
// 一遍走索引、一遍走原来的 matchesSiteQuery，两者必须同真同假。

test("索引路径与逐个现算的命中结果完全一致（多词 / 域名 / 描述 / 未命中）", () => {
    const sites: Site[] = [
        site({ id: 1, name: "云设", url: "https://www.yunso.net/", description: "在线设计工具" }),
        site({ id: 2, name: "GitHub", url: "https://github.com", description: "代码托管" }),
        site({ id: 3, name: "百度", url: "https://baidu.com", description: "搜索" }),
        site({ id: 4, name: "设计_素材", url: "https://sucai.example", description: "" }),
    ];
    const groups: GroupWithSites[] = [{ id: 1, name: "常用工具", order_num: 0, sites }];
    const index = buildSearchIndex(groups);

    const queries = [
        "云设", "设计", "云设 设计", "云设 不存在的词", "github",
        "https://github.com", "搜索", "", "   ", "素材", "baidu", "不存在的东西",
    ];

    for (const q of queries) {
        const prepared = prepareQuery(q);
        for (const s of sites) {
            const entry = index.sites.get(s.id as number);
            assert.ok(entry, `索引里该有站点 ${s.id}`);
            const viaIndex = matchesPrepared(entry!.haystack, entry!.name, prepared, false);
            const direct = matchesSiteQuery(s, q, false);
            assert.equal(
                viaIndex,
                direct,
                `关键词「${q}」对站点「${s.name}」：索引结果 ${viaIndex} 与直接结果 ${direct} 不一致`
            );
        }
    }
});

test("分组名命中：索引里的分组名与现算一致（整组保留那一条分支）", () => {
    const groups: GroupWithSites[] = [
        { id: 1, name: "常用工具", order_num: 0, sites: [site({ id: 11, name: "A" })] },
        { id: 2, name: "开发", order_num: 1, sites: [site({ id: 21, name: "B" })] },
    ];
    const index = buildSearchIndex(groups);

    for (const name of ["常用工具", "常用", "开发", "不存在的分组"]) {
        const prepared = prepareQuery(name);
        for (const g of groups) {
            const haystack = index.groups.get(g.id as number) ?? "";
            assert.equal(
                matchesPrepared(haystack, g.name, prepared, false),
                matchesGroupQuery(g.name, name, false),
                `分组「${g.name}」关键词「${name}」结果不一致`
            );
        }
    }
});

test("索引在数据不变时不用重建：站点侧文本只算一次", () => {
    // 计数用的探针：normalizeSearchText 是被复用的，这里数的是「建索引走了多少次」
    const groups: GroupWithSites[] = [
        {
            id: 1,
            name: "分组",
            order_num: 0,
            sites: Array.from({ length: 500 }, (_, i) =>
                site({ id: 100 + i, name: `站点${i}`, url: `https://s${i}.com` })
            ),
        },
    ];

    const t0 = process.hrtime.bigint();
    const index = buildSearchIndex(groups);
    const t1 = process.hrtime.bigint();
    assert.equal(index.sites.size, 500, "每张卡片都要进索引");

    // 索引建好之后，一次查询里不再有任何归一化：只做 includes
    const prepared = prepareQuery("站点250");
    let hits = 0;
    for (const entry of index.sites.values()) {
        if (matchesPrepared(entry.haystack, entry.name, prepared, false)) hits++;
    }
    const t2 = process.hrtime.bigint();

    assert.equal(hits, 1, "只有那一张命中");
    // 这两条不是精确的性能断言（机器不同差异大），只保证「扫一遍比建索引快一个量级」：
    // 真退化成「每次查询都重新归一化」的话，扫一遍不可能比建索引还快
    const scanMs = Number(t2 - t1) / 1e6;
    const buildMs = Number(t1 - t0) / 1e6;
    assert.ok(scanMs < Math.max(buildMs, 1), `扫一遍(${scanMs.toFixed(2)}ms)不该比建索引(${buildMs.toFixed(2)}ms)还慢`);
});

test("siteHaystack 与 matchesSiteQuery 用同一套归一化（改了归一化两边一起变）", () => {
    const s = site({ name: "云设", url: "https://www.YunSo.net/" });
    assert.equal(siteHaystack(s), normalizeSearchText(siteSearchText(s)));
});
