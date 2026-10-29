// src/components/notes/seedDraft.ts
// 草稿播种决策（纯函数）。
//
// 为什么单独抽出来：这段判断连着两次线上事故式的修正，规则本身很细，但全埋在一个
// 几百行的 hook 的 useEffect 里就只能靠人工回归。抽成纯函数后 tests/seedDraft.test.ts
// 能把四条规则逐条钉住。
//
// 背景（两条互相打架的约束）：
//   1) 列表用 summary 模式取正文，长笔记在列表里只有开头一段（content_truncated）。
//      **摘要绝不能灌进草稿** —— 一保存就把整篇砍成一段。
//   2) 但「保存 → 列表刷新 → 这一行又变回摘要态」是每次自动保存都会发生的事。
//      如果一见到摘要就清草稿，用户就会看到「写着写着整篇空了」
//      （2026-10-29 线上反馈，库里内容其实还在）。
//
// 所以判据不是「是不是摘要」，而是「这份草稿属不属于当前这条笔记」：
//   · 换到另一条笔记且还没补全 → 清空（防止上一条的正文被 dirty 判成改动写过去）；
//   · 同一条笔记又变回摘要态     → 保留草稿（用户正在打的字就在里面）；
//   · 同一条笔记补全回来了       → 草稿已经在手上就保留（别拿服务端那份盖掉刚敲的字）。

export type DraftLike = { title: string; content: string } | null;

export type SeedableNote = {
    id?: number;
    title?: string;
    content?: string;
    content_truncated?: boolean;
};

/** keep = 什么都不做；clear = 把草稿置空；set = 用全文灌进去 */
export type DraftSeedDecision = { kind: "keep" } | { kind: "clear" } | { kind: "set"; draft: { title: string; content: string } };

export function decideDraftSeed(
    note: SeedableNote | null | undefined,
    seededNoteId: number | null,
    currentDraft: DraftLike
): DraftSeedDecision {
    if (!note) return { kind: "keep" };

    const noteId = note.id ?? null;

    if (note.content_truncated) {
        // 换了一条笔记、手上还没有它的全文：清掉，避免上一条的正文被当成「本条已改动」
        if (seededNoteId !== noteId) return { kind: "clear" };
        // 同一条笔记的摘要态刷新：草稿保持原样（这条就是「写着写着变空」的修复点）
        return { kind: "keep" };
    }

    // 同一条笔记且已经有草稿：补全回读不覆盖用户正在编辑的内容
    if (seededNoteId === noteId && currentDraft !== null) return { kind: "keep" };

    return { kind: "set", draft: { title: note.title || "", content: note.content || "" } };
}
