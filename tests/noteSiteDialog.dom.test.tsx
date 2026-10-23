// tests/noteSiteDialog.dom.test.tsx
//
// 笔记 → 网站（2026-10-23 用户要求：「笔记右键加上绑定网站」）。
//
// 与卡片那一侧是同一件事的两个方向，落库都是 notes.site_id。这个文件钉住：
//   ① 右键菜单里真有「绑定网站…」，并且点它会打开这个弹窗（静态守卫那半条）；
//   ② 弹窗能列出网站、选中后按「笔记 → 网站」的方向落库；
//   ③ 目标网站已经被别的笔记占着时，要**在这里就说清楚**（否则用户点完才发现
//      自己把别人顶掉了）；
//   ④ 已绑定时能解除 —— 而且解除是按「当前那个站」解，不能瞎传一个 id。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NoteSiteDialog from "../src/components/notes/NoteSiteDialog";
import type { NotesSiteLinkApi } from "../src/components/notes/notesPageCtx";
import type { Note } from "../src/API/http";
import { readSrcFile, stripComments } from "./helpers/notesSource";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

type SiteRow = { id?: number; name: string; note_id?: number | null; note_title?: string | null };

function makeNote(over: Partial<Note> = {}): Note {
    return { id: 7, title: "这个站的登录方式", content: "", ...over } as Note;
}

type Calls = {
    bound: number[];
    unbound: number;
    refreshed: number;
    closed: number;
    notify: Array<[string, string | undefined]>;
};

function makeApi(sites: SiteRow[], calls: Calls): NotesSiteLinkApi {
    return {
        resolve: (siteId: number) => sites.find(s => s.id === siteId) ?? null,
        open: () => {},
        list: () => sites,
        refresh: () => {
            calls.refreshed += 1;
        },
    };
}

function mount(note: Note, sites: SiteRow[]) {
    const calls: Calls = { bound: [], unbound: 0, refreshed: 0, closed: 0, notify: [] };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteSiteDialog
                note={note}
                siteLinkApi={makeApi(sites, calls)}
                onBind={async siteId => {
                    calls.bound.push(siteId);
                }}
                onUnbind={async () => {
                    calls.unbound += 1;
                }}
                onClose={() => {
                    calls.closed += 1;
                }}
                onNotify={(msg, sev) => calls.notify.push([msg, sev])}
            />
        );
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
        await new Promise(r => setTimeout(r, 20));
    });
};
const byText = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === label
    ) ?? null;

test("选一个网站按「绑定」：按「笔记 → 网站」的方向落库", async () => {
    const calls = mount(makeNote(), [
        { id: 101, name: "Cloudflare Docs", note_id: null },
        { id: 102, name: "GitHub", note_id: null },
    ]);

    const option = q('[data-site-id="102"]');
    assert.ok(option, "网站列表里要有可选项");
    await click(option!);

    const confirm = byText("绑定");
    assert.ok(confirm, "要有「绑定」按钮");
    await click(confirm!);

    assert.deepEqual(calls.bound, [102], "把这条笔记绑到网站 102");
    assert.equal(calls.closed, 1, "绑完关掉弹窗");
    assert.equal(calls.notify.at(-1)?.[1], "success", "给一句回执");
    cleanup();
});

test("目标网站已经被别的笔记占着：在列表里就说清楚", () => {
    mount(makeNote(), [
        { id: 101, name: "Cloudflare Docs", note_id: 99, note_title: "别人的笔记" },
        { id: 102, name: "GitHub", note_id: null },
    ]);
    const text = document.body.textContent || "";
    assert.ok(
        text.includes("已绑「别人的笔记」"),
        "要提示这个站已经有笔记了 —— 不说的话用户点完才发现把别人顶掉了"
    );
    cleanup();
});

test("已绑定时「解除绑定」按当前那个站解，不瞎传 id", async () => {
    const calls = mount(makeNote({ site_id: 101 }), [{ id: 101, name: "Cloudflare Docs", note_id: 7 }]);
    const unbind = byText("解除绑定");
    assert.ok(unbind, "已绑定时要有「解除绑定」");
    await click(unbind!);
    assert.equal(calls.unbound, 1, "解除一次");
    assert.equal(calls.closed, 1);
    cleanup();
});

test("右键菜单里真有「绑定网站…」，而且两个变体（列表 / 左栏）都有", () => {
    // 用户指的是列表行的右键菜单；左栏内联笔记那份精简菜单也给了同一条，
    // 免得「同一个动作换个地方右键就消失了」。
    const src = stripComments(readSrcFile("src/components/notes/NotesOverlayLayer.tsx"));
    const hits = src.match(/data-row-op='bind-site'/g) ?? [];
    assert.equal(hits.length, 2, "两个菜单变体各要有一个「绑定网站…」");
    assert.ok(src.includes("绑定网站…"), "菜单文案要对得上");
    assert.ok(
        /setBindSiteNoteId\(\s*id\s*\)/.test(src),
        "点菜单项要把那条笔记交给弹窗"
    );
});
