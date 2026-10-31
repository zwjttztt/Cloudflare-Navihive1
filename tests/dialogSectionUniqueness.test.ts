// tests/dialogSectionUniqueness.test.ts
// 「弹窗小节」排版件的**唯一性守卫**（2026-10-31 视觉收敛）。
//
// 为什么要有这条守卫：收敛前，同一个设置中心里并存四套「小节标题」实现 ——
//   · components/dialogSection.tsx  Section（3px 竖条 + subtitle2 + 可选 hint）
//   · components/AccountDialog.tsx  Section（与上面**逐字重复**的一份拷贝）
//   · components/StatsPanel.tsx     SectionTitle（无竖条，靠 mt:2 / mb:1 分节）
//   · components/PasswordHealthDialog.tsx SectionTitle（带 icon，字重 700）
// 四套的差别只在「有没有竖条 / 有没有 icon / 上下留白多少」。单看每一处都合理，
// 放在一起就是「左栏切一屏，小标题换一种长相」—— 这正是用户说的「不够统一」。
//
// 这类回归**肉眼很难发现、类型检查完全看不见**（四个函数签名兼容，编译照过），
// 只有换屏对比才看得出来。所以在这儿把「只允许一处实现」钉死。
//
// 判据分两段：
//   ① 正向：全仓 src/components/** 里，除 dialogSection.tsx 外不许再出现
//      Section / SectionTitle 的**定义**（只许 import 使用）；
//   ② 反向：喂一段带本地 Section 定义的假源码，确认守卫真的会点名 ——
//      否则「永远匹配不到」会退化成假绿（navihive 里已有过这种教训）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();

/** 唯一允许定义小节排版件的文件（相对项目根，统一用 / 分隔） */
const ALLOWED = "src/components/dialogSection.tsx";

/** 被守护的两个名字：新增别的小节原语请加进这个表，并想清楚为什么不能再共用 */
const GUARDED_NAMES = ["Section", "SectionTitle"];

/**
 * 剥注释，**保留行号与列位**：块注释换成等量空格（含换行），行注释直接切掉。
 *
 * 保留行号是为了失败信息能直接点名 file:line —— 只说「某处又定义了一个 Section」
 * 等于让人自己去全仓翻。行注释里可能写着 `// function Section(...)` 这种说明，
 * 不剥掉就会假红。
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            if (i < 0) return line;
            // `https://` 里的 // 不是注释
            return line.slice(0, i).includes("://") ? line : line.slice(0, i);
        })
        .join("\n");
}

export interface SectionDefHit {
    /** 相对项目根的路径，如 src/components/StatsPanel.tsx */
    file: string;
    /** 1 起的行号 */
    line: number;
    /** 命中的名字（Section / SectionTitle） */
    name: string;
    /** 原始那一行的内容（去掉首尾空白），便于定位 */
    text: string;
}

/**
 * 在**一份**源码里找小节排版件的定义。
 *
 * 只认定义，不认使用：
 *   · `function Section(`            ← 命中
 *   · `export function Section<T>(`  ← 命中
 *   · `const Section = ...`          ← 命中
 *   · `const Section: FC<P> = ...`   ← 命中
 *   · `let/var Section = ...`        ← 命中（防「换关键字绕过」）
 *   · `function SectionHeading(`     ← **不**命中（共用件自己的名字，合法）
 *   · `<Section title=...>`          ← 不命中
 *   · `import { Section }`           ← 不命中
 */
export function findSectionDefs(file: string, src: string): SectionDefHit[] {
    const code = stripComments(src);
    const lines = code.split("\n");
    const hits: SectionDefHit[] = [];
    const declaration = new RegExp(
        // 行首（允许缩进）+ 可选 export / async，然后是 function 或 const/let/var
        `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+(${GUARDED_NAMES.join("|")})\\b`
    );
    lines.forEach((line, index) => {
        const m = line.match(declaration);
        if (!m) return;
        hits.push({
            file,
            line: index + 1,
            name: m[1] ?? "",
            // 用原文那一行（剥注释后行号一致，直接取剥过的也没问题）
            text: line.trim().slice(0, 80),
        });
    });
    return hits;
}

/** 递归收集 src/components 下的 .ts / .tsx（跳过测试与目录） */
function collectSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectSources(full));
            continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
        out.push(full);
    }
    return out;
}

test("全仓只允许 dialogSection.tsx 定义 Section / SectionTitle", () => {
    const files = collectSources(join(ROOT, "src/components"));
    assert.ok(files.length > 20, `扫描到的源文件太少（${files.length}），路径大概错了`);

    const offenders: SectionDefHit[] = [];
    for (const full of files) {
        const rel = relative(ROOT, full).split("\\").join("/");
        if (rel === ALLOWED) continue;
        offenders.push(...findSectionDefs(rel, readFileSync(full, "utf8")));
    }

    assert.deepEqual(
        offenders.map(h => `${h.file}:${h.line} → ${h.text}`),
        [],
        "小节排版件只能有一处实现（src/components/dialogSection.tsx）。" +
            "上面这些文件又各自写了一份 —— 单看每处都合理，但换一屏小标题就换一种长相，" +
            "用户看到的就是「这个设置中心不统一」。请改成从 dialogSection 导入 Section / SectionHeading。"
    );
});

test("共用件本身还在（否则上一条会因为「找不到定义」而假绿）", () => {
    const src = readFileSync(join(ROOT, ALLOWED), "utf8");
    const names = findSectionDefs(ALLOWED, src).map(h => h.name);
    assert.ok(names.includes("Section"), "dialogSection.tsx 里必须还有 Section");
    // SectionHeading 是「只要标题行」的那个出口，与 Section 共用同一段渲染
    assert.equal(
        findSectionDefs(ALLOWED, src).filter(h => h.name === "Section").length,
        1,
        "Section 只该定义一次"
    );
    assert.match(
        src,
        /export function SectionHeading\b/,
        "SectionHeading 必须由共用件导出 —— StatisticsPanel / PasswordHealthDialog 只用标题行"
    );
});

test("反向验证：喂一段本地 Section 定义，守卫必须点名（file:line 要对）", () => {
    const fake = [
        "// 假装这是一个面板文件",
        "import { Box } from '@mui/material';",
        "",
        "function Section({ title }: { title: string }) {",
        "    return <Box>{title}</Box>;",
        "}",
        "",
        "/** 又一份：只写标题的版本 */",
        "const SectionTitle = ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>;",
        "",
        "function SectionHeading() {} // 共用件自己的名字，不该被误判",
    ].join("\n");

    const hits = findSectionDefs("src/components/FakePanel.tsx", fake);
    assert.deepEqual(
        hits.map(h => `${h.file}:${h.line}:${h.name}`),
        ["src/components/FakePanel.tsx:4:Section", "src/components/FakePanel.tsx:9:SectionTitle"],
        "两处定义都要命中，SectionHeading 与非定义行不能命中"
    );
});

test("反向验证：注释里写的 function Section 不算回归", () => {
    const fake = [
        "// 这里原来有一份 function Section(...)，已收敛到 dialogSection",
        "/*",
        " function SectionTitle() {}",
        "*/",
        "export const ok = 1;",
    ].join("\n");
    assert.deepEqual(findSectionDefs("src/components/X.tsx", fake), []);
});
