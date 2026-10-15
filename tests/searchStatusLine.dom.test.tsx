// tests/searchStatusLine.dom.test.tsx
// 搜索框下面的状态行（SearchStatusLine），重点是语义搜索那句「要先建索引」的提示。
//
// 2026-10-15 线上 bug：这句话在页面上出现了**两遍**。根因是 SearchStatusLine 从
// App.tsx「纯搬迁」时，App 里那份旧 JSX 没删 —— 组件渲染一遍、App 又渲染一遍，
// 两处的条件还完全一样，所以任何时候都是成对出现。搬迁类重构的经典后遗症。
//
// 本测试两层防线：
//   1. 源码守卫：这句文案在整个 src/ 里只允许出现在 SearchStatusLine.tsx 一个文件
//      （再有人把提示搬去哪里、或者又留一份旧的，这里直接红）；
//   2. DOM 行为：条件满足时渲染一次，「现在生成」点了真的触发回调；
//      没开语义 / 已有索引时不渲染。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SearchStatusLine from "../src/components/SearchStatusLine";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(ui));
}

const HINT = "语义搜索要先给站点建一次索引。";

/** 默认 props：语义搜索开着、AI 就绪、还没建索引 —— 提示该出现的场景 */
function props(overrides: Partial<Parameters<typeof SearchStatusLine>[0]> = {}) {
    return {
        filtering: false,
        matchedCount: 0,
        renderedCount: 0,
        searchTruncated: false,
        searchExpanded: false,
        onExpand: () => { },
        onCollapse: () => { },
        hint: "",
        semanticEnabled: true,
        semanticNote: "",
        aiReady: true,
        embeddedCount: 0,
        semanticBusy: false,
        onBuildSemanticIndex: () => { },
        ...overrides,
    };
}

test("没建索引时提示出现且只出现一次，「现在生成」触发回调", t => {
    t.after(cleanup);
    let built = 0;
    mount(<SearchStatusLine {...props({ onBuildSemanticIndex: () => { built += 1; } })} />);

    const text = document.body.textContent ?? "";
    const occurrences = text.split(HINT).length - 1;
    assert.equal(occurrences, 1, `提示应只出现一次，实际 ${occurrences} 次`);

    const btn = [...document.querySelectorAll<HTMLElement>("button")].find(
        b => (b.textContent || "").trim() === "现在生成"
    );
    assert.ok(btn, "应有「现在生成」按钮");
    act(() => {
        btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(built, 1, "点了要真的触发建索引");
});

test("已建索引 / 没开语义：不出现建索引提示", t => {
    t.after(cleanup);
    mount(<SearchStatusLine {...props({ embeddedCount: 3 })} />);
    assert.ok(!(document.body.textContent ?? "").includes(HINT), "有索引了不该再教人建索引");
    cleanup();

    mount(<SearchStatusLine {...props({ semanticEnabled: false })} />);
    assert.ok(!(document.body.textContent ?? "").includes(HINT), "没开语义搜索不该出现这句");
});

// ---- 源码守卫：这句文案只许有一个出处 ----

function projectDir(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

test("源码守卫：建索引提示只出现在 SearchStatusLine.tsx（防「搬迁留旧副本」再犯）", () => {
    const owners = walk(path.join(projectDir(), "src"))
        .filter(f => readFileSync(f, "utf8").includes(HINT))
        // Windows 下 path.relative 给反斜杠，统一成正斜杠再比
        .map(f => path.relative(projectDir(), f).split(path.sep).join("/"));
    assert.deepEqual(
        owners,
        ["src/components/SearchStatusLine.tsx"],
        `这句提示只应由 SearchStatusLine 渲染，实际出处：${JSON.stringify(owners)}` +
        "（2026-10-15 的「显示两遍」就是 App.tsx 里留了一份旧副本）"
    );
});
