// src/utils/tagOps.ts
// 标签的重命名与合并 —— 只做纯计算，写库由调用方（UIPrefs 的 applyTagOps）负责。
//
// 为什么要有这两个操作：标签散在几十张卡片上，改一个错别字意味着
// 「新建正确的 → 挨个卡片摘掉旧的 → 再挨个加上新的 → 还得保证中间没漏」，
// 手做必然出错。合并同理（「AI」和「人工智能」其实是一个东西）。
//
// 两个操作共用同一条底线：**不能凭空造出新标签，也不能让任何一张卡片丢标签**。
// 重命名到已有标签时语义上就是合并，所以 renameTag 内部走 mergeTag。

/** 站点 id -> 该站点身上的标签 */
export type TagMap = Record<string, string[]>;

export interface TagOpsResult {
    tags: TagMap;
    /** 被改动的站点 id（撤销时用得上，也是「影响 N 个网站」那个 N） */
    affected: number[];
}

export interface RenamePlan {
    affectedCount: number;
    /** 新名字已经被别的卡片用了：这不是错误，但用户得知道这是「合并」不是「改名」 */
    mergesIntoExisting: boolean;
    /** 目标名与源名相同（或都是空）：没有可做的事 */
    noop: boolean;
}

const clean = (value: string) => value.trim();

/** 这张 map 里所有出现过的标签（去重、保持发现顺序便于 UI 展示稳定） */
export function allTags(tags: TagMap): string[] {
    const seen = new Set<string>();
    for (const list of Object.values(tags)) {
        for (const tag of list ?? []) {
            const t = clean(tag);
            if (t) seen.add(t);
        }
    }
    return [...seen];
}

/**
 * 把 AI 给的标签建议合并进现有 tag 表：给指定站点**追加**若干标签。
 *
 * 与 mergeTags 的区别：mergeTags 是「把 A 改名/并到 B」（会摘掉源标签），
 * 这里是纯追加——AI 只负责补充，绝不许它摘掉用户自己打的标签。
 *
 * 三条底线：
 *   - 已有的标签不重复加（"AI" 建议了两次也只留一份）
 *   - 空标签跳过（模型偶尔会吐空串）
 *   - 没在建议清单里的站点原样保留（不动不相干的卡片）
 *
 * 返回新表，不改入参。picked 为空时返回原引用（调用方可以据此判断「没事发生」）。
 */
export function applyTagSuggestions(
    tags: TagMap,
    picked: { id: number | string; tags: string[] }[]
): TagMap {
    const usable = picked
        .map(item => ({
            key: String(item.id),
            add: Array.from(
                new Set((item.tags ?? []).map(clean).filter(Boolean))
            ),
        }))
        .filter(item => item.add.length > 0);

    if (usable.length === 0) return tags;

    const next: TagMap = { ...tags };
    let changed = false;

    for (const { key, add } of usable) {
        const current = next[key] ?? [];
        const have = new Set(current.map(clean));
        const missing = add.filter(t => !have.has(t));
        if (missing.length === 0) continue;
        next[key] = [...current, ...missing];
        changed = true;
    }

    return changed ? next : tags;
}

/**
 * 有多少张卡片带着这个标签。
 * 比对前两边都 trim —— 库里可能躺着历史遗留的 `" AI "`，
 * 不 trim 就会得出「没人用这个标签」，改名时静默什么都不做。
 */
export function countSitesWithTag(tags: TagMap, tag: string): number {
    const want = clean(tag);
    if (!want) return 0;
    return Object.values(tags).filter(list =>
        (list ?? []).some(t => clean(t) === want)
    ).length;
}

/**
 * 重命名前的预演：新名字撞车时，UI 要把「改名」说成「合并」——
 * 否则用户以为只是换个叫法，结果两个标签的卡片被合到了一起。
 */
export function planRename(tags: TagMap, from: string, to: string): RenamePlan {
    const source = clean(from);
    const target = clean(to);
    const affectedCount = countSitesWithTag(tags, source);
    return {
        affectedCount,
        mergesIntoExisting: Boolean(target) && source !== target && countSitesWithTag(tags, target) > 0,
        noop: !source || !target || source === target || affectedCount === 0,
    };
}

/**
 * 把一个标签改名为另一个。
 * 目标名已存在 → 按合并处理（两边都归到目标名下，只留一份）。
 * 返回 null 表示「没有可做的」（空名、同名、源标签没人用）。
 */
export function renameTag(tags: TagMap, from: string, to: string): TagOpsResult | null {
    const source = clean(from);
    const target = clean(to);
    if (!source || !target || source === target) return null;
    if (countSitesWithTag(tags, source) === 0) return null;
    return mergeTags(tags, [source], target);
}

/**
 * 把若干个标签合并成一个：凡是带着 sources 中任一标签的卡片，
 * 都改成带 target，且同一张卡片上不重复出现。
 * sources 里带 target 自己也无所谓（等于把自己并给自己，去重后没有副作用）。
 */
export function mergeTags(tags: TagMap, sources: string[], target: string): TagOpsResult | null {
    const wanted = Array.from(new Set(sources.map(clean).filter(Boolean)));
    const to = clean(target);
    if (!to || wanted.length === 0) return null;

    const next: TagMap = {};
    const affected: number[] = [];

    for (const [siteId, list] of Object.entries(tags)) {
        const current = list ?? [];
        const hit = current.some(t => wanted.includes(clean(t)));
        if (!hit) {
            next[siteId] = current;
            continue;
        }
        // 先摘掉所有源标签，再补一个目标标签；剩下的按原顺序保留（顺手把脏空格修掉）
        const rest = current
            .map(clean)
            .filter(t => t && !wanted.includes(t) && t !== to);
        const merged = [...rest, to];
        next[siteId] = merged;
        affected.push(Number(siteId));
    }

    if (affected.length === 0) return null;
    return { tags: next, affected: affected.filter(id => Number.isFinite(id)) };
}
