// tests/aiMeta.test.ts
// AI 助手的护栏：模型返回怎么洗、提示词带了什么、向量怎么比。
// 这层一旦放松，模型胡说的内容会直接落到库里（编造的分组、编造的 id、五十字长的标签），
// 所以每条判定都钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_DESC_LEN,
    MAX_NAME_LEN,
    buildSiteMetaPrompt,
    buildTagSuggestionPrompt,
    clampText,
    cosineSimilarity,
    embeddingText,
    normalizeTag,
    normalizeTags,
    parseAnyJson,
    parseSiteMeta,
    parseTagSuggestions,
    resolveGroupName,
    topMatches,
} from "../src/utils/aiMeta";

const GROUPS = ["常用工具", "开发", "AI"];
const TAGS = ["工具", "AI", "设计"];

test("parseAnyJson：三种写法都能抠出 JSON（裸的 / 代码块 / 前后带废话）", () => {
    assert.deepEqual(parseAnyJson('{"name":"云设"}'), { name: "云设" });
    assert.deepEqual(parseAnyJson('好的：\n```json\n{"name":"云设"}\n```\n希望有帮助'), {
        name: "云设",
    });
    assert.deepEqual(parseAnyJson('我的建议是 {"name":"云设"} 完毕'), { name: "云设" });
});

test("parseAnyJson：不是 JSON 就返回 null，不抛异常", () => {
    assert.equal(parseAnyJson("抱歉，我无法回答这个问题"), null);
    assert.equal(parseAnyJson(""), null);
    assert.equal(parseAnyJson("{ 半截的 json"), null);
});

test("parseSiteMeta：正常结果逐字段落地", () => {
    const got = parseSiteMeta('{"name":"云设","description":"在线工具集合","group":"常用工具","tags":["工具","在线"]}', {
        groups: GROUPS,
    });
    assert.deepEqual(got, {
        name: "云设",
        description: "在线工具集合",
        group: "常用工具",
        tags: ["工具", "在线"],
    });
});

test("parseSiteMeta：全空的结果当没给（不能拿一份空壳去覆盖用户已有的字段）", () => {
    assert.equal(parseSiteMeta('{"name":"","description":"","group":"","tags":[]}'), null);
    assert.equal(parseSiteMeta("不是 JSON"), null);
});

test("parseSiteMeta：超长字段被截断到界面上限", () => {
    const long = "描".repeat(500);
    const got = parseSiteMeta(`{"name":"${"名".repeat(200)}","description":"${long}","tags":[]}`);
    assert.equal(got?.name.length, MAX_NAME_LEN);
    assert.equal(got?.description.length, MAX_DESC_LEN);
});

test("normalizeTag：去 # 前缀、去空白、挡纯符号与超长", () => {
    assert.equal(normalizeTag("#AI"), "AI");
    assert.equal(normalizeTag("  # AI工具 "), "AI工具");
    assert.equal(normalizeTag("   "), null);
    assert.equal(normalizeTag("###"), null);
    assert.equal(normalizeTag("标".repeat(30)), null);
    assert.equal(normalizeTag(42), null);
});

test("normalizeTags：去重（大小写不敏感）、不重复已有标签、限 5 个", () => {
    assert.deepEqual(normalizeTags(["AI", "ai", " 工具 ", "工具", "设计"]), ["AI", "工具", "设计"]);
    // 已有的「工具」不再建议一遍
    assert.deepEqual(normalizeTags(["工具", "新标签"], ["工具"]), ["新标签"]);
    assert.equal(normalizeTags(["1", "2", "3", "4", "5", "6", "7"]).length, 5);
    // 逗号分隔的字符串也认
    assert.deepEqual(normalizeTags("AI, 工具，设计"), ["AI", "工具", "设计"]);
});

test("resolveGroupName：命中已有分组就用它的原名，没命中才当新分组", () => {
    assert.equal(resolveGroupName("常用工具", GROUPS), "常用工具");
    assert.equal(resolveGroupName("  开发  ", GROUPS), "开发");
    assert.equal(resolveGroupName("ai", GROUPS), "AI"); // 大小写不敏感，回原名
    assert.equal(resolveGroupName("效率", GROUPS), "效率");
    assert.equal(resolveGroupName("", GROUPS), "");
    assert.equal(resolveGroupName(null, GROUPS), "");
});

test("提示词把已有分组与标签都摆出来，逼它从里面选", () => {
    const prompt = buildSiteMetaPrompt({
        url: "https://example.com",
        groups: GROUPS,
        tags: TAGS,
    });
    assert.match(prompt, /https:\/\/example\.com/);
    assert.match(prompt, /常用工具、开发、AI/);
    assert.match(prompt, /工具、AI、设计/);
    assert.match(prompt, /只输出一个 JSON 对象/);
});

test("批量建议的提示词只列 MAX_SUGGEST_SITES 个站点", () => {
    const sites = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        name: `站点${i + 1}`,
        url: `https://s${i + 1}.com`,
    }));
    const prompt = buildTagSuggestionPrompt({ sites, groups: GROUPS, tags: TAGS });
    assert.match(prompt, /id=40/);
    assert.equal(prompt.includes("id=41"), false);
});

test("parseTagSuggestions：只认真实存在的 id，编造的丢掉", () => {
    const got = parseTagSuggestions(
        '{"sites":[{"id":11,"tags":["效率"],"group":"AI"},{"id":999,"tags":["假的"],"group":"假分组"}]}',
        { allowedIds: [11, 12], groups: GROUPS, tags: TAGS }
    );
    assert.deepEqual(got, [{ id: 11, tags: ["效率"], group: "AI" }]);
});

test("parseTagSuggestions：重复 id 只取第一次，空建议不返回", () => {
    const got = parseTagSuggestions(
        '{"sites":[{"id":11,"tags":["AI"]},{"id":11,"tags":["重复"]},{"id":12,"tags":[]}]}',
        { allowedIds: [11, 12] }
    );
    assert.deepEqual(got, [{ id: 11, tags: ["AI"], group: "" }]);
});

test("parseTagSuggestions：顶层是数组也能认", () => {
    const got = parseTagSuggestions('[{"id":11,"tags":["工具"]}]', { allowedIds: [11] });
    assert.deepEqual(got, [{ id: 11, tags: ["工具"], group: "" }]);
});

test("embeddingText：名称 + 链接 + 描述 + 标签，去掉多余空白", () => {
    assert.equal(
        embeddingText({ name: "云设", url: "https://yunso.net", description: "在线工具", tags: ["工具"] }),
        "云设 https://yunso.net 在线工具 工具"
    );
    assert.equal(embeddingText({}), "");
});

test("cosineSimilarity：同向为 1、正交为 0，异常输入一律 0 不产生 NaN", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([1, 2], [1]), 0); // 维度不等
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0); // 零向量
    assert.equal(cosineSimilarity([Number.NaN, 1], [1, 1]), 0);
});

test("topMatches：按分数降序、取前 N 条、低于门槛的不算命中", () => {
    const items = [
        { id: 1, vec: [1, 0] },
        { id: 2, vec: [0.9, 0.1] },
        { id: 3, vec: [0, 1] },
    ];
    const got = topMatches([1, 0], items, 2, 0.5);
    assert.deepEqual(
        got.map(g => g.id),
        [1, 2]
    );
    assert.ok(got[0].score >= got[1].score);
    // 门槛抬高到 0.995 时只剩完全同向的那条（id=2 的余弦约 0.994）
    assert.deepEqual(
        topMatches([1, 0], items, 10, 0.995).map(g => g.id),
        [1]
    );
});

test("clampText：压缩空白并截断，非字符串给空串", () => {
    assert.equal(clampText("  多  个   空格 ", 50), "多 个 空格");
    assert.equal(clampText("1234567890", 4), "1234");
    assert.equal(clampText(123, 4), "");
});
