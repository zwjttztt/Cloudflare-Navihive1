// src/utils/noteOutline.ts
// 从 Markdown 源码里抽出标题层级，供「大纲」面板用。
//
// 为什么单独成文件：抽标题这件事有真坑（下面三条），而它必须能单测 ——
// 「大纲点���跳错位置」这种问题在界面上极难复现，每次都要重新手写一篇长笔记。
//
// ⚠️ 三个必须处理的坑：
//   1. **代码块里的 # 不是标题**。` ```bash\n# 安装\n``` ` 里那行是注释，
//      直接正则匹配会凭空多出一个一级标题，大纲里出现「安装」——
//      而点进去跳到的是代码块中间，纯属误导。
//   2. **行内代码 / 公式里的 # 同理**（`a # b`）。
//   3. **ATX 标题最多 6 级**，且 `#Hello`（井号后没空格）在 CommonMark 里**不算标题**
//      （那是普通文本）。所以判定要 `#` + 空格（或行尾）才算。
//
// 只抽**当前这条笔记的**大纲（inkstone 的大纲也是单篇级别，不是全库）。

/** 大纲里的一节 */
export interface OutlineItem {
    /** 1~6 级 */
    level: number;
    /** 标题文字（去掉井号与前后空白） */
    text: string;
    /** 在**源码**里的起始下标 —— 点击跳转就靠它 */
    offset: number;
    /** 该行的行号（0 起），跳过去之后顺便把光标放到行首 */
    line: number;
}

/** 去掉行内标记，得到「人能读的标题」：`## **加粗** 的标题` → `加粗 的标题` */
function plainTitle(raw: string): string {
    return (
        raw
            .replace(/`([^`]*)`/g, "$1") // 行内代码
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接
            .replace(/\$[^$]*\$/g, " ") // 行内公式 → 空格（不是空串，见下）
            .replace(/[*_~]{1,3}/g, "") // 强调 / 删除线 / 高亮
            // ⚠️ 剔掉公式/标记后可能留下**连续空格**（「勾股定理 $x$ 的证明」→「勾股定理  的证明」），
            // 大纲里那种双空格看着就像漏排版，统一压成单空格。
            .replace(/\s{2,}/g, " ")
            .trim()
    );
}

/**
 * 抽大纲。
 *
 * @param source 当前笔记的 Markdown 源码
 * @param maxLevel 保留到第几级（默认 6 全留；面板窄的时候传 3 就只留 H1~H3）
 */
export function extractOutline(source: string, maxLevel = 6): OutlineItem[] {
    if (!source) return [];
    const out: OutlineItem[] = [];
    const lines = source.split("\n");

    /**
     * 当前是否在代码围栏里。
     *
     * ⚠️ 必须**单次遍历**里维护，不能「先扫一遍标记围栏行、再扫一遍抽标题」——
     * 围栏的**内容行**（`# 这是注释`）本身不匹配围栏正则，第一遍根本不会碰它，
     * 于是它被当成普通行去匹配标题，大纲里就凭空多出一个「这是注释」，
     * 点进去落在代码块中间。大纲一旦胡说八道，用户就不敢用了。
     *
     * 闭合规则照 CommonMark：同一种标记（``` 或 ~~~）、长度不短于开围栏那行。
     * 只比字符串是错的（"````" >= "` ``` `" 这种比较没有意义）。
     */
    let fence: { mark: string; len: number } | null = null;

    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 围栏行后面允许跟语言标注（```bash / ~~~js），正则不能要求行尾紧跟
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            const mark = fenceMatch[1][0];
            const len = fenceMatch[1].length;
            if (fence === null) fence = { mark, len };
            else if (mark === fence.mark && len >= fence.len) fence = null;
        }
        if (fence === null) {
            // 标题：1~6 个 # + 空格（或只有 #s）
            // ⚠️ 分组编号别搞错：m[1]=缩进、m[2]=**井号串**、m[3]=分隔空白、m[4]=标题文字。
            // 拿 m[3].length 当层级的话恒等于 1 —— 所有标题都被当成一级，
            // 大纲里一片平级，缩进也跟着全错。
            const m = /^(\s{0,3})(#{1,6})(\s+|$)(.*)$/.exec(line);
            if (m) {
                const level = m[2].length;
                const text = plainTitle(m[4].replace(/\s+#+\s*$/, ""));
                if (level <= maxLevel && text) {
                    out.push({ level, text, offset, line: i });
                }
            }
        }
        offset += line.length + 1; // +1 是换行符
    }
    return out;
}

/** 缩进用的层级：给面板每层一个左缩进（px） */
export function outlineIndent(level: number): number {
    return Math.max(0, level - 1) * 12;
}
