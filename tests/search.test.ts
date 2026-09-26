// tests/search.test.ts
// 搜索与查重的单测。pinyin 相关一律不传 usePinyin（那会触发词典加载，
// 单测里不该有这种副作用），拼音本身由端到端冒烟覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    matchesGroupQuery,
    matchesSiteQuery,
    normalizeSearchText,
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
