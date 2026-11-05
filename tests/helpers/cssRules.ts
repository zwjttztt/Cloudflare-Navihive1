// tests/helpers/cssRules.ts
// 从 index.css 源码里索引出「选择器 + 声明体 + 它所在的 @ 条件（@media / @supports）」。
//
// 为什么需要它：样式守卫经常要问「这条声明在什么设备条件下才生效」。
// 2026-11-05 的方案三把整块复制按钮改成「悬停才显形」，判据从「任何规则都不许
// opacity: 0」变成「藏，只许藏在 hover-capable 的媒体查询里，并且触屏要显式写回可见」。
//
// ⚠️ 用 `/([^{}]+)\{([^{}]*)\}/g` 那种一把抓的正则**做不到**这件事：
//    `@media (…) {` 里的 `{` 把匹配起点顶到内层规则上，抓出来的选择器是
//    `.md-copy-btn`、包着它的媒体条件是空的 —— 守卫会「看起来在测媒体查询」，
//    实际什么也没测到（这类守卫比没有更糟：它给出一片假绿灯）。
//    所以要按花括号配对逐层下潜，把当前所在的 @ 条件记下来。

export interface CssRule {
    /** 选择器原文（@media / @supports 里的规则就是内层选择器） */
    selector: string;
    /** 花括号里的声明体 */
    body: string;
    /** 外包的 @ 条件，多层用空格连起来；顶层规则是空串 */
    media: string;
}

/**
 * 剥掉 CSS 块注释。
 * 守卫要扫源码，而注释里常写着「静止 opacity: 0」这种**说明文字**，
 * 不剥就会变成永远红的假警报。
 */
export function stripCssComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 把 CSS 源码索引成规则表（调用前请先 stripCssComments） */
export function indexCssRules(css: string): CssRule[] {
    const rules: CssRule[] = [];
    const atStack: string[] = [];
    let prelude = "";
    let i = 0;
    while (i < css.length) {
        const ch = css[i];
        if (ch === "{") {
            const head = prelude.trim();
            prelude = "";
            if (head.startsWith("@")) {
                // @media / @supports / @keyframes：下潜一层，记住条件
                atStack.push(head);
                i += 1;
                continue;
            }
            // 普通规则：声明体里不会有花括号，直接找到配对的那个 `}`
            const end = css.indexOf("}", i);
            if (end < 0) break;
            rules.push({ selector: head, body: css.slice(i + 1, end), media: atStack.join(" ") });
            i = end + 1;
            continue;
        }
        if (ch === "}") {
            atStack.pop();
            prelude = "";
            i += 1;
            continue;
        }
        prelude += ch;
        i += 1;
    }
    return rules;
}

/** 取规则体里某条声明的值（没写就是 undefined） */
export function declOf(body: string, prop: string): string | undefined {
    const hit = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body.replace(/\s+/g, " "));
    return hit ? hit[1].trim() : undefined;
}

/** 规则体里声明的不透明度（没写 / 非数字就是 undefined） */
export function opacityOf(body: string): number | undefined {
    const value = declOf(body, "opacity");
    if (value === undefined) return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** 这条规则是否在「有 hover 的设备」条件下生效 */
export function isHoverCapable(rule: CssRule): boolean {
    return /hover\s*:\s*hover/.test(rule.media);
}

/** 这条规则是否在「没有 hover 的设备」条件下生效 */
export function isNoHover(rule: CssRule): boolean {
    return /hover\s*:\s*none/.test(rule.media);
}
