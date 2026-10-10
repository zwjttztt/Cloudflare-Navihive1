// tests/noteFeatures.batchB.dom.test.tsx
// 批次 B 的三项：标签颜色 / 列表快捷多选（⌘·Ctrl 点、Shift 点）/ 灯箱键盘与焦点。
//
// 这一组盯的是「改了之后**看得见的差别**」。标签颜色最容易写成「存进去了、
// 列表里却还是灰的片」；多选最容易写成「点了列表就被打开、根本没选上」；
// 灯箱最容易写成「自定义的 Box 挂了 aria-modal 就以为有了焦点管理」。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import NotesPage from "../src/components/NotesPage";
import TagColorDialog from "../src/components/TagColorDialog";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/http";

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
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
});

function setWide() {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
}

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
    setWide();
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

/** 列表里的行（按渲染顺序），每一行上有 data-note-id */
function rows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-note-list] [data-note-id]")];
}

/** 用带修饰键的鼠标事件点一行：React 的 onClick 收的是**合成事件**，
 *  真实 click() 不带修饰键，所以只能自己 dispatch MouseEvent。 */
function clickRow(el: HTMLElement, init: MouseEventInit = {}) {
    el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window, ...init })
    );
}

// ---------------- 多选：⌘/Ctrl 点 切换选中；Shift 点 范围选 ----------------

test("⌘/Ctrl+点：把这一条选上，且不会顺手把笔记打开换掉正在编辑的那篇", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    const openedBefore = document.querySelector<HTMLElement>("[data-note-list] [data-note-id='1']");
    assert.ok(openedBefore);
    await act(async () => {
        clickRow(rows()[1], { ctrlKey: true, metaKey: true });
    });
    assert.ok(
        document.querySelector("[data-bulk-bar='1']"),
        "Ctrl+点要直接进入多选态（批量条出现）"
    );
    // ② 勾选框要是打勾的
    const box = rows()[1].querySelector<HTMLInputElement>("input[data-note-check='2']");
    assert.ok(box, "行首要出现勾选框");
    assert.equal(box!.checked, true, "这一条要被勾上");
    // ③ 不能顺手把笔记打开/切换过去 —— Ctrl 点的目的是「选上」，不是「打开」。
    //    判据看标题输入框：它还停在原来那条（《甲》）上。
    const title = document.querySelector<HTMLInputElement>("input[aria-label='笔记标题']");
    assert.ok(title, "要有标题输入框（用来判断当前打开的是哪一篇）");
    assert.equal(title!.value, "甲", "Ctrl+点不该切换当前笔记");
});

test("Shift+点：从上次点的那条一路选到这里（两端都算）", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
        note({ id: 3, title: "丙", content: "c" }),
        note({ id: 4, title: "丁", content: "d" }),
    ]);
    // 先普通点第 2 条（建立锚点）
    await act(async () => {
        clickRow(rows()[1]);
    });
    // Shift 点第 4 条 → 2、3、4 全选（渲染顺序可能被「更新日期」分组重排，
    // 所以这里按 data-note-id 断言成员，不看下标）
    await act(async () => {
        clickRow(rows()[3], { shiftKey: true });
    });
    const checkedIds = [...document.querySelectorAll<HTMLInputElement>("input[data-note-check]")]
        .filter(i => i.checked)
        .map(i => Number(i.getAttribute("data-note-check")));
    checkedIds.sort();
    assert.deepEqual(checkedIds, [2, 3, 4], "锚点到 Shift 点之间（含两端）都要选上");
});

test("多选态下再 Ctrl+点同一条 = 取消勾选", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    await act(async () => { clickRow(rows()[0], { ctrlKey: true }); });
    const first = () => rows()[0].querySelector<HTMLInputElement>("input[data-note-check='1']")!;
    assert.equal(first().checked, true);
    await act(async () => { clickRow(rows()[0], { ctrlKey: true }); });
    assert.equal(first().checked, false, "再 Ctrl+点一次要把勾去掉");
});

// ---------------- 标签颜色 ----------------

test("列表里的标签徽章带上库里存的颜色", async () => {
    mountPanel(
        [note({ id: 1, title: "甲", content: "a" })],
        {
            folderTags: {
                folders: [],
                tags: [{ id: 5, name: "合同", color: "#3b82f6" }],
                noteTags: { 1: [5] },
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
                onStyleTag: async () => {},
            },
        }
    );
    const badge = document.querySelector<HTMLElement>("[data-note-list] [data-note-tag='合同']");
    assert.ok(badge, "列表行里要有这个标签徽章");
    assert.equal(
        badge!.getAttribute("data-note-tag-color"),
        "#3b82f6",
        "徽章要带上标签自己的颜色（note_tag.color 早就存在，之前界面没用它）"
    );
    // 左栏那条标签也要有色点：改了色之后「一眼扫出是哪一组」才成立
    const dot = document.querySelector<HTMLElement>("[data-tag-dot='#3b82f6']");
    assert.ok(dot, "左栏标签行要画出一颗同色的小圆点");
});

test("标签菜单里要有「设置颜色」，点了要把颜色发出去", async () => {
    const styled: { id: number; color: string }[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        folderTags: {
            folders: [],
            tags: [{ id: 5, name: "合同" }],
            noteTags: {},
            onCreateFolder: async () => null,
            onRenameFolder: async () => {},
            onRemoveFolder: async () => {},
            onCreateTag: async () => null,
            onRenameTag: async () => {},
            onRemoveTag: async () => {},
            onAssignTags: async () => null,
            onStyleTag: async (id: number, color: string | null) => {
                styled.push({ id, color: String(color) });
            },
        },
    });
    const dots = document.querySelector<HTMLElement>('button[aria-label="合同 操作"]');
    assert.ok(dots, "标签行要有「⋯」按钮");
    await act(async () => { dots!.click(); });
    const item = document.querySelector<HTMLElement>("[data-folder-op='tag-color']");
    assert.ok(item, "标签菜单里要有「设置颜色」");
    await act(async () => { item!.click(); });
    const swatch = document.querySelector<HTMLElement>("[data-tag-color='#22c55e']");
    assert.ok(swatch, "颜色弹窗里要有那枚绿色色块");
    await act(async () => { swatch!.click(); });
    const save = document.querySelector<HTMLElement>("[data-tag-color-save='1']");
    assert.ok(save, "要有保存按钮");
    await act(async () => { save!.click(); });
    assert.deepEqual(styled, [{ id: 5, color: "#22c55e" }], "选中色要走 onStyleTag 落库");
});

test("TagColorDialog：脏数据（不在调色板里的色值）按默认起手，选「空」= 清掉颜色", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const saved: (string | null)[] = [];
    act(() => {
        root!.render(
            <TagColorDialog
                open
                tag={{ id: 5, name: "合同", color: "rgb(1,2,3)" }}
                onSave={async c => {
                    saved.push(c);
                }}
                onClose={() => {}}
            />
        );
    });
    // 脏数据不该显示成一个被选中的按钮
    const anySelected = [...document.querySelectorAll("[data-tag-color]")].some(
        el => el.getAttribute("aria-label") === "颜色 rgb(1,2,3)"
    );
    assert.equal(anySelected, false, "不在调色板里的色值要回落成「默认」");
    await act(async () => {
        (document.querySelector("[data-tag-color='default']") as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector("[data-tag-color-save='1']") as HTMLElement).click();
    });
    assert.deepEqual(saved, [null]);
});

// ---------------- 列表性能：content-visibility 必须配 contain-intrinsic-size ----------------
// jsdom 没有布局，css invoices 不了效果；这里钉住「两个必须成对出现」。
// 只写 contentVisibility 不写 containIntrinsicSize 是最坏的一种优化：
// 离屏行按 0 高占位 → 滚动条长度随滚动跳 → 列表根本滑不动。
function projectDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

test("笔记列表行：content-visibility 必须配上 contain-intrinsic-size", () => {
    const src = readFileSync(
        join(projectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const at = src.indexOf("contentVisibility");
    assert.ok(at > 0, "列表行要开 content-visibility（几百条笔记时差别最大的一处）");
    // ⚠️ 窗口取 contentVisibility 的**两侧**，不取整行：行里还会不断加东西
    // （2026-10-10 加的那段修饰键点击就把窗口撑破了），锚定关键字更稳。
    const around = src.slice(Math.max(0, at - 400), at + 600);
    assert.ok(
        /containIntrinsicSize:\s*/.test(around),
        "⚠️ content-visibility 必须配 contain-intrinsic-size：不给的话离屏行按 0 高算，滚动条会跳"
    );
});

// ---------------- 灯箱：键盘缩放 + 焦点管理 ----------------

/** 轮询等一个异步出现的元素（markdown 渲染是 async import + Promise） */
async function waitFor<T extends Element>(q: string): Promise<T> {
    for (let i = 0; i < 40; i++) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
        const el = document.querySelector<T>(q);
        if (el) return el;
    }
    throw new Error(`等不到元素：${q}`);
}

test("灯箱：+ / - / 0 缩放；Esc 关闭；焦点锁在里面、关掉后还给原处", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "![图](https://example.com/a.png)" })]);
    const img = await waitFor<HTMLImageElement>("[data-preview-content='1'] img");
    // 先让一个可聚焦的元素拿到焦点：这就是「打开灯箱前我在哪」。
    // ⚠️ 不要指望「点图片会让图片拿到焦点」—— <img> 不是可聚焦元素，
    // 浏览器里也一样，所以焦点归还的对象只能是**打开前真正有焦点的那个**。
    const search = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']")!;
    await act(async () => { search.focus(); });
    const before = document.body.style.overflow;
    await act(async () => { img.click(); });

    const box = document.querySelector<HTMLElement>("[data-lightbox='1']");
    assert.ok(box, "点预览里的图片要打开灯箱");
    // ⚠️ 背景滚动必须被锁：不然滚轮会穿透滚到下层的笔记列表
    assert.equal(document.body.style.overflow, "hidden", "打开灯箱要锁背景滚动");
    // 焦点要进来（aria-modal 的自定义 Box 没有 MUI 自带的 FocusTrap）
    // ⚠️ 别用 assert.equal 比较 DOM 节点：失败时 node:test 会把整棵 jsdom 树
    // inspect 一遍，直接 RangeError: Array buffer allocation failed（2026-10-09 踩过）。
    assert.ok(document.activeElement === box, "打开后焦点要收到灯箱容器上");

    const pct = () => document.querySelector<HTMLElement>("[data-lightbox='1'] [aria-live='polite']")!.textContent;
    assert.equal(pct(), "100%");
    await act(async () => {
        box!.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    });
    assert.equal(pct(), "125%", "按 + 要放大");
    await act(async () => {
        box!.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true }));
    });
    assert.equal(pct(), "100%", "按 - 要缩小");
    // 缩放会被 Shfit+等号/数字键盘的各种写法打到，这里再试 code-only 的那种
    await act(async () => {
        box!.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", code: "Equal", bubbles: true }));
    });
    assert.equal(pct(), "125%", "code=Equal 也算按了 +（不同键盘布局给的 key 不一样）");
    await act(async () => {
        box!.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    });
    assert.equal(pct(), "100%", "按 0 回到原大小");

    await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.ok(document.querySelector("[data-lightbox='1']") === null, "Esc 要关闭灯箱");
    assert.equal(document.body.style.overflow, before, "关掉之后要把背景滚动解回来");
    // 焦点归还：回到打开它的那个元素，而不是掉回 body（掉回去的话下一次 Tab
    // 会从页面最开头开始走一遍，人也跟着「丢位置」了）
    assert.ok(
        document.activeElement === search,
        `关闭后焦点要还给打开前焦点所在的那个元素，实际是 ${document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.tagName}`
    );
});
