// src/components/NoteTabsNode.tsx
// 标签页容器 `:::tabs` 的渲染体。
//
// 结构：一排页签 + 当前页的 Markdown 正文。
// 正文要再跑一遍渲染（异步），所以整体是个组件而不是渲染函数里的一个分支。
//
// 交互上刻意做得比 inkstone 朴素：只用按钮 + aria-selected，不做键盘左右箭头。
// 页签是 <button>，Tab 键本来就能依次走到，方向键属于额外花活；
// 而这份代码里每个交互都要有单测覆盖，为省两个用例加方向键不划算。
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { parseTabPages } from "../utils/noteBlocks";

export function NoteTabsNode({
    body,
    arg,
    depth,
    render,
}: {
    /** 容器里的原始正文（`=== 名称` 分页） */
    body: string;
    /** `:::tabs 名称` 的参数，作为第一页的默认标题 */
    arg: string;
    depth: number;
    render: (source: string, depth: number) => Promise<ReactNode>;
}) {
    const pages = useMemo(() => parseTabPages(body, arg), [body, arg]);
    const [active, setActive] = useState(0);
    const [body0, setBody0] = useState<ReactNode | null>(null);

    // 页数变少（用户删了一页）时把选中项夹回范围，否则内容区会空白
    const index = Math.min(active, Math.max(0, pages.length - 1));
    const current = pages[index];

    useEffect(() => {
        if (!current) {
            setBody0(null);
            return;
        }
        let alive = true;
        void render(current.source, depth).then(node => {
            if (alive) setBody0(node);
        });
        return () => {
            alive = false;
        };
    }, [current, depth, render]);

    if (pages.length === 0) {
        return (
            <div style={{ fontSize: 13, opacity: 0.7, margin: "8px 0" }}>（空标签页）</div>
        );
    }

    return (
        <div data-note-tabs={pages.length} style={{ margin: "8px 0" }}>
            <div role="tablist" aria-label="标签页" style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                {pages.map((p, i) => (
                    <button
                        key={`${p.title}-${i}`}
                        type="button"
                        role="tab"
                        aria-selected={i === index}
                        data-tab-index={i}
                        onClick={() => setActive(i)}
                        style={{
                            all: "unset",
                            cursor: "pointer",
                            fontSize: 13,
                            padding: "4px 10px",
                            borderBottom: i === index ? "2px solid var(--accent)" : "2px solid transparent",
                            color: i === index ? "var(--accent)" : "inherit",
                            opacity: i === index ? 1 : 0.7,
                        }}
                    >
                        {p.title}
                    </button>
                ))}
            </div>
            <div role="tabpanel" style={{ paddingTop: 8, fontSize: 14 }}>
                {body0}
            </div>
        </div>
    );
}
