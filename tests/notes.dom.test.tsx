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
                    trashedNotes={[]}
                    onLoadTrash={async () => {}}
                    onRestoreTrashed={async () => {}}
                    onPurgeTrashed={async () => {}}
                    onEmptyTrash={async () => {}}
                    onToggleArchive={async () => {}}
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

// ---------- 阶段一：工具栏图标化 + 分组 + 标题层级下拉 ----------

test("工具栏按 data-tool 暴露分组按钮（不再是 15 个散落文字按钮）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement | null;
    assert.ok(bar, "要有格式工具栏");
    const tools = [...bar.querySelectorAll("button[data-tool]")].map(b =>
        b.getAttribute("data-tool")
    );
    for (const key of ["bold", "italic", "strike", "code", "ul", "ol", "task", "link", "image", "quote", "table"]) {
        assert.ok(tools.includes(key), `工具栏要有 ${key} 按钮，实际 ${JSON.stringify(tools)}`);
    }
    // 分组之间要用 Divider 隔开，不然又变成一长串
    assert.ok(bar.querySelectorAll('hr, [class*="MuiDivider"]').length >= 4, "分组之间要有分隔线");
});

test("标题层级下拉：点 H2 是把 `## ` 加在当前行开头", () => {
    mountPanel([note({ id: 1, title: "甲", content: "一段文字" })]);
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='笔记内容']")!;
    const bar = document.querySelector('[aria-label="Markdown 格式"]')!;

    // 光标放在「段」与「文字」之间
    act(() => {
        ta.focus();
        ta.value = "一段文字";
        ta.setSelectionRange(2, 2);
    });

    const headingBtn = bar.querySelector('button[aria-label="标题层级"]') as HTMLElement | null;
    assert.ok(headingBtn, "要有标题层级按钮");
    act(() => headingBtn!.click());

    const h2 = document.querySelector('[data-heading="2"]') as HTMLElement | null;
    assert.ok(h2, "H2 要在下拉里");
    act(() => h2!.click());

    // 标题是行首前缀，不能插到光标中间把半句话劈开
    assert.equal(ta.value, "## 一段文字", "H2 要落在整行开头");
    assert.equal(ta.selectionStart, 3, "光标跟着落到前缀之后");
});

test("左栏导航「收藏」只看置顶的那几条", () => {
    mountPanel([
        note({ id: 1, title: "置顶的", content: "a", pinned: true }),
        note({ id: 2, title: "普通的", content: "b", pinned: false }),
    ]);
    const list = () =>
        document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(list().includes("置顶的") && list().includes("普通的"), "默认全部");

    const starred = [...document.querySelectorAll("button[data-view]")].find(
        b => b.getAttribute("data-view") === "starred"
    ) as HTMLElement | null;
    assert.ok(starred, "要有收藏视图按钮");
    act(() => starred!.click());

    assert.ok(list().includes("置顶的"), "收藏里要有置顶的");
    assert.ok(!list().includes("普通的"), "收藏里不该出现没置顶的");
});

// ---------- 阶段二：左栏折叠 / 月份分组 / ⌘K ----------

test("标题下拉按钮和图标按钮一样大（28×28），不再高一截", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]')!;
    const head = bar.querySelector('button[aria-label="标题层级"]') as HTMLElement;
    const bold = bar.querySelector('button[data-tool="bold"]') as HTMLElement;
    assert.ok(head && bold, "标题下拉和粗体按钮都要在");
    // ⚠️ jsdom 没有布局，getBoundingClientRect 恒为 0，量不了真实尺寸；
    // 所以这里查源码：标题按钮必须和图标按钮一样是 28×28 —— 它之前是「Button」自带
    // padding + 18px 字，比图标高一截，用户一眼看出大小不一致。
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    const headBlock = src.slice(src.indexOf("标题层级"), src.indexOf("</Button>", src.indexOf("标题层级")));
    assert.ok(headBlock.includes("width: 28"), "标题按钮宽度要和图标按钮一致");
    assert.ok(headBlock.includes("height: 28"), "标题按钮高度要和图标按钮一致");
});

test("选中一段字点粗体后，选区还在（不能一按就没了）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='笔记内容']")!;
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement;
    act(() => {
        ta.focus();
        ta.value = "这篇笔记";
        ta.setSelectionRange(0, 4);
    });
    act(() => bold.click());
    assert.equal(ta.value, "**这篇笔记**", "第一下包一层");
    assert.equal(ta.selectionStart, 2, "选区左边界要跟着标记挪到 `**` 之后");
    assert.equal(ta.selectionEnd, 6, "刚包上的 `这篇笔记`(4 字)要整体还在选中态");
});

test("阶段二：列表按月份分组，月份标题挂在条目上面", () => {
    mountPanel([
        note({ id: 1, title: "早的", content: "a", updated_at: "2026-09-03T10:00:00Z" }),
        note({ id: 2, title: "晚的", content: "b", updated_at: "2026-10-05T10:00:00Z" }),
    ]);
    const headers = [...document.querySelectorAll("[data-month]")].map(h => h.textContent);
    assert.deepEqual(headers, ["2026 年 10 月", "2026 年 9 月"], "月份从新到旧");
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list.textContent!.includes("晚的") && list.textContent!.includes("早的"));
    // 分组顺序：新的月份那组整体排在前面（「晚的」必须出现在「早的」之前）
    assert.ok(
        list.innerHTML.indexOf("晚的") < list.innerHTML.indexOf("早的"),
        "新的月份分组要在列表里排在前面"
    );
});

test("阶段二：顶栏能收起 / 展开左栏", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    assert.ok(document.querySelector("[data-note-list]"), "默认列表在");
    const collapse = document.querySelector('button[aria-label="收起笔记列表"]');
    assert.ok(collapse, "顶栏要有收起按钮");
    act(() => (collapse as HTMLElement).click());
    assert.equal(
        document.querySelector("[data-note-list]"),
        null,
        "收起后列表要整块消失（不是被 width:0 藏起来）"
    );
    const expand = document.querySelector('button[aria-label="展开笔记列表"]');
    assert.ok(expand, "要能再展开回来");
    act(() => (expand as HTMLElement).click());
    assert.ok(document.querySelector("[data-note-list]"), "展开后列表回来");
});

test("阶段二：搜索框右侧挂 ⌘K 提示", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const input = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    assert.ok(input.parentElement!.textContent!.includes("⌘K"), "要有 ⌘K 角标");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    assert.equal(document.activeElement, input, "Ctrl+K 要聚焦搜索框");
});

// ---------- 阶段三：回收站 / 归档 / 未归类 ----------

test("阶段三：左栏六个视图（全部/最近/收藏/归档/未归类/回收站）都在", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const views = [...document.querySelectorAll("button[data-view]")].map(b =>
        b.getAttribute("data-view")
    );
    // 顺序按 inkstone 那套（所有 / 最近编辑 / 收藏 / 未归类 / … / 归档 / 回收站）：
    // 「未归类」紧跟收藏、「归档」收在末尾，是刻意的，不是随手排的。
    assert.deepEqual(views, [
        "all",
        "recent",
        "starred",
        "uncategorized",
        "archived",
        "trash",
    ]);
});

test("阶段三：回收站视图列出被删的笔记，并给还原 / 彻底删除两个动作", () => {
    const onLoadTrash = async () => {};
    mountPanel([note({ id: 1, title: "甲", content: "" })], {
        trashedNotes: [{ recycleId: 42, title: "删掉的那条", deletedAt: Date.now() }],
        onLoadTrash,
    });
    act(() => {
        (
            document.querySelector('button[data-view="trash"]') as HTMLElement
        ).click();
    });
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list.textContent!.includes("删掉的那条"), "回收站里要列出标题");
    assert.ok(list.querySelector('[data-action="restore"]'), "要有还原按钮");
    assert.ok(list.querySelector('[data-action="purge"]'), "要有彻底删除按钮");
    assert.ok(list.textContent!.includes("保留 30 天"), "要说清保留多久");
});

test("阶段三：进回收站视图才去拉回收站（别在首屏就发请求）", () => {
    let calls = 0;
    mountPanel([note({ id: 1, title: "甲", content: "" })], {
        onLoadTrash: async () => {
            calls += 1;
        },
    });
    assert.equal(calls, 0, "默认视图不该拉回收站");
    act(() => {
        (document.querySelector('button[data-view="trash"]') as HTMLElement).click();
    });
    assert.equal(calls, 1, "切到回收站要拉一次");
});

test("阶段三：回收站里不能编辑笔记（它已经不在 notes 表里了）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "内容" })], {
        trashedNotes: [{ recycleId: 42, title: "删掉的", deletedAt: Date.now() }],
    });
    act(() => {
        (document.querySelector('button[data-view="trash"]') as HTMLElement).click();
    });
    assert.equal(
        document.querySelector("textarea[aria-label='笔记内容']"),
        null,
        "回收站视图不该渲染编辑器"
    );
    assert.ok(text().includes("不能直接编辑"), "要有一句说明");
});

test("阶段三：归档的笔记从「全部」里隐去，只在「归档」视图露面", () => {
    mountPanel([
        note({ id: 1, title: "正常的", content: "a" }),
        note({ id: 2, title: "收起来的", content: "b", archived: true }),
    ]);
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("正常的") && !listText().includes("收起来的"), "全部视图不该有归档的");

    act(() => {
        (document.querySelector('button[data-view="archived"]') as HTMLElement).click();
    });
    assert.ok(listText().includes("收起来的"), "归档视图里要有它");
    assert.ok(!listText().includes("正常的"), "归档视图不该混进正常笔记");
});

test("阶段三：未归类 = 没挂在任何站点上的笔记", () => {
    mountPanel([
        note({ id: 1, title: "没挂站点", content: "a", site_id: null }),
        note({ id: 2, title: "挂了站点", content: "b", site_id: 7 }),
    ]);
    act(() => {
        (
            document.querySelector('button[data-view="uncategorized"]') as HTMLElement
        ).click();
    });
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("没挂站点"), "未归类里要有它");
    assert.ok(!listText().includes("挂了站点"), "挂了站点的不该进来");
});

// ---------- 本轮修掉的三个界面问题 ----------

test("折叠左栏时搜索框和视图导航要一起藏掉（只藏列表会文字重叠）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    act(() => {
        (document.querySelector('button[aria-label="收起笔记列表"]') as HTMLElement).click();
    });
    assert.equal(document.querySelector("input[aria-label='搜索笔记']"), null, "搜索框要收起来");
    assert.equal(
        document.querySelectorAll("button[data-view]").length,
        0,
        "视图导航也要收起来，否则 44px 宽的轨道里文字会溢出压到编辑区"
    );
});

test("顶栏：折叠按钮不能挨着「返回导航站」（两个无文字箭头靠太近会误按）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // 源码里两者的距离：返回键之后应当先出现标题 Typography，折叠按钮在它右边
    const backAt = src.indexOf("aria-label='返回导航站'");
    const foldAt = src.indexOf("收起笔记列表", backAt);
    const titleAt = src.indexOf("记事本", backAt);
    assert.ok(backAt > 0 && foldAt > backAt, "折叠按钮要在返回键之后");
    assert.ok(
        titleAt > backAt && titleAt < foldAt,
        "折叠按钮要挪到标题右边那一组，不能紧贴返回键"
    );
});

test("滚动条样式里不能有 scrollbarWidth: thin（会让 Chrome 忽略自定义样式）", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // ⚠️ 必须先剥注释：这段 CSS 上方就有解释「别写 scrollbarWidth: thin」的注释，
    // 不剥的话守卫会自己把自己判红
    const clean = stripComments(src);
    const block = clean.slice(
        clean.indexOf("const SCROLLBAR_SX"),
        clean.indexOf("} as const;")
    );
    assert.ok(
        !/scrollbarWidth\s*:/.test(block),
        "scrollbarWidth: thin 会让 Chrome 改用自己的细滚动条，::-webkit-scrollbar 全部失效"
    );
    assert.ok(/::-webkit-scrollbar-thumb/.test(block), "自定义滚动条样式要留着");
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
    // 内层那两条定宽是配套的：外层不定宽、内层不定宽就没有「固定宽列表」可言。
    //
    // ⚠️ 这里判的是**两列之和**，不是某个写死的像素：
    // 阶段三收尾把左栏从「单列 300px」改成 inkstone 那样「导航列 + 列表列」两列，
    // 所以总宽变成 NAV_COL_W + LIST_COL_W（336）。再钉 300 只会每次改布局都变红。
    assert.ok(
        /width: listCollapsed \? 44 : \{ xs: "100%", md: NAV_COL_W \+ LIST_COL_W \}/.test(source),
        "listPane 展开时宽度应是「导航列 + 列表列」两列之和"
    );
    assert.ok(
        /export const NAV_COL_W = \d+;/.test(source) &&
            /export const LIST_COL_W = \d+;/.test(source),
        "两列各自的宽度要在文件顶部导出常量（别散落在 sx 里）"
    );
    // 导航列和列表列都得是「定宽 + 不收缩」：少一个 flexShrink、或给某一列 flex:1，
    // 两列就会互相挤，列表在窄窗口下被压成几十像素。
    assert.ok(
        (source.match(/flexShrink: 0/g) ?? []).length >= 2,
        "两列都要 flexShrink: 0（宽度由它们自己的 width 决定）"
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

    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
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

test("选中一段内容后点两下 B：第二下只取消粗体，不能把内容删掉", () => {
    // 用户原话：「选中输入内容后点击两下粗体会删除内容，应该只取消粗体」。
    // 选中的正文是**用户自己的字**，第二下撤的是「加粗」这件事本身，不是把字也删了。
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='笔记内容']"
    );
    assert.ok(ta, "要有笔记内容输入框");
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    // 先手动敲一段字，整段选中
    act(() => {
        ta.focus();
        ta.value = "这篇笔记";
        ta.setSelectionRange(0, 4);
    });

    act(() => bold!.click());
    assert.equal(ta.value, "**这篇笔记**", "第一下：把选中的字加粗");

    act(() => bold!.click());
    assert.equal(
        ta.value,
        "这篇笔记",
        "第二下：只摘掉 ** 标记，选中的正文必须还在（不能变成空）"
    );
    assert.equal(ta.selectionStart, 0, "取消后光标落回那段正文的开头");
    assert.equal(ta.selectionEnd, 4, "并把正文重新选上，方便接着编辑");
});

test("已经有这层格式时点按钮是摘掉标记（不是再加一层）", () => {
    // 选中整段带标记的内容 / 只选中被两枚标记夹在中间的字，按同名按钮都要「取消」
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='笔记内容']"
    );
    assert.ok(ta, "要有笔记内容输入框");
    // ⚠️ 按钮要等面板挂上才存在，不能在 mountPanel 之前去查
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
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
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement | null;
    assert.ok(bar, "要有格式工具栏");
    // ⚠️ 图标化之后按钮上不再有文字，按 data-tool 找（阶段一重构跟着改）
    const byLabel = (tool: string) =>
        bar!.querySelector(`button[data-tool="${tool}"]`) as HTMLElement | null;

    act(() => {
        ta!.focus();
        ta!.setSelectionRange(0, 0);
    });
    act(() => byLabel("bold")!.click());
    assert.equal(ta.value, "**粗体**", "B：加粗");

    // 关键点：I 按下之后，**粗体那一段必须还留着**（不能当成「同名第二次」撤掉）。
    // 至于 I 自己是在光标处插还是摘，两种都算合理，浏览器里再细调。
    act(() => byLabel("italic")!.click());
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

// ---------- 阶段三收尾：左栏两列 + 文件夹 / 标签 ----------

test("左栏真的是两列：导航列与列表列各自独立", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const nav = document.querySelector("[data-nav-col]");
    const list = document.querySelector("[data-list-col]");
    assert.ok(nav, "要有导航列（data-nav-col）");
    assert.ok(list, "要有列表列（data-list-col）");
    assert.ok(nav!.contains(document.querySelector("input[aria-label='搜索笔记']")!), "搜索框在导航列里");
    assert.ok(!nav!.contains(document.querySelector("[data-note-list]")!), "笔记列表不该在导航列里");
    assert.ok(list!.contains(document.querySelector("[data-note-list]")!), "笔记列表在列表列里");
});

test("选中某个文件夹 → 列表只留这个文件夹里的笔记", () => {
    mountPanel(
        [
            note({ id: 1, title: "甲", content: "", folder_id: 7 }),
            note({ id: 2, title: "乙", content: "", folder_id: null }),
        ],
        {
            folderTags: {
                folders: [
                    { id: 7, name: "收集箱" },
                    { id: 8, name: "空的" },
                ],
                tags: [],
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("甲") && listText().includes("乙"), "默认全部都该在");

    const folderBtn = [...document.querySelectorAll("button[data-folder-id]")].find(
        b => b.getAttribute("data-folder-id") === "7"
    ) as HTMLElement | null;
    assert.ok(folderBtn, "导航列里要有「收集箱」这一项");
    act(() => folderBtn!.click());

    assert.ok(listText().includes("甲"), "选中收集箱后，它里面的要还在");
    assert.ok(!listText().includes("乙"), "别文件夹的笔记要被筛掉");
});

test("导航列要自己滚（整块一起滚会把搜索框顶出视野）", () => {
    // 静态守卫：jsdom 里 MUI 的 sx 编译成 hash 类名，量不到 overflow-y，
    // 只能把结论钉在源码上（和「左栏容器不能带 flex:1」同一套路）。
    const clean = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // ⚠️ 源码里写的是单引号 `data-nav-col='1'`：找错引号会拿到 -1，
    // slice(-1, -1) 是个空串，断言会报「没这个属性」而不是「这一列没滚」。
    const navCol = clean.slice(clean.indexOf("data-nav-col='1'"), clean.indexOf("data-list-col='1'"));
    assert.ok(navCol.includes("overflowY: \"auto\""), "导航列得住自己那一列滚");
    assert.ok(
        navCol.includes("flexShrink: 0"),
        "导航列要定宽不收缩，否则会被列表挤掉"
    );
});

test("没有 folderTags（老部署）时退化成只有那六个视图，不能崩", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    assert.deepEqual(
        [...document.querySelectorAll("button[data-view]")].map(b => b.getAttribute("data-view")),
        ["all", "recent", "starred", "uncategorized", "archived", "trash"]
    );
    assert.ok(document.querySelector("[data-note-list]"), "列表照常渲染");
});
