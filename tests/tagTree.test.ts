// tests/tagTree.test.ts
// B4 标签层级（2026-10-22）。
//
// 钉的是四个「错了也不崩、但筛选结果悄悄不对」的地方：
//   1. 前缀匹配必须按**段**比 —— 字符串的 startsWith 会让「工作」命中「工作日晚高峰」
//   2. 隐式父节点要补齐 —— 用户只打过「工作/项目A」时，界面也得有「工作」可点
//   3. 输入要容忍用户乱写（空格、连续斜杠、空段）
//   4. 顺序必须稳定 —— 排序漂动就是「昨天第三个的标签今天跑别处了」
//
// ⚠️ 只断言字符串与数字：断言失败路径里不放 DOM 元素（node:assert 会 util.inspect 它）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildTagTree,
    flattenTagTree,
    hasHierarchy,
    joinTagPath,
    matchesAnySelected,
    splitTagPath,
    tagDepth,
    tagLeaf,
    tagMatches,
    tagParent,
} from "../src/utils/tagTree";

test("拆分路径：去空格、去空段", () => {
    assert.deepEqual(splitTagPath("工作/项目A"), ["工作", "项目A"]);
    assert.deepEqual(splitTagPath(" 工作 / 项目A "), ["工作", "项目A"]);
    assert.deepEqual(splitTagPath("工作//项目A"), ["工作", "项目A"], "连续斜杠不能产生空段");
    assert.deepEqual(splitTagPath(""), []);
});

test("层级关系：深度 / 父 / 末段", () => {
    assert.equal(tagDepth("工作"), 1);
    assert.equal(tagDepth("工作/项目A/后端"), 3);
    assert.equal(tagParent("工作/项目A"), "工作");
    assert.equal(tagParent("工作"), null, "一级标签没有父");
    assert.equal(tagLeaf("工作/项目A"), "项目A", "子标签显示末段就够了");
});

test("拼回路径会归一化用户输入", () => {
    assert.equal(joinTagPath([" 工作 ", "项目A"]), "工作/项目A");
    assert.equal(joinTagPath(["", "  "]), "");
});

test("匹配：选中父级含所有子级", () => {
    assert.equal(tagMatches("工作/项目A", "工作"), true);
    assert.equal(tagMatches("工作/项目A/后端", "工作"), true);
    assert.equal(tagMatches("工作", "工作"), true);
});

test("匹配：按段比，不能让「工作」命中「工作日晚高峰」", () => {
    // ⚠️ 这是写 tagMatches 时最容易踩的：用 startsWith 字符串前缀就会误命中
    assert.equal(tagMatches("工作日晚高峰", "工作"), false);
    assert.equal(tagMatches("工作2", "工作"), false);
});

test("匹配：选中子级不含父级、不含旁支", () => {
    assert.equal(tagMatches("工作", "工作/项目A"), false, "子级选中不该把父级也算进来");
    assert.equal(tagMatches("工作/项目B", "工作/项目A"), false);
});

test("匹配：空值不命中", () => {
    assert.equal(tagMatches("", "工作"), false);
    assert.equal(tagMatches("工作", ""), false);
});

test("一组选中项：任一命中即可（沿用「多标签之间是且」由调用方 every 组合）", () => {
    assert.equal(matchesAnySelected("工作/项目A", ["生活", "工作"]), true);
    assert.equal(matchesAnySelected("生活/买菜", ["工作"]), false);
    assert.equal(matchesAnySelected("工作", []), false);
});

test("建树：隐式父节点要补齐（只打过子标签也能选到父级）", () => {
    const tree = buildTagTree(["工作/项目A", "生活"]);
    const paths = flattenTagTree(tree).map(n => n.path);
    assert.ok(paths.includes("工作"), "用户没单独打过「工作」，树里也得有这个节点");
    assert.ok(paths.includes("工作/项目A"));
    assert.equal(hasHierarchy(["工作/项目A"]), true);
    assert.equal(hasHierarchy(["工作", "生活"]), false, "全是一级时不按树排版");
});

test("建树：顺序稳定（父在前、同层字典序）", () => {
    const a = flattenTagTree(buildTagTree(["生活", "工作/项目B", "工作/项目A"])).map(n => n.path);
    const b = flattenTagTree(buildTagTree(["工作/项目A", "生活", "工作/项目B"])).map(n => n.path);
    assert.deepEqual(a, b, "输入顺序不同，输出顺序必须一致");
    // ⚠️ 中文按 UTF-16 码位排（'工' U+5DE5 在 '生' U+751F 之前），不是拼音序 ——
    //    这里钉的是「顺序稳定可复现」，不是「符合某个locale」，所以不引入 localeCompare
    //    （CI 是 small-icu，中文 collation 不可用，用了反而会飘）。
    assert.deepEqual(a, ["工作", "工作/项目A", "工作/项目B", "生活"]);
});
