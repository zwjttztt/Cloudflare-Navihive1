// src/utils/advancedSearch.ts
// 搜索框里的高级语法：`tag:AI`、`group:开发`、`url:github`、`is:starred`、`-关键词`。
//
// 为什么要这个：靠顶栏那排开关只能筛「星标 / 失效 / 某几个标签」，
// 一旦想找「带 AI 标签但不在开发分组里、又不带教程的卡片」，就只能靠眼睛扫。
// 语法是给已经在用的人准备的 —— 不打字的人完全不受影响（不写冒号就还是普通搜索）。
//
// 两条底线：
//   1. 认不出来的 token 一律退回普通关键词，绝不静默丢掉（丢了等于搜不到，用户只会以为没有）；
//   2. 语法只做「再收窄」，不越过现有的筛选开关，两条路可以叠加。

export interface AdvancedQuery {
    /** 剥掉语法之后剩下的自由文本（给普通搜索用） */
    text: string;
    /** tag: 的值，多取交集 */
    tags: string[];
    /** group: / in: 的值，命中分组名（模糊） */
    groups: string[];
    /** url: 的值，只匹配链接 */
    urls: string[];
    /** is: 的标志：starred / dead / untagged */
    flags: string[];
    /** -xxx 排除词：命中即排除 */
    excludes: string[];
    /** 认不出来的 is:xxx（UI 用它提示「没有这个条件」） */
    unknownFlags: string[];
}

export const EMPTY_ADVANCED: AdvancedQuery = {
    text: "",
    tags: [],
    groups: [],
    urls: [],
    flags: [],
    excludes: [],
    unknownFlags: [],
};

export const KNOWN_FLAGS = ["starred", "dead", "untagged"] as const;

/** 是否用了高级语法（UI 只在用的时候才显示提示 / 语法说明） */
export function hasAdvancedSyntax(raw: string): boolean {
    const query = raw ?? "";
    return (
        /(^|\s)(tag|group|in|url|is):/i.test(query) ||
        /(^|\s)-[^\s-]/.test(query) ||
        /(^|\s)#[^\s#]/.test(query)
    );
}

/** 按空白切分，双引号里的内容算一个整体（标签名带空格就靠它） */
function tokenize(raw: string): string[] {
    const out: string[] = [];
    let buf = "";
    let quoted = false;
    for (const ch of raw) {
        if (ch === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (buf) out.push(buf);
            buf = "";
            continue;
        }
        buf += ch;
    }
    if (buf) out.push(buf);
    return out;
}

export function parseAdvancedQuery(raw: string): AdvancedQuery {
    if (!raw || !raw.trim()) return EMPTY_ADVANCED;

    const result: AdvancedQuery = { ...EMPTY_ADVANCED, tags: [], groups: [], urls: [], flags: [], excludes: [], unknownFlags: [] };
    const free: string[] = [];

    for (const token of tokenize(raw)) {
        let piece = token;
        let negated = false;
        if (piece.startsWith("-") && piece.length > 1) {
            negated = true;
            piece = piece.slice(1);
        }

        // #标签 的简写
        if (piece.startsWith("#") && piece.length > 1) {
            const value = piece.slice(1);
            (negated ? result.excludes : result.tags).push(value);
            continue;
        }

        const colon = piece.indexOf(":");
        if (colon > 0) {
            const key = piece.slice(0, colon).toLowerCase();
            const value = piece.slice(colon + 1);
            if (!value) {
                // 「tag:」后面是空的：当普通词搜，别当成条件
                free.push(piece);
                continue;
            }
            if (key === "tag") {
                result.tags.push(value);
                continue;
            }
            if (key === "group" || key === "in") {
                result.groups.push(value);
                continue;
            }
            if (key === "url") {
                result.urls.push(value);
                continue;
            }
            if (key === "is") {
                const flag = value.toLowerCase();
                if ((KNOWN_FLAGS as readonly string[]).includes(flag)) result.flags.push(flag);
                else result.unknownFlags.push(value);
                continue;
            }
            // 其它前缀（http:、file: 之类）不是我们的语法，退回普通搜索
            free.push(piece);
            continue;
        }

        if (negated) result.excludes.push(piece);
        else free.push(piece);
    }

    result.text = free.join(" ").trim();
    return result;
}

export interface AdvancedSiteContext {
    /** 这张卡片身上的标签 */
    tags: string[];
    /** 是否加了星标 */
    starred: boolean;
    /** 是否被检测为失效链接 */
    dead: boolean;
}

const lower = (value?: string | null) => (value ?? "").toLowerCase();

/**
 * 语法条件是否全都满足。text / excludes 由调用方走普通搜索与排除逻辑，
 * 这里只管 tag / group / url / is 四类。
 */
export function matchesAdvanced(
    site: { name?: string; url?: string },
    groupName: string,
    query: AdvancedQuery,
    ctx: AdvancedSiteContext
): boolean {
    const ownTags = (ctx.tags ?? []).map(t => lower(t));
    for (const tag of query.tags) {
        const want = lower(tag);
        if (!ownTags.some(t => t.includes(want))) return false;
    }
    for (const group of query.groups) {
        if (!lower(groupName).includes(lower(group))) return false;
    }
    for (const url of query.urls) {
        if (!lower(site.url).includes(lower(url))) return false;
    }
    for (const flag of query.flags) {
        if (flag === "starred" && !ctx.starred) return false;
        if (flag === "dead" && !ctx.dead) return false;
        if (flag === "untagged" && ownTags.length > 0) return false;
    }
    return true;
}

/** 排除词：命中任意一个就剔除（名称、链接、描述、标签都算命中） */
export function matchesExcludes(
    site: { name?: string; url?: string; description?: string },
    groupName: string,
    excludes: string[]
): boolean {
    if (excludes.length === 0) return false;
    const hay = [
        site.name ?? "",
        site.url ?? "",
        site.description ?? "",
        groupName ?? "",
    ]
        .join(" ")
        .toLowerCase();
    return excludes.some(word => hay.includes(lower(word)));
}

/** 输入框里给的语法提示（只在用户真的用了语法时才提示未知条件） */
export function advancedHint(query: AdvancedQuery): string {
    if (query.unknownFlags.length === 0) return "";
    return `不认识的条件：is:${query.unknownFlags.join("、is:")}（可用：${KNOWN_FLAGS.join("、")}）`;
}
