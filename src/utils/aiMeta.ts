// src/utils/aiMeta.ts
// AI 助手的纯逻辑：提示词怎么拼、模型返回怎么校验、向量怎么比。
//
// 全是不碰网络也不碰 DOM 的函数，因为**模型会说胡话**是常态而不是异常：
// 它会在 JSON 外面裹一段话、会把标签写成 "#AI, 工具"、会返回一个你根本没有的分组名、
// 也会给一批站点里的某几个编造出压根不存在的 id。所有「信不信它」的判断都收在这一层，
// 路由层拿到的是已经洗干净的数据。

/** 名称 / 描述 / 分组名 / 标签的长度上限，跟界面上的输入框对齐 */
export const MAX_NAME_LEN = 60;
export const MAX_DESC_LEN = 200;
export const MAX_GROUP_LEN = 40;
export const MAX_TAG_LEN = 24;
/** 一个站点最多给多少个标签：给多了等于没给 */
export const MAX_TAGS_PER_SITE = 5;
/** 一次批量建议最多送多少站点：塞太多进去模型就开始漏、开始编 */
export const MAX_SUGGEST_SITES = 40;

export interface SiteMetaSuggestion {
    name: string;
    description: string;
    /** 建议的分组名（已有分组里的原名，或一个新名字）；空串表示「没建议」 */
    group: string;
    tags: string[];
}

export interface TagSuggestion {
    id: number;
    tags: string[];
    /** 建议移到的分组名；空串表示「保持原分组」 */
    group: string;
}

export interface PromptSite {
    id: number;
    name: string;
    url: string;
    description?: string;
}

/** 截断到指定长度（按字符数，中文一个字算一个） */
export function clampText(value: unknown, max: number): string {
    if (typeof value !== "string") return "";
    const text = value.trim().replace(/\s+/g, " ");
    return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/**
 * 从模型的回答里抠出 JSON。
 * 三种写法都见过：直接给 JSON、裹在 ```json 代码块里、前后各说一段话再给 JSON。
 */
export function parseAnyJson(raw: string): unknown | null {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const candidate = fenced?.[1] ?? raw;
    const firstBrace = candidate.search(/[[{]/);
    if (firstBrace === -1) return null;
    const opener = candidate[firstBrace];
    const closer = opener === "[" ? "]" : "}";
    const end = candidate.lastIndexOf(closer);
    if (end <= firstBrace) return null;
    try {
        return JSON.parse(candidate.slice(firstBrace, end + 1));
    } catch {
        return null;
    }
}

/**
 * 洗一个标签：去 # 前缀、去空白、限长。
 * 返回 null 表示这条不能用（空、纯符号、太长）。
 */
export function normalizeTag(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // 模型很爱写 "#AI"、"# AI"、「AI工具」
    const text = value.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_TAG_LEN) return null;
    // 纯标点没有意义
    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    return text;
}

/** 洗一组标签：逐条清洗、去重（大小写不敏感）、限数量 */
export function normalizeTags(value: unknown, existing: string[] = []): string[] {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、]/) : [];
    const out: string[] = [];
    const seen = new Set(existing.map(t => t.trim().toLowerCase()).filter(Boolean));
    for (const item of raw) {
        const tag = normalizeTag(item);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
        if (out.length >= MAX_TAGS_PER_SITE) break;
    }
    return out;
}

/**
 * 分组名：优先落在**已有分组**里（大小写/空白不敏感时用已有分组的原名），
 * 否则当成一个新分组名。模型编出来的新名字也要限长，免得建出一个五十字长的分组。
 */
export function resolveGroupName(value: unknown, groups: string[]): string {
    const text = clampText(value, MAX_GROUP_LEN);
    if (!text) return "";
    const hit = groups.find(g => g.trim().toLowerCase() === text.toLowerCase());
    return hit ?? text;
}

/** 站点元信息补全的提示词：把已有分组与标签都摆出来，逼它从里面选 */
export function buildSiteMetaPrompt(opts: {
    url: string;
    name?: string;
    groups: string[];
    tags: string[];
}): string {
    const groups = opts.groups.length > 0 ? opts.groups.join("、") : "（还没有分组）";
    const tags = opts.tags.length > 0 ? opts.tags.join("、") : "（还没有标签）";
    const known = opts.name ? `网站名称已知是「${opts.name}」，可以修正错别字但不要换成别的网站。` : "";
    return [
        "你是一个导航站的整理助手。用户给出了一个网址，请推断这个网站是什么。",
        known,
        `网址：${opts.url}`,
        `已有分组：${groups}`,
        `已有标签：${tags}`,
        "",
        "只输出一个 JSON 对象，不要任何解释文字，格式如下：",
        '{"name":"网站中文或常用名称（不超过20字）","description":"一句话说明这个网站是干什么的（不超过60字）","group":"从已有分组里选一个最合适的，没有合适的就给一个新分组名","tags":["标签1","标签2"]}',
        "",
        "规则：分组优先用已有分组的原名；标签 2 到 4 个、简短、用中文；不确定就留空字符串或空数组，不要编造。",
    ]
        .filter(Boolean)
        .join("\n");
}

export function parseSiteMeta(
    raw: string,
    opts: { groups?: string[]; tags?: string[] } = {}
): SiteMetaSuggestion | null {
    const data = parseAnyJson(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const obj = data as Record<string, unknown>;
    const name = clampText(obj.name ?? obj.title, MAX_NAME_LEN);
    const description = clampText(obj.description ?? obj.summary, MAX_DESC_LEN);
    const group = resolveGroupName(obj.group ?? obj.groupName ?? obj.category, opts.groups ?? []);
    const tags = normalizeTags(obj.tags ?? obj.labels, opts.tags ?? []);
    if (!name && !description && !group && tags.length === 0) return null;
    return { name, description, group, tags };
}

/** 批量打标签 / 归组的提示词 */
export function buildTagSuggestionPrompt(opts: {
    sites: PromptSite[];
    groups: string[];
    tags: string[];
}): string {
    const groups = opts.groups.length > 0 ? opts.groups.join("、") : "（还没有分组）";
    const tags = opts.tags.length > 0 ? opts.tags.join("、") : "（还没有标签）";
    const list = opts.sites
        .slice(0, MAX_SUGGEST_SITES)
        .map(s => `- id=${s.id} 名称=${s.name || "（无）"} 网址=${s.url}${s.description ? ` 描述=${s.description}` : ""}`)
        .join("\n");
    return [
        "你是一个导航站的整理助手。下面是用户收藏的网站，请给每个网站建议标签，并在合适时建议它应该归到哪个分组。",
        "",
        "网站列表：",
        list,
        "",
        `已有分组：${groups}`,
        `已有标签：${tags}`,
        "",
        "只输出一个 JSON 对象，不要任何解释文字，格式如下：",
        '{"sites":[{"id":12,"tags":["标签1","标签2"],"group":"已有分组里的一个名字或留空表示不改分组"}]}',
        "",
        `规则：只处理上面列出的 id，不要新增 id；每个站点 1 到 3 个标签，优先用已有标签；分组优先用已有分组的原名，拿不准就留空字符串。`,
    ].join("\n");
}

/**
 * 解析批量建议。
 * 只认 `allowedIds` 里出现过的 id —— 模型编出来的 id 会被直接丢掉，
 * 否则前端拿到一个不存在的 id 去写标签，会写到莫名其妙的地方。
 */
export function parseTagSuggestions(
    raw: string,
    opts: { allowedIds: number[]; groups?: string[]; tags?: string[] }
): TagSuggestion[] {
    const data = parseAnyJson(raw);
    if (!data || typeof data !== "object") return [];
    const list = Array.isArray(data)
        ? data
        : Array.isArray((data as Record<string, unknown>).sites)
          ? ((data as Record<string, unknown>).sites as unknown[])
          : [];
    const allowed = new Set(opts.allowedIds);
    const out: TagSuggestion[] = [];
    const seen = new Set<number>();
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const id = Number(obj.id);
        if (!Number.isInteger(id) || !allowed.has(id) || seen.has(id)) continue;
        const tags = normalizeTags(obj.tags, opts.tags ?? []);
        const group = resolveGroupName(obj.group, opts.groups ?? []);
        if (tags.length === 0 && !group) continue;
        seen.add(id);
        out.push({ id, tags, group });
    }
    return out;
}

/** 一条站点被嵌入的文本：语义搜索靠它，字段顺序固定，改了就必须重算（见 EMBED_TEXT_VERSION） */
export function embeddingText(site: {
    name?: string;
    url?: string;
    description?: string;
    tags?: string[];
}): string {
    const parts = [site.name || "", site.url || "", site.description || "", (site.tags ?? []).join(" ")];
    return parts.join(" ").trim().slice(0, 500);
}

/** 余弦相似度。长度不等或零向量一律 0 —— 宁可「不匹配」也不要 NaN 炸到排序里 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 按相似度取前 limit 条；分数太低的不算命中（避免「最像的那个也完全不像」还硬塞给用户） */
export function topMatches(
    query: readonly number[],
    items: readonly { id: number; vec: readonly number[] }[],
    limit: number,
    minScore = 0
): { id: number; score: number }[] {
    const scored: { id: number; score: number }[] = [];
    for (const item of items) {
        const score = cosineSimilarity(query, item.vec);
        if (score >= minScore) scored.push({ id: item.id, score });
    }
    scored.sort((x, y) => y.score - x.score || x.id - y.id);
    return scored.slice(0, Math.max(0, limit));
}
