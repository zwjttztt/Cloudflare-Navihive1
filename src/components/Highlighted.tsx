// 把命中的关键词片段包成 <mark>，未命中时原样输出。
//
// 从 SiteCard.tsx 里挪出来的：搜索结果高亮不只卡片要用（分组名、命令面板
// 都有可能），留在 1000 行的卡片文件里没人找得到。

export default function Highlighted({ text, query }: { text: string; query?: string }) {
    if (!query) return <>{text}</>;

    const lower = text.toLowerCase();
    const key = query.toLowerCase();
    const hit = lower.indexOf(key);
    if (hit === -1) return <>{text}</>;

    return (
        <>
            {text.slice(0, hit)}
            <mark className='nav-hl'>{text.slice(hit, hit + query.length)}</mark>
            {text.slice(hit + query.length)}
        </>
    );
}
