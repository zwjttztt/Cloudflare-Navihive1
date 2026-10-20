// src/utils/noteSummary.ts
// 把 Markdown 源码压成一行预览（去掉语法符号，不解析）。
//
// 从 NotesPage.tsx 抽出来（2026-10-20 拆分第一期）：它是纯函数、零依赖，
// 却住在一个 6675 行的组件文件里 —— 想单测它就得把整个组件一起 import。
export function summarize(source: string, max = 90): string {
    const flat = source
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
