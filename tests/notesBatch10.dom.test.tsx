// ===========================================================================
// 2026-10-07 第十批：分隔线对齐 inkstone / 侧栏切分栏位移 / 编辑区即时渲染修复 /
// 工具栏对齐 inkstone（7 下拉 + 快捷键）/ 打字机 / 快捷键体系 / 阅读位置记忆
// ===========================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 剥掉注释，避免扫到「为什么不用 X」这类说明文字（否则守卫永远红） */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const idx = line.indexOf("//");
            if (idx === -1) return line;
            return /:\/\/[\s\S]*$/.test(line.slice(0, idx)) ? line : line.slice(0, idx);
        })
        .join("\n");
}

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const readSrcFile = (...parts: string[]) =>
    stripComments(readFileSync(join(findProjectDir(), "src", ...parts), "utf-8"));

const readNotesPageForBatch10 = () => readSrcFile("components", "NotesPage.tsx");

// ---------------------------------------------------------------------------
// 快捷键：单表驱动键盘绑定与 UI 显示
// ---------------------------------------------------------------------------

test("快捷键是一张单表：keymap 与菜单显示都从它派生", () => {
    const sc = readSrcFile("utils", "editorShortcuts.ts");
    assert.ok(sc.includes("export const EDITOR_SHORTCUTS"), "必须有那张表");
    assert.ok(
        sc.includes("export function comboFor"),
        "必须有 comboFor(id) —— 工具栏靠它反查，不能各写各的字符串"
    );
    // ⚠️ 这条是这个设计的全部意义：加了快捷键忘了加显示（或者反过来），
    // 用户按了没反应、或者菜单上写着一个按了不响的键 —— 极难发现。
    const editorSrc = readSrcFile("components", "NoteEditor.tsx");
    assert.ok(
        editorSrc.includes("EDITOR_SHORTCUTS.filter"),
        "keymap 必须由 EDITOR_SHORTCUTS 生成，不能另写一份映射"
    );
    assert.ok(
        /toCodeMirrorKey\(s\.combo/.test(editorSrc),
        "keymap 要把 combo 转成 CodeMirror 语法"
    );
    // ⚠️ combo 在表里是**可选**的（有些动作只声明不绑定），所以过滤条件里
    // 必须同时判 combo —— 只判 run 的话 toCodeMirrorKey 会吃到 undefined。
    assert.ok(
        /filter\(s => s\.run && s\.combo\)/.test(editorSrc),
        "生成 keymap 时要同时过滤 run 和 combo（combo 可选，漏判就崩）"
    );
});

test("标题快捷键用 mod+alt+N，不占用数字键（inkstone 的取舍）", () => {
    const sc = readSrcFile("utils", "editorShortcuts.ts");
    for (let i = 1; i <= 6; i++) {
        assert.ok(
            sc.includes(`mod+alt+\${level}`) || sc.includes("mod+alt+"),
            `标题 ${i} 应该有快捷键`
        );
    }
    // 不能出现裸的 mod+1 .. mod+9：那会跟 CodeMirror 自带的 Mod-数字 冲突
    assert.ok(
        !/combo: "mod\+[1-9]"/.test(sc),
        "不能把裸数字键绑成标题（会和 CM 的 Mod-数字 打架）"
    );
    assert.ok(sc.includes('combo: `mod+alt+${level}`'), "标题走 mod+alt+N");
});

test("prettyCombo：mac 用符号、其它平台用文字", () => {
    const sc = readSrcFile("utils", "editorShortcuts.ts");
    assert.ok(sc.includes('isMac ? "⌘" : "Ctrl"'), "mod 在 mac 上是 ⌘");
    assert.ok(sc.includes('isMac ? "⇧" : "Shift"'), "shift 同理");
    assert.ok(sc.includes('isMac ? "⌥" : "Alt"'), "alt 同理");
    assert.ok(sc.includes("return part.length === 1 ? part.toUpperCase()"), "单字符键位大写");
});

test("Kbd 用真正的 <kbd> 标签，且没绑定时不渲染", () => {
    const kbd = readSrcFile("components", "Kbd.tsx");
    assert.ok(kbd.includes("<kbd"), "必须是真 kbd 标签（读屏会念、用户能复制）");
    assert.ok(
        kbd.includes("if (parts.length === 0) return null"),
        "没有快捷键时不能渲染一个空盒子"
    );
});

// ---------------------------------------------------------------------------
// 工具栏：inkstone 的 7 个下拉 + 主按钮双态
// ---------------------------------------------------------------------------

test("工具栏对齐 inkstone：图标下拉 + 主按钮双态", () => {
    const src = readNotesPageForBatch10();
    // inkstone 的 7 个下拉：heading / reference / image / note / code / math / block
    for (const label of ["标题层级", "链接与引用", "插入图片", "笔记工具", "代码块语言", "公式", "块"]) {
        assert.ok(
            src.includes(`aria-label='${label}'`),
            `工具栏应该有「${label}」下拉（inkstone 的 7 个之一）`
        );
    }
    // 「主按钮 + 箭头」双态：点图标直接执行，点箭头开列表
    assert.ok(
        src.includes("data-tool='link-menu'") && src.includes("data-tool='image-menu'"),
        "链接/图片要有独立的下拉箭头按钮（inkstone 的 menuButton 双态）"
    );
    assert.ok(
        src.includes("data-tool='code-menu'"),
        "代码也要有下拉箭头"
    );
});

test("工具栏菜单项右侧显示快捷键（用 Kbd 组件）", () => {
    const src = readNotesPageForBatch10();
    // 标题 7 档都要显示快捷键
    assert.ok(
        src.includes("<Kbd combo={comboFor(h.shortcutId)} />"),
        "标题菜单项右侧要显示快捷键"
    );
    assert.ok(
        src.includes('<Kbd combo={comboFor("link")} />'),
        "链接菜单项要显示快捷键"
    );
    assert.ok(
        src.includes('<Kbd combo={comboFor("comment")} />'),
        "隐藏注释要显示快捷键"
    );
    // 图标按钮的 tooltip 里也带快捷键
    assert.ok(
        src.includes("<Kbd combo={combo} />"),
        "独立图标按钮的 tooltip 要显示快捷键"
    );
});

test("工具栏分组与 inkstone 一致：强调（含高亮/行内代码）| 列表（含引用）", () => {
    const src = readNotesPageForBatch10();
    const groups = src.slice(src.indexOf("const TOOL_GROUPS"), src.indexOf("const CODE_LANGUAGES"));
    // inkstone 的强调组：B I S 高亮 行内代码 —— 5 个
    for (const key of ["bold", "italic", "strike", "highlight", "code"]) {
        assert.ok(groups.includes(`key: "${key}"`), `强调组要有 ${key}`);
    }
    // inkstone 的列表组：无序 有序 任务 引用 —— 4 个
    for (const key of ["ul", "ol", "task", "quote"]) {
        assert.ok(groups.includes(`key: "${key}"`), `列表组要有 ${key}`);
    }
    // 每个可绑定的都要写 shortcutId
    assert.ok(
        (groups.match(/shortcutId:/g) ?? []).length >= 8,
        "可绑定的按钮都要声明 shortcutId，否则 tooltip 不显示快捷键"
    );
});

test("引用不再有独立按钮（已并入列表组，否则工具栏比 inkstone 宽）", () => {
    const src = readNotesPageForBatch10();
    // 只允许列表组里那一个 data-tool='quote'
    const count = (src.match(/data-tool='quote'/g) ?? []).length +
        (src.match(/key: "quote"/g) ?? []).length;
    assert.equal(count, 1, "引用只能出现一次（列表组里），不该有第二个独立按钮");
});

test("提示框并进「块」下拉（inkstone 就是这么放的）", () => {
    const src = readNotesPageForBatch10();
    const blockMenu = src.slice(src.indexOf('aria-label=\'块\''), src.indexOf('data-block-op=\'divider\''));
    assert.ok(
        blockMenu.includes("data-callout-type"),
        "提示框类型应该在「块」下拉里，而不是另开一个菜单"
    );
});

test("标题下拉 7 档，且用 setHeadingLevel 而不是加前缀", () => {
    const src = readNotesPageForBatch10();
    const levels = src.slice(src.indexOf("const HEADING_LEVELS"), src.indexOf("/**", src.indexOf("const HEADING_LEVELS")));
    for (const lv of ["0", "1", "2", "3", "4", "5", "6"]) {
        assert.ok(levels.includes(`level: "${lv}"`), `标题下拉要有 ${lv} 档`);
    }
    assert.ok(
        src.includes("onSetHeading(h.value)"),
        "必须走 setHeadingLevel（会先剥旧前缀），不能走 insertLinePrefix（会叠成 ###）"
    );
});

test("setHeadingLevel 会剥掉已有前缀（换层级而不是往上叠）", () => {
    const tools = readSrcFile("hooks", "useEditorTools.ts");
    assert.ok(tools.includes("const setHeadingLevel"), "要有 setHeadingLevel");
    // ⚠️ 这是它存在的全部理由：无条件加前缀会让「二级上点一级」变成三级
    assert.ok(
        tools.includes('replace(') && tools.includes('#{1,6}'),
        "必须先把已有的标题前缀剥掉"
    );
    assert.ok(
        /\\d\+\[\.\)\]/.test(tools),
        "也要剥掉有序列表前缀（列表转标题是常用操作）"
    );
});

// ---------------------------------------------------------------------------
// 分隔线：inkstone 的 Resizer 公式
// ---------------------------------------------------------------------------

test("分隔条照 inkstone：命中区 9px + 负边距 −4px + 内含 1px 线", () => {
    const src = readNotesPageForBatch10();
    const handle = src.slice(src.indexOf("function ColResizeHandle"), src.indexOf("const AUTO_SAVE_MS"));
    assert.ok(handle.includes("width: 9"), "命中区 9px（inkstone 的 w-[9px]）");
    assert.ok(handle.includes('mx: "-4px"'), "负外边距 −4px（inkstone 的 -mx-[4px]，实际可点 ≈17px）");
    assert.ok(handle.includes("& > span"), "线要用真 span 画（::after 量不到宽度，测不了）");
    assert.ok(handle.includes('left: "50%"'), "线要居中");
    // inkstone：静止 1px、hover/拖动 2px 强调色，没有发光也没有阴影
    assert.ok(handle.includes("var(--accent)"), "hover/拖动变强调色");
    assert.ok(
        !/boxShadow|filter:|gradient/.test(handle),
        "不要加发光/阴影/渐变 —— inkstone 那种「只有一根细线」反而更好看"
    );
});

test("分屏两栏无框（之前给两栏套边框+圆角+淡底色，很脏）", () => {
    const src = readNotesPageForBatch10();
    assert.ok(
        !/border:\s*pane === "split"/.test(src),
        "源码区/预览区都不该再有完整边框"
    );
    assert.ok(!/borderRadius: pane === "split"/.test(src), "不该再有圆角边框");
    assert.ok(!/bgcolor:\s*pane === "split"/.test(src), "不该再有淡底色");
    // 分隔由那根线负责
    assert.ok(
        (src.match(/role='separator'/g) ?? []).length >= 3,
        "主栏分屏 / 侧栏分栏 / 两篇笔记之间都该有 separator"
    );
});

test("分隔条键盘可达（Tab 聚焦 + 方向键 + Home/End + 双击复位）", () => {
    const src = readNotesPageForBatch10();
    const handle = src.slice(src.indexOf("function ColResizeHandle"), src.indexOf("const AUTO_SAVE_MS"));
    assert.ok(handle.includes("tabIndex={0}"), "要能 Tab 聚焦");
    assert.ok(handle.includes("ArrowLeft") && handle.includes("ArrowRight"), "方向键调比例");
    assert.ok(handle.includes("onDoubleClick={onReset}"), "双击复位");
    assert.ok(handle.includes("aria-valuenow"), "要报 aria-valuenow");
    assert.ok(
        handle.includes("onNudge"),
        "要接一个键盘微调回调，否则方向键没反应"
    );
});

// ---------------------------------------------------------------------------
// 即时渲染：块行号开区间（本次最关键的 bug）
// ---------------------------------------------------------------------------

test("即时渲染：块行号是开区间，单行段落才渲染得出来", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    // ⚠️ 旧实现 endLine 是闭区间，`endLine <= startLine` 把所有单行段落判成空块跳过，
    // 而真实笔记里绝大多数段落都是单行 → 用户看到「开了没反应」。
    assert.ok(
        src.includes("flush(lines.length)"),
        "末尾 flush 要用行数（开区间），不能用 lines.length - 1"
    );
    assert.ok(
        src.includes("state.doc.line(Math.min(block.endLine, state.doc.lines)).to"),
        "右边界用开区间 endLine"
    );
});

test("即时渲染有异步兜底（渲染失败显示原文，不能整块空白）", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    assert.ok(
        src.includes(".catch("),
        "渲染管线是异步的（markdown-it 动态 import），失败必须有兜底"
    );
    assert.ok(
        src.includes("note-live-block-fallback"),
        "兜底要显示原文 —— 宁可丑也不能让文档少几段"
    );
});

test("即时渲染有行内语法级渲染（源码态的 **粗体** 也要显示成粗体）", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    assert.ok(src.includes("syntaxTree"), "要用 CM 的语法树");
    assert.ok(src.includes("cm-live-strong"), "StrongEmphasis → cm-live-strong");
    assert.ok(src.includes("cm-live-em"), "Emphasis → cm-live-em");
    assert.ok(src.includes("cm-live-heading"), "ATXHeading → cm-live-heading");
    assert.ok(
        src.includes("visibleRanges"),
        "只给可见范围加 mark 装饰（全量加在长文上会卡）"
    );
});

test("即时渲染跟随聚焦态（点到别处整篇都是渲染态）", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    assert.ok(
        src.includes("live.focused || !r.empty"),
        "未聚焦时空选区不算落在块里（inkstone 同款判定）"
    );
    assert.ok(
        src.includes("focusChanged"),
        "要有 focus/blur 的 StateEffect"
    );
});

test("打字机模式：光标行居中，但鼠标拖选时不接管", () => {
    const tw = readSrcFile("components", "NoteTypewriter.ts");
    assert.ok(tw.includes("lineBlockAt"), "按光标所在行块算居中目标");
    assert.ok(tw.includes("mouseSelection"), "要判断鼠标拖选");
    assert.ok(
        tw.includes("if (this.mouseSelection) return"),
        "拖选中必须不接管滚动（否则选文字时视口乱跑）"
    );
    // 用 Compartment 热插拔：不重建编辑器，撤销历史保留
    assert.ok(tw.includes("export const typewriterCompartment"), "要用 Compartment");
    // 差值小于 1px 不写：否则每次按键都触发 scroll，滚动同步跟着抖
    assert.ok(
        tw.includes("Math.abs(next - scroller.scrollTop) > 1"),
        "滚动差值小于 1px 要跳过，否则滚动同步会抖"
    );
});

test("阅读位置记忆：按账号+笔记分桶，记比例不记像素", () => {
    const rp = readSrcFile("utils", "readingPosition.ts");
    assert.ok(rp.includes("account"), "必须按账号分桶（否则切换账号会串味）");
    assert.ok(rp.includes("noteId"), "必须按笔记分桶");
    assert.ok(
        rp.includes("Number.isFinite(n) && n >= 0 && n <= 1"),
        "读回要校验比例合法（脏数据不能让滚动条飞出屏幕）"
    );
    assert.ok(
        rp.includes("catch"),
        "隐私模式读不了要静默返回 null，不能抛"
    );
    // 恢复要处理「内容还没量高」
    const handle = readSrcFile("utils", "noteEditorHandle.ts");
    assert.ok(
        handle.includes("requestAnimationFrame"),
        "切笔记时长文要几帧才撑开高度，恢复必须重试一次"
    );
    assert.ok(
        handle.includes("scrollRatio") && handle.includes("restoreScrollRatio"),
        "handle 要暴露滚动比例的存取"
    );
});

test("打字机/阅读位置在设置里有开关，且默认值的取舍说得通", () => {
    const st = readSrcFile("utils", "notesSettings.ts");
    assert.ok(st.includes("typewriterMode: boolean"), "打字机要有设置项");
    assert.ok(st.includes("rememberPosition: boolean"), "阅读位置要有设置项");
    // 打字机默认关：它会改变滚动行为，不是每个人都习惯
    assert.ok(
        st.includes("typewriterMode: false"),
        "打字机默认关（会接管滚动，得让用户主动开）"
    );
    assert.ok(
        st.includes("rememberPosition: true"),
        "阅读位置默认开（符合预期且没有副作用）"
    );
    assert.ok(
        st.includes("typewriterMode: bool(") && st.includes("rememberPosition: bool("),
        "两个都要过 sanitize 兜底"
    );
});
