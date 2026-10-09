// src/utils/ftsQuery.ts
// 服务端全文检索（FTS5）的「查询串构造」与「中文分词」。
//
// 为什么非要分词：SQLite 的 unicode61 分词器按**空白与标点**切词，
// 中文一整句没有空格 → 索引里就一个巨大的 token，搜「设计」永远命中不了。
// 所以写入与查询两侧都先做 segmentCJK：把每个汉字两侧塞空格，
// 「数据库设计说明」→「数 据 库 设 计 说 明」，再交给 unicode61，
// 于是每个字都是一个 token，搜「设 计」（短语）就能命中。
//
// 这个做法与 inkstone 的 shared/markdown-utils 的 segmentCJK 完全一致。
// ⚠️ 两侧**必须**用同一个函数：只在一侧分词的话，索引里是分过的、
// 查询串没分（或反之），MATCH 出来永远是空 —— 而且不报错，只是「搜不到」。

const CJK_GLOBAL = /[⺀-鿿豈-﫿！-￠]/g;

/** 把连续的中文拆成单字，用空格隔开（英文/数字原样保留） */
export function segmentCJK(text: string): string {
    return text.replace(CJK_GLOBAL, c => ` ${c} `).replace(/\s{2,}/g, " ");
}

/** 索引里正文最多收这么多字（更长的不进索引，省 D1 空间与写入时间） */
export const FTS_CONTENT_LIMIT = 20000;

/**
 * 把用户输入变成 FTS5 的 MATCH 表达式。
 *
 * - 按空白切成多个词，词之间是 AND（「设计 索引」= 两个都要有）
 * - 每个词内部是**短语**查询（`"设 计"`），顺序不能乱
 * - 最后一个词加 `*` 做前缀匹配（输一半也能搜到，符合输入框的即时反馈）
 *
 * ⚠️ 双引号要从词里剥掉：它会提前闭合短语，甚至拼出非法表达式（MATCH 报语法错 → 500）。
 */
export function buildFtsMatch(query: string): string {
    const terms = query.split(/\s+/).map(t => t.trim()).filter(Boolean);
    if (terms.length === 0) return "";
    const parts: string[] = [];
    for (const term of terms.slice(0, 8)) {
        const seg = segmentCJK(term).trim().replace(/"/g, "");
        if (!seg) continue;
        parts.push(seg.includes(" ") ? `"${seg}"` : `"${seg}"*`);
    }
    return parts.length ? parts.join(" AND ") : "";
}

/** LIKE 回退用的转义（`%` `_` 在 LIKE 里是通配符，不转义会把「_」当任意字符） */
export function escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, c => "\\" + c);
}

/**
 * 从正文里截一段带命中词的摘要（FTS 的 snippet() 在 trigram/unicode61 下
 * 对中文切出来的片段很难看，干脆自己截：命中位置前后各留一段）。
 */
export function makeSnippet(content: string, terms: string[], radius = 40): string {
    const text = (content || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    let hit = -1;
    for (const term of terms) {
        const at = lower.indexOf(term.toLowerCase());
        if (at >= 0) {
            hit = at;
            break;
        }
    }
    if (hit < 0) return text.slice(0, radius * 2);
    const start = Math.max(0, hit - radius);
    const end = Math.min(text.length, hit + radius);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
