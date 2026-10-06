import { useEffect, useState, type ReactNode } from "react";
import { renderMarkdownToReact } from "../utils/markdownToReact";

export default function PublicNotePage({ token }: { token: string }) {
    const [title, setTitle] = useState("只读分享");
    const [body, setBody] = useState<ReactNode>("正在加载…");
    useEffect(() => {
        let live = true;
        const abort = new AbortController();
        void (async () => {
            try {
                const response = await fetch(`/api/note-shares/${encodeURIComponent(token)}`, {
                    credentials: "omit", cache: "no-store", signal: abort.signal,
                });
                if (!response.ok) throw new Error("分享不存在、已过期或已撤销");
                const note = await response.json() as { title: string; content: string };
                const rendered = await renderMarkdownToReact(note.content);
                if (live) { setTitle(note.title || "无标题"); setBody(rendered); }
            } catch (error) {
                if (live) setBody(error instanceof Error ? error.message : "无法加载分享");
            }
        })();
        return () => { live = false; abort.abort(); };
    }, [token]);
    return <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px", overflowWrap: "anywhere" }}>
        <p>记事本 · 只读分享</p><h1>{title}</h1><article>{body}</article>
    </main>;
}
