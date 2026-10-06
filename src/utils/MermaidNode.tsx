import { useEffect, useRef, useState } from "react";

export function MermaidNode({ source }: { source: string }) {
    const frame = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(180);
    const [error, setError] = useState("");
    useEffect(() => {
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
        const timeout = setTimeout(() => { if (!ready) setError("图表未能加载，请检查网络或查看源码。"); }, 20_000);
        return () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
    }, [source]);
    return <figure style={{ margin: "12px 0" }}>
        {source.length <= 30_000 && !error && <iframe ref={frame} src="/mermaid-sandbox.html" sandbox="allow-scripts" title="Mermaid 图表" referrerPolicy="no-referrer" style={{ width: "100%", height, border: 0 }} />}
        {(error || source.length > 30_000) && <p role="status">{error || "图表过长，请缩短到30000字符以内。"}</p>}
        <details><summary>查看图表源码</summary><pre style={{ overflow: "auto" }}>{source}</pre></details>
    </figure>;
}
