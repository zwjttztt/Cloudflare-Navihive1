// src/utils/noteWikiLinkCount.ts
//
// 「数一篇正文里有几个 `[[双链]]`」—— 一条正则就能算完的纯函数。
//
// ⚠️ 为什么它不待在 noteWikiLink.ts 里（2026-10-26 体积预算抓出来的）：
// noteWikiLink.ts 为了注册 inline 规则，顶层 `import MarkdownIt from "markdown-it"`；
// 而 `API/mock.ts` 需要这个计数（写入时算 link_count），`App.tsx` 又**静态** import 了
// MockNavigationClient —— 于是 mock → noteWikiLink → markdown-it 这条边把整个
// markdown 渲染器（约 106 KB）拽进了首屏预载，check:budget 直接红。
// 计数本身跟解析器毫无关系，拆出来之后 mock 只拿到这 20 行，首屏回到原样。
//
// 规则仍与 noteWikiLink.ts 是**同一份实现**（那边 re-export 本文件），
// 不会出现「回填一套规则、新增一套规则」的总数对不上的老问题。

/**
 * 数出正文里 `[[目标]]` 双链**出现的次数**（不去重，不含 `![[嵌入]]`）。
 *
 * 与 extractWikiLinks 的区别（两个都要，别互相替代）：
 *   · extractWikiLinks 走完整 markdown-it 解析 → 拿到**去重**后的目标名，
 *     用来建反向链接；代价是每次都要实例化解析器，且拿不到出现次数。
 *   · 这里只用一条正则 → 拿到**出现次数**，用来给数据页的「双链」一格做统计。
 *     它不解析语法（代码块里的 `[[x]]` 也会算），这是刻意的：那个数字表达的是
 *     「这篇正文里写了多少个双链」，而不是「渲染后有多少个链接」。
 *
 * ⚠️ 调用方：`API/methods/notes/notesNote.ts`（写入时算 link_count）、
 * `API/methods/migration.ts`（老数据回填）、`API/mock.ts`（模拟同一个数）。
 * **必须同一份实现** —— 各写一份的话，回填出来的数和之后新增的数会来自两套规则，
 * 总数永远对不上。
 */
export function countWikiLinks(text: string): number {
    const re = /\[\[([^\]\n]+)\]\]/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) !== null) {
        // 前一个字符是 ! 的就是嵌入 `![[...]]`，不计入双链
        if (m.index > 0 && text[m.index - 1] === "!") continue;
        n += 1;
    }
    return n;
}
