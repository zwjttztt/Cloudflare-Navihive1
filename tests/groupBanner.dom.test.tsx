// tests/groupBanner.dom.test.tsx
// A3 分组横幅（2026-10-22）：纯 CSS 取色带 + 首字水印，不存数据不改接口。
//
// 盯三点：① 横幅真的在（以前只有左角一根 3px 色条，整屏分组一个样）；
// ② 水印字是组名首字；③ 取色规则 —— 传了强调色用它，没传按组名哈希
// （同名同色，所以两个同名的组横幅必须一样，这是「稳定可辨」的判据）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import GroupCard from "../src/components/GroupCard";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { GroupWithSites } from "../src/types";
import { toneForName } from "../src/utils/siteAvatar";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
});

function group(name: string, id = 1): GroupWithSites {
    return { id, name, order_num: 0, sites: [] };
}

function mount(g: GroupWithSites, accentColor = "") {
    // 同一个用例里可能要挂好几次（比较不同分组）：先拆掉上一个，不然
    // querySelector 会命中还挂在 body 里的旧面板
    if (root) act(() => root!.unmount());
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <DndContext>
                    <GroupCard
                        group={g}
                        sortMode="None"
                        currentSortingGroupId={null}
                        onUpdate={() => {}}
                        onDelete={() => {}}
                        onSaveSiteOrder={() => {}}
                        onStartSiteSort={() => {}}
                        accentColor={accentColor}
                    />
                </DndContext>
            </UIPrefsProvider>
        );
    });
}

const banner = () => document.querySelector<HTMLElement>("[data-group-banner='1']");

test("分组面板顶部有横幅（不再只有左角一根色条）", () => {
    mount(group("开发工具"));
    const el = banner();
    assert.ok(el, "分组面板要有横幅");
    // 装饰性：读屏不该念一遍组名首字（组名本身就在标题里）
    assert.equal(el!.getAttribute("aria-hidden"), "true", "横幅是装饰，读屏跳过");
    const bg = getComputedStyle(el).backgroundImage;
    assert.ok(bg.includes("linear-gradient"), "横幅要是渐变色带，不是纯色块");
});

test("水印字 = 组名首字（中文取第一个字，不转大写）", () => {
    mount(group("开发工具"));
    assert.equal(banner()?.textContent, "开", "中文组名取第一个字");
    mount(group("Design"));
    assert.equal(banner()?.textContent ?? "", "D", "英文组名取首字母（保留原大小写）");
});

test("取色：传了强调色就用它；没传按组名哈希，同名同色", () => {
    mount(group("开发工具"), "#123456");
    assert.ok(
        getComputedStyle(banner()!).backgroundImage.includes("18, 52, 86"),
        "accentColor=#123456 → 横幅渐变用 rgb(18,52,86)"
    );
    // 没传：按组名哈希。两个同名的组必须拿到同一个色（稳定可辨的判据）
    mount(group("设计灵感"));
    const first = getComputedStyle(banner()!).backgroundImage;
    const expected = toneForName("设计灵感").strong;
    const rgb = expected.slice(1).match(/../g)!.map(h => parseInt(h, 16)).join(", ");
    assert.ok(first.includes(rgb), `没传强调色时用 toneForName 的色（期望 rgb(${rgb})）`);
    mount(group("设计灵感"));
    assert.equal(
        getComputedStyle(banner()!).backgroundImage,
        first,
        "同名分组再渲染一次，横幅颜色必须一样（哈希稳定）"
    );
    mount(group("完全不同的名字"));
    assert.notEqual(
        getComputedStyle(banner()!).backgroundImage,
        first,
        "不同名分组颜色应该散开（否则哈希白做）"
    );
});

test("空组名不炸：水印给占位符", () => {
    mount(group(""));
    assert.ok(banner(), "空组名也要有横幅（布局不能塌）");
    assert.equal(banner()?.textContent, "?", "空组名给问号占位");
});
