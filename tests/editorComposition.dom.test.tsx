// tests/editorComposition.dom.test.tsx
// 中文输入法（IME）composition 期间「受控 value 全量回写」竞态的复现与守卫。
//
// 用户现象：正文里落下 `sssss` / `x'x'x'x'x'x` 这类拼音字母，下方还挂着候选框；
// 字数统计显示这些字母已经进入文档模型 —— 组合被中途打断，浏览器把缓冲区中间态
// 当成最终文本提交了。
//
// 根因（QA 逐行验证）：NoteEditor 的 useEffect([value]) 用
// `changes: { from: 0, to: doc.length, insert: value }` **整篇替换**文档；而
// updateListener 的 150ms 合并窗口让 draft.content 永远慢半拍。组合期间任何一次
// 带旧 value 的重渲染都会整棵重绘 contenteditable，IME 绑定的文本节点被换掉，
// 拼音固化；那次 dispatch 又 docChanged → pushImmediate → 自激循环。
//
// ⚠️ jsdom 没有 contenteditable 的 IME 实现，派发 compositionstart 不会真的把拼音
//    写进 CM doc。所以这里用 CM 自己的 `view.dispatch({ userEvent: "input.type.compose" })`
//    注入组合事务（该 userEvent 会被 `isUserEvent("input.type")` 前缀命中，走合并窗口），
//    再闭合「onChange → 父级 value」的受控环，推进 150ms 观察回写。
//
// ⚠️ 断言一律先转布尔/字符串，绝不把 DOM 元素交给 assert.equal —— node:assert 失败
//    时会 util.inspect 展开 React 的 __reactFiber$ 图把堆打爆。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import NoteEditor from "../src/components/NoteEditor";
import type { NoteEditorHandle } from "../src/utils/noteEditorHandle";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

interface AppChange {
    from: number;
    to: number;
    insert: string;
}

interface Harness {
    view: EditorView;
    /** 父级带一份草稿重渲染受控编辑器（外部灌入 / 陈旧 value 都走这里） */
    renderWith(value: string): void;
    /** onChange 收到的文本，按时间顺序 */
    emitted: string[];
    /** 应用层（非测试注入）dispatch 的 changes，用来数「有没有回写」 */
    appChanges: AppChange[];
    /** 推进真实定时器；期间不套外层 act 的嵌套调用 */
    wait(ms: number): Promise<void>;
    /** 模拟一次 composition 期间 CM 收到的文档变更 */
    compose(insert: string, userEvent?: string): void;
    /** 模拟最终汉字上屏：把 [from,to) 换成 insert */
    replace(from: number, to: number, insert: string, userEvent?: string): void;
    fire(type: "compositionstart" | "compositionend"): void;
    dispose(): void;
}

function mount(initial: string): Harness {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    const editorRef: { current: NoteEditorHandle | null } = { current: null };
    const emitted: string[] = [];
    const appChanges: AppChange[] = [];
    let current = initial;
    // emit.pushImmediate 会在 dispatch 的 updateListener 里同步回调 onChange，
    // 那时外层 renderWith 的 act 还在栈上；再套一层 act 会触发 React 19 的
    // 「suspended inside an act scope」告警。重入/外层 act 期间直接 render。
    let renderDepth = 0;
    let inWait = false;

    const renderWith = (value: string) => {
        current = value;
        const apply = () => root.render(
            <NoteEditor
                editorRef={editorRef}
                value={current}
                onChange={v => {
                    emitted.push(v);
                    renderWith(v);
                }}
            />
        );
        if (renderDepth > 0 || inWait) {
            apply();
            return;
        }
        renderDepth++;
        try {
            act(apply);
        } finally {
            renderDepth--;
        }
    };
    renderWith(initial);

    const content = host.querySelector<HTMLElement>(".cm-content");
    assert.ok(content, "没挂载出 .cm-content");
    const maybeView = EditorView.findFromDOM(content!);
    assert.ok(maybeView, "拿不到 EditorView");
    const view: EditorView = maybeView!;

    // 记录「应用层」dispatch：测试注入的组合事务会置 simulating，不计数。
    let simulating = false;
    const originalDispatch = view.dispatch.bind(view);
    view.dispatch = ((...specs: Parameters<EditorView["dispatch"]>) => {
        if (!simulating) {
            for (const spec of specs) {
                const changes = (spec as { changes?: unknown }).changes;
                if (changes && typeof changes === "object" && !Array.isArray(changes)) {
                    const c = changes as { from?: number; to?: number; insert?: string };
                    appChanges.push({ from: c.from ?? -1, to: c.to ?? -1, insert: c.insert ?? "" });
                }
            }
        }
        return originalDispatch(...specs);
    }) as EditorView["dispatch"];

    const inject = (fn: () => void) => {
        simulating = true;
        try {
            act(fn);
        } finally {
            simulating = false;
        }
    };

    return {
        view,
        renderWith,
        emitted,
        appChanges,
        async wait(ms: number) {
            inWait = true;
            try {
                await act(async () => {
                    await new Promise(r => setTimeout(r, ms));
                });
            } finally {
                inWait = false;
            }
        },
        compose(insert, userEvent = "input.type.compose") {
            inject(() => {
                view.dispatch({
                    changes: { from: view.state.doc.length, insert },
                    userEvent,
                });
            });
        },
        replace(from, to, insert, userEvent = "input.type.compose") {
            inject(() => {
                view.dispatch({ changes: { from, to, insert }, userEvent });
            });
        },
        fire(type) {
            act(() => {
                view.contentDOM.dispatchEvent(
                    new window.Event(type, { bubbles: true, cancelable: true })
                );
            });
        },
        dispose() {
            act(() => root.unmount());
            host.remove();
        },
    };
}

const docOf = (h: Harness): string => h.view.state.doc.toString();

test("IME 复现：组合中带陈旧 value 重渲染，不许整篇回写打断组合（红→绿）", async () => {
    const h = mount("甲");
    try {
        h.fire("compositionstart");
        h.compose("s");
        h.compose("ssss");
        assert.equal(docOf(h), "甲sssss", "前置：拼音作为组合中间态进文档");

        // 150ms 合并窗口上抛的旧草稿：value 变了，doc 已经往前走了。
        // 修复前这里会命中 useEffect([value]) 的整篇 dispatch → doc 变回 "甲s"。
        h.renderWith("甲s");
        assert.equal(
            docOf(h) === "甲sssss",
            true,
            `组合被打断：文档被回写成 ${JSON.stringify(docOf(h))}，` +
                "浏览器会把拼音中间态固化成最终正文（用户报的 sssss / x'x'x'）"
        );
        assert.equal(h.appChanges.length === 0, true, "组合期间不该有任何应用层 dispatch");

        // 合并窗口到点，上抛含拼音的中间态（spec 明确允许「晚一拍」，不许暂停上抛）。
        await h.wait(170);
        assert.equal(h.emitted.includes("甲sssss"), true, "组合期 draft 仍要照常上抛");
        assert.equal(docOf(h), "甲sssss", "上抛本身不得回写文档");

        // 最终汉字上屏（仍在组合内），收尾。
        h.replace(1, 6, "少时");
        h.fire("compositionend");
        // 等过「合并窗口 + 补同步」两个时机，确保补同步真的跑过一轮。
        await h.wait(220);
        assert.equal(docOf(h), "甲少时", "compositionend 后不许把旧回声回灌成拼音");
        assert.equal(/[a-z']/i.test(docOf(h)), false, "正文里不该残留拉丁拼音字母");
        assert.equal(h.appChanges.length === 0, true, "仅用户敲字应零回写");
        assert.equal(h.emitted.includes("甲少时"), true, "draft 最终要收敛成中文");
    } finally {
        h.dispose();
    }
});

test("IME：组合中外部灌入，结束后收敛为外部内容，且中途不回放拼音", async () => {
    const h = mount("甲");
    try {
        h.fire("compositionstart");
        h.compose("sss");
        await h.wait(170); // 让合并窗口先把含拼音的中间态推给父级
        h.renderWith("外部内容"); // 同笔记版本恢复 / 协同写入：组合中换了 prop
        assert.equal(docOf(h), "甲sss", "组合中外部改动只登记，不许立刻回写");
        assert.equal(h.appChanges.length === 0, true, "组合期间不许 dispatch");

        h.fire("compositionend");
        await h.wait(220);
        assert.equal(docOf(h) === "外部内容", true, "组合结束后外部内容必须灌进编辑器");
        assert.equal(h.appChanges.length === 1, true, "只应有一次补同步 dispatch");
        assert.equal(
            h.appChanges.every(c => !c.insert.includes("sss")),
            true,
            "补同步不许把含拼音的字符串回放进 doc"
        );
    } finally {
        h.dispose();
    }
});

test("IME：仅用户敲字零回写，doc/草稿都收敛为最终中文且撤销历史可用", async () => {
    const h = mount("甲");
    try {
        h.fire("compositionstart");
        h.compose("sssss");
        h.replace(1, 6, "少时"); // 最终中文上屏（仍在组合内）
        // 父级因字数统计 / 自动保存等其它 state 重渲染，仍带着组合中途的旧拼音草稿。
        // 修复前这一步就会触发整篇回写，把中文打回拼音。
        h.renderWith("甲ssss");
        assert.equal(docOf(h) === "甲少时", true, "组合中的陈旧重渲染不许回写");
        h.fire("compositionend");
        await h.wait(220);

        assert.equal(docOf(h), "甲少时", "doc 必须稳定为最终中文");
        assert.equal(/[a-z']/i.test(docOf(h)), false, "不许有 sssss / x'x'x' 拉丁残留");
        assert.equal(h.emitted.includes("甲少时"), true, "draft.content 要收敛为最终中文");
        assert.equal(h.appChanges.length === 0, true, "整条链路应零回写，撤销历史不被污染");
        act(() => {
            assert.equal(undo(h.view), true, "撤销历史必须仍然可用");
        });
        assert.equal(docOf(h) !== "甲少时", true, "撤销要真的改动了文档");
    } finally {
        h.dispose();
    }
});

test("IME：漏 compositionend 时超时兜底仍能把外部改动灌进编辑器", async () => {
    // Android / Safari 会漏 compositionend；没有兜底的话 pendingSyncRef 会永久挂起，
    // 组合中被外部灌入（版本恢复 / 协同写入）的内容永远进不了编辑器。
    const WATCHDOG_MS = 1200;
    const h = mount("甲");
    try {
        h.fire("compositionstart");
        h.compose("sss");
        await h.wait(170);
        h.renderWith("兜底内容");
        assert.equal(docOf(h), "甲sss", "组合中仍不许回写");
        // 故意**不**派发 compositionend，只等看门狗走满 4 轮。
        await h.wait(WATCHDOG_MS * 4 + 400);
        assert.equal(
            docOf(h) === "兜底内容",
            true,
            "漏 compositionend 时外部改动被永久挂起了（超时兜底失效）"
        );
    } finally {
        h.dispose();
    }
});

test("外部同步只改差异段，不许整篇替换 contenteditable", () => {
    const h = mount("AAAA中BBBB");
    try {
        h.renderWith("AAAAXBBBB");
        assert.equal(h.appChanges.length === 1, true, "应恰好有一次同步 dispatch");
        const c = h.appChanges[0];
        assert.equal(
            c.from === 4 && c.to === 5 && c.insert === "X",
            true,
            `局部 diff 应只改 [4,5) → "X"，实际 ${JSON.stringify(c)}；` +
                "from:0..doc.length 的整篇替换会重绘整个 contenteditable"
        );
        assert.equal(docOf(h), "AAAAXBBBB", "同步后文档要等于最新 prop");
    } finally {
        h.dispose();
    }
});

test("源码契约：[value] effect 判 composing，且不再出现整篇 range", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src", "components", "NoteEditor.tsx"),
        "utf8"
    );
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/gm, "$1");
    const tail = code.slice(code.lastIndexOf("useImperativeHandle"));
    assert.equal(
        /view\.composing\s*\|\|\s*view\.compositionStarted/.test(tail),
        true,
        "[value] effect 必须同时判 view.composing 与 view.compositionStarted（只用 composing 会漏掉组合刚开始的窗口）"
    );
    assert.equal(
        code.includes("from: 0, to: view.state.doc.length"),
        false,
        "不许再出现整篇 from:0..doc.length 替换"
    );
    assert.equal(code.includes("applyDocDiff(view, target)"), true, "同步必须走局部 diff");
    assert.equal(code.includes("compositionend()"), true, "compositionend 必须触发补同步");
    assert.equal(code.includes("armWatchdog"), true, "必须有漏 compositionend 的超时兜底");
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 7 条：**真实短组合**（与第 1 条区分开）
//
// 第 1 条在 compositionend 之前有 `await h.wait(170)`，也就是**已经发生过一次
// onChange**（150ms 合并窗口走完）。这一条不同：整个组合生命周期里一次 onChange
// 都还没发生，父级的 value 仍停在组合开始前那版（初始 "甲"）。
// 这是用户报的 bug 最人味的场景 —— 拼音敲完立刻选字上屏。
//
// ⚠️ 这条同时守两处 spec 外补充（QA 变异实测，两条各自都会让它红）：
//    ① 去掉 `notify()` 里的乐观同步 `valueRef.current = text`
//       → 170ms 补同步时 valueRef 还是旧 prop，`applyDocDiff` 把 "甲少时" 打回 "甲"；
//    ② 把 `compositionend` 的补同步延迟从 `CHANGE_COALESCE_MS + 20` 改回 `0`
//       → 立刻比较时 valueRef 尚未收敛，同样打回 "甲"。
test("IME 真实短组合：零 onChange 直接 compositionend，父级仍带初始 value，不许回灌", async () => {
    const h = mount("甲");
    try {
        h.fire("compositionstart");
        h.compose("sssss");
        h.replace(1, 6, "少时"); // 最终中文上屏（仍在组合内）
        assert.equal(docOf(h), "甲少时", "前置：最终中文已在文档里");

        // 关键：一次 onChange 都还没发生（150ms 窗口没走完），父级 value 仍是初始 "甲"。
        // 模拟父级因字数统计 / 自动保存等其它 state 重渲染。
        h.renderWith("甲");
        assert.equal(docOf(h) === "甲少时", true, "组合中的陈旧初始 value 不许回写");

        h.fire("compositionend");
        await h.wait(220); // 过 150ms 合并窗口 + 170ms 补同步

        assert.equal(docOf(h), "甲少时", "短组合结束后 doc 必须稳定为最终中文");
        assert.equal(/[a-z']/i.test(docOf(h)), false, "不许回灌出拉丁拼音");
        assert.equal(h.emitted.includes("甲少时"), true, "短组合也要把最终中文上抛给草稿");
        assert.equal(h.appChanges.length === 0, true, "短组合整条链路应零回写");
    } finally {
        h.dispose();
    }
});
