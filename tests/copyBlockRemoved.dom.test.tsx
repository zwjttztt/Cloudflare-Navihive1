// tests/copyBlockRemoved.dom.test.tsx
// 复制块移除后的**渲染守卫**：历史笔记里的 `> [!COPY]` 只剩「一段普通引用」。
//
// 静态守卫（copyBlockRemoved.test.ts）管「源码里不许再有复制标识符 / COPY 类型」；
// 这一条管「用户实际看到的东西」：没有内容块、没有任何可点的复制单元、正文一字不丢。
// 两边缺一不可 —— 只测源码，别人可以换个类名把按钮加回来；只测渲染，
// 残留的 CSS / hook 会一直躺在包里没人发现。
//
// ⚠️ 兼容性的落点已经**搬家**了：v31 那版靠「CALLOUT_TYPES 保留 COPY +
//    渲染层降级成中性块」保证历史笔记不出事故；本版把语法也删了，
//    兼容改由数据迁移 `notes-copy-callout-marker` 负责 ——
//    它把历史笔记里的标记行删掉，正文一字不动。
//    所以这里断言的是「迁移之前那一刻的渲染结果」：退化成一个普通引用，
//    标记会作为普通文本露出来（正是迁移要清掉的东西），而**正文与行内代码完整**。
//
// ⚠️ 断言一律先转成布尔值再交给 assert.equal：失败时 node:assert 会 util.inspect
//    参数，直接塞一个 jsdom 元素会展开 React 的 __reactFiber$ 图把堆打爆。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";

/** 渲染到真实 DOM 再读节点 —— 断言的是「浏览器里看到的」 */
async function renderToDom(md: string): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = await renderMarkdownToReact(md);
    const root = createRoot(host);
    act(() => {
        root.render(<UIPrefsProvider>{node}</UIPrefsProvider>);
    });
    return host;
}

test("历史 COPY 块：只是一个普通引用，没有任何复制单元，正文完整", async () => {
    const host = await renderToDom("> [!COPY]\n> 甲 `code` 乙");

    // ① 不再是内容块：COPY 这个类型已经从 CALLOUT_TYPES 里删了，
    //    渲染层不该再产出任何 data-callout（连中性色板的那份也没有）。
    assert.equal(
        host.querySelector('[data-callout="COPY"]') === null,
        true,
        "还渲染出了 data-callout=COPY —— 语法已删，不该再有 COPY 内容块"
    );
    assert.equal(
        host.querySelector("[data-callout]") === null,
        true,
        "不该再有任何内容块配色（它现在只是一段普通引用）"
    );
    // ② 退化成引用，而不是整块消失（整块消失等于正文丢了）
    assert.equal(
        host.querySelector("blockquote") !== null,
        true,
        "认不出类型之后必须退回普通引用，而不是把这块内容整段吞掉"
    );

    // ③ 一个复制控件都不许有：片段（role=button）、整块按钮、宿主 class、事件钩子。
    assert.equal(
        host.querySelector('[role="button"]') === null,
        true,
        "出现了 role=button 的可复制片段"
    );
    assert.equal(
        host.querySelector(".md-copy-frag") === null,
        true,
        "出现了 .md-copy-frag 片段节点"
    );
    assert.equal(
        host.querySelector(".md-copy-host") === null,
        true,
        "出现了 .md-copy-host 复制块宿主"
    );
    assert.equal(
        host.querySelector("[data-copy-op]") === null,
        true,
        "出现了带 data-copy-op 的复制按钮"
    );
    assert.equal(
        host.querySelector("button") === null,
        true,
        "这块里不该有任何按钮（整块/片段复制都已移除）"
    );

    // ④ 正文一字不丢（这是删语法时唯一真正的风险）。
    const text = (host.textContent ?? "").replace(/\s+/g, " ").trim();
    assert.equal(
        text.includes("甲 code 乙"),
        true,
        `正文丢了或行内代码被改写了，实际文本：${JSON.stringify(text)}`
    );

    // ⑤ 反引号现在是**普通行内代码**（灰底胶囊），不是可复制片段。
    const code = host.querySelector("code");
    assert.equal(code !== null, true, "行内代码没渲染出来");
    assert.equal(
        (code!.className ?? "").includes("md-copy"),
        false,
        "行内代码还挂着复制片段的 class"
    );
    assert.equal(code!.textContent, "code", "行内代码内容要原样保留");

    // ⑥ 诚实钉住「迁移之前」的样子：标记会作为普通文本露出来。
    //    这不是 bug，是迁移 `notes-copy-callout-marker` 存在的原因 ——
    //    它把标记行删掉之后，线上就看不到这行字了。
    //    断言一旦变红，说明有人把 COPY 重新加进了 CALLOUT_TYPES（死灰复燃）。
    assert.equal(
        text.includes("[!COPY]"),
        true,
        "语法删除后标记会原样显示，清洗靠数据迁移；红说明 COPY 又被加回枚举了"
    );
});
