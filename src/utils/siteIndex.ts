// src/utils/siteIndex.ts
// 站点索引：**模块级**的一份只读快照，给记事本那边查 `[[站点名]]` 用。
//
// 为什么是模块级而不是 props 一层层传：记事本的渲染链路已经很深
// （App → NotesOverlay → NotesPage → NotesEditorPane → MarkdownPreview），
// 而站点列表是**导航站自己的数据**，记事本本来不碰它 —— 为了一个点击
// 把整条链路的 props 全改一遍，代价远大于收益。
//
// 代价是「记事本必须靠导航站先跑起来才有这份索引」：没打开过首页时为**空**，
// 那时 `[[站点]]` 退化成原来的死链提示（不是报错，只是不认）。
// 这个退化是安全的：索引只影响「原本点了没反应」的那部分链接，
// 已有笔记双链的行为完全不变。
//
// ⚠️ 别在这个文件里 import 任何会带进 Markdown / 编辑器的东西：
// App（首屏）直接 import 本模块，加一个 markdown-it 就是首屏 +105 KB。
// ⚠️ 只从 siteMatch 引（不碰 Markdown）：本模块被 App 直接 import，
// 引了 siteNoteLink 会把 markdown-it 拽进首屏（详见 siteMatch.ts 头注）。
import { findSiteByTarget, type SiteLinkRef } from "./siteMatch";

let index: readonly SiteLinkRef[] = [];

/** 用最新一份站点列表刷新索引（App 在 groups 变化时调一次，很便宜） */
export function setSiteIndex(sites: readonly SiteLinkRef[] | null | undefined): void {
    index = sites?.length ? sites : [];
}

/** 当前索引（只读）。没跑过首页时是空数组 */
export function getSiteIndex(): readonly SiteLinkRef[] {
    return index;
}

/** 清空（退出登录 / 切换账号时用：不该让上一个账号的站点还认得出来） */
export function clearSiteIndex(): void {
    index = [];
}

/** `[[target]]` 是不是指某个站点。索引为空时恒为 null（退化，不报错） */
export function findIndexedSite(target: string): SiteLinkRef | null {
    if (!index.length) return null;
    return findSiteByTarget(index, target);
}
