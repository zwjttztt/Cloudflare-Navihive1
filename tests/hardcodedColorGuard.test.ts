// tests/hardcodedColorGuard.test.ts
// P2-7 的复发守卫：src 下的颜色字面量必须**要么走 token、要么在豁免清单里**。
//
// 为什么需要它：index.css 定义了 60+ 个设计 token，组件里却仍有一批 `sx={{ color: "#fff" }}`
// 写死的颜色。单看每一处都无害，累积起来是两件事：
//   1) 换肤 / 暗色有漏网点 —— 硬编码那几处不跟着主题走（真踩到过：MobileTabBar 的角标
//      写死 #fff，而暗色 --accent 是浅蓝 #90caf9，角标数字对比度 1.9:1，等于看不见）；
//   2) 「加皮肤只改 token」这个承诺兑现不了 —— 谁也不知道还剩多少处写死。
//
// 守卫怎么判：扫 src/**/*.{ts,tsx}，剥掉注释后找颜色字面量（#rgb / #rrggbb / rgb(a)）。
//   · 不在豁免清单里的文件 → **一处都不许有**；
//   · 在清单里的 → 数量不得超过 cap（钉住当前值，新增即红）。
// 每条豁免都必须写 reason —— 没写清「为什么必须硬编码」的豁免不许存在。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function findProjectDir(): string {
    for (let dir = process.cwd(), i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();

/** 剥注释：注释里会写「React error #321」「# 号开头」这类假命中 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            // 只剥「整行/行尾注释」，放过字符串里的 http:// 与 url(#id)
            let out = "";
            let quote: string | null = null;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (quote) {
                    out += c;
                    if (c === "\\") {
                        out += line[i + 1] ?? "";
                        i++;
                        continue;
                    }
                    if (c === quote) quote = null;
                    continue;
                }
                if (c === '"' || c === "'" || c === "`") {
                    quote = c;
                    out += c;
                    continue;
                }
                if (c === "/" && line[i + 1] === "/") break;
                out += c;
            }
            return out;
        })
        .join("\n");
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g;

/**
 * `var(--token, #fallback)` 的兜底部分**不算**硬编码 —— 那是刻意的「token 优先、
 * 取不到时还有个能看的值」，正是我们鼓励的写法（ChunkBoundary 就靠它在样式表
 * 没加载出来时仍然可读）。扫之前先把整个 var() 摘掉。
 */
const VAR_WITH_FALLBACK = /var\(\s*--[a-z0-9-]+\s*,[^)]*\)/gi;

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
}

/** 豁免清单：key 是相对仓库根的路径，cap 是**当前**命中数（新增即红） */
const EXEMPT: Record<string, { reason: string; cap: number }> = {
    "src/components/ErrorBoundary.tsx": {
        reason: "整页崩溃时的兜底 UI，必须零依赖（连主题/token 都不能依赖）——它要在「样式表都没加载出来」时也能读",
        cap: 19,
    },
    "src/hooks/useThemeController.ts": {
        reason: "MUI 主题**定义源**本身：这里的字面量是产出方，不是消费方（token 就是照它写的）。2026-10-24 弹窗底色改成 var(--surface-modal) 后从 6 降到 4",
        cap: 4,
    },
    "src/brand.ts": {
        reason: "品牌色定义（themeColor 等），是常量源头不是样式消费",
        cap: 1,
    },
    "src/mermaidSandbox.ts": {
        reason: "独立 iframe 沙箱，不继承宿主样式表，只能直接写色值",
        cap: 2,
    },
    "src/API/mock.ts": {
        reason: "mock 数据里的标签颜色字段值，不是样式",
        cap: 1,
    },
    "src/utils/notesSettings.ts": {
        reason: "外观设置的**默认值**（默认强调色），是数据不是样式",
        cap: 1,
    },
    "src/utils/siteAvatar.ts": {
        reason: "站点 favicon 缺失时按域名哈希取的**调色板**——给用户的是具体颜色值，不是主题语义",
        cap: 16,
    },
    "src/utils/folderAppearance.ts": {
        reason: "文件夹哈希取色的调色板（同上），8 个色是刻意挑的、亮暗两套统一使用",
        cap: 8,
    },
    "src/utils/noteHtmlExport.ts": {
        reason: "导出成**独立 .html 文件**的内嵌 CSS —— 那个文件脱离本站运行，拿不到任何 token",
        cap: 6,
    },
    "src/utils/markdownToReact.tsx": {
        reason: "Markdown 渲染器的局部样式常量（callout / 脚注 / 高亮 / 引用），alpha 是刻意分档的语义层级；归并成 5 档会丢掉分级",
        cap: 25,
    },
    "src/components/BackgroundLayers.tsx": {
        reason: "装饰性极光渐变：两组多段 radial-gradient 是一次性调出来的美术值，没有语义可抽",
        cap: 6,
    },
    "src/components/SettingsDialog.tsx": {
        reason: "用户**可选**的背景渐变预设与强调色色板（`#1976d2` 还是 <input type=color> 的默认值，是数据不是样式）——色板不能跟着主题变，否则用户挑的颜色会自己漂移",
        cap: 23,
    },
    "src/components/EditGroupDialog.tsx": {
        reason: "同上：分组强调色的可选色板",
        cap: 8,
    },
    "src/components/NotesPage.tsx": {
        reason: "两处刻意的实底色：①「暖白」纸感背景（用户可选的外观预设，深色模式下本就不成立）；②抽屉纸面必须实底色（--bg-sunken 近透明，做浮层会「透明虚化」，有注释钉着）",
        cap: 3,
    },
};

const files = walk(path.join(ROOT, "src"));

test("组件里的颜色字面量必须走 token —— 硬编码只许出现在豁免清单里且不许变多", () => {
    const offenses: string[] = [];
    for (const file of files) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        const text = stripComments(readFileSync(file, "utf8")).replace(VAR_WITH_FALLBACK, "");
        const hits = text.match(new RegExp(COLOR_RE.source, "g")) ?? [];
        if (hits.length === 0) continue;
        const rule = EXEMPT[rel];
        if (!rule) {
            offenses.push(`${rel}：有 ${hits.length} 处颜色字面量，且不在豁免清单里`);
            continue;
        }
        assert.ok(rule.reason.length > 10, `${rel} 的豁免必须写清原因`);
        if (hits.length > rule.cap) {
            offenses.push(
                `${rel}：颜色字面量从 ${rule.cap} 涨到 ${hits.length}（豁免只钉住存量，新增请改用 token）`
            );
        }
    }
    assert.deepEqual(offenses, [], `\n${offenses.join("\n")}`);
});

test("豁免清单里的 cap 必须与实际命中数一致（存量清了就把 cap 降下来）", () => {
    const stale: string[] = [];
    for (const file of files) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        const rule = EXEMPT[rel];
        if (!rule) continue;
        const hits =
            stripComments(readFileSync(file, "utf8"))
                .replace(VAR_WITH_FALLBACK, "")
                .match(new RegExp(COLOR_RE.source, "g")) ?? [];
        if (hits.length < rule.cap) {
            stale.push(`${rel}：cap=${rule.cap} 但实际只有 ${hits.length} 处，请把 cap 调低`);
        }
    }
    assert.deepEqual(stale, [], `\n${stale.join("\n")}`);
});

test("新增的 token 必须在亮暗两套主题里都有定义（否则暗色下取不到值）", () => {
    const css = readFileSync(path.join(ROOT, "src", "index.css"), "utf8");
    // 只查 P2-7 新加的那批语义 token
    for (const name of [
        "--success",
        "--danger",
        "--shadow-float",
        "--shadow-chip",
        "--shadow-pop",
        "--neutral-wash",
        "--neutral-hover",
        "--neutral-hairline",
        "--neutral-border",
        "--neutral-strong",
        "--surface-modal",
        "--surface-inset",
        "--logo-plate",
        "--logo-plate-border",
        "--accent-wash",
        "--scrim",
        "--on-scrim",
        "--on-accent",
        "--editor-selection",
        "--editor-match",
        "--editor-match-active",
        "--editor-match-ring",
    ]) {
        const declared = new RegExp(`^\\s*${name}\\s*:`, "m").test(css);
        assert.ok(declared, `${name} 必须在 src/index.css 里声明`);
    }
    // 需要随主题换值的那批，:root 与 .dark 都得有
    // ⚠️ 必须定位到**行首的 `.dark {`**：直接 indexOf(".dark") 会命中注释里提到的
    // 那一次（本文件里 `:root` 之前的注释就写过 .dark），整段切错就成了假通过。
    // ⚠️ .dark 在 index.css 里出现两次（第一次只覆盖滚动条那三个变量），
    // 必须挑**带 --accent 的那一块**——只取第一次会让「暗色里有没有 --success」假通过。
    let darkBlock = "";
    for (const m of css.matchAll(/(?:^|\n)\.dark\s*\{/g)) {
        const body = css.slice(m.index! + m[0].length, css.indexOf("\n}", m.index! + m[0].length));
        if (body.includes("--accent")) {
            darkBlock = body;
            break;
        }
    }
    assert.ok(darkBlock.length > 0, "src/index.css 里找不到带 --accent 的 .dark 块");
    for (const name of [
        "--success",
        "--danger",
        "--shadow-float",
        "--shadow-chip",
        "--shadow-pop",
        "--surface-modal",
        "--surface-inset",
        "--logo-plate",
        "--logo-plate-border",
        "--on-accent",
    ]) {
        assert.ok(
            new RegExp(`^\\s*${name}\\s*:`, "m").test(darkBlock),
            `${name} 必须在 .dark 里也定义一份（暗色下不能用亮色的值）`
        );
    }
    // 遮罩恒黑 → --scrim / --on-scrim 不该在暗色里被改
    assert.ok(
        !new RegExp(`^\\s*--on-scrim\\s*:`, "m").test(darkBlock),
        "--on-scrim 不该在 .dark 里覆盖：遮罩恒为深色，上面只能配白字"
    );
});
