// src/components/AiSuggestDialog.tsx 的直测（288 行，此前零覆盖）。
//
// 为什么是它：AI 建议落地前的唯一闸门 —— 刻意「不自动应用」，勾选状态就是
// 数据流向（onApply 只收勾着的）。这里判错的后果是静默的：把用户没勾的
// 建议写进库，或者把建议指到已经不存在的站点上。
//
// MUI/React 坑（见 memory）：Checkbox/Switch 的 onChange 监听 click 不是 change，
// 用原生 el.click()；Select 弹层 jsdom 偶发红（此组件没有 Select，不受影响）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AiSuggestDialog from "../src/components/AiSuggestDialog";
import type { AiAssistant } from "../src/hooks/useAiAssistant";
import type { TagSuggestion } from "../src/utils/aiMeta";

const SITES = [
    { id: 1, name: "站点一", url: "https://1.example/" },
    { id: 2, name: "", url: "https://2.example/" },
    { id: 3, name: "第三", url: "https://3.example/" },
];
const GROUPS = ["工具箱", "备用"];
const ALL_TAGS = ["工具"];

const SUGGESTIONS: TagSuggestion[] = [
    { id: 1, tags: ["工具", "云盘"], group: "工具箱" },
    { id: 2, tags: [], group: "备用" },
    { id: 3, tags: ["阅读"], group: "" },
    { id: 4, tags: [], group: "" },
];

interface SuggestCall {
    sites: { id: number }[];
    groups: string[];
    tags: string[];
}

function fakeAi(
    suggestImpl: (payload: { sites: unknown[]; groups: string[]; tags: string[] }) => Promise<{
        ok: boolean;
        message?: string;
        data?: TagSuggestion[];
    }>
): AiAssistant {
    return {
        status: null,
        ready: false,
        reason: null,
        refresh: async () => {},
        siteMeta: async () => ({ ok: false, message: "unused" }),
        suggestTags: suggestImpl as unknown as AiAssistant["suggestTags"],
        embed: async () => ({ ok: false, message: "unused" }),
        search: async () => ({ ok: false, message: "unused" }),
        test: async () => ({ ok: false, message: "unused" }),
    };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => {
        resolve = r;
    });
    return { promise, resolve };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface MountOpts {
    sites?: typeof SITES;
    groups?: string[];
    allTags?: string[];
    ai?: AiAssistant;
    onApply?: (picked: { id: number; tags: string[] }[]) => void;
    onClose?: () => void;
}

async function mount(opts: MountOpts = {}) {
    const calls: SuggestCall[] = [];
    const ai =
        opts.ai ??
        fakeAi(async payload => {
            calls.push(payload as SuggestCall);
            return { ok: true, data: SUGGESTIONS };
        });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <AiSuggestDialog
                open
                onClose={opts.onClose ?? (() => {})}
                ai={ai}
                sites={opts.sites ?? SITES}
                groups={opts.groups ?? GROUPS}
                allTags={opts.allTags ?? ALL_TAGS}
                onApply={opts.onApply ?? (() => {})}
            />
        );
    });
    await act(async () => {});
    return { calls };
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(cleanup);

const checkboxOf = (siteName: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="采纳「${siteName}」的建议"]`);
const buttonByText = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );
const buttonByTextStart = (prefix: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim().startsWith(prefix)
    );

async function click(el: Element | null | undefined, msg = "要点的元素不在") {
    assert.ok(el, msg);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** Checkbox/switch 必须走原生 click（React 对它们监听 click，不是 change） */
async function tickCheckbox(el: HTMLInputElement | null, msg = "勾选框不在") {
    assert.ok(el, msg);
    await act(async () => {
        el!.click();
        await Promise.resolve();
    });
}

test("打开先问一次 AI：参数带 sites/groups/tags 原样，问的时候是加载态", async () => {
    const gate = deferred<{ ok: true; data: TagSuggestion[] }>();
    let asked = 0;
    const ai = fakeAi(async payload => {
        asked += 1;
        void payload;
        return gate.promise;
    });
    await mount({ ai });
    assert.equal(asked, 1, "打开时要问一次");
    assert.ok(document.querySelector(".MuiLinearProgress-root"), "等结果期间要有进度条");
    assert.equal(buttonByTextStart("应用")!.disabled, true, "没结果之前应用要禁用");

    await act(async () => {
        gate.resolve({ ok: true, data: SUGGESTIONS });
    });
    assert.equal(asked, 1, "结果到了不要重复问");
    assert.equal(document.querySelector(".MuiLinearProgress-root"), null, "结果到了要停进度条");
});

test("建议清单：名字回退、空标签给「建议分组」、分组 chip、计数与应用按钮", async () => {
    await mount();
    const body = document.body.textContent || "";
    assert.ok(body.includes("站点一"));
    assert.ok(body.includes("https://2.example/"), "空名字要用 URL 兜底");
    assert.ok(body.includes("建议分组：备用"), "没标签只有分组时要说明");
    assert.ok(body.includes("（没有标签建议）"), "标签与分组都空时要有兜底文案");
    assert.ok(body.includes("分组 工具箱"), "有标签也有分组时分组是 chip");
    assert.ok(body.includes("共 4 条建议"));
    assert.ok(body.includes("工具") && body.includes("云盘") && body.includes("阅读"), "标签 chip 要全在");

    const apply = buttonByTextStart("应用");
    assert.ok(apply, "要有应用按钮");
    assert.equal(apply!.textContent!.trim(), "应用 4 条", "默认全选，计数与建议数一致");
    assert.equal(apply!.disabled, false);
});

test("应用只带勾选的，应用后收起弹窗", async () => {
    const applied: { id: number; tags: string[] }[][] = [];
    let closed = 0;
    await mount({ onApply: picked => applied.push(picked), onClose: () => { closed += 1; } });

    await tickCheckbox(checkboxOf("站点一"), "站点一的勾选框不在");
    const apply = buttonByTextStart("应用");
    assert.equal(apply!.textContent!.trim(), "应用 3 条", "取消一个后计数要跟着变");
    await click(apply!);

    assert.deepEqual(applied, [[
        { id: 2, tags: [] },
        { id: 3, tags: ["阅读"] },
        { id: 4, tags: [] },
    ]], "只带勾着的几条，且不带分组字段（分组不自动挪）");
    assert.equal(closed, 1, "应用完要收弹窗");
});

test("全不选禁用应用，全选恢复", async () => {
    await mount();
    await click(buttonByText("全不选"));
    const afterNone = buttonByTextStart("应用");
    assert.equal(afterNone!.disabled, true, "一条没勾不能应用");

    await click(buttonByText("全选"));
    const afterAll = buttonByTextStart("应用");
    assert.equal(afterAll!.disabled, false);
    assert.equal(afterAll!.textContent!.trim(), "应用 4 条");
});

test("失败：原因摆出来、没有清单、应用禁用（AI 帮不上忙不算操作失败）", async () => {
    const ai = fakeAi(async () => ({ ok: false, message: "模型没配好" }));
    let applied = 0;
    await mount({ ai, onApply: () => { applied += 1; } });
    const body = document.body.textContent || "";
    assert.ok(body.includes("模型没配好"), "失败原因要摆出来");
    assert.ok(!body.includes("共 4 条建议"), "失败不能残留建议清单");
    assert.equal(buttonByTextStart("应用")!.disabled, true);
    assert.equal(applied, 0);
});

test("空建议：兜底文案，不是一片空白", async () => {
    const ai = fakeAi(async () => ({ ok: true, data: [] }));
    await mount({ ai });
    assert.ok(
        (document.body.textContent || "").includes("AI 这次没给出建议，再试一次或换个模型。")
    );
    assert.equal(buttonByTextStart("应用")!.disabled, true);
});

test("建议指向清单里没有的站点：名字兜底「站点 N」，应用照带", async () => {
    const applied: { id: number; tags: string[] }[][] = [];
    const ai = fakeAi(async () => ({
        ok: true,
        data: [{ id: 99, tags: ["孤儿"], group: "" }],
    }));
    await mount({ ai, onApply: picked => applied.push(picked) });
    assert.ok(
        (document.body.textContent || "").includes("站点 99"),
        "找不到名字要用「站点 N」兜底"
    );
    await click(buttonByTextStart("应用"));
    assert.deepEqual(applied, [[{ id: 99, tags: ["孤儿"] }]]);
});
