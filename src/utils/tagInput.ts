// src/utils/tagInput.ts
// 标签输入框的文本与「标签数组」之间的转换。
//
// 之所以要单独放一个文件：「点一下候选就进输入框」这件事有个容易写歪的地方 ——
// 分隔符和空格混着用（"AI，工具 效率"），手写 split 的地方多了，迟早有一处漏掉
// 中文逗号。目前批量打标签弹窗用它；「网站设置」里那处仍是手写的 split，
// 要改时直接换成这两个函数即可。

/** 把输入框的原文切成标签：中英文逗号与空白都算分隔，去空、去重、保序 */
export function parseTagInput(input: string): string[] {
    const seen = new Set<string>();
    for (const raw of input.split(/[,，\s]+/)) {
        const tag = raw.trim();
        if (tag) seen.add(tag);
    }
    return [...seen];
}

/**
 * 点一下候选标签：已经在输入框里就摘掉，否则追加到末尾。
 * 返回**新的输入框文本**（统一用 ", " 分隔）。
 *
 * 走输入框而不是另存一份「已勾选项」，是为了让「我到底要提交哪些标签」只有一处真相：
 * 勾完还能手改、还能删，提交的就是框里那串字。
 */
export function toggleTagInInput(input: string, tag: string): string {
    const target = tag.trim();
    if (!target) return input;
    const list = parseTagInput(input);
    const next = list.includes(target)
        ? list.filter(t => t !== target)
        : [...list, target];
    return next.join(", ");
}
