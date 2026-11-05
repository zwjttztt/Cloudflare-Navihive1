// tests/copyBlockRemoved.test.ts
// 复制块功能整体移除后的**静态守卫**（v31 起下线能力，本版连语法一起删）。
//
// 用户判定「复制块功能和预期不符，先全部去除」，后来又追加「笔记中跟复制按键有关的内容
// 全删干净」。移除不等于「以后不许再有人加回来」—— 恰恰相反，历史上有过三次改形态又回退，
// 最容易发生的是某次顺手把一段 CSS / 一个组件 / 一个类型枚举值贴回来。
// 这里从**源码文本**上钉死：复制能力的标识符与 `COPY` 这个类型名都不许再出现。
//
// ⚠️ 为什么要剥注释：移除过程里在两处留了守卫性说明（「COPY 已彻底移除，不要再加回」
//    之类），注释里必然会写出 `COPY` 字样。不剥就会变成永远红的假警报。
// ⚠️ 只扫 src/：tests/ 里这些守卫自己当然要写出这些标识符，扫进去就自相矛盾了。
// ⚠️ 断言一律只比布尔值 / 字符串，不把 DOM 或复杂对象交给 assert.equal
//    （node:assert 失败时会 util.inspect 展开，React fiber 图能把堆打爆）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { MIGRATION_STEPS } from "../src/API/methods/migration";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
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

/** 只要前端源码；别把 .d.ts / 图片 / 日志扫进来制造无关噪音 */
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css"]);

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if (entry.isFile() && SCAN_EXT.has(full.slice(full.lastIndexOf(".")))) {
            out.push(full);
        }
    }
    return out;
}

/**
 * 剥注释：先去 /* ... *\/ 块，再去「行首或空白之后的 // …」行注释。
 * 只认空白后面的 // 是有意的 —— `https://` / `data://` 里的 // 前面是冒号，
 * 切掉会让后面的代码整行消失，守卫反而漏检。
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/gm, "$1");
}

/** 读 src 下的一个文件，并剥掉注释（守卫一律看「代码」而不是「说明」） */
function srcCode(...segments: string[]): string {
    return stripComments(readFileSync(join(ROOT, "src", ...segments), "utf8"));
}

/** 这些标识符任意一个重新出现，就等于复制能力被加回来了 */
const FORBIDDEN: readonly string[] = [
    "md-copy-",        // index.css 的 .md-copy-frag / .md-copy-btn / .md-copy-host
    "data-copy-op",    // 片段与整块按钮的事件钩子
    "CopyFragment",    // 渲染层的可复制片段组件（也覆盖 buildCopyBlockSource）
    "CopyBlock",       // 渲染层的整块组件
    "onInsertCopyBlock", // 工具栏 / hook / ctx 的插入入口
    // 语法名本身（大写）。`CALLOUT_TYPES` 里重新出现 "COPY" 就等于把下线的功能
    // 复活了一半：解析层认它、渲染层却没有任何复制实现，得到的是「长得像内容块、
    // 但点了没反应」的僵尸；反过来它不在枚举里、脏数据就由迁移负责洗（见下面第 3 条）。
    "COPY",
];

/**
 * 「只允许出现在这些文件里」的标识符 → 白名单（相对 src/ 的路径，正斜杠）。
 *
 * `COPY` 必须豁免迁移：`stripCopyCalloutMarkers` 干的活就是**识别并删掉**
 * 历史数据里的 `> [!COPY]` 字面量，它不写这几个字就无从下手。
 * 这是全仓唯一合法的地方，其余任何文件出现 `COPY` 都算把语法加回来了。
 */
const ALLOWED_IN: Readonly<Record<string, readonly string[]>> = {
    COPY: ["API/methods/migration.ts"],
};

test("复制能力已彻底移除：src/ 源码里不许再出现任何复制块标识符", () => {
    const files = sourceFiles(join(ROOT, "src"));
    assert.ok(files.length > 100, `扫到的源码文件只有 ${files.length} 个，路径可能不对`);
    const hits: string[] = [];
    for (const file of files) {
        const rel = relative(join(ROOT, "src"), file).replace(/\\/g, "/");
        const code = stripComments(readFileSync(file, "utf8"));
        for (const token of FORBIDDEN) {
            if (!code.includes(token)) continue;
            const allowed = ALLOWED_IN[token];
            if (allowed && allowed.includes(rel)) continue;
            hits.push(`src/${rel} → ${token}`);
        }
    }
    assert.equal(
        hits.length,
        0,
        `复制块功能被重新引入了：\n  ${hits.join("\n  ")}\n` +
            "用户已明确要求「先全部去除，后续再考虑重新做」，要恢复必须走新方案评审。"
    );
});

test("COPY 语法已彻底移除：CALLOUT_TYPES 不含 COPY，渲染层也没有它的分支", () => {
    const callout = srcCode("utils", "markdownCallout.ts");
    const decl = /CALLOUT_TYPES\s*=\s*\[([^\]]+)\]/.exec(callout);
    assert.ok(decl, "找不到 CALLOUT_TYPES 声明");
    assert.equal(
        decl![1].toUpperCase().includes("COPY"),
        false,
        "CALLOUT_TYPES 又含 COPY 了 —— 语法已下线，脏数据由迁移 notes-copy-callout-marker 清洗"
    );

    // 渲染层：颜色板里不许再有 COPY 键，也不许再有 `type === "COPY"` 这种分支。
    // 语法删干净之后，`CALLOUT_STYLE` 是 Record<CalloutType, …>，多一个键 tsc 就会红；
    // 这条再从文本上钉一次，免得有人顺手连类型一起放宽。
    const react = srcCode("utils", "markdownToReact.tsx");
    assert.equal(
        react.includes("COPY"),
        false,
        "markdownToReact.tsx 里还有 COPY —— 语法已删，任何 COPY 分支/色板键都是残留"
    );
});

// 这条钉的是「被删掉的东西现在归谁管」：语法没了，历史数据必须靠数据迁移洗，
// 否则那条 `> [!COPY]` 源码会一直以文字形式杵在用户正文里。
test("历史数据靠迁移收尾：MIGRATION_STEPS 里必须有 notes-copy-callout-marker", () => {
    const ids = MIGRATION_STEPS.map(step => step.id);
    assert.equal(
        ids.includes("notes-copy-callout-marker"),
        true,
        "删掉 COPY 语法却没登记清洗步骤 —— 线上历史笔记会一直显示 `[!COPY]` 字样"
    );
    // 步骤 id 是**稳定契约**（跑过的步骤记在 configs.schema.steps 里）：
    // 重名会让记账集合出现歧义，改名等于让老库把它重跑一遍。
    assert.equal(
        ids.filter(id => id === "notes-copy-callout-marker").length,
        1,
        "迁移步骤 id 不许重复"
    );

    // ⚠️ 剥注释再查：文件里有多处「不动 updated_at」的说明文字，
    //    不剥的话那条禁止性断言会被自己的注释判红。
    const migration = srcCode("API", "methods", "migration.ts");
    // 注册了步骤但方法不存在 = 一条空转的步骤（tsc 会拦，这里再钉一次文本）
    assert.equal(
        /migrateStripCopyCalloutMarkers\s*:\s*async function/.test(migration),
        true,
        "migrateStripCopyCalloutMarkers 实现不见了"
    );
    // 纯函数必须是导出的、签名就是 (string) => string —— 迁移与测试共用同一份口径
    assert.equal(
        /export function stripCopyCalloutMarkers\s*\(\s*content:\s*string\s*\)\s*:\s*string/.test(
            migration
        ),
        true,
        "stripCopyCalloutMarkers 必须是导出的 (content: string) => string"
    );
    // 写回语句的两条硬约束：rev 必须 +1（客户端缓存靠它失效），
    // 且**不许**顺手写 updated_at（那一列决定笔记列表排序，洗数据不该重排用户的笔记）。
    assert.equal(
        /UPDATE\s+notes\s+SET\s+content\s*=\s*\?,\s*rev\s*=\s*rev\s*\+\s*1\s+WHERE\s+id\s*=\s*\?/i.test(
            migration
        ),
        true,
        "写回必须是 `UPDATE notes SET content = ?, rev = rev + 1 WHERE id = ?`"
    );
    assert.equal(
        /UPDATE\s+notes\s+SET[^"'`]*updated_at/i.test(migration),
        false,
        "迁移不许改 updated_at —— 那会把用户的笔记列表顺序重排一遍"
    );
});

// ⚠️ 定位：上面那条静态扫描只防「换名以外」的原样贴回（`CopyFragment` / `.md-copy-*` /
//    `onInsertCopyBlock` / `COPY` 这些固定标识符）。如果将来有人换一套名字重写（比如
//    `CopySnippet` + `data-clip-op`），静态层**不会**红 —— 那是行为层
//    `tests/copyBlockRemoved.dom.test.tsx` 的职责（它断言渲染结果里没有任何可点的
//    复制单元、正文完整），别把静态守卫当成「功能不存在」的完整证明。
test("工具栏不再暴露「复制块」按钮与 prop", () => {
    const toolbar = srcCode("components", "notes", "markdownToolbar.tsx");
    // ⚠️ 用正则而不是写死单引号字面量：JSX 里属性可以写成 `="copyblock"` /
    //    `={'copyblock'}` / `={"copyblock"}`，旧断言只认 `='copyblock'`，
    //    把按钮用双引号加回来就静默漏检（QA 独立复核抓到）。
    assert.equal(
        /data-tool\s*=\s*\{?\s*["']copyblock["']/.test(toolbar),
        false,
        "工具栏还有复制块按钮"
    );
    assert.equal(
        /aria-label\s*=\s*\{?\s*["'](?:复制块|复制本块)["']/.test(toolbar),
        false,
        "工具栏还有复制块可访问名（换文案也要抓得住）"
    );
    const ctx = srcCode("components", "notes", "notesPageCtx.ts");
    assert.equal(ctx.includes("onInsertCopyBlock"), false, "页面上下文类型里还挂着复制块回调");
});
