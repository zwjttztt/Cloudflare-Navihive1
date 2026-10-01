// tests/advancedSearch.test.ts
// 搜索框的高级语法。两条底线有用例钉着：
//   ① 认不出来的 token 退回普通关键词，绝不静默丢掉（丢了用户只会以为「没有这张卡片」）；
//   ② 语法只做收窄，不越过现有的筛选开关。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    advancedHint,
    hasAdvancedSyntax,
    matchesAdvanced,
    matchesExcludes,
    parseAdvancedQuery,
} from "../src/utils/advancedSearch";

const site = {
    name: "GitHub",
    url: "https://github.com/foo",
    description: "代码托管",
};
const ctx = { tags: ["开发工具", "AI"], starred: true, dead: false };

test("普通搜索：没有冒号就原样留在 text 里，不产生任何条件", () => {
    const q = parseAdvancedQuery("github 代码");
    assert.equal(q.text, "github 代码");
    assert.deepEqual(q.tags, []);
    assert.deepEqual(q.flags, []);
    assert.equal(hasAdvancedSyntax("github 代码"), false);
});

test("tag: 支持交集、#简写，比对不区分大小写", () => {
    const q = parseAdvancedQuery("tag:AI #开发工具");
    assert.deepEqual(q.tags, ["AI", "开发工具"]);
    assert.equal(q.text, "");
    assert.equal(hasAdvancedSyntax("tag:AI"), true);

    assert.equal(
        matchesAdvanced(site, "开发", q, ctx),
        true,
        "两个标签都有才命中"
    );
    assert.equal(
        matchesAdvanced(site, "开发", parseAdvancedQuery("tag:没有的"), ctx),
        false
    );
});

test("group: / in: / url: 分别命中分组名与链接", () => {
    assert.equal(matchesAdvanced(site, "常用工具", parseAdvancedQuery("group:工具"), ctx), true);
    assert.equal(matchesAdvanced(site, "常用工具", parseAdvancedQuery("in:开发"), ctx), false);
    assert.equal(matchesAdvanced(site, "常用工具", parseAdvancedQuery("url:github"), ctx), true);
    assert.equal(matchesAdvanced(site, "常用工具", parseAdvancedQuery("url:gitlab"), ctx), false);
});

test("is: 三个标志：starred / dead / untagged", () => {
    assert.equal(matchesAdvanced(site, "g", parseAdvancedQuery("is:starred"), ctx), true);
    assert.equal(
        matchesAdvanced(site, "g", parseAdvancedQuery("is:starred"), { ...ctx, starred: false }),
        false
    );
    assert.equal(
        matchesAdvanced(site, "g", parseAdvancedQuery("is:dead"), { ...ctx, dead: true }),
        true
    );
    assert.equal(
        matchesAdvanced(site, "g", parseAdvancedQuery("is:untagged"), { ...ctx, tags: [] }),
        true,
        "没有标签才算 untagged"
    );
    assert.equal(matchesAdvanced(site, "g", parseAdvancedQuery("is:untagged"), ctx), false);
});

test("-关键词 排除：名称 / 链接 / 描述 / 分组名命中就算被排除", () => {
    const q = parseAdvancedQuery("代码 -github");
    assert.equal(q.text, "代码");
    assert.deepEqual(q.excludes, ["github"]);
    assert.equal(matchesExcludes(site, "常用", q.excludes), true);
    assert.equal(matchesExcludes(site, "常用", ["gitlab"]), false);
    assert.equal(matchesExcludes(site, "常用", []), false, "没有排除词时不排除任何东西");
});

test("认不出来的 is: 记进 unknownFlags，提示里点名（不静默当作没写）", () => {
    const q = parseAdvancedQuery("is:deleted");
    assert.deepEqual(q.flags, []);
    assert.deepEqual(q.unknownFlags, ["deleted"]);
    const hint = advancedHint(q);
    assert.ok(hint.includes("is:deleted"), `提示应点名，实际 ${hint}`);
    assert.ok(hint.includes("starred"), "提示应列出可用的条件");
    assert.equal(advancedHint(parseAdvancedQuery("tag:a")), "");
});

test("不是我们语法的冒号（http: 之类）退回普通关键词", () => {
    const q = parseAdvancedQuery("https://a.com");
    assert.equal(q.text, "https://a.com", "链接里本来就有冒号，不能被当成条件吃掉");
    assert.deepEqual(q.tags, []);
});

test("冒号后面是空的：当普通词搜，不产生空条件", () => {
    const q = parseAdvancedQuery("tag:");
    assert.equal(q.text, "tag:");
    assert.deepEqual(q.tags, []);
});

test("引号里的空格不算分隔：标签名带空格也能筛", () => {
    const q = parseAdvancedQuery('tag:"机器学习 入门"');
    assert.deepEqual(q.tags, ["机器学习 入门"]);
    assert.equal(
        matchesAdvanced(site, "g", q, { ...ctx, tags: ["机器学习 入门"] }),
        true
    );
});

test("语法与自由词可以混用，free text 拼回去给普通搜索", () => {
    const q = parseAdvancedQuery("github tag:AI -教程");
    assert.equal(q.text, "github");
    assert.deepEqual(q.tags, ["AI"]);
    assert.deepEqual(q.excludes, ["教程"]);
});
