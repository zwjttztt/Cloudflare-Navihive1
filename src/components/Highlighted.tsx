// 把命中的关键词片段包成 <mark>，未命中时原样输出。
//
// 从 SiteCard.tsx 里挪出来的：搜索结果高亮不只卡片要用（分组名、命令面板
// 都有可能），留在 1000 行的卡片文件里没人找得到。

import { splitByRanges } from "../utils/fuzzy";

/**
 * 命中区间优先（`ranges` 由模糊匹配算出来，能标出「打了错字也匹配上」的那几个字）；
 * 没给区间就退回整串子串匹配（导航站搜索一直在用这条老路径）。
 */
export default function Highlighted({
    text,
    query,
    ranges,
}: {
    text: string;
    query?: string;
    ranges?: [number, number][];
}) {
    if (ranges && ranges.length) {
        return (
            <>
                {splitByRanges(text, ranges).map((part, i) =>
                    part.hit ? (
                        <mark key={i} className='nav-hl' data-hit='1'>
                            {part.text}
                        </mark>
                    ) : (
                        <span key={i}>{part.text}</span>
                    )
                )}
            </>
        );
    }

    if (!query) return <>{text}</>;

    const lower = text.toLowerCase();
    const key = query.toLowerCase();
    const hit = lower.indexOf(key);
    if (hit === -1) return <>{text}</>;

    return (
        <>
            {text.slice(0, hit)}
            <mark className='nav-hl' data-hit='1'>
                {text.slice(hit, hit + query.length)}
            </mark>
            {text.slice(hit + query.length)}
        </>
    );
}
