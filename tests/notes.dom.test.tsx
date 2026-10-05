// tests/notes.dom.test.tsx
// 记事本页面（NotesPage）+ 数据层（useNotes）的行为用例。
//
// 这一组钉的是**写错了不报错、只是界面不对**的地方：
//   - 面板的搜索/摘要/编辑态切换；
//   - useNotes 的**乐观更新 + 失败回滚**（这是最容易写错的地方：
//     不回滚的话，保存失败后界面上会留着一份根本没存下来的内容）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesPage from "../src/components/NotesPage";
import { useNotes } from "../src/hooks/useNotes";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) {
        act(() => root!.unmount());
        root = null;
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
});

function note(over: Partial<Note> = {}): Note {
    return {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        order_num: 0,
        site_id: null,
        ...over,
    };
}

function mountPanel(notes: Note[], handlers: Record<string, unknown> = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={notes}
                    onCreate={async () => note({ id: 99 })}
                    onUpdate={async () => {}}
                    onDelete={async () => {}}
                    onTogglePin={async () => {}}
                    {...handlers}
                />
            </UIPrefsProvider>
        );
    });
}

const text = () => document.body.textContent || "";

test("面板列出笔记的标题与内容摘要", () => {
    mountPanel([
        note({ id: 1, title: "常用入口", content: "# 标题\n\n- [x] 已完成" }),
        note({ id: 2, title: "待办", content: "第二条内容" }),
    ]);
    assert.ok(text().includes("常用入口"));
    assert.ok(text().includes("待办"));
    // 摘要要去掉 Markdown 语法符号（# 与列表符），不是原样显示源码。
    // ⚠️ 只在**列表项里**找：编辑区/预览区本来就显示原文（那是源码视图，不是摘要）
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list, "列表区要有标记，方便测试只盯它");
    assert.ok(!list.textContent!.includes("- [x] 已完成"), "摘要里不该留着列表符号");
    assert.ok(list.textContent!.includes("已完成"));
});

test("没有笔记时给一句引导，不是一片空白", () => {
    mountPanel([]);
    assert.ok(text().includes("还没有笔记"), "空状态要有引导文案");
});

test("关键字过滤：只留命中的那几条", () => {
    mountPanel([
        note({ id: 1, title: "苹果", content: "a" }),
        note({ id: 2, title: "香蕉", content: "b" }),
    ]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']")!;
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, "苹果");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(text().includes("苹果"));
    assert.ok(!text().includes("香蕉"), "不匹配的笔记该被过滤掉");
});

test("有笔记但没匹配时，提示与「没有笔记」要区分开", () => {
    mountPanel([note({ id: 1, title: "苹果" })]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']")!;
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, "zzz");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(text().includes("没有匹配的笔记"));
    assert.ok(!text().includes("还没有笔记"));
});

// ---------------------------------------------------------------------------
// useNotes：乐观更新 + 失败回滚
// ---------------------------------------------------------------------------

async function mountHook(api: Record<string, unknown>, onError = () => {}) {
    const seen: ReturnType<typeof useNotes>[] = [];
    function Probe() {
        const notes = useNotes({
            api: api as never,
            onError,
            onNotify: () => {},
        });
        seen.push(notes);
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <Probe />
            </UIPrefsProvider>
        );
    });
    // ⚠️ 必须单独等一轮：首屏那次 listNotes 是异步的，不等的话 hook 里的 notes
    // 还是初始空数组，「回滚到删除前」断言的就是空→空，等于什么都没测
    await act(async () => {
        await Promise.resolve();
    });
    assert.ok(seen.length > 0, "Probe 至少该渲染过一次");
    return seen;
}

test("useNotes：首屏就拉一次列表（顶栏按钮要显示条数）", async () => {
    let calls = 0;
    await mountHook({
        listNotes: async () => {
            calls += 1;
            return [note()];
        },
        createNote: async () => note(),
        updateNote: async () => note(),
        deleteNote: async () => ({ success: true }),
    });
    assert.equal(calls, 1, "列表要在挂载时就拉，不能等用户点开面板");
});

test("useNotes：删除失败要把笔记放回列表", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "别删我" })],
        createNote: async () => note(),
        updateNote: async () => note(),
        deleteNote: async () => {
            throw new Error("网络断了");
        },
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.deleteNote(note({ id: 1, title: "别删我" }));
    });
    assert.equal(
        seen[seen.length - 1].notes.length,
        1,
        "删除失败后列表要回到删除前 —— 不回滚的话界面上就少了一条其实还在的笔记"
    );
});

test("useNotes：保存失败要把内容回滚（旧值不能丢）", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "旧标题", content: "旧内容" })],
        createNote: async () => note(),
        updateNote: async () => {
            throw new Error("写不进去");
        },
        deleteNote: async () => ({ success: true }),
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.updateNote(1, { title: "新标题" });
    });
    const after = seen[seen.length - 1].notes[0];
    assert.equal(after.title, "旧标题", "保存失败要回滚到旧值，不能把没存下来的内容留在界面上");
});

test("useNotes：保存成功后以服务端回显为准", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "旧标题" })],
        createNote: async () => note(),
        updateNote: async () => note({ id: 1, title: "服务端改过的标题" }),
        deleteNote: async () => ({ success: true }),
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.updateNote(1, { title: "客户端写的" });
    });
    assert.equal(
        seen[seen.length - 1].notes[0].title,
        "服务端改过的标题",
        "乐观更新之后要拿服务端回显替换，否则 updated_at 之类会一直停在旧值"
    );
});

test("未置顶的笔记不会在标题左边渲染出一个「0」", () => {
    // 真踩过的 bug：`{note.pinned && <Icon/>}` —— pinned 存的是数字 0，
    // 而 `0 && x` 在 JS 里**返回 0**，React 把 0 当文本渲染，列表里就冒出一个孤零零的 0。
    // 写这条的时候要传 pinned: 0（数字）而不是 false，否则测不到。
    mountPanel([note({ id: 1, title: "甲", pinned: 0 as unknown as boolean })]);
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(
        !list.textContent!.includes("0"),
        `列表里出现了裸的 0：${list.textContent!.slice(0, 60)} —— ` +
            "pinned 是数字 0，`0 && <Icon/>` 会把 0 本身返回出来"
    );
    assert.ok(list.textContent!.includes("甲"));
});

test("搜索框的放大镜在框内（不是绝对定位飘在外面）", () => {
    mountPanel([note({ id: 1, title: "甲" })]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']");
    assert.ok(input, "搜索框应该是 MUI TextField（自带 adornment 槽）");
    // 放大镜作为 input 的前置节点存在，而不是页面里独立漂浮的一枚图标
    const adornment = input!.parentElement?.querySelector(".MuiInputAdornment-root");
    assert.ok(
        adornment,
        "放大镜应该在 InputAdornment 里（跟着输入框走），不是绝对定位浮在页面上的"
    );
});

test("左栏容器不能带 flex:1（会把 300px 的列表撑成两栏宽，中间留空白）", () => {
    // 这条是**静态守卫**：jsdom 没有布局，目测不了「中间那块空白」，
    // 只能把结论钉在源码上。
    //
    // 坑的来由：listPane 内部已经 `width: 300 + flexShrink: 0` 定死了宽度，
    // 而它**外层**那个容器又写了 `flex: 1` —— flex 会把外层撑到约 445px，
    // 里面的列表还是 300px，多出来的 145px 就是用户看到的「中间空白」。
    // 宽度只能由一层决定：外层 `flex: 0 0 auto`。
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const body = source.slice(
        source.indexOf("主体：移动端"),
        source.indexOf("移动端从编辑态回列表")
    );
    assert.ok(
        body.includes('flex: "0 0 auto"'),
        "左栏容器应该是 flex: 0 0 auto（宽度由内层的 width:300 决定）"
    );
    // 内层那条 width:300 是配套的：外层不定宽、内层不定宽就没有「固定宽列表」可言
    assert.ok(
        source.includes("md: 300"),
        "listPane 内部仍应是 width 300（md 起）"
    );
});

test("右栏要有 minHeight:0（缺了它内容会顶出视口，出现页面级滚动条）", () => {
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const body = source.slice(
        source.indexOf("主体：移动端"),
        source.indexOf("移动端从编辑态回列表")
    );
    // 右栏那一段（最后一个容器）必须带 minHeight
    const parts = body.split("minWidth: 0");
    assert.ok(
        body.includes("minHeight: 0"),
        "两个容器都要有 minHeight: 0 —— flex 子项默认 min-height:auto，" +
            "内容一高就撑破容器，把 fixed 布局顶出视口（页面级滚动条的来源）"
    );
    assert.ok(parts.length >= 2, "没找到两个容器的 minWidth 声明，检查匹配是否失效");
});

test("分栏是「左栏按比例 + 可拖分隔条」，不是写死的对半", () => {
    // 判据换过一次：从「两边 basis 相同」改成了「按 splitRatio 分配 + 有分隔条」。
    // 用户原话是「分栏两边大小不合理，做**可拖拽**的分隔条」——
    // 写死对半只是第一步，能拖才是他要的。
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    assert.ok(
        source.includes("splitRatio"),
        "左栏宽度应该由 splitRatio 决定"
    );
    assert.ok(
        source.includes("splitRatio * 100"),
        "源码区宽度要用 splitRatio 算，不能写死"
    );
    assert.ok(
        source.includes("role='separator'"),
        "要有可拖的分隔条（role=separator，键盘/读屏也能认出）"
    );
    assert.ok(
        source.includes("startSplitDrag"),
        "分隔条要接上拖拽处理"
    );
    // 拖拽监听必须挂在 window 上：指针移出那条 8px 宽的带子就会丢 mousemove
    assert.ok(
        source.includes("window.addEventListener(\"mousemove\""),
        "mousemove/mouseup 要挂在 window 上 —— 只挂分隔条会在拖出边界时卡住"
    );
});

test("格式工具栏：存在，且按钮用 onMouseDown preventDefault 保住选区", () => {
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    assert.ok(source.includes("MarkdownToolbar"), "要有格式工具栏");
    assert.ok(
        /onMouseDown=\{e => e\.preventDefault\(\)\}/.test(source),
        "工具栏按钮必须 onMouseDown + preventDefault —— 默认行为会让 textarea 失焦、" +
            "selectionStart 变成 0，插入的位置全跑到开头"
    );
    assert.ok(
        source.includes("setSelectionRange"),
        "插入后要把光标放回去（setSelectionRange），否则接着打字会打到别处"
    );
});

test("整页容器不许滚动（页面级滚动条是缺陷，该滚的是预览区内部）", () => {
    // ⚠️ 索引必须在**同一个字符串**上找：剥掉注释后长度变了，
    // 拿原文的偏移去切清理后的字符串会切错位置（守卫就会误报）。
    const clean = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    const at = clean.indexOf('position: "fixed"');
    assert.ok(at >= 0, "没找到整页容器的 position:fixed —— 检查是否被删改");
    const root = clean.slice(at, at + 600);
    assert.ok(
        root.includes('overflow: "hidden"'),
        "position:fixed;inset:0 的整页容器要显式 overflow:hidden —— " +
            "某一层漏了 minHeight:0 就会连带 body 出现滚动条"
    );
});

test("挂载期间锁住整页滚动（底下的导航站不该让 document 变长）", () => {
    // 真因（浏览器实测 1696 vs 700）：记事本自己是 fixed，压根不占文档流；
    // 是**底下没卸载的导航站**（卡片网格 1475px）把 document 撑长了，
    // body 又是 overflow-y:visible，于是整页出现滚动条。
    // 只把记事本做成 fixed 治不了这个 —— 必须按住 document。
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    mountPanel([note({ id: 1, title: "甲", content: "内容甲" })]);
    assert.equal(document.body.style.overflow, "hidden", "body 要锁滚动");
    assert.equal(
        document.documentElement.style.overflow,
        "hidden",
        "html 也要锁 —— 只锁 body 在部分浏览器上挡不住滚轮"
    );

    // 关掉记事本要把样式还原，否则整站都滚不动了（这是最容易被漏掉的那一半）
    act(() => root!.unmount());
    root = null;
    assert.equal(document.body.style.overflow, "", "卸载后 body 的内联样式要还原");
    assert.equal(document.documentElement.style.overflow, "", "卸载后 html 的内联样式要还原");
});

test("工具栏同名按钮是开关：连点第二下是「取消」而不是再插一遍", () => {
    // 用户原话：「把连点两下粗体第二下改为取消」。
    // 工具栏的语义应该是**开关**（像 inkstone / 富文本编辑器那样），
    // 不是每次都往里塞一层新标记。
    mountPanel([note({ id: 1, title: "甲", content: "abc" })]);
    const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='笔记内容']"
    );
    assert.ok(ta, "要有笔记内容输入框");

    ta.focus();
    ta.setSelectionRange(3, 3); // 光标放到 "abc" 末尾

    const bold = [...document.querySelectorAll("button")].find(b => b.textContent === "B");
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    act(() => bold!.click());
    assert.equal(ta.value, "abc**粗体**", "第一下：包一层");

    act(() => bold!.click());
    assert.equal(
        ta.value,
        "abc",
        "第二下：把上一次插的那段撤掉（取消），不能变成 abc**粗体****粗体**"
    );
    assert.equal(ta.selectionStart, 3, "取消后光标回到原来的插入处");
});

test("已经有这层格式时点按钮是摘掉标记（不是再加一层）", () => {
    // 选中整段带标记的内容 / 只选中被两枚标记夹在中间的字，按同名按钮都要「取消」
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='笔记内容']"
    );
    assert.ok(ta, "要有笔记内容输入框");
    // ⚠️ 按钮要等面板挂上才存在，不能在 mountPanel 之前去查
    const bold = [...document.querySelectorAll("button")].find(b => b.textContent === "B");
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    // ① 整段 `**粗**`（5 字符）：选区自带两枚标记 → 去掉标记
    act(() => {
        ta!.focus();
        ta!.value = "**粗**";
        ta!.setSelectionRange(0, 6);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "粗", "整段选中带标记的内容，按 B 要去掉标记");

    // ② 只选中里面的字：前后各有一枚标记 → 也要去掉标记
    act(() => {
        ta.focus();
        ta.value = "**粗**";
        ta.setSelectionRange(2, 3);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "粗", "只选中被 ** 夹住的字，按 B 要去掉标记");

    // ③ 没被标记包着的字，按同名按钮仍然是加格式
    act(() => {
        ta.focus();
        ta.value = "粗";
        ta.setSelectionRange(0, 1);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "**粗**", "没带标记的内容不受影响，正常包一层");
});

test("换一个按钮不会被误判成「取消」（点完粗体再点斜体不能把粗体撤掉）", () => {
    // 浏览器实测抓出来的：记录上次插入时只存了片段没存按钮，
    // 于是「斜体」一按，发现同一位置还是那段 `**粗体**`，就当成同名按钮撤了它。
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='笔记内容']"
    );
    assert.ok(ta, "要有笔记内容输入框");
    const bar = document.querySelector('[aria-label="Markdown 格式"]');
    assert.ok(bar, "要有格式工具栏");
    const byLabel = (label: string) =>
        [...bar!.querySelectorAll("button")].find(b => b.textContent === label);

    act(() => {
        ta!.focus();
        ta!.setSelectionRange(0, 0);
    });
    act(() => byLabel("B")!.click());
    assert.equal(ta.value, "**粗体**", "B：加粗");

    // 关键点：I 按下之后，**粗体那一段必须还留着**（不能当成「同名第二次」撤掉）。
    // 至于 I 自己是在光标处插还是摘，两种都算合理，浏览器里再细调。
    act(() => byLabel("I")!.click());
    assert.ok(
        ta.value.includes("**粗体**"),
        "I 是另一个按钮，不能把上一段粗体撤销掉；实际 " + JSON.stringify(ta.value)
    );
});

test("插入内容以 textarea 的 DOM 值为准，不能读 draft", () => {
    // 静态守卫：上面那条行为用例只覆盖连点，读错来源换个场景又会漏回去。
    const clean = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    const fn = clean.slice(
        clean.indexOf("const insertAtCursor"),
        clean.indexOf("const charCount")
    );
    assert.ok(fn.includes("el.value"), "插入要以 textarea 的 DOM 值（el.value）为准");
    assert.ok(
        !fn.includes("draft.content"),
        "不能从 draft 读内容：setDraft 异步，连点第二下读到的是上一次插入前的值"
    );
    // 光标位置必须把闭合标记算进去（漏 after.length 会插到 `**` 中间）。
    // ⚠️ 位置是**作为参数**传给 writeBack 的，不再有 `const caret` 这一句，
    // 所以只认这个表达式本身。
    assert.ok(
        fn.includes("before.length + selected.length + after.length"),
        "光标位置必须算上 after.length —— 否则点完「粗体」光标卡在闭合的 ** 中间"
    );
});
