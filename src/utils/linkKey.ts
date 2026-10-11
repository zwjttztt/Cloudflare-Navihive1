// src/utils/linkKey.ts
// 「链接键」归一化：决定两个 URL 算不算同一个探测 / 查重目标。
//
// 为什么单独一个文件：这个纯函数得给**三处**用 —— 前端失效检测（utils/linkHealth）、
// worker 死链巡检（worker/cronLogic）、以及各自的单测。而 worker 侧没有 DOM lib，
// linkHealth 里的 localStorage 引用会让 worker 编译不过；反过来把整个 utils/url
// 拖进 worker 也没必要。所以它待在一个零依赖的小模块里，谁都能安全引。
//
// 只合并**发给服务器的请求必然相同**的那些写法，其余一律不动：
//   - 去首尾空白
//   - 丢掉 #hash —— 片段根本不会发到服务器，换个锚点不是换个链接
//   - host 后只有一个 / 时去掉它（https://a.com 与 https://a.com/ 是同一个请求；
//     但 /a 与 /a/ 是不同请求，尾斜杠保留）
//   - scheme / host 转小写（这两段大小写不敏感，浏览器也会这么发）
// 刻意不做：查询串（?a=1 就是另一个请求）、路径大小写（服务器区分）、非默认端口
// （:8080 ≠ :80；默认端口的省略交给 normalizeUrl 那条入库路径处理）。
export function normalizeKey(url: string): string {
    const trimmed = (url || "").trim();
    if (!trimmed) return "";
    try {
        const u = new URL(trimmed);
        const scheme = u.protocol.toLowerCase();
        const host = u.hostname.toLowerCase();
        const port = u.port ? `:${u.port}` : "";
        const path = u.pathname === "/" ? "" : u.pathname;
        return `${scheme}//${host}${port}${path}${u.search}`;
    } catch {
        // 解析不了就原样返回：不硬造键，宁可退化成老行为
        return trimmed;
    }
}

/**
 * 从「最后一次成功 / 最后一次失败」两份时间戳推导当前失效清单。
 *
 * 判据：`dead[url] > probe[url]` 且不在白名单里。抽成纯函数是因为**两处都要用**：
 *   - 前端卡片（utils/linkHealth，数据来自 localStorage）
 *   - 服务端统计看板（API/methods/audit，数据来自 configs 里的 link.health 快照）
 * 两边各写一遍必然漂移 —— 看板会数出比卡片上「失效」标记更多的条数，
 * 用户看到两个自相矛盾的数字。
 *
 * @param dead   最后一次**失败**的时间戳表
 * @param probe  最后一次**成功**的时间戳表
 * @param white  用户手动标过「其实能访问」的链接
 */
export function deriveDeadLinks(
    dead: Record<string, number>,
    probe: Record<string, number>,
    white: readonly string[] = []
): Record<string, number> {
    const whitelist = new Set(white.map(normalizeKey).filter(Boolean));
    const out: Record<string, number> = {};
    for (const [rawUrl, ts] of Object.entries(dead)) {
        const url = normalizeKey(rawUrl);
        if (!url) continue;
        // 用户手动纠偏过的、或之后又探测成功的，都不算失效
        if (whitelist.has(url)) continue;
        if ((probe[url] ?? 0) >= ts) continue;
        out[url] = ts;
    }
    return out;
}
