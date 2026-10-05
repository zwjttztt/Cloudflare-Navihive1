// 图标按钮的可访问名守卫。
//
// 为什么需要：图标按钮在视觉上就是一个图标，读屏用户只能听到「按钮」——
// 不知道是「删除」还是「复制」。这类缺陷**任何截图对比和冒烟测试都发现不了**，
// 只能靠静态扫描钉住。
//
// ⚠️ 这条用例的第一版写错过一次，值得记下来：
// 它用 `<IconButton\b([\s\S]{0,600}?)(?:\/>|>)` 找标签的结束位置，
// 而 `onClick={() => ...}` 里的 **`>`**（箭头函数的 `=>`）被当成了结束符 ——
// 属性列表在 `=>` 处就被截断，后面的 `aria-label` 自然看不见。
// 结果报出「51 个里有 9 个缺可访问名」，而实际上**一个不缺**（2026-10-05 更正）。
//
// 所以下面这个扫描是手写状态机：遇到 `=` 且下一个字符是 `>` 时跳过（那是箭头函数），
// 只认真正的 `/>` 或落单的 `>`。别为了简洁把它改回正则。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith(".tsx")) out.push(full);
    }
    return out;
}

interface ButtonSite {
    file: string;
    line: number;
    tag: string;
}

/** 找出所有 IconButton 标签（含起止行号与属性段） */
function iconButtons(source: string): ButtonSite[] {
    const found: ButtonSite[] = [];
    let idx = 0;
    while ((idx = source.indexOf("<IconButton", idx)) !== -1) {
        const line = source.slice(0, idx).split("\n").length;
        // 从标签名之后开始找真正的结束
        let i = idx + "<IconButton".length;
        let end = -1;
        while (i < source.length - 1) {
            if (source[i] === "/" && source[i + 1] === ">") {
                end = i + 2;
                break;
            }
            // 箭头函数的 => 不是标签结束，跳过
            if (source[i] === "=" && source[i + 1] === ">") {
                i += 2;
                continue;
            }
            if (source[i] === ">") {
                end = i + 1;
                break;
            }
            i++;
        }
        if (end === -1) end = Math.min(source.length, idx + 600);
        found.push({ file: "", line, tag: source.slice(idx, end) });
        idx = end;
    }
    return found;
}

test("每个 IconButton 都有可访问名（aria-label / aria-labelledby / aria-hidden）", () => {
    const root = findProjectDir();
    const files = walk(join(root, "src", "components"));
    assert.ok(files.length > 0, "没扫到任何 .tsx 组件，口径坏了");

    const offenders: string[] = [];
    let total = 0;
    for (const file of files) {
        const source = readFileSync(file, "utf-8");
        for (const b of iconButtons(source)) {
            total++;
            if (!/aria-label|aria-labelledby|aria-hidden/.test(b.tag)) {
                offenders.push(`${relative(root, file)}:${b.line}`);
            }
        }
    }

    assert.ok(total > 0, "一个 IconButton 都没扫到，口径坏了");
    assert.deepEqual(
        offenders,
        [],
        `这些图标按钮读屏只会念出「按钮」：\n  ${offenders.join("\n  ")}\n` +
            `要么给 aria-label，要么是纯装饰（那就 aria-hidden 藏起来）。`
    );
});

test("IconButton 守卫的扫描口径没被改坏（扫到的数量要是合理的）", () => {
    // 这条不是给产品用的，是给上面那条用例的**自检**：
    // 一旦有人把状态机改回正则，`=>` 截断会重新出现，误报会卷土重来。
    // 真实的 IconButton 数量在几十的量级；如果扫出 0 个或只剩个位数，说明口径坏了。
    const root = findProjectDir();
    const files = walk(join(root, "src", "components"));
    let total = 0;
    for (const file of files) {
        total += iconButtons(readFileSync(file, "utf-8")).length;
    }
    assert.ok(
        total >= 30,
        `只扫到 ${total} 个 IconButton，太少了 —— 扫描口径多半又坏了` +
            `（真实数量在 50 上下；扫不出来通常是把 => 当成了标签结束）。`
    );
});

test("aria-label 不是空字符串或纯空白", () => {
    // 有名字但名字是空的，等于没有。顺带挡一下写成占位符的（"button" / "按钮"）。
    const root = findProjectDir();
    const files = walk(join(root, "src", "components"));
    const bad: string[] = [];
    for (const file of files) {
        const source = readFileSync(file, "utf-8");
        for (const b of iconButtons(source)) {
            const m = b.tag.match(/aria-label=(?:"([^"]*)"|'([^']*)')/);
            if (m) {
                const value = (m[1] ?? m[2] ?? "").trim();
                if (!value || value === "button" || value === "按钮") {
                    bad.push(`${relative(root, file)}:${b.line} -> ${JSON.stringify(value)}`);
                }
            }
        }
    }
    assert.deepEqual(bad, [], `这些 aria-label 等于没写：\n  ${bad.join("\n  ")}`);
});

// 让 TS 知道 statSync 被用到（walk 用的是 readdirSync，这里保留一个直接引用以免 lint 报未使用）
void statSync;
