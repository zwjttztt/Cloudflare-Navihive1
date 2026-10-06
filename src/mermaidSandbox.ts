// 独立 opaque-origin iframe；绝不在主页面运行 Mermaid 的字符串 DOM 操作。
import mermaid from "mermaid";
let running = false;
window.addEventListener("message", event => {
    if (event.source !== parent || running || event.data?.kind !== "render-mermaid") return;
    const { source, dark } = event.data as { source: string; dark: boolean };
    if (typeof source !== "string" || source.length > 30_000) return;
    running = true;
    void (async () => {
        const root = document.getElementById("diagram")!;
        try {
            // directives 可能覆盖初始化配置，故拒绝；关闭 HTML labels 和点击链接。
            if (/%%\s*\{|^\s*---/m.test(source)) throw new Error("不支持图表配置指令");
            mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", flowchart: { htmlLabels: false }, maxTextSize: 30_000, maxEdges: 300 });
            const { svg } = await mermaid.render("chart", source);
            const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
            const node = parsed.documentElement;
            // 严格模式之外再移除链接、嵌入对象、外部资源和事件属性。
            node.querySelectorAll("script, foreignObject, image, a, use").forEach(el => el.remove());
            for (const el of [node, ...node.querySelectorAll("*")]) {
                for (const attr of Array.from(el.attributes)) {
                    if (/^on/i.test(attr.name) || /href/i.test(attr.name)) el.removeAttribute(attr.name);
                }
            }
            root.replaceChildren(document.importNode(node, true));
            document.body.style.color = dark ? "#eee" : "#222";
            parent.postMessage({ kind: "mermaid-ready", height: Math.min(900, Math.max(120, root.scrollHeight + 24)) }, "*");
        } catch {
            root.textContent = "图表语法错误或包含不支持的配置，请检查源码。";
            parent.postMessage({ kind: "mermaid-error" }, "*");
        }
    })();
});
parent.postMessage({ kind: "mermaid-loaded" }, "*");
