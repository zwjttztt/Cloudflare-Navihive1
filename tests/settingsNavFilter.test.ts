// tests/settingsNavFilter.test.ts
// 设置中心左栏搜索过滤的**纯函数**部分 + 两条源码守卫。
//
// 为什么要有这个文件：`filterNavGroups` 是这次改动里唯一有分支的逻辑
// （空词短路、三个搜索面、空分组丢弃），而它的三个行为都很容易「改得看起来
// 一样、实际已经不对」——
//   · 空词不再返回原引用 → 清空搜索时整列重渲染，且 `===` 断言失效；
//   · 空分组不丢 → 读屏念一个「数据与活动，分组」然后什么都没有；
//   · 搜索面退化成只看 label → 「深色」「死链」「WebDAV」这些别名全失效。
// 这三点都能在纯函数层钉死，不需要挂 React。
//
// 另外两条是**源码守卫**：`aria-label` 挂错层、`Escape` 只写 preventDefault
// 不写 stopPropagation —— 这两种都是「编译过、单测过、只有读屏/键盘用户发现」
// 的回归，跑不出运行时症状，只能看源码。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { filterNavGroups } from "../src/components/settingsWorkspace/SettingsWorkspaceNavFilter";
import type { WorkspaceNavGroup } from "../src/components/settingsWorkspace/SettingsWorkspaceNav";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();

/** [id, label, searchText] 三元组造组，省得每条都写一遍 icon: null */
function group(title: string, items: Array<[string, string, string]>): WorkspaceNavGroup {
    return {
        title,
        items: items.map(([id, label, searchText]) => ({ id, label, searchText, icon: null })),
    };
}

/** 三条搜索面各不相同的样本：label / 别名 / 说明 分别能单独命中 */
const GROUPS: WorkspaceNavGroup[] = [
    group("数据与活动", [
        ["stats", "统计", "统计 排行 趋势 访问统计与运营看板"],
        ["audit", "审计日志", "审计日志 记录 历史 谁在什么时候改了什么"],
    ]),
    group("外观与工具", [
        ["config-appearance", "外观与搜索", "外观与搜索 主题 深色 站点名称主色自定义 CSS"],
        ["ai", "AI 设置", "AI 设置 密钥 API 模型服务"],
    ]),
    group("个人与支持", [["shortcuts", "快捷键与操作帮助", "快捷键与操作帮助 键盘 安装到桌面"]]),
];

const idsOf = (groups: WorkspaceNavGroup[]): string[] =>
    groups.flatMap(g => g.items.map(i => i.id));

test("空词（含纯空格）原样返回**同一个引用**：清空搜索不重算、不重渲染", () => {
    assert.equal(filterNavGroups(GROUPS, ""), GROUPS, "空串必须返回传入的那个数组引用");
    assert.equal(filterNavGroups(GROUPS, "   "), GROUPS, "纯空格视为空词，同样返回原引用");
    assert.equal(filterNavGroups(GROUPS, "\t\n"), GROUPS, "制表符/换行也算空白");
});

test("三个搜索面都能单独命中：label / 别名 / 说明", () => {
    // ① label：「审计日志」
    assert.deepEqual(idsOf(filterNavGroups(GROUPS, "审计日志")), ["audit"]);
    // ② 别名（searchText 里 label 之外那几个词）：「排行」只出现在 stats 的别名里
    assert.deepEqual(idsOf(filterNavGroups(GROUPS, "排行")), ["stats"]);
    // ③ 说明（拼在 searchText 尾部的那句话）：「运营看板」只在 stats 的说明里
    assert.deepEqual(idsOf(filterNavGroups(GROUPS, "运营看板")), ["stats"]);
});

test("大小写不敏感：css / CSS、ai / AI 都命中", () => {
    for (const q of ["css", "CSS", "Css"]) {
        assert.deepEqual(idsOf(filterNavGroups(GROUPS, q)), ["config-appearance"], `「${q}」要命中`);
    }
    for (const q of ["ai", "AI", "Ai"]) {
        assert.deepEqual(idsOf(filterNavGroups(GROUPS, q)), ["ai"], `「${q}」要命中`);
    }
});

test("关键词前后的空白不算输入：'  css  ' 等同于 'css'", () => {
    assert.deepEqual(idsOf(filterNavGroups(GROUPS, "  css  ")), ["config-appearance"]);
});

test("过滤后空掉的分组整组丢弃（不留一个光秃秃的 role=group）", () => {
    const hit = filterNavGroups(GROUPS, "css");
    assert.equal(hit.length, 1, "只有「外观与工具」这一组有命中");
    assert.equal(hit[0]?.title, "外观与工具");
    // 每条命中都要真的带 item，否则渲染出来就是一个只有 aria-label 的空组
    for (const g of hit) assert.ok(g.items.length > 0, `分组「${g.title}」不该是空的`);
});

test("全部不命中返回空数组（调用方据此渲染空态）", () => {
    assert.deepEqual(filterNavGroups(GROUPS, "绝不可能命中的词"), []);
});

// ── 源码守卫 ①：aria-label / onKeyDown 必须挂在 slotProps.htmlInput 上 ──────
test("守卫：aria-label 与 onKeyDown 都写在 slotProps.htmlInput 里", () => {
    const code = stripComments(
        readFileSync(
            join(ROOT, "src", "components", "settingsWorkspace", "SettingsWorkspaceNavFilter.tsx"),
            "utf8"
        )
    );

    const htmlInputAt = code.indexOf("htmlInput");
    assert.ok(htmlInputAt > 0, "组件必须用 slotProps.htmlInput 把属性交给原生 <input>");

    // 属性写法（aria-label: "…"）与 JSX 写法（aria-label='…'）都抓
    const ariaAt = code.search(/\baria-label\b\s*[:=]/);
    assert.ok(ariaAt > 0, "组件里找不到 aria-label —— 读屏会念「编辑框」，用户不知道搜什么");
    assert.ok(
        ariaAt > htmlInputAt,
        "aria-label 必须写在 slotProps.htmlInput 里，不能写在 <TextField> 顶层：" +
            "写在顶层会被 MUI 摊到外层 FormControl（div）上，读屏念的是 input、" +
            "`input[aria-label=…]` 选择器也找不到它"
    );

    const slot = code.slice(htmlInputAt, htmlInputAt + 400);
    assert.ok(slot.includes("aria-label"), "htmlInput 槽位里没有 aria-label");
    assert.ok(slot.includes("onKeyDown"), "htmlInput 槽位里没有 onKeyDown —— Esc / ↓ 会收不到");
});

// ── 源码守卫 ②：Esc 分支必须 stopPropagation ────────────────────────────────
test("守卫：Esc 分支必须 stopPropagation（只 preventDefault 拦不住 MUI 关弹窗）", () => {
    const code = stripComments(
        readFileSync(
            join(ROOT, "src", "components", "settingsWorkspace", "SettingsWorkspaceNavFilter.tsx"),
            "utf8"
        )
    );

    const escAt = code.indexOf('"Escape"');
    assert.ok(escAt > 0, "找不到 Escape 分支 —— 有词时按 Esc 会直接把中心关掉");
    const branch = code.slice(escAt, escAt + 500);

    assert.ok(
        branch.includes("stopPropagation"),
        "Esc 分支必须调用 stopPropagation。证据（@mui/material 9.5.0）：" +
            "node_modules/@mui/material/Modal/useModal.js:107-119 明确写着 " +
            "「The handler doesn't take event.defaultPrevented into account」—— " +
            "Modal 只在事件冒到根那层时才 onClose('escapeKeyDown')，" +
            "所以 preventDefault 对它完全无效，只有阻止冒泡能拦住"
    );
    assert.ok(branch.includes("preventDefault"), "Esc 分支同样要 preventDefault（别让浏览器做默认动作）");
});

/** 剥注释：注释里会写示例代码，不剥会误判（与 lazyGuard 同一份实现） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            if (i < 0) return line;
            return line.slice(0, i).includes("://") ? line : line.slice(0, i);
        })
        .join("\n");
}
