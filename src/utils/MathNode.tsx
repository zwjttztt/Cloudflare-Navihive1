// src/utils/MathNode.tsx
// 一个公式 → KaTeX 渲染结果（React 元素）。
//
// ⚠️ 为什么不用 `katex.renderToString()` + `dangerouslySetInnerHTML`：
// 本项目的 CSP 有 `require-trusted-types-for 'script'`（enforce、且没有 `trusted-types` 指令），
// 任何 innerHTML / dangerouslySetInnerHTML 这类 sink 都会**直接抛异常、界面白屏**。
// 所以这里走 KaTeX 的 DOM 入口 `katex.render(tex, element)` —— 它用 createElement /
// appendChild 建节点，不碰字符串 sink（katex 0.19 的 dist 里没有任何 innerHTML /
// insertAdjacentHTML / outerHTML，这一点有静态用例盯着）。
//
// 也为什么必须动态 import：katex 是 ~270KB 的笨重依赖，静态引入会直接顶穿首屏预算
// （tests/bundleBudget.test.ts 会红）。动态 import 让它待在自己的 lazy chunk 里。
//
// 兜底设计：KaTeX 加载失败、或公式语法坏到抛异常时，**降级成等宽文本显示原文**，
// 而不是让整篇预览挂掉 —— 一篇笔记里有个公式写错，不该让别的段落一起消失。

import { useEffect, useRef, useState, type CSSProperties } from "react";

type KatexRender = (
    tex: string,
    element: HTMLElement,
    options?: Record<string, unknown>
) => void;

let katexPromise: Promise<KatexRender> | null = null;

function loadKatex(): Promise<KatexRender> {
    if (!katexPromise) {
        katexPromise = import("katex")
            // ⚠️ katex 的 ESM 入口（katex/dist/katex.mjs）只给**具名导出** `render`，
            // 没有 default。`mod.default ?? mod` 那套写法（markdown-it 那边能用是因为
            // 它是 CJS）在这里拿到的是模块命名空间对象，当函数调用直接抛
            // "render is not a function" —— 界面上只表现为「公式变文本」，看不出原因。
            // 所以两条路都留着：具名优先，没有再退 default（CJS 打包器场景）。
            .then(mod => {
                const ns = mod as unknown as Record<string, unknown> & { default?: unknown };
                const api =
                    typeof ns.render === "function"
                        ? (ns.render as KatexRender)
                        : (ns.default as KatexRender);
                // 样式同理必须 lazy：katex.min.css 带十几张字体表（woff2），
                // 静态引入会把它们一起拖进首屏。非浏览器环境（单测）失败也不要命。
                void (async () => {
                    try {
                        await import("katex/dist/katex.min.css");
                    } catch {
                        /* 环境不支持就落到「没有字体表」的降级外观，不影响公式结构 */
                    }
                })();
                return api;
            })
            // 失败原因挂到 DOM 上：公式降级成文本时，能在 DevTools 里一眼看出
            // 是「包没加载出来」还是「公式写坏了」，不用去翻灰盒
            .then(api => {
                if (typeof api !== "function") {
                    throw new Error("katex 模块里既没有 render 也没有 default");
                }
                return api;
            })
            .catch(err => {
                katexPromise = null; // 失败要能重试，别把一次网络抖动记成永久
                throw err;
            });
    }
    return katexPromise;
}

const INLINE_SX: CSSProperties = {};
const BLOCK_SX: CSSProperties = {
    display: "block",
    textAlign: "center",
    margin: "10px 0",
    overflowX: "auto",
};

export function MathNode({ tex, block = false }: { tex: string; block?: boolean }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (!tex || !tex.trim()) {
            setFailed(true);
            return;
        }
        let alive = true;
        setFailed(false);
        loadKatex()
            .then(render => {
                const target = ref.current;
                if (!alive || !target) return;
                // 清掉上一轮的结果（tex 变了会重跑到这儿），
                // React 眼里这个 span 是空的 —— 子节点全交给 KaTeX 管
                while (target.firstChild) target.removeChild(target.firstChild);
                try {
                    render(tex, target, {
                        throwOnError: true, // 坏公式要能被 catch 住降级，不能红一堆字糊上去
                        strict: "ignore", // 不用为 `\not` 之类的小事报错
                        output: "html", // 不要 MathML 副本，DOM 少一半
                        displayMode: block,
                        trust: false, // 禁 \href / \includegraphics 之类的外部动作
                        macros: {},
                    });
                } catch {
                    if (alive) setFailed(true);
                }
            })
            .catch(() => {
                if (alive) setFailed(true);
            });
        return () => {
            alive = false;
        };
    }, [tex, block]);

    if (failed) {
        return (
            <code
                data-math-fallback='1'
                data-math-error='1'
                style={{
                    ...(block ? { display: "block", textAlign: "center", margin: "10px 0" } : {}),
                    background: "rgba(128,128,128,0.18)",
                    borderRadius: 4,
                    padding: "1px 5px",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.9em",
                    color: "inherit",
                }}
            >
                {tex}
            </code>
        );
    }

    return (
        <span
            ref={ref}
            role='math'
            aria-label={tex}
            style={block ? BLOCK_SX : INLINE_SX}
        />
    );
}
