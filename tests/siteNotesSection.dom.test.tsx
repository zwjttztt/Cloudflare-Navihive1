// tests/siteNotesSection.dom.test.tsx
//
// 站点设置里那一节「相关笔记」。
//
// 2026-10-23 用户报「卡片绑了笔记，编辑窗口却没相关笔记」：这一节原来只列
// **正文里提到它的**笔记（走搜索 + 启发式判据），把用户亲手在卡片上绑的那篇
// 漏在外面 —— 明明绑成功了，打开设置却像没绑。现在的口径：
//   ① 已绑定的那篇直接用 site.note_id / note_title 摆在最上面，标「已绑定」，不走搜索；
//   ② 下面才是「提到它的」，并且**排掉已绑定的那篇**（同一个标题出现两次会让人
//      以为绑了两篇）；
//   ③ 一篇都没有时，空态要区分「已绑定但没别的笔记提到」和「一篇都没有」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteNotesSection from "../src/components/SiteNotesSection";
import { AppConfigProvider } from "../src/context/AppConfigContext";
import type { AppConfigContextValue } from "../src/context/appConfigStore";
import type { Site } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

type Hit = { id?: number; title: string; content: string };

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

function makeBridge(hits: Hit[], opened: number[]): AppConfigContextValue {
    return {
        iconApi: "",
        thumbApi: "",
        backgroundImage: "",
        backgroundMaskOpacity: "0.15",
        notesBridge: {
            search: async () => hits,
            open: (id: number) => opened.push(id),
            list: async () => hits.map(h => ({ id: h.id, title: h.title, site_id: null })),
            bind: async () => {},
            createAndBind: async (_siteId: number, title: string) => ({ id: 999, title }),
            get: async () => null,
        },
    };
}

async function mount(site: Site, hits: Hit[] = []) {
    const opened: number[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <AppConfigProvider value={makeBridge(hits, opened)}>
                <SiteNotesSection site={site} />
            </AppConfigProvider>
        );
        // 那一节要等一次 search 回来
        await new Promise(r => setTimeout(r, 30));
    });
    return opened;
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

test("卡片绑了笔记：设置里的「相关笔记」要把它列出来（标「已绑定」）", async () => {
    const opened = await mount({ ...SITE, note_id: 42, note_title: "这个站的登录方式" }, []);
    const bound = q('[data-site-note-bound="42"]');
    assert.ok(bound, "已绑定的那篇必须出现在这一节里 —— 不然用户以为绑定没成功");
    assert.ok(
        (bound!.textContent || "").includes("这个站的登录方式"),
        "要显示笔记标题，而不是一个空行"
    );
    assert.ok(document.body.textContent?.includes("已绑定"), "要标明这是绑定关系");

    act(() => {
        bound!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(opened, [42], "点它直接跳到那条笔记");
    cleanup();
});

test("已绑定的那篇不会在「提到它」里重复出现", async () => {
    // 绑定的笔记正文里往往就写着站名 —— 不去重的话同一个标题会出现两次
    const hits: Hit[] = [
        { id: 42, title: "这个站的登录方式", content: "示例站点 的登录方式" },
        { id: 7, title: "另一条也提到它的", content: "顺便记了 示例站点 的地址" },
    ];
    const opened = await mount({ ...SITE, note_id: 42, note_title: "这个站的登录方式" }, hits);

    assert.ok(q('[data-site-note-bound="42"]'), "绑定的那篇在最上面");
    assert.equal(q('[data-site-note="42"]'), null, "它不该再出现在下面的「提到」列表里");
    assert.ok(
        q('[data-site-note="7"]'),
        "别的提到它的笔记照常列出来（去重只去掉已绑定的那一条）"
    );
    assert.equal(opened.length, 0, "列表渲染本身不该触发跳转");
    cleanup();
});

test("没有绑定、也没人提到：空态要说清「怎么绑」", async () => {
    await mount(SITE, []);
    assert.equal(q("[data-site-note-bound]"), null);
    const text = document.body.textContent || "";
    assert.ok(text.includes("还没有笔记提到它"), "空态文案要在");
    assert.ok(text.includes("笔记按钮"), "空态要指路到卡片上那颗按钮（新用户唯一的绑定入口）");
    cleanup();
});
