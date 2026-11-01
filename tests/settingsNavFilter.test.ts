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
// 后半段用**真实注册表**（model.ts 的 NAV_CENTER_GROUPS，不是自造样本）跑一遍：
// 左栏那条链路原来只有 tsc 和类型在保，谁也没验过「拼出来的串到底能不能搜到」。
//
// 另外两条是**源码守卫**：`aria-label` 挂错层、`Escape` 只写 preventDefault
// 不写 stopPropagation —— 这两种都是「编译过、单测过、只有读屏/键盘用户发现」
// 的回归，跑不出运行时症状，只能看源码。
//
// 顺带的好处（2026-11 拆文件时拿到）：`filterNavGroups` 搬进 navFilter.ts 之后，
// 这个用例不必再从组件文件里 import —— 也就不会为了拿一个函数把整套 MUI
// TextField / InputAdornment 组件树一起拉进纯函数 bundle。
//（下面 import 的 model.ts 只带图标组件与数据，不挂任何组件树、不需要 DOM。）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { filterNavGroups } from "../src/components/settingsWorkspace/navFilter";
import type { WorkspaceNavGroup } from "../src/components/settingsWorkspace/SettingsWorkspaceNav";
import { NAV_CENTER_GROUPS, navSearchText } from "../src/components/navigationCenter/model";

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

// ── 真实注册表：左栏那条链路原来只有 tsc 在保 ───────────────────────────────
//
// 样本用 model.ts 里**真实的** NAV_CENTER_GROUPS，而不是上面那组自造数据：
// 自造样本只能证明「算法对」，证明不了「注册表里真的写了那些词」。
// 映射方式与 NavigationCenterDialog 一致（searchText 走 navSearchText），
// 所以这组用例同时盯住了「拼接规矩」和「过滤行为」两头。
const REAL_GROUPS: WorkspaceNavGroup[] = NAV_CENTER_GROUPS.map(group => ({
    title: group.title,
    items: group.items.map(item => ({
        id: item.id,
        label: item.label,
        // 纯函数层不渲染图标，null 就够
        icon: null,
        searchText: navSearchText(item),
    })),
}));

test("真实注册表：搜「主色」命中「外观与搜索」—— 说明（description）也参与过滤", () => {
    // 「主色」既不在 label 里、也不在 keywords 里，只出现在那句说明
    // 「站点名称、主色、圆角字号…」中 —— 这一条红了，就是 description
    // 没被拼进 searchText（用户搜得到功能，搜不到设置项）。
    assert.deepEqual(idsOf(filterNavGroups(REAL_GROUPS, "主色")), ["config-appearance"]);
});

test("真实注册表：搜小写「webdav」命中「数据安全」—— 别名 + 大小写不敏感", () => {
    // 注册表里写的是大写的 "WebDAV"，用户只会打小写。命中同时依赖两件事：
    // ① keywords 被拼进了 searchText；② norm 把两边都转成小写。
    assert.deepEqual(idsOf(filterNavGroups(REAL_GROUPS, "webdav")), ["backup"]);
});

test("真实注册表：搜「退出」不命中任何设置项（刻意不给「账号与安全」加这个别名）", () => {
    // 🔴 这是**刻意的设计**，不是漏网：用户搜「退出」十有八九在找左栏底部
    // 那颗「退出登录」，让「账号与安全」命中它就是把用户引到错的一屏。
    // 谁想「顺手」给 account 补一个「退出」别名，这条会立刻红。
    assert.deepEqual(idsOf(filterNavGroups(REAL_GROUPS, "退出")), []);
    // 反向确认这组样本不是空的 —— 否则上面那条恒真，等于没测
    assert.deepEqual(idsOf(filterNavGroups(REAL_GROUPS, "账号")), ["account"]);
});

test("真实注册表：必然不存在的词返回空数组", () => {
    assert.deepEqual(filterNavGroups(REAL_GROUPS, "zzz-不存在的词-zzz"), []);
});

test("真实注册表：每条 navSearchText 都非空、且含自己的 label", () => {
    const items = NAV_CENTER_GROUPS.flatMap(group => group.items);
    assert.equal(items.length, 9, "注册表应是 9 条设置项（左栏「9 条」的说法就指这个数）");
    for (const item of items) {
        const text = navSearchText(item);
        assert.ok(text.trim().length > 0, `${item.id} 的搜索面是空的，搜什么都搜不到它`);
        assert.ok(
            text.includes(item.label),
            `${item.id} 的搜索面里没有自己的名称「${item.label}」—— 说明拼接时把 label 漏了`
        );
    }
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
