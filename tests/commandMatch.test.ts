// tests/commandMatch.test.ts
// 命令面板的排序：输什么就该把最像的那条排在最上面。
// 原来是纯 includes + 生成顺序，「设置」常常把真正想要的命令压在第四五行。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    fuzzyMatch,
    groupBySection,
    pushRecentCommand,
    rankCommands,
    readRecentCommands,
    scoreCommand,
} from "../src/utils/commandMatch";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

const cmd = (id: string, label: string, hint?: string, keywords?: string) => ({
    id,
    label,
    hint,
    keywords,
});

test("打分：完全相等 > 前缀 > 包含 > 跳字 > 不匹配", () => {
    assert.equal(scoreCommand(cmd("1", "设置"), "设置"), 100);
    const prefix = scoreCommand(cmd("1", "设置外观"), "设置");
    const contains = scoreCommand(cmd("1", "打开设置面板"), "设置");
    const fuzzy = scoreCommand(cmd("1", "GitHub"), "gh");
    assert.ok(prefix > contains && contains > fuzzy, `顺序应为前缀>包含>跳字：${prefix}/${contains}/${fuzzy}`);
    assert.equal(scoreCommand(cmd("1", "GitHub"), "zzz"), -1);
});

test("hint 与 keywords 也算命中，但排在 label 命中之后", () => {
    const item = cmd("1", "GitHub", "代码托管", "github repo");
    assert.equal(scoreCommand(item, "代码托管"), 40);
    assert.equal(scoreCommand(item, "repo"), 40);
});

test("排序：最像的排第一，不再按生成顺序", () => {
    const items = [
        cmd("a", "网站设置里的某一项", "顺带提到了设置"),
        cmd("b", "打开设置"),
        cmd("c", "设置外观"),
    ];
    const ranked = rankCommands(items, "设置");
    assert.equal(ranked[0].id, "c", "前缀命中应排最前");
    assert.equal(ranked[1].id, "b", "包含命中次之");
    assert.equal(ranked[2].id, "a", "只在 hint 里出现的最后");
});

test("排序：跳字命中也能搜到（gh → GitHub）", () => {
    const ranked = rankCommands([cmd("a", "其它"), cmd("b", "GitHub")], "gh");
    assert.deepEqual(ranked.map(i => i.id), ["b"]);
});

test("排序：关键词为空时保持原顺序，只让最近用过的提前", () => {
    const items = [cmd("a", "A"), cmd("b", "B"), cmd("c", "C")];
    assert.deepEqual(rankCommands(items, "", []).map(i => i.id), ["a", "b", "c"]);
    assert.deepEqual(
        rankCommands(items, "", ["c"]).map(i => i.id),
        ["c", "a", "b"],
        "空关键词时用过的排最前"
    );
});

test("排序：同分时最近用过的靠前", () => {
    const items = [cmd("a", "设置"), cmd("b", "设置")];
    assert.deepEqual(rankCommands(items, "设置", ["b"]).map(i => i.id), ["b", "a"]);
});

test("最近使用：去重、最新在前、超出上限只留最近几条", () => {
    localStorage.clear();
    assert.deepEqual(readRecentCommands(), []);

    pushRecentCommand("a");
    pushRecentCommand("b");
    pushRecentCommand("a");
    assert.deepEqual(readRecentCommands(), ["a", "b"], "重复使用要提到最前且去重");

    for (let i = 0; i < 20; i++) pushRecentCommand(`id-${i}`);
    const recent = readRecentCommands();
    assert.equal(recent.length, 12, `最多留 12 条，实际 ${recent.length}`);
    assert.equal(recent[0], "id-19");
});

test("最近使用：存储坏了不影响排序（读不到就是空列表）", () => {
    localStorage.setItem("navihive:commandRecent", "{不是数组");
    assert.deepEqual(readRecentCommands(), []);
    const items = [cmd("a", "A")];
    assert.deepEqual(rankCommands(items, "A", readRecentCommands()).map(i => i.id), ["a"]);
});

test("fuzzyMatch：顺序对得上才算，空关键词一律命中", () => {
    assert.equal(fuzzyMatch("GitHub", "gh"), true);
    assert.equal(fuzzyMatch("GitHub", "hg"), false, "字符顺序反了不算");
    assert.equal(fuzzyMatch("GitHub", ""), true);
    assert.equal(fuzzyMatch("", "a"), false);
});

// ============ 任务 #30：拼音层与分组展示 ============

test("打分：拼音层命中得 30 分，排在关键词(40)后、跳字(20)前；未注入则不命中", () => {
    const pinyin = (text: string, key: string) => text === "设置" && key === "sz";
    assert.equal(scoreCommand(cmd("1", "设置"), "sz", { pinyin }), 30);
    assert.equal(scoreCommand(cmd("1", "设置"), "sz"), -1, "词典没就位时不能靠拼音命中");
    // 拼音与跳字同时能命中时，拼音排前
    const both = (text: string) => text === "设置";
    assert.equal(scoreCommand(cmd("1", "设置"), "shezhi", { pinyin: both }), 30);
});

test("rankCommands：拼音命中能进结果，且排在纯跳字之前", () => {
    const pinyin = (text: string, key: string) => text === "设置" && key === "sz";
    const ranked = rankCommands(
        // SuZhou 能被「sz」跳字命中（s→u→z 跳过 u）——两条都进结果才比得出先后
        [cmd("fuzzy", "SuZhou"), cmd("py", "设置")],
        "sz",
        [],
        { pinyin }
    );
    assert.deepEqual(ranked.map(i => i.id), ["py", "fuzzy"], "拼音(30)必须排在跳字(20)前");
});

test("groupBySection：按首次出现顺序分组，组内保持打分序与扁平下标", () => {
    const flat = [
        { id: "1", label: "站点甲", section: "打开网站" },
        { id: "2", label: "设置", section: "命令" },
        { id: "3", label: "站点乙", section: "打开网站" },
    ];
    const groups = groupBySection(flat);
    assert.deepEqual(groups.map(g => g.section), ["打开网站", "命令"], "组按首次出现顺序，不按字母序重排");
    assert.deepEqual(
        groups[0].entries.map(e => [e.index, e.item.id]),
        [[0, "1"], [2, "3"]],
        "扁平下标必须跟 results 对齐（键盘导航靠它）"
    );
    assert.deepEqual(groups[1].entries.map(e => e.item.id), ["2"]);
});
