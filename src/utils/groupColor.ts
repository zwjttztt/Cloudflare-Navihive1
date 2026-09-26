// src/utils/groupColor.ts
// 分组自动配色：按分组 id 稳定地映射到一组色相上，让分组之间一眼能分开。
// 用哈希而不是「按序号取色」是因为分组会被删除、重排，序号一变颜色就跟着跳。
const HUES = [4, 24, 42, 96, 142, 172, 199, 232, 262, 320];

function hueOf(id: number): number {
    // 分组 id 可能为负（本地虚拟分组），取绝对值保证落在数组范围内
    const n = Math.abs(Math.trunc(id)) || 0;
    return HUES[n % HUES.length];
}

/** HSL → RGB（0~255），只用来算相对亮度 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r1, g1, b1] =
        hp < 1 ? [c, x, 0]
        : hp < 2 ? [x, c, 0]
        : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c]
        : hp < 5 ? [x, 0, c]
        : [c, 0, x];
    const m = l - c / 2;
    return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

/** WCAG 相对亮度 */
function relLum([r, g, b]: [number, number, number]): number {
    const lin = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fgLum: number, bgLum: number): number {
    return (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
}

// 亮色下页面底色接近纯白
const LIGHT_BG_LUM = 1;
// AA 对正文的要求是 4.5；分组名是 12px 小字，按正文标准算，留一点余量
const TARGET_RATIO = 4.6;

/**
 * 求「在亮底上刚好达标的最亮值」。
 *
 * 这里不能所有色相共用一个亮度：HSL 的 L 只是名义亮度，同样 L 下
 * 黄绿（色相约 96）比蓝紫亮得多。原来统一给 46%，橙色分组勉强够、
 * 绿色分组只有 3 左右 —— 实测「常用工具」这个 12px 标题就只有 4.06。
 * 改成按色相二分、各自取满足对比度的最大值，既都达标又尽量鲜艳。
 */
function lightLightness(hue: number, sat: number): number {
    let ok = 0.1; // 这个亮度一定达标
    let bad = 0.72; // 这个亮度一定不达标
    for (let i = 0; i < 24; i++) {
        const mid = (ok + bad) / 2;
        if (contrast(relLum(hslToRgb(hue, sat, mid)), LIGHT_BG_LUM) >= TARGET_RATIO) {
            ok = mid; // 还能再亮一点
        } else {
            bad = mid;
        }
    }
    return ok;
}

const LIGHT_SAT = 0.62;
// 算一次就够：色相一共 10 个，缓存掉重复的二分
const lightCache = new Map<number, number>();

function lightAccent(hue: number): string {
    let l = lightCache.get(hue);
    if (l === undefined) {
        l = lightLightness(hue, LIGHT_SAT);
        lightCache.set(hue, l);
    }
    // 固定一位小数：避免浮点尾数每次渲染都不一样，导致内联样式抖动
    return `hsl(${hue} ${LIGHT_SAT * 100}% ${(l * 100).toFixed(1)}%)`;
}

/**
 * 分组强调色。亮色按对比度反推亮度；暗色背景本身很暗，
 * 原来的 68% 亮度实测全部达标（扫描 0 处不合格），保持不动。
 */
export function groupAccent(id: number, mode: "light" | "dark"): string {
    const h = hueOf(id);
    return mode === "dark" ? `hsl(${h} 68% 68%)` : lightAccent(h);
}
