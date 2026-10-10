// tests/noteCompletion.dom.test.tsx
// 编辑器自动补全（`[[` / `#` / 围栏语言）：用**真** EditorState + CompletionContext 跑，
// 断言的是「在某个位置、应该吐出什么候选」，而不是「函数存在」。
//
// 为什么必须真环境：这三个 source 全是正则 + 二分位置的活儿，
// mock 一个假的 context 很容易写成「怎么测都过」的假绿
// （比如把 `matchBefore` 换成自己想当然的字符串，测的是空气的匹配结果）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { act, createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import NoteEditor from "../src/components/NoteEditor";
import type { NoteEditorHandle } from "../src/utils/noteEditorHandle";
import {
    codeFenceSource,
    tagSource,
    wikiLinkSource,
    type CompletionSources,
} from "../src/utils/noteCompletion";

const SOURCES: CompletionSources = {
    notes: () => [
        { id: 1, title: "季度复盘", excerpt: "这是第一季度的工作总结，篇幅很长很长很长很长", },
        { id: 2, title: "读书笔记", excerpt: "" },
        // 故意留一条大小写不同、名字相同的：去重必须生效，否则面板里会出两条
        { id: 3, title: "季度复盘", excerpt: "" },
    ],
    tags: () => [
        { name: "工作", count: 12 },
        { name: "灵感", count: 3 },
        { name: "合同", count: 0 },
    ],
};

interface OptionShape {
    label: string;
    boost?: number;
    detail?: string;
}

/** 在某个文档/光标位置上问一次补全。explicit=true 等于用户按了 Ctrl-Space */
function ask(
    source: (ctx: CompletionContext) => unknown,
    doc: string,
    pos?: number,
    explicit = false
): { from: number; options: OptionShape[] } | null {
    const state = EditorState.create({ doc });
    const ctx = new CompletionContext(state, pos ?? doc.length, explicit);
    return source(ctx) as { from: number; options: OptionShape[] } | null;
}

const wiki = wikiLinkSource(() => SOURCES);
const tag = tagSource(() => SOURCES);

test("「[[」之后按标题模糊补全，候选里自动带上闭合的 ]]", () => {
    const result = ask(wiki, "今天读了 [[季度");
    assert.ok(result, "要有候选（而不是 null）");
    const labels = result!.options.map(o => o.label);
    assert.ok(labels.includes("季度复盘"), `候选应包含「季度复盘」，实际：${labels.join("/")}`);

    // 同名的重复项要被吃掉（否则面板里两根「季度复盘」，点哪个都一样还占地方）
    assert.equal(labels.filter(l => l === "季度复盘").length, 1);

    // from 必须落在第一个候选词开头：`[[` 之后
    assert.equal(result!.from, "今天读了 [[".length);
});

test("「[[」+ 打错的词也能靠模糊匹配命中（「数据哭」→「季度复盘」这类）", () => {
    const result = ask(wiki, "见 [[季复");
    assert.ok(result);
    assert.ok(
        result!.options.some(o => o.label === "季度复盘"),
        "跳跃字符也要命中（鲁棒性的意义就在这里）"
    );
});

test("完全没有匹配的字给出「新建笔记」候选，且排在最后（boost 为负）", () => {
    const result = ask(wiki, "备忘 [[一个全新的话题");
    assert.ok(result);
    const fresh = result!.options.find(o => o.label === "一个全新的话题");
    assert.ok(fresh, "要给出「按这个标题新建」的候选");
    assert.equal(fresh!.detail, "新建笔记");
    assert.ok((fresh!.boost ?? 0) < 0, "新建设想的优先级必须低于已有标题");
    // 已有笔记没有一条匹配这个词，所以此时**只有**那一条新建
    assert.equal(result!.options.length, 1);
});

test("选中已有笔记时真正写入的是「标题]]」，光标落在闭合符之后", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const state = EditorState.create({ doc: "参考 [[" });
    const view = new EditorView({ state, parent: host });
    const ctx = new CompletionContext(view.state, view.state.doc.length, true);
    const result = wiki(ctx);
    const apply = result!.options.find(o => o.label === "季度复盘")!.apply;
    if (typeof apply !== "function") throw new Error("候选项缺少 apply");
    apply(view, result!.options[0] as never, "参考 [[".length, view.state.doc.length);
    assert.equal(view.state.doc.toString(), "参考 [[季度复盘]]");
    // ⚠️ 光标必须落在 `]]` 之后，而不是留在标题中间（不然接着打字会把]] 拆开）
    assert.equal(view.state.selection.main.head, "参考 [[季度复盘]]".length);
    view.destroy();
    host.remove();
});

test("「#」补全标签；已有标签一并按题目复用度排序", () => {
    const result = ask(tag, "随手记 #");
    assert.ok(result);
    const labels = result!.options.map(o => o.label);
    assert.deepEqual(labels.sort(), ["合同", "工作", "灵感"].sort());
    // 用得多的排前面：这里「工作」12 篇 vs 「灵感」3 篇
    const work = result!.options.find(o => o.label === "工作")!;
    const idea = result!.options.find(o => o.label === "灵感")!;
    assert.ok((work.boost ?? 0) > (idea.boost ?? 0), "高频标签要排得靠前");
    assert.ok(work.detail?.includes("12"), "面板里要显示「多少篇笔记」");
});

test("标题行开头的 # 不能弹标签面板（否则打 `# 标题` 被打断）", () => {
    assert.equal(ask(tag, "# 会"), null, "行首 `# 标题` 不当标签");
    assert.equal(ask(tag, "## 二层"), null, "二级标题同样不当标签");
    // 段落中间的 # 才是标签
    const result = ask(tag, "一句话 #工");
    assert.ok(result, "段落中的 # 仍然是标签");
    assert.ok(result!.options.some(o => o.label === "工作"));
});

// 一条**真**线上事故钉在这里（2026-10-10 收尾巡检抓到）：
// 后端/缓存里混进一条没有 name 的标签时，原来的实现会把 `label: undefined`
// 直接交给 CodeMirror —— 默认候选渲染里有 `off < label.length`（label 为空时
// 循环不进，正好撞上），抛 TypeError；CM 捕获到插件异常后会 destroy + deactivate，
// **整个补全扩展当场下线**，之后再按 Ctrl-Space 也没反应。
// 所以这里的断言是「脏数据根本不能变成候选」，而不是「别崩就行」。
test("标签数据缺 name 时不能把它当候选交出去（否则 CM 补全面板会把扩展打挂）", () => {
    const dirty = tagSource(() => ({
        notes: () => [],
        tags: () => [
            { name: undefined as unknown as string, count: 0 },
            { name: "   ", count: 5 },
            { name: "正常标签", count: undefined as unknown as number },
        ],
    }));
    const result = ask(dirty, "随手记 #");
    assert.ok(result, "还有一条正常标签，面板该照常弹");
    assert.deepEqual(result!.options.map(o => o.label), ["正常标签"]);
    // count 缺了也要兜住：不能显示「undefined 篇笔记」，boost 也不能是 NaN
    const only = result!.options[0];
    assert.ok(!String(only.detail).includes("undefined"), `detail 不该带 undefined：${only.detail}`);
    assert.ok(Number.isFinite(only.boost ?? NaN), `boost 不能是 NaN：${only.boost}`);
});

test("标签全是脏数据时直接不弹面板（而不是弹一个空/崩的面板）", () => {
    const dirty = tagSource(() => ({
        notes: () => [],
        tags: () => [{ name: undefined as unknown as string, count: 0 }],
    }));
    assert.equal(ask(dirty, "随手记 #"), null);
});

test("行首 ``` 之后补语言；段落里的三个反引号不弹面板", () => {
    const atStart = ask(codeFenceSource, "```js");
    assert.ok(atStart, "行首围栏要弹候选");
    assert.ok(atStart!.options.some(o => o.label === "javascript"));
    // from 落在反引号之后
    assert.equal(atStart!.from, 3);

    const inline = ask(codeFenceSource, "正文里提到 ```pyt");
    assert.equal(inline, null, "段落里的 ``` 不是围栏，不该弹面板");
});

// ---------- 端到端：真的挂到 NoteEditor 上，按 Ctrl-Space 要弹面板 ----------
//
// 上面的用例测的是「source 逻辑」，这一段测的是**接线**：
// autocompletion 扩展装没装、completionKeymap 排没排进 keymap 顺序、
// 候选有没有真的画到 DOM 里。任一条没接上，上面那组用例照样全绿，
// 但用户在编辑器里 `[[` 之后什么都不会弹。
test("NoteEditor：Ctrl-Space 真的弹出补全面板，里面是笔记标题", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editorRef = createRef<NoteEditorHandle>();
    const root = createRoot(host);
    act(() => {
        root.render(
            <NoteEditor
                editorRef={editorRef}
                value='参考 [['
                onChange={() => {}}
                completionSources={() => SOURCES}
            />
        );
    });
    const ref = editorRef as RefObject<NoteEditorHandle>;
    act(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange("参考 [[".length, "参考 [[".length);
    });
    const content = host.querySelector(".cm-content") as HTMLElement;
    assert.ok(content, "编辑器应挂载");
    act(() => {
        content.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: " ",
                code: "Space",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            })
        );
    });
    // ⚠️ 补全面板是**异步**画的（CM 内部有 updateDelay 去抖），按下键就去查必然查不到。
    // 也不能写死 sleep 一个数：CI 机器慢时会假红 —— 这里轮询到 1s 为止。
    let tip: Element | null = null;
    for (let i = 0; i < 40 && !tip; i++) {
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        tip = host.ownerDocument.querySelector(".cm-tooltip-autocomplete");
    }
    assert.ok(tip, "Ctrl-Space 要弹出补全面板（.cm-tooltip-autocomplete）");
    const text = tip!.textContent || "";
    assert.ok(text.includes("季度复盘"), `面板里要能看到笔记标题，实际内容：${text}`);
    act(() => root.unmount());
    host.remove();
});

test("NoteEditor：没传 completionSources 也不会崩（只读场景照样能用编辑器）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editorRef = createRef<NoteEditorHandle>();
    const root = createRoot(host);
    act(() => {
        root.render(<NoteEditor editorRef={editorRef} value='# 标题' onChange={() => {}} />);
    });
    const ref = editorRef as RefObject<NoteEditorHandle>;
    assert.equal(ref.current?.value, "# 标题");
    act(() => root.unmount());
    host.remove();
});
