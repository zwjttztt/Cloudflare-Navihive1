// src/components/settingsWorkspace/navFilter.ts
// 设置中心左栏搜索的**纯函数**：关键词归一化 + 分组的过滤。
//
// ── 为什么单独一个 .ts（而不是留在 SettingsWorkspaceNavFilter.tsx 里）────────
// ① 组件文件里同时 `export default` 组件和 `export function 纯函数`，
//    `react-refresh/only-export-components` 会报警告：Fast refresh 只认「只导出组件」
//    的模块，混着导出一个函数会让它退化成整页刷新。拆开是最干净的解法；
// ② 纯函数要能**脱离 React 单测** —— 不挂 DOM、不拉 MUI，毫秒级。
//    留在 .tsx 里的话，tests/settingsNavFilter.test.ts 为了拿一个函数得把
//    React / MUI 一起打进 bundle；
// ③ 它被 `SettingsWorkspaceNav` 静态引用，而后者是**中心懒加载块**里的模块
//    （见 tests/navigationCenterLazyGuard.test.ts 的 CENTER_MODULES）——
//    静态引用的关系保住之后，这条守卫也顺带看住了这个文件，
//    防止有人把它静态拉进首屏（那会把过滤逻辑塞进 index chunk）。
//
// ⚠️ 这个文件**必须**被 SettingsWorkspaceNav.tsx 静态 import 到。
// 覆盖率第 1 层是「文件触及率」（src/components/** 要求 100%），
// 一个没人 import 的文件要么被算成没覆盖，要么就是一段死代码。
import type { WorkspaceNavGroup, WorkspaceNavItem } from "./SettingsWorkspaceNav";

/** 归一化：去首尾空白 + 转小写。中文没有大小写，但中文输入法常带全角空格。 */
const norm = (s: string): string => s.trim().toLowerCase();

/** 一条条目是否命中关键词（q 已经是 norm 过的） */
function matches(item: WorkspaceNavItem, q: string): boolean {
    // searchText 是调用方（导航中心）拼好的搜索面：名称 + 别名 + 一行说明。
    // 没传的中心退化成「只按名称搜」—— 导航组件不认识 model.ts 里有几个字段。
    return norm(item.searchText ?? item.label).includes(q);
}

/**
 * 按关键词过滤分组。**纯函数**，可以脱离 React 单测。
 *
 * 三个刻意的行为：
 *   1. 空词（含纯空格）**原样返回传入的那个数组引用** —— 引用相等意味着
 *      `useMemo` 的下游不会因为「清空搜索」而白重渲染一次，也意味着
 *      「清空 = 回到原样」是可以被 `===` 断言钉住的；
 *   2. 过滤后空掉的分组整组丢弃：一个只有 `aria-label` 没有子项的
 *      `role="group"`，读屏会念「数据与活动，分组」然后什么都没有 ——
 *      比不渲染更迷惑；
 *   3. **先 filter 再交给调用方 map**（调用方拿到的已经是过滤后的数组）：
 *      分组之间那条 1px 分割线是按 `index > 0` 画的，下标必须是过滤后的，
 *      否则第一个可见分组会带着一条分割线、上面什么都没有。
 */
export function filterNavGroups(
    groups: WorkspaceNavGroup[],
    keyword: string
): WorkspaceNavGroup[] {
    const q = norm(keyword);
    if (!q) return groups;
    return groups
        .map(group => ({ ...group, items: group.items.filter(item => matches(item, q)) }))
        .filter(group => group.items.length > 0);
}
