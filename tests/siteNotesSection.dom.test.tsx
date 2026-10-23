// tests/siteNotesSection.dom.test.tsx
//
// 站点设置里那一节「相关笔记」。
//
// 2026-10-23 用户定了新口径：**每个网站只绑一篇笔记**，并且**去掉「[[站名]] 自动关联」**。
// 所以这一节只剩三件事：显示当前绑的那篇、能在这一节里换 / 绑、能解除。
//
// 这个文件钉住：
//   ① 已绑定的那篇要出现、标「已绑定」、点它跳过去；
//   ② 没绑时给「绑定笔记」入口，点开能列出笔记并选中绑定；
//   ③ 能解除；
//   ④ **不许再出现「提到它的笔记」那套启发式**（用户明确要去掉：靠不住，还让人
//      以为「我没绑它怎么冒出来了」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteNotesSection from "../src/components/SiteNotesSection";
import { AppConfigProvider } from "../src/context/AppConfigContext";
import type { AppConfigContextValue } from "../src/context/appConfigStore";
import type { Site } from "../src/API/http";
import { readSrcFile, stripComments } from "./helpers/notesSource";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

type NoteRow = { id?: number; title: string; site_id?: number | null };

const SITE: Site = {
    id: 101,
    group_id: 1,
    name: "示例站点",
    url: "https://example.com/",
    icon: "",
    description: "",
    notes: "",
    order_num: 0,
};

type Calls = {
    opened: number[];
    bound: Array<[number, number | null]>;
    listed: number;
};

function makeBridge(rows: NoteRow[], calls: Calls): AppConfigContextValue {
    return {
        iconApi: "",
        thumbApi: "",
        backgroundImage: "",
        backgroundMaskOpacity: "0.15",
        notesBridge: {
            search: async () => [],
            open: (id: number) => calls.opened.push(id),
            list: async () => {
                calls.listed += 1;
                return rows;
            },
            bind: async (noteId: number, siteId: number | null) => {
                calls.bound.push([noteId, siteId]);
            },
            createAndBind: async (_siteId: number, title: string) => ({ id: 999, title }),
            get: async () => ({ title: "这个站的登录方式", content: "账号 admin\n密码 123456" }),
        },
    };
}

async function mount(site: Site, rows: NoteRow[] = []) {
    const calls: Calls = { opened: [], bound: [], listed: 0 };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <AppConfigProvider value={makeBridge(rows, calls)}>
                <SiteNotesSection site={site} />
            </AppConfigProvider>
        );
        await new Promise(r => setTimeout(r, 30));
    });
    return calls;
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (el: HTMLElement) => {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => setTimeout(r, 30));
    });
};

test("已绑定：显示那篇笔记、标「已绑定」，点标题先弹预览、点「编辑」才跳", async () => {
    const calls = await mount({ ...SITE, note_id: 42, note_title: "这个站的登录方式" });
    const bound = q('[data-site-note-bound="42"]');
    assert.ok(bound, "已绑定的那篇必须出现在这一节里");
    assert.ok((bound!.textContent || "").includes("这个站的登录方式"), "要显示标题");
    assert.ok(document.body.textContent?.includes("已绑定"), "要标明这是绑定关系");

    // 2026-10-23 用户要求：这里点标题也先弹预览（与卡片角上那颗按钮一致），
    // 不要点一下就把人从站点设置里扔进记事本。
    await act(async () => {
        bound!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // 预览弹窗是 lazy chunk，且要等一次 getNote + 一次 markdown 渲染
        await new Promise(r => setTimeout(r, 160));
    });
    assert.deepEqual(calls.opened, [], "点标题只是预览，不该这时候就跳走");
    assert.ok(
        document.body.textContent?.includes("账号 admin"),
        "预览窗里要能看到正文"
    );

    const edit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === "编辑"
    );
    assert.ok(edit, "预览窗里要有「编辑」");
    await click(edit!);
    assert.deepEqual(calls.opened, [42], "点「编辑」才跳进记事本并定位到这条");
    cleanup();
});

test("没绑定时点「绑定笔记」：列出笔记并选中绑定", async () => {
    const calls = await mount(SITE, [
        { id: 7, title: "第一条", site_id: null },
        { id: 8, title: "第二条", site_id: null },
    ]);
    assert.ok(document.body.textContent?.includes("还没有绑定笔记"), "空态要有");
    assert.equal(calls.listed, 0, "只是看看就不该拉列表");

    const openBtn = q("[data-site-note-bind]");
    assert.ok(openBtn, "没绑定时要有「绑定笔记」入口（用户要求这一节里也能绑）");
    await click(openBtn!);
    assert.equal(calls.listed, 1, "展开选择器才拉列表");

    const pick = q('[data-site-note-pick="8"]');
    assert.ok(pick, "列表里要有可选的笔记");
    await click(pick!);
    assert.deepEqual(calls.bound, [[8, 101]], "选中即以「笔记 8 → 站点 101」落库");
    cleanup();
});

test("已绑定时能解除", async () => {
    const calls = await mount({ ...SITE, note_id: 42, note_title: "这个站的登录方式" });
    const unbind = q("[data-site-note-unbind]");
    assert.ok(unbind, "已绑定时要能解除");
    await click(unbind!);
    assert.deepEqual(calls.bound, [[42, null]], "解除 = 把这篇笔记的 site_id 清掉");
    cleanup();
});

test("那句说明文字已经去掉（用户点名删的那句）", async () => {
    await mount({ ...SITE, note_id: 42, note_title: "这个站的登录方式" });
    const text = document.body.textContent || "";
    assert.equal(
        text.includes("绑上之后，卡片右上角"),
        false,
        "用户点名要去掉的就是这句"
    );
    assert.equal(text.includes("一个网站只绑一篇笔记"), false, "这句一起删");
    cleanup();
});

test("不再有「提到它的笔记」那套启发式（反向守卫）", () => {
    // 用户明确去掉：[[站名]] 自动关联靠不住，还会让人以为「我没绑怎么冒出来了」。
    // 谁把启发式加回来，这条先红。
    // 只看代码，不看注释 —— 文件头正好在解释「为什么把提到那套删了」
    const src = stripComments(readSrcFile("src/components/SiteNotesSection.tsx"));
    assert.equal(
        /notesMentioningSite|noteMentionsSite|siteNoteLink/.test(src),
        false,
        "这一节不该再引用「正文提到站名」那套判据"
    );
    assert.equal(src.includes("提到"), false, "不该再出现「提到它的笔记」这类文案");
    // 被删掉的那个模块不该又冒出来
    let stillThere = true;
    try {
        readFileSync(new URL("../src/utils/siteNoteLink.ts", import.meta.url), "utf-8");
    } catch {
        stillThere = false;
    }
    assert.equal(stillThere, false, "utils/siteNoteLink.ts 应该已经被删掉");
});
