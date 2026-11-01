import { useEffect, useRef, useState } from "react";

export function MermaidNode({ source }: { source: string }) {
    const frame = useRef<HTMLIFrameElement>(null);
    // 懒加载哨兵：iframe 挂在前先渲染一个等高占位块，滚近视口才换真 iframe。
    // 动机：以前每个 mermaid 块挂载即起一个 /mermaid-sandbox.html（各解析一整套 mermaid），
    // 一篇 5 图的笔记打开瞬间 5 个实例，低端设备 CPU/内存尖峰。滚近（rootMargin 300px）
    // 才挂载后，打开瞬间只有视口附近的块在渲染，没滚到的块零开销。
    const placeholderRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(180);
    const [error, setError] = useState("");
    const [nearViewport, setNearViewport] = useState(false);
    useEffect(() => {
        // 环境没有 IntersectionObserver（jsdom / 极老内核）时直接退回旧版立即渲染，
        // 不让懒加载本身成为「图出不来」的原因。
        if (typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        if (nearViewport || error || source.length > 30_000) return;
        const el = placeholderRef.current;
        if (!el) return;
        const io = new IntersectionObserver(
            entries => {
                if (entries.some(e => e.isIntersecting)) {
                    // 渲染一次就够了：图表是静态的，滚走再滚回不重挂（避免来回滚动反复解析）。
                    io.disconnect();
                    setNearViewport(true);
                }
            },
            { rootMargin: "300px" }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [nearViewport, error, source]);
    useEffect(() => {
        if (!nearViewport) return;
        let ready = false;
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.current?.contentWindow) return;
            if (event.data?.kind === "mermaid-loaded") {
                frame.current?.contentWindow?.postMessage({ kind: "render-mermaid", source,
                    dark: window.matchMedia("(prefers-color-scheme: dark)").matches }, "*");
            } else if (event.data?.kind === "mermaid-ready") {
                ready = true;
                const size = Number(event.data.height);
                if (Number.isFinite(size)) setHeight(Math.min(900, Math.max(120, size)));
            } else if (event.data?.kind === "mermaid-error") {
                ready = true;
                setError("图表语法错误或包含不支持的配置，请检查源码。");
            }
        };
        window.addEventListener("message", receive);
        // 20s 看门狗跟 iframe 同 gate：没滚到的块不计时，免得「滚到时图已被判超时」。
        const timeout = setTimeout(() => { if (!ready) setError("图表未能加载，请检查网络或查看源码。"); }, 20_000);
        return () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
    }, [source, nearViewport]);
    return <figure style={{ margin: "12px 0" }}>
        {source.length <= 30_000 && !error && !nearViewport &&
            <div ref={placeholderRef} aria-hidden="true" style={{ width: "100%", height, border: 0 }} />}
        {source.length <= 30_000 && !error && nearViewport &&
            <iframe ref={frame} src="/mermaid-sandbox.html" sandbox="allow-scripts" title="Mermaid 图表" referrerPolicy="no-referrer" style={{ width: "100%", height, border: 0 }} />}
        {(error || source.length > 30_000) && <p role="status">{error || "图表过长，请缩短到30000字符以内。"}</p>}
        <details><summary>查看图表源码</summary><pre style={{ overflow: "auto" }}>{source}</pre></details>
    </figure>;
}
