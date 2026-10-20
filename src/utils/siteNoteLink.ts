// src/utils/siteNoteLink.ts
// **笔记正文里有没有提到某个站点** —— D2 双向绑定的站点那一侧的筛选用。
//
// ⚠️ 这个文件会 import `noteWikiLink`（也就是 markdown-it，约 105 KB）。
// 所以它**只能被懒加载到的组件引用**（站点设置弹窗 SiteNotesSection），
// 绝不能从 App / siteIndex 那边引 —— 那会把 markdown-it 拽进首屏
// （实测首屏 852 → 971 KB）。名字/网址匹配那种不碰 Markdown 的判据在
// `siteMatch.ts`，那边才是首屏能碰的。
import { extractWikiLinks } from "./noteWikiLink";
import {
    normalizeSiteLabel,
    siteMatchKeys,
    siteUrlKey,
    type NoteLinkRef,
    type SiteLinkRef,
} from "./siteMatch";

/**
 * 去掉代码块：示例代码 / 命令里的网址与站名不算「我提到了这个站」。
 *
 * 不剥的话，一条写满 `git clone https://github.com/x` 的笔记会被每个站都认领 ——
 * 那不叫关联，那叫噪音。围栏与行内代码各剥一次，剥成空格而不是删掉，
 * 免得把「代码前后的两个词」粘成一个不存在的词。
 */
function stripCodeRegions(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/~~~[\s\S]*?~~~/g, " ")
        .replace(/`[^`\n]*`/g, " ");
}

/**
 * 这条笔记有没有提到这个站点。
 *
 * 三条判据（任一命中即算）：
 *   ① 正文里的 `[[…]]` 指向它（复用 noteWikiLink 的解析，与双链同一套口径：
 *      行内代码 / 围栏代码 / 链接目标里写的不算）—— 这是最**显式**的一种；
 *   ② 正文**直接写了它的网址**（很多人是贴链接、不是打双链）；
 *   ③ 正文里出现了站点名。
 *
 * ⚠️ ② 只认**带点**的键（host / host+path），③ 要求站名至少两个字符：
 *    单字的站名（「A」）会把半本笔记都认领，宁可漏也不要噪音。
 *    两字符及以上照常认（中文站名「知乎」就是两个字）。
 *   ②③ 都在**剥掉代码块**之后的文本上比 —— 见 stripCodeRegions。
 *
 * ⚠️ `content` 可以是**全文**，也可以是搜索返回的**片段**（站点侧拿不到全文，
 *    只有命中位置附近的一段）：片段越短漏得越多，这是取舍的另一面 ——
 *    不为一个附加小节把全部笔记正文拉一遍。
 */
export function noteMentionsSite(note: NoteLinkRef, site: SiteLinkRef): boolean {
    const nameKey = normalizeSiteLabel(site.name || "");
    const urlKeys = siteMatchKeys(site).filter(k => k.includes("."));
    if (!nameKey && !urlKeys.length) return false;

    const hay = `${note.title || ""}\n${note.content || ""}`;
    for (const target of extractWikiLinks(hay)) {
        if (nameKey && normalizeSiteLabel(target) === nameKey) return true;
        const tk = siteUrlKey(target);
        if (tk && urlKeys.includes(tk)) return true;
    }

    const lower = stripCodeRegions(hay).toLowerCase();
    for (const k of urlKeys) {
        if (lower.includes(k)) return true;
    }
    // ③ 名字子串：单字站名不认 —— 见上面那段说明
    return Array.from(nameKey).length >= 2 && lower.includes(nameKey);
}

/** 提到了这个站点的笔记（不含没有 id 的 —— 跳不过去的结果不给） */
export function notesMentioningSite(
    notes: readonly NoteLinkRef[],
    site: SiteLinkRef
): { id: number; title: string }[] {
    const out: { id: number; title: string }[] = [];
    for (const note of notes) {
        if (note.id === undefined) continue;
        if (noteMentionsSite(note, site)) {
            out.push({ id: note.id, title: note.title || "无标题" });
        }
    }
    return out;
}
