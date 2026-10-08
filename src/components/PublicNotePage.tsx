import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderMarkdownToReact } from "../utils/markdownToReact";

// 公开分享页（/s/:token）：无需登录，只读。
//
// 为什么单独一个页面而不是复用 NotesPage：这一页要能被聊天软件抓成预览卡片，
// 所以不能带任何登录态外壳；后端那边也明确回 noindex + no-store
// （分享链接等同于私密链接，不该被索引）。
export default function PublicNotePage({ token }: { token: string }) {
    const [title, setTitle] = useState("只读分享");
    const [body, setBody] = useState<ReactNode>("正在加载…");
    // 标签页标题换成笔记标题（对齐 inkstone 的 SharePage）——
    // 否则一串分享链接在浏览器里全叫「Navihive 导航站」，根本分不出是哪条笔记。
    //
    // ⚠️ 卸载时必须还原，且**只在标题还是我们设的那个时才还原**：
    // 无脑写回会冲掉这期间别人（比如主应用的 useDocumentEffects）设的新标题。
    // 进页面时的标题只在挂载那一刻取一次（effect 闭包里捕获），不读 ref ——
    // 这个 ref 挂载后再也不写，读 ref 只会招来 exhaustive-deps 的假警告。
    const appliedTitle = useRef<string | null>(null);
    useEffect(() => {
        const originalTitle = document.title;
        let live = true;
        const abort = new AbortController();
        void (async () => {
            try {
                const response = await fetch(`/api/note-shares/${encodeURIComponent(token)}`, {
                    credentials: "omit", cache: "no-store", signal: abort.signal,
                });
                if (!response.ok) throw new Error("分享不存在、已过期或已撤销");
                const note = await response.json() as { title: string; content: string };
                // ⚠️ 正文里的图片路径要**改写**：存进笔记的是
                // `/api/notes/attachments/<id>`，那条挂在登录鉴权后面 —— 访客没有
                // cookie，取回来是 401，图就显示不出来。公开页走免鉴权那条通道
                // （后端只放行「属于一条当前有效分享」的附件，见 getPublicAttachment）。
                const rendered = await renderMarkdownToReact(
                    note.content.replace(/\/api\/notes\/attachments\//g, "/api/note-shares/attachments/")
                );
                if (live) {
                    const shown = note.title || "无标题";
                    setTitle(shown);
                    setBody(rendered);
                    document.title = shown;
                    appliedTitle.current = shown;
                }
            } catch (error) {
                if (live) setBody(error instanceof Error ? error.message : "无法加载分享");
            }
        })();
        return () => {
            live = false;
            abort.abort();
            if (appliedTitle.current && document.title === appliedTitle.current) {
                document.title = originalTitle;
            }
            appliedTitle.current = null;
        };
    }, [token]);
    return <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px", overflowWrap: "anywhere" }}>
        <p>记事本 · 只读分享</p><h1>{title}</h1><article>{body}</article>
    </main>;
}
