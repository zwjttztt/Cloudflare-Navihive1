// src/utils/commandMatch.ts
// 命令面板的匹配与排序：从「纯 includes」升级成「打分排序」。
//
// 以前只要 label/hint/keywords 里出现关键词就算命中，顺序完全由条目生成顺序决定 ——
// 输「设置」时，「打开设置」常常排在「网站设置里的某一项」后面，因为后者先生成。
// 现在按「有多像」打分：完全相等 > 前缀 > 包含 > 跳字（gh 能命中 GitHub），
// 再用「最近用过」加一点权重 —— 用过的命令第二次就该排在前面。

const RECENT_KEY = "navihive:commandRecent";
const RECENT_MAX = 12;

/** 跳字匹配：字符按顺序出现即可（gh → GitHub），返回是否命中 */
export function fuzzyMatch(text: string, key: string): boolean {
    if (!key) return true;
    const hay = text.toLowerCase();
    const needle = key.toLowerCase();
    let i = 0;
    for (const ch of hay) {
        if (ch === needle[i]) i += 1;
        if (i === needle.length) return true;
    }
    return false;
}

export interface MatchCandidate {
    id: string;
    label: string;
    hint?: string;
    keywords?: string;
    section?: string;
}

export interface MatchOptions {
    /**
     * 拼音匹配函数（词典就位后由调用方注入；未注入 = 不做拼音层）。
     * 命中得 30 分：排在关键词(40)之后、跳字(20)之前 ——
     * 「sz → 设置」比「gh 碰巧跳中 GitHub」更像用户想搜的。
     */
    pinyin?: (text: string, key: string) => boolean;
}

/**
 * 打分：越高越靠前，< 0 表示不命中。
 * 输入为空时一律给 0（保持原顺序，由调用方决定最近使用的加权）。
 */
export function scoreCommand(item: MatchCandidate, key: string, opts?: MatchOptions): number {
    if (!key) return 0;
    const label = (item.label ?? "").toLowerCase();
    const hint = (item.hint ?? "").toLowerCase();
    const keywords = (item.keywords ?? "").toLowerCase();

    if (label === key) return 100;
    if (label.startsWith(key)) return 80;
    // 包含命中按「关键词占整条标签的比例」微调：
    // 「打开设置」比「网站设置里的某一项」更像在找「设置」，光看包含与否两者同分
    if (label.includes(key)) {
        return 60 + Math.round(10 * (key.length / Math.max(label.length, 1)));
    }
    if (hint.includes(key) || keywords.includes(key)) return 40;
    if (opts?.pinyin && (opts.pinyin(item.label ?? "", key) || (item.hint ? opts.pinyin(item.hint, key) : false))) {
        return 30;
    }
    if (fuzzyMatch(label, key)) return 20;
    return -1;
}

/**
 * 排序：先按分数，分数相同则最近用过的靠前，再相同按原顺序（稳定）。
 * recent 是「最近 → 更早」排列的命令 id。
 */
export function rankCommands<T extends MatchCandidate>(
    items: T[],
    key: string,
    recent: string[] = [],
    opts?: MatchOptions
): T[] {
    const trimmed = key.trim().toLowerCase();
    const scored = items
        .map((item, index) => {
            const score = scoreCommand(item, trimmed, opts);
            const recentIndex = recent.indexOf(item.id);
            const boost = recentIndex >= 0 ? (recent.length - recentIndex) * 0.5 : 0;
            return { item, index, score, boost };
        })
        .filter(entry => entry.score >= 0);

    scored.sort((a, b) => {
        const totalA = a.score + a.boost;
        const totalB = b.score + b.boost;
        if (totalB !== totalA) return totalB - totalA;
        return a.index - b.index;
    });
    return scored.map(entry => entry.item);
}

export interface CommandGroup<T> {
    section: string;
    /** 组内条目连同它在扁平结果里的下标（键盘 active 仍按扁平序号走） */
    entries: { item: T; index: number }[];
}

/**
 * 把已排序的扁平结果按 section 分组展示：组按「首次出现顺序」排，
 * 组内保持打分排序不变 —— 分组只是视觉归类，不能反过来影响排名。
 */
export function groupBySection<T extends MatchCandidate>(items: T[]): CommandGroup<T>[] {
    const groups: CommandGroup<T>[] = [];
    const bySection = new Map<string, CommandGroup<T>>();
    items.forEach((item, index) => {
        const section = item.section ?? "";
        let group = bySection.get(section);
        if (!group) {
            group = { section, entries: [] };
            bySection.set(section, group);
            groups.push(group);
        }
        group.entries.push({ item, index });
    });
    return groups;
}

/** 读最近用过的命令 id（最新在前）；存储不可用时返回空数组 */
export function readRecentCommands(): string[] {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((v): v is string => typeof v === "string");
    } catch {
        return [];
    }
}

/** 记一次使用：去重后放最前，最多留 RECENT_MAX 条 */
export function pushRecentCommand(id: string): void {
    if (!id) return;
    try {
        const next = [id, ...readRecentCommands().filter(v => v !== id)].slice(0, RECENT_MAX);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
        // 隐私模式下写不进去就算了，最近使用只是排序偏好
    }
}
