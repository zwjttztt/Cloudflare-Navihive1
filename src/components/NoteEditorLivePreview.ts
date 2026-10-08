// 编辑区「即时渲染」（live preview）—— 参考 inkstone 的 src/client/editor/live-preview.ts。
//
// 做法（与 inkstone 同思路）：把文档按「空行分隔的块」切开，**光标不在的那一块**
// 用 `Decoration.replace` 整块换成渲染后的 widget；光标所在的那一块保持源码，
// 所以打字永远是在源码上进行的（撤销/搜索/保存全是纯 Markdown，没有富文本节点）。
// 点渲染块 → 光标回到那一块的源码行，接着改字。
//
// ⚠️ 与 inkstone 的一个关键差异：**不用 innerHTML**。
// inkstone 的 RenderedBlock.toDOM 里是 `host.innerHTML = block.html`；我们这边
// 全项目禁止字符串 HTML sink（严格 Trusted Types），渲染统一走「Markdown token →
// ReactNode」。所以 widget 里挂一个 React root，把 token 树渲染进去。
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/**
 * 一段 Markdown 块（空行分隔；围栏代码块内部不切）。
 *
 * ⚠️ `endLine` 是**开区间**（= 块内最后一行 + 1），与 inkstone 的 MarkdownBlock 一致。
 * 这一点必须和 inkstone 一样，否则「单行段落」会被判成空块而整块跳过 ——
 * 而真实笔记里绝大多数段落都是单行，结果就是「开了即时渲染什么都没发生」。
 */
export interface LiveBlock {
    /** 0 起的起止行号，endLine 为开区间 */
    startLine: number;
    endLine: number;
    source: string;
}

/**
 * 按空行切块，但要**跳过围栏代码块内部**的空行 ——
 * ``` 围栏里常有空行，按空行切会把代码块切碎、渲染出乱码。
 *
 * 行号约定与 inkstone 的 renderMarkdownBlocks 对齐：
 * `startLine` 0 起（含），`endLine` 开区间（不含）。
 */
export function splitLiveBlocks(doc: string): LiveBlock[] {
    const lines = doc.split("\n");
    const blocks: LiveBlock[] = [];
    let fence: string | null = null;
    let start = 0;
    let buf: string[] = [];
    const flush = (end: number) => {
        if (buf.some(l => l.trim() !== "")) {
            blocks.push({ startLine: start, endLine: end, source: buf.join("\n") });
        }
        buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
        if (m) {
            const mark = m[1];
            if (fence === null) {
                flush(i);
                start = i;
                fence = mark[0];
            } else if (mark[0] === fence) {
                fence = null;
            }
        }
        if (fence === null && text.trim() === "" && buf.length > 0) {
            flush(i);
            start = i + 1;
            continue;
        }
        buf.push(text);
    }
    flush(lines.length);
    return blocks;
}

const refreshEffect = StateEffect.define<boolean>();
const focusChanged = StateEffect.define<boolean>();

interface LiveState {
    blocks: LiveBlock[];
    decorations: DecorationSet;
    /** 编辑器是否聚焦。inkstone 用它决定「空选区算不算落在某块里」——
     *  点进正文外时，整篇都该显示成渲染态。 */
    focused: boolean;
    revision: number;
}

/** 宿主提供的渲染函数：Markdown 源码 → React 节点（我们走 token→React，无 HTML sink） */
export type LiveRenderer = (source: string, key: string) => Promise<ReactNode>;

/**
 * 渲染块 widget：挂一个 React root，把这一块的渲染结果放进去。
 * 点击 → 把光标送回该块源码行（inkstone 的行为：点哪儿就回到那行接着编辑）。
 */
class LiveBlockWidget extends WidgetType {
    private root: Root | null = null;
    /**
     * 渲染块高度的观察器（2026-10-09 补，对齐 inkstone 的 RenderedBlock）。
     *
     * ⚠️ **这条是「编辑区里图片不停抽动」的真因**。CM 用一张自己的高度表来算
     * 视口 / 要不要出滚动条 / 该虚拟化哪些行；而渲染块的高度是**会变的** ——
     * 图片加载完会把这一块从 20px 撑到 300px。以前只在 render() 的 promise
     * 完成后 `requestMeasure()` 一次，那时 React 连 <img> 都还没插进去，
     * CM 量到的是「图还没来」的空高度，之后**再也没人告诉它高度变了**。
     *
     * 于是「CM 以为的高度」和「浏览器真实布局」长期不一致：编辑区大小拖到
     * 刚好要出上下滚动条的临界点时，两边互相推翻——CM 按旧高度重排 → 真实
     * 高度变化 → 滚动条加/去 → 内容宽度变 → 图片等比变高变矮 → 又一次重排，
     * 看上去就是图片（连同整块内容）不停地抖。
     *
     * 修法就是 inkstone 的做法：给 host 挂 ResizeObserver，高度一变就让 CM
     * 重新测量（`view.requestMeasure()`）。destroy 时必须 disconnect，
     * 否则销毁后还会往已经下线的 view 上报测量。
     */
    private observer: ResizeObserver | null = null;

    constructor(
        readonly block: LiveBlock,
        readonly render: LiveRenderer,
        readonly revision: number
    ) {
        super();
    }

    eq(other: LiveBlockWidget): boolean {
        return other.block.source === this.block.source && other.revision === this.revision;
    }

    toDOM(view: EditorView): HTMLElement {
        const host = document.createElement("div");
        host.className = "note-live-block";
        host.dataset.liveStart = String(this.block.startLine);
        host.title = "点击这一块即可回到源码编辑";
        const container = document.createElement("div");
        host.appendChild(container);
        this.root = createRoot(container);
        const source = this.block.source;
        const revision = this.revision;
        void this.render(source, `${this.block.startLine}:${revision}`)
            .then(node => {
                if (!this.root) return; // 已被销毁
                this.root.render(node);
                view.requestMeasure();
            })
            // ⚠️ 渲染管线是异步的（markdown-it 动态 import）。任何一次失败都会让
            // 这个块**整块空白** —— 用户看到的就是「即时渲染开了、文档少了好几段」。
            // 所以兜一层：失败就把原文显示出来，宁可丑也不能少内容。
            .catch(() => {
                if (!this.root) return;
                this.root.render(
                    createElement("span", { className: "note-live-block-fallback" }, source)
                );
                view.requestMeasure();
            });
        // 高度一变就通知 CM 重新测量（见上面 observer 字段的说明）
        if (typeof ResizeObserver === "function") {
            this.observer = new ResizeObserver(() => view.requestMeasure());
            this.observer.observe(host);
        }
        host.addEventListener("mousedown", event => {
            // 让浏览器先把这次点击当普通点击处理，我们只负责把光标送回去
            event.preventDefault();
            const lineNo = Math.min(this.block.startLine + 1, view.state.doc.lines);
            const line = view.state.doc.line(lineNo);
            view.dispatch({ selection: { anchor: line.from }, userEvent: "select.pointer" });
            view.focus();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null && pos >= line.from && pos <= line.to) {
                view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
            }
        });
        return host;
    }

    destroy(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.root?.unmount();
        this.root = null;
    }

    // 事件由 widget 自己处理（点渲染块回到源码），CM 不要拦截
    ignoreEvent(): boolean {
        return false;
    }
}

function buildDecorations(state: EditorState, live: LiveState, render: LiveRenderer): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const block of live.blocks) {
        // endLine 是开区间：单行块的 endLine = startLine + 1，正好通过这道检查
        // （旧实现用闭区间，`endLine <= startLine` 会把**所有单行段落**判成空块跳过）。
        if (block.endLine <= block.startLine) continue;
        if (block.startLine >= state.doc.lines) continue;
        const from = state.doc.line(block.startLine + 1).from;
        const to = state.doc.line(Math.min(block.endLine, state.doc.lines)).to;
        if (to <= from) continue;
        // 光标（或选区）落在这块里 → 保持源码，方便接着打字。
        // 编辑器未聚焦时空选区不算「落在某块里」—— 点到别处去，整篇都该是渲染态。
        const active = state.selection.ranges.some(
            r => (live.focused || !r.empty) && r.from <= to && r.to >= from
        );
        if (active) continue;
        ranges.push(
            Decoration.replace({
                block: true,
                widget: new LiveBlockWidget(block, render, live.revision),
            }).range(from, to)
        );
    }
    return Decoration.set(ranges, true);
}

/**
 * 即时渲染扩展。
 * @param render 宿主注入的渲染函数（异步，因为 markdown-it 是动态 import）
 */
export function livePreview(render: LiveRenderer): Extension {
    const field = StateField.define<LiveState>({
        create(state) {
            const blocks = splitLiveBlocks(state.doc.toString());
            const value: LiveState = { blocks, decorations: Decoration.none, focused: false, revision: 0 };
            value.decorations = buildDecorations(state, value, render);
            return value;
        },
        update(value, tr) {
            const refresh = tr.effects.find(e => e.is(refreshEffect));
            const focused = tr.effects.find(e => e.is(focusChanged));
            if (!tr.docChanged && !tr.selection && !refresh && !focused) return value;
            // 打字时只重算「哪一块被替换」（行号会随编辑漂移），不重新解析整篇；
            // 真正的重新渲染交给下面的防抖 refresh —— 打字路径必须便宜。
            // ⚠️ 但行号会漂：编辑后旧块号不再准确，所以先把**被动过的块**丢掉，
            // 余下的按 changes 映射修正（inkstone 的 mapped 逻辑），否则装饰会错位。
            const mapped = tr.docChanged
                ? value.blocks.flatMap(block => {
                      const from = tr.startState.doc.line(block.startLine + 1).from;
                      const to = tr.startState.doc.line(Math.min(block.endLine, tr.startState.doc.lines)).to;
                      if (tr.changes.touchesRange(from, to)) return [];
                      const startLine = tr.state.doc.lineAt(tr.changes.mapPos(from, 1)).number - 1;
                      const endLine = tr.state.doc.lineAt(tr.changes.mapPos(to, -1)).number;
                      return startLine < endLine ? [{ ...block, startLine, endLine }] : [];
                  })
                : value.blocks;
            // ⚠️ refresh 那支必须**显式带上 focused**（哪怕下一行就会覆盖）：
            // 直接少写这个键，TS 会说这个对象不满足 LiveState（TS2322）——
            // 类型系统在这类地方比人可靠，别用类型断言把它糊过去。
            const next: LiveState = refresh
                ? {
                      blocks: splitLiveBlocks(tr.state.doc.toString()),
                      decorations: Decoration.none,
                      focused: focused ? focused.value : value.focused,
                      revision: value.revision + 1,
                  }
                : { ...value, blocks: mapped };
            next.focused = focused ? focused.value : value.focused;
            next.decorations = buildDecorations(tr.state, next, render);
            return next;
        },
        provide: f => EditorView.decorations.from(f, v => v.decorations),
    });

    return [
        field,
        // 防抖重解析：停手 90ms 后才重新渲染（和 inkstone 一样），
        // 否则每敲一个字都要把整篇重新渲染一遍。
        ViewPlugin.fromClass(
            class {
                timer = 0;
                constructor(readonly view: EditorView) {}
                update(update: { docChanged: boolean }) {
                    if (!update.docChanged) return;
                    window.clearTimeout(this.timer);
                    this.timer = window.setTimeout(() => {
                        this.view.dispatch({ effects: refreshEffect.of(true) });
                    }, 90);
                }
                destroy() {
                    window.clearTimeout(this.timer);
                }
            }
        ),
        // 聚焦态：inkstone 用它判断「空选区算不算落在某块里」。
        EditorView.domEventHandlers({
            focus(_event, view) {
                view.dispatch({ effects: focusChanged.of(true) });
            },
            blur(_event, view) {
                view.dispatch({ effects: focusChanged.of(false) });
            },
        }),
        // 行内语法级渲染（inkstone 的第二个 ViewPlugin）：**当前这块还是源码**，
        // 但源码里的 `**粗体**` / `*斜体*` / `# 标题` 也要显示成对应样式，
        // 否则源码态和渲染态的观感差一大截（用户会以为「开了即时渲染没生效」）。
        ViewPlugin.fromClass(
            class {
                decorations: DecorationSet = Decoration.none;
                constructor(view: EditorView) {
                    this.build(view);
                }
                update(update: { view: EditorView }) {
                    this.build(update.view);
                }
                build(view: EditorView) {
                    const ranges: Range<Decoration>[] = [];
                    for (const { from, to } of view.visibleRanges) {
                        syntaxTree(view.state).iterate({
                            from,
                            to,
                            enter(node) {
                                const cls =
                                    node.name === "StrongEmphasis"
                                        ? "cm-live-strong"
                                        : node.name === "Emphasis"
                                          ? "cm-live-em"
                                          : /^ATXHeading/.test(node.name)
                                            ? "cm-live-heading"
                                            : "";
                                if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
                            },
                        });
                    }
                    this.decorations = Decoration.set(ranges, true);
                }
            },
            { decorations: plugin => plugin.decorations }
        ),
        EditorView.baseTheme({
            ".note-live-block": {
                padding: "2px 4px",
                borderRadius: "6px",
                cursor: "text",
            },
        }),
    ];
}
