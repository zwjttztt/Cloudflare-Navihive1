import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderMarkdownToReact } from "../utils/markdownToReact";
import { Button, TextField, Typography } from "@mui/material";

// 公开分享页（/s/:token）：无需登录，只读。
//
// 为什么单独一个页面而不是复用 NotesPage：这一页要能被聊天软件抓成预览卡片，
// 所以不能带任何登录态外壳；后端那边也明确回 noindex + no-store
// （分享链接等同于私密链接，不该被索引）。
export default function PublicNotePage({ token }: { token: string }) {
    const [title, setTitle] = useState("只读分享");
    const [body, setBody] = useState<ReactNode>("正在加载…");
    const [needPw, setNeedPw] = useState(false);
    const [pw, setPw] = useState("");
    const [pwError, setPwError] = useState("");
    const [pwBusy, setPwBusy] = useState(false);
    // 标签页标题换成笔记标题（对齐 inkstone 的 SharePage）——
    // 否则一串分享链接在浏览器里全叫「Navihive 导航站」，根本分不出是哪条笔记。
    //
    // ⚠️ 卸载时必须还原，且**只在标题还是我们设的那个时才还原**：
    // 无脑写回会冲掉这期间别人（比如主应用的 useDocumentEffects）设的新标题。
    // 进页面时的标题只在挂载那一刻取一次（effect 闭包里捕获），不读 ref ——
    // 这个 ref 挂载后再也不写，读 ref 只会招来 exhaustive-deps 的假警告。
    const appliedTitle = useRef<string | null>(null);

    const load = async (password?: string) => {
        const response = await fetch(`/api/note-shares/${encodeURIComponent(token)}`, {
            method: password ? "POST" : "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: password ? { "Content-Type": "application/json" } : undefined,
            body: password ? JSON.stringify({ password }) : undefined,
        });
        if (response.status === 401) {
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            setNeedPw(true);
            setPwError(data.error || "需要访问口令");
            setBody("这条分享受访问口令保护。");
            return;
        }
        if (!response.ok) throw new Error("分享不存在、已过期或已撤销");
        const note = await response.json() as { title: string; content: string };
        // ⚠️ 正文里的图片路径要**改写**：存进笔记的是
        // `/api/notes/attachments/<id>`，那条挂在登录鉴权后面 —— 访客没有
        // cookie，取回来是 401，图就显示不出来。公开页走免鉴权那条通道
        // （后端只放行「属于一条当前有效分享」的附件，见 getPublicAttachment）。
        const rendered = await renderMarkdownToReact(
            note.content.replace(/\/api\/notes\/attachments\/([0-9a-z-]+)/g, (_all, id: string) => `/api/note-shares/attachments/${id}?share=${encodeURIComponent(token)}`)
        );
        const shown = note.title || "无标题";
        setTitle(shown);
        setBody(rendered);
        document.title = shown;
        appliedTitle.current = shown;
        setNeedPw(false);
        setPwError("");
    };

    useEffect(() => {
        const originalTitle = document.title;
        let live = true;
        setNeedPw(false);
        setPw("");
        void (async () => {
            try {
                await load();
            } catch (error) {
                if (live) setBody(error instanceof Error ? error.message : "无法加载分享");
            }
        })();
        return () => {
            live = false;
            if (appliedTitle.current && document.title === appliedTitle.current) {
                document.title = originalTitle;
            }
            appliedTitle.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const submitPw = async (e: React.FormEvent) => {
        e.preventDefault();
        setPwBusy(true);
        setPwError("");
        try {
            await load(pw);
        } catch (error) {
            setPwError(error instanceof Error ? error.message : "无法加载分享");
        } finally {
            setPwBusy(false);
        }
    };

    if (needPw) {
        return (
            <main style={{ maxWidth: 420, margin: "0 auto", padding: "24px", overflowWrap: "anywhere" }}>
                <p>记事本 · 只读分享</p>
                <h1>需要访问口令</h1>
                <form onSubmit={submitPw} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                    <TextField
                        type='password'
                        label='访问口令'
                        value={pw}
                        autoFocus
                        disabled={pwBusy}
                        onChange={e => setPw(e.target.value)}
                        slotProps={{ input: { "aria-label": "访问口令" } }}
                    />
                    {pwError && (
                        <Typography variant='body2' color='error.main'>
                            {pwError}
                        </Typography>
                    )}
                    <Button type='submit' variant='contained' disabled={pwBusy}>
                        查看笔记
                    </Button>
                </form>
            </main>
        );
    }

    return <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px", overflowWrap: "anywhere" }}>
        <p>记事本 · 只读分享</p><h1>{title}</h1><article>{body}</article>
    </main>;
}
