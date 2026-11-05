// tests/copyBlockFragments.dom.test.tsx
// `> [!COPY]` 可复制块：方案三「极简虚线下划线 + 悬停显形」（2026-11-05）。
//
// 这一组要钉住的四件事，每一条都是「用户能直接感觉到」的：
//   ① 块内**每个反引号片段**都是独立复制单元（一行里三个就三个，分别能复制）；
//   ② 块**外**的行内代码一个字节都不能变（灰底圆角胶囊照旧）—— 这是防回归的重点；
//   ③ 复制的是**片段原文**（不带反引号、不带气泡文字）；
//   ④ 触屏与键盘两条路径都能用（触屏点击即复制、Tab 能逐个片段聚焦、Enter/Space 触发）。
//
// ⚠️ jsdom 不跑媒体查询里的层叠、也不真的「悬停」，所以第 ⑤ 条（悬停整块才显整块按钮）
//    测的是**结构性契约**：DOM 结构 + `md-copy-host` 类名 + index.css 里
//    `@media (hover: hover)` 那几条规则的存在性。这里不写「假装悬停成功」的假绿，
//    真悬停由 audit:contrast 的 hover 段与人工验收兜着。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import {
    declOf,
    indexCssRules,
    isHoverCapable,
    isNoHover,
    opacityOf,
    stripCssComments,
} from "./helpers/cssRules";

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

/** 渲染到真实 DOM 再断言 —— 断言的是「浏览器里看到的节点」 */
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

/**
 * 剪贴板桩。与 tests/markdownRender.dom.test.tsx 同一套（jsdom 没有 navigator.clipboard，
 * 而 copyToClipboard 在非安全上下文里会走 execCommand 兜底，两条路都得摆平）。
 * 返回 `written`（写进去的内容，按顺序）与 `restore`。
 */
function stubClipboard(): { written: string[]; restore: () => void } {
    const written: string[] = [];
    const prevClipboard = navigator.clipboard;
    const hadClipboard = Boolean(prevClipboard);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t: string) => { written.push(t); } },
    });
    const prevSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const restore = () => {
        if (hadClipboard) {
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: prevClipboard });
        } else {
            delete (navigator as unknown as { clipboard?: unknown }).clipboard;
        }
        if (prevSecure) Object.defineProperty(window, "isSecureContext", prevSecure);
    };
    return { written, restore };
}

/** 等微任务队列空下来（copyToClipboard 是 async） */
async function flush(): Promise<void> {
    await act(async () => {
        await new Promise(r => setTimeout(r, 0));
    });
}

/** 用户报的那三行示例：一行一个片段 + 一行三个片段 */
const THREE_UNITS = [
    "> [!COPY]",
    "> 镜像站点：`https://mirror.example.org/v2`",
    "> 数据库连接：`10.0.42.18:5432`  账号：`postgres_ro`  密码：`db_9981_xk`",
].join("\n");

const fragsOf = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-copy-op="copy-frag"]'));

const fragTextOf = (host: HTMLElement): string[] =>
    fragsOf(host).map(el => (el.querySelector("code")?.textContent ?? "").trim());

// ---------------------------------------------------------------------------
// ① 数量与粒度
// ---------------------------------------------------------------------------

test("COPY 块：反引号片段逐个成为可复制单元（同一行里的多个也各算一个）", async () => {
    const host = await renderToDom(THREE_UNITS);
    const block = host.querySelector('[data-callout="COPY"]');
    assert.ok(block, "没渲染出 COPY 块");

    assert.deepEqual(
        fragTextOf(host),
        ["https://mirror.example.org/v2", "10.0.42.18:5432", "postgres_ro", "db_9981_xk"],
        "第一行 1 个 + 第二行 3 个 = 4 个独立单元；顺序必须与正文一致"
    );
    // 片段里包的是**原文**（不带反引号），用 <code> 保等宽
    for (const el of fragsOf(host)) {
        assert.ok(el.querySelector("code"), "每个片段里要有 <code>（等宽字形）");
        assert.equal(el.textContent?.includes("`"), false, "片段文本里不能带反引号");
    }
    // 块内普通文字（没有反引号的）不产生单元
    assert.equal(
        (block!.textContent ?? "").includes("镜像站点"),
        true,
        "块内普通文字照常显示（不能被吞掉）"
    );
});

test("COPY 块：嵌套结构（列表里的片段）同样带复制单元（Cursor 逐层传递）", async () => {
    const host = await renderToDom("> [!COPY]\n> - 甲 `list-a`\n> - 乙 `list-b`");
    assert.deepEqual(fragTextOf(host), ["list-a", "list-b"], "列表项里的片段也必须可复制");
});

// ---------------------------------------------------------------------------
// ② 防回归：块外的行内代码一个字都不许变
// ---------------------------------------------------------------------------

test("块外的行内代码不带复制单元，并且保留原来的灰底圆角胶囊", async () => {
    const host = await renderToDom(
        ["普通段落里的 `const a = 1` 必须还是老样子", "", THREE_UNITS].join("\n")
    );

    const outside = host.querySelector("p code") as HTMLElement | null;
    assert.ok(outside, "块外的行内代码应当仍然渲染成 <code>");
    // ⚠️ 只把**布尔值**交给 assert.equal，绝不把 DOM 元素本身交给它。
    //    2026-11-05 QA 变异测试发现的坑：React 会给渲染出的 jsdom 节点挂上
    //    __reactFiber$ / __reactProps$，node:assert 在**构造失败消息**时会 inspect
    //    那个元素，把整棵 fiber 图展开成字符串 —— 实测 512MB 堆 2.8s 就 OOM，
    //    CI 上只有一条文件级 not ok、零断言消息（见 QA 的 M7/M7b/M7c）。
    //    换成布尔值后，同样的失败 2ms 报出 41 字的可读消息。
    assert.equal(
        outside!.closest("[data-copy-op]") === null,
        true,
        "块外的行内代码**不许**带上任何复制单元（这是本次改动最容易踩的回归）"
    );
    // INLINE_CODE 的四个特征属性，一个都不能被新样式顶掉
    assert.match(
        outside!.getAttribute("style") ?? "",
        /--md-inline-code-bg/,
        "块外行内代码的背景必须仍走 --md-inline-code-bg（灰底胶囊）"
    );
    assert.equal(outside!.style.borderRadius, "5px", "圆角 5px 是行内代码的既有形态");
    assert.equal(outside!.style.padding, "1px 5px", "内边距 1px 5px 不能被改（会改变行内代码的占地）");
    assert.equal(
        outside!.className,
        "",
        "块外的 <code> 不许被加上 md-copy-frag 那套 class"
    );

    // 块内则相反：有单元、没有灰底胶囊
    assert.equal(fragsOf(host).length, 4, "块内 4 个片段照旧");
});

// ---------------------------------------------------------------------------
// ③ 复制内容：片段原文 / 整块纯文本
// ---------------------------------------------------------------------------

test("点片段 → 剪贴板收到**该片段原文**，并在片段自身给出「已复制」反馈", async () => {
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(THREE_UNITS);
        const frags = fragsOf(host);
        const target = frags[2]; // 第二行的「账号：`postgres_ro`」
        assert.ok(target, "找不到要点的片段");
        assert.equal(target.getAttribute("data-copied"), null, "点之前不该有已复制标记");

        await act(async () => {
            target.click();
        });
        await flush();

        assert.deepEqual(written, ["postgres_ro"], "只写一次，内容是该片段原文（不带反引号、不带前后文字）");
        assert.equal(target.getAttribute("data-copied"), "1", "片段自己要有已复制状态（不弹全局 toast）");
        assert.match(
            target.getAttribute("aria-label") ?? "",
            /^已复制：/,
            "可访问名要跟着变，读屏用户才知道点成功了"
        );
        // 整块按钮的状态机不许被片段的复制带起来（两者是独立的反馈）
        const blockBtn = host.querySelector('[data-copy-op="copy-block"]') as HTMLElement;
        assert.equal(
            blockBtn.getAttribute("data-copied"),
            null,
            "片段复制不能顺手把整块按钮也点亮（状态机要独立）"
        );
        // 另一个片段不受影响
        assert.equal(frags[0].getAttribute("data-copied"), null, "别的片段不该跟着变");
    } finally {
        restore();
    }
});

// 2026-11-05 追加：把「点片段不会冒泡触发整块复制」单独钉成一条。
// 结构性事实：整块按钮是 `<div class="md-copy-host">` 下的独立 `<button onClick>`，
// host 上没有 onClick，片段的 click 冒泡到 host 时没有任何处理器 —— 于是
// 整块复制的 `copyToClipboard` 根本不会被调用，剪贴板里只该有**一次写入**。
// 之前那条用例里顺带查过一次 data-copied，但那是「片段反馈」的一部分；
// 这里明确把「剪贴板内容 === 片段原文」和「整块按钮没有 data-copied」绑成同一断言组，
// 免得将来有人给 host 加 onClick（比如做「点空白全选」）时静默把整块也复制一遍。
test("事件冒泡：点片段只写片段原文，整块复制按钮不会被连带触发", async () => {
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(THREE_UNITS);
        const blockBtn = host.querySelector('[data-copy-op="copy-block"]') as HTMLButtonElement | null;
        assert.ok(blockBtn, "整块按钮必须在场（这条测的正是它没被误触发）");
        const expected = "db_9981_xk";
        const target = fragsOf(host).find(el => el.querySelector("code")?.textContent === expected);
        assert.ok(target, "找不到最后一个片段");

        await act(async () => {
            target!.click();
        });
        await flush();

        // ① 剪贴板只收到片段原文一次；出现第二笔（整块文本）就是冒泡误触发
        assert.deepEqual(
            written,
            [expected],
            "点片段后剪贴板必须恰好是 [片段原文]；多一条写入说明整块复制被连带触发了"
        );
        // ② 整块按钮的状态机完全没动
        assert.equal(
            blockBtn!.hasAttribute("data-copied"),
            false,
            "整块按钮上不许出现 data-copied（没点它就不该有反馈）"
        );
        assert.equal(
            blockBtn!.getAttribute("data-copied"),
            null,
            "整块按钮的 data-copied 必须仍是缺位，不是空串 / 0"
        );
        assert.equal(
            (blockBtn!.textContent ?? "").trim(),
            "复制",
            "整块按钮的文字不能被片段的复制改成「已复制」"
        );
    } finally {
        restore();
    }
});

test("整块复制的产物与改动前逐字相同：不含反引号、不含气泡文字", async () => {
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(["> [!COPY]", "> 甲 `a1` 乙", ">", "> 丙 `b1` 丁"].join("\n"));
        const blockBtn = host.querySelector('[data-copy-op="copy-block"]') as HTMLButtonElement;
        assert.ok(blockBtn, "没渲染出整块复制按钮");
        await act(async () => {
            blockBtn.click();
        });
        await flush();

        assert.equal(written.length, 1, "点一次只写一次");
        assert.equal(
            written[0],
            "甲 a1 乙\n\n丙 b1 丁",
            "整块复制仍然走 blockTextOf（渲染后纯文本），与改动前逐字相同"
        );
        // 气泡文字是 CSS 生成内容 —— 一旦有人把它写成文本节点，这里立刻红
        assert.equal(
            written[0].includes("点击复制") || written[0].includes("已复制"),
            false,
            "气泡文字不许混进整块复制的产物（它只是装饰）"
        );
        assert.equal(blockBtn.getAttribute("data-copied"), "1", "整块按钮自己的反馈照旧");
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// ④ 降级：块内一个反引号都没有
// ---------------------------------------------------------------------------

test("块内没有反引号 → 优雅降级成「只有整块复制」，不报错不吞内容", async () => {
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(["> [!COPY]", "> 甲行", ">", "> 乙行"].join("\n"));
        assert.equal(fragsOf(host).length, 0, "没有反引号就不该冒出任何片段单元");
        const blockBtn = host.querySelector('[data-copy-op="copy-block"]') as HTMLButtonElement;
        assert.ok(blockBtn, "整块按钮必须还在（这是降级后唯一的复制入口）");
        await act(async () => {
            blockBtn.click();
        });
        await flush();
        assert.equal(written[0], "甲行\n\n乙行", "降级路径仍能整块复制，内容完整");
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// ⑤ 可访问性 / 输入方式
// ---------------------------------------------------------------------------

test("片段的 DOM 契约：role=button、可 Tab 聚焦、可访问名里带片段原文", async () => {
    const host = await renderToDom(THREE_UNITS);
    const frags = fragsOf(host);
    assert.equal(frags.length, 4);
    for (const el of frags) {
        assert.equal(el.getAttribute("role"), "button", "片段必须是按钮语义（读屏会念「按钮」）");
        assert.equal(el.getAttribute("tabindex"), "0", "Tab 必须能逐个走到每个片段");
        const label = el.getAttribute("aria-label") ?? "";
        assert.match(
            label,
            /^复制：\S/,
            `可访问名要明确（形如「复制：10.0.42.18:5432」），实际是 ${JSON.stringify(label)}`
        );
        // 名字里要带上片段原文，否则读屏用户连听几个「复制」分不清是哪一个
        assert.ok(
            label.includes((el.querySelector("code")?.textContent ?? "").trim()),
            "可访问名必须含片段原文"
        );
    }
    // 气泡里**不能**有文本节点（否则 jsdom 的 textContent 兜底会把装饰文字也复制走）
    for (const tip of Array.from(host.querySelectorAll<HTMLElement>(".md-copy-frag-tip"))) {
        assert.equal(tip.textContent, "", "气泡文字必须来自 CSS 生成内容，DOM 里保持空");
        assert.equal(tip.getAttribute("aria-hidden"), "true", "气泡是装饰，别让读屏念出来");
    }
});

test("键盘：Enter 与 Space 都能触发片段复制（Space 还要拦掉页面滚动）", async () => {
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(THREE_UNITS);
        const frag = fragsOf(host)[1];
        assert.ok(frag, "找不到第二个片段");

        await act(async () => {
            frag.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
            }));
        });
        await flush();
        assert.deepEqual(written, ["10.0.42.18:5432"], "Enter 要能复制");

        const spaceEvent = new KeyboardEvent("keydown", {
            key: " ",
            bubbles: true,
            cancelable: true,
        });
        await act(async () => {
            frag.dispatchEvent(spaceEvent);
        });
        await flush();
        assert.deepEqual(
            written,
            ["10.0.42.18:5432", "10.0.42.18:5432"],
            "Space 也要能复制"
        );
        assert.equal(spaceEvent.defaultPrevented, true, "Space 必须 preventDefault，否则页面会跟着滚一格");

        // 其它键不许触发复制（否则在正文里按方向键也在写剪贴板）
        await act(async () => {
            frag.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        });
        await flush();
        assert.equal(written.length, 2, "非 Enter/Space 的按键不该触发复制");
    } finally {
        restore();
    }
});

test("悬停整块才显整块按钮：DOM 结构与 CSS 类构成的结构性契约", async () => {
    const host = await renderToDom(THREE_UNITS);
    const block = host.querySelector('[data-callout="COPY"]') as HTMLElement;
    assert.ok(block, "没渲染出 COPY 块");
    // ① 块必须有 md-copy-host —— index.css 的显形选择器全挂在它身上，
    //    组件要是把这个类名丢了，悬停显形会**静默失效**（按钮永远看不见）。
    assert.ok(block.classList.contains("md-copy-host"), "块上必须有 md-copy-host 类（悬停显形靠它）");
    // ② 按钮是块的**直接子元素**且绝对定位：静止时不占版面（也就不会有 28px 操作带）
    const btn = block.querySelector('[data-copy-op="copy-block"]') as HTMLElement;
    // 同「只比较布尔值」：这里也别把 btn.parentElement 直接交给 assert.equal。
    assert.equal(
        btn.parentElement === block,
        true,
        "按钮必须是块的直接子元素（hover 选择器是 .md-copy-host:hover .md-copy-btn）"
    );
    assert.equal(btn.style.getPropertyValue("position"), "absolute");
    assert.equal(block.style.getPropertyValue("padding-top"), "", "不许给按钮预留操作带（28px 已删）");

    // 真 hover 在 jsdom 里测不到（不跑媒体查询、不合成 :hover），
    // 所以这里断言「显形规则确实存在且只在 hover-capable 下生效」，不写假绿。
    const css = stripCssComments(readFileSync(resolve(findProjectDir(), "src", "index.css"), "utf-8"));
    const rules = indexCssRules(css);
    const hideRule = rules.find(r => r.selector === ".md-copy-btn" && opacityOf(r.body) === 0);
    assert.ok(hideRule, "index.css 里缺「静止隐藏整块按钮」的规则");
    assert.ok(isHoverCapable(hideRule!), "静止隐藏只许出现在 @media (hover: hover) 里");
    assert.ok(
        rules.some(r => isHoverCapable(r) && r.selector.includes(".md-copy-host:hover")),
        "缺「悬停整块 → 按钮显形」的规则"
    );
});

// ---------------------------------------------------------------------------
// ⑥ 样式守卫：紧凑形态 + 触屏可用 + 配色走 token
// ---------------------------------------------------------------------------

test("片段样式：静止只有一条 1px 虚线，不加 padding / 不占额外空间", () => {
    const css = stripCssComments(readFileSync(resolve(findProjectDir(), "src", "index.css"), "utf-8"));
    const rules = indexCssRules(css);

    const frag = rules.find(r => r.selector === ".md-copy-frag" && r.media === "");
    assert.ok(frag, "index.css 里缺 .md-copy-frag 的基础规则");
    assert.match(
        declOf(frag!.body, "border-bottom") ?? "",
        /^1px\s+dashed\s+var\(--md-copy-frag-rule/,
        "静止态的标志就是这条 1px 虚线，且颜色必须走 token（硬编码色守卫是棘轮）"
    );
    assert.equal(
        declOf(frag!.body, "padding"),
        undefined,
        "片段不许加 padding —— 那会改变正文的排版密度，正是「占地方」的老毛病"
    );
    assert.equal(
        declOf(frag!.body, "display"),
        "inline",
        "必须是 inline（inline 元素的 border **不参与行盒高度计算**，所以虚线是零占地的）"
    );
    // 块内代码片段不带灰底胶囊（那是「块外行内代码」的形态）
    const code = rules.find(r => r.selector === ".md-copy-frag-code" && r.media === "");
    assert.ok(code, "缺 .md-copy-frag-code 规则");
    assert.equal(declOf(code!.body, "background"), "transparent", "块内片段不要灰底胶囊");
    assert.equal(declOf(code!.body, "padding"), "0", "块内片段不要行内代码的内边距");

    // 悬停 / 已复制 都必须是**有专属配色**的状态，且颜色一律走 token
    // （硬编码色守卫是棘轮，只许降不许升；首屏 CSS 预算也逼着复用既有 token）
    for (const sel of [".md-copy-frag:hover", ".md-copy-frag[data-copied=\"1\"]"]) {
        const rule = rules.find(r => r.selector.includes(sel) && r.media === "");
        assert.ok(rule, `缺 ${sel} 的样式`);
        assert.match(
            declOf(rule!.body, "background") ?? "",
            /^var\(--/,
            `${sel} 的底色必须走 CSS 变量（别写死颜色）`
        );
        assert.match(
            declOf(rule!.body, "border-bottom-color") ?? "",
            /^var\(--/,
            `${sel} 的虚线颜色也必须走 CSS 变量`
        );
    }
});

test("气泡：文字来自 CSS 生成内容，悬停 / 聚焦 / 已复制时才显形", () => {
    const css = stripCssComments(readFileSync(resolve(findProjectDir(), "src", "index.css"), "utf-8"));
    const rules = indexCssRules(css);

    const tip = rules.find(r => r.selector === ".md-copy-frag-tip" && r.media === "");
    assert.ok(tip, "缺 .md-copy-frag-tip 规则");
    assert.equal(opacityOf(tip!.body), 0, "气泡静止必须不可见");
    assert.equal(declOf(tip!.body, "pointer-events"), "none", "气泡不许吃鼠标（否则自己 hover 自己会抖）");

    const text = rules.find(r => r.selector === ".md-copy-frag-tip::before");
    assert.ok(text, "气泡文字必须是 ::before 的生成内容");
    assert.match(declOf(text!.body, "content") ?? "", /点击复制/, "气泡文案要说明「点了会怎样」");

    const copied = rules.find(r => r.selector.includes('.md-copy-frag[data-copied="1"] .md-copy-frag-tip::before'));
    assert.ok(copied, "缺「已复制」那份生成内容");
    assert.match(declOf(copied!.body, "content") ?? "", /已复制/, "复制成功后气泡文字要变");

    const reveal = rules.filter(r => opacityOf(r.body) === 1 && r.selector.includes(".md-copy-frag-tip"));
    assert.ok(reveal.some(r => r.selector.includes(":hover")), "悬停要显形（鼠标路径）");
    assert.ok(
        reveal.some(r => r.selector.includes(":focus-visible")),
        "键盘聚焦也要显形（只有鼠标反馈等于没法用键盘）"
    );
});

test("触屏 / 无 hover 设备：碎片点击即复制、整块按钮常显（不能只靠悬停）", async () => {
    // ① CSS 侧：必须有 @media (hover: none) 把整块按钮显式写回可见
    const css = stripCssComments(readFileSync(resolve(findProjectDir(), "src", "index.css"), "utf-8"));
    const rules = indexCssRules(css);
    const touchVisible = rules.filter(
        r => isNoHover(r) && r.selector.includes(".md-copy-btn") && (opacityOf(r.body) === 1 || declOf(r.body, "visibility") === "visible")
    );
    assert.ok(
        touchVisible.length >= 1,
        "缺 @media (hover: none) 的「常显」规则 —— 触屏上整块复制会变成按不到的按钮"
    );
    // 隐藏规则一条都不许出现在无 hover 的条件里
    for (const rule of rules) {
        if (!isNoHover(rule)) continue;
        if (!rule.selector.includes(".md-copy-btn")) continue;
        assert.notEqual(opacityOf(rule.body), 0, "@media (hover: none) 里不许把整块按钮藏起来");
    }

    // ② 行为侧：触屏唯一的交互是 click，所以 click 必须**直接**完成复制（不是「先选中再点」）
    const { written, restore } = stubClipboard();
    try {
        const host = await renderToDom(THREE_UNITS);
        const frag = fragsOf(host)[0];
        await act(async () => {
            frag.click();
        });
        await flush();
        assert.deepEqual(written, ["https://mirror.example.org/v2"], "点一下就复制（触屏没有悬停可依赖）");
    } finally {
        restore();
    }
});
