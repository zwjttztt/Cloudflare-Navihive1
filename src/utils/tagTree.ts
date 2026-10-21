// src/utils/tagTree.ts
// 标签层级（2026-10-22，B4）。
//
// 标签一多就痛在两点：一是一排几十个 chip 找不到想要的，二是「工作」和「工作/项目A」
// 想一起筛的时候得点两次。这里用 **路径** 表达层级：`工作/项目A` 是 `工作` 的子标签。
//
// ⚠️ 三条刻意的取舍：
//   1. **不新增数据结构**：标签在库里一直是字符串，改成树要动表结构、动导入导出、
//      动分享 —— 代价远大于收益。用 `/` 分隔是「同一个字符串里带层级」，
//      老标签（没有 / 的）天然是一级，不需要迁移。
//   2. **匹配语义是前缀，不是相等**：选中「工作」= 选中「工作」及其所有子标签
//      （`tagMatches`）；选中「工作/项目A」只筛它自己。也就是说父级是「或」，
//      多个选中项之间仍然是「且」（沿用原来的 every 语义）。
//   3. **只在真的有层级时才分组显示**：全是一级标签时树形展示纯属添乱
//      （`hasHierarchy` 判断），界面按这个开关决定排版。
//
// ⚠️ 标签里出现 `/` 是用户自己写的（标签管理里输入），所以这里的解析必须
//    容忍空段、首尾空格、连续斜杠 —— 用户不会按我们的格式来。
export const TAG_PATH_SEP = "/";

/** 拆成层级段：去空段、去首尾空格。'工作/项目A' → ['工作','项目A'] */
export function splitTagPath(tag: string): string[] {
    return String(tag ?? "")
        .split(TAG_PATH_SEP)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/** 拼回路径（顺手归一：' 工作 / 项目A ' → '工作/项目A'），拿不到有效段时返回空串 */
export function joinTagPath(segments: string[]): string {
    return splitTagPath(segments.join(TAG_PATH_SEP)).join(TAG_PATH_SEP);
}

/**
 * 单个标签名归一化（' 工作 / 项目A ' → '工作/项目A'）。
 * ⚠️ 与 joinTagPath 分开：那边收的是段数组，这里收的是**用户打的一整个标签** ——
 *    混成一个函数时传字符串进去会 segments.join is not a function（2026-10-22 踩到）。
 */
export function normalizeTag(tag: string): string {
    return splitTagPath(tag).join(TAG_PATH_SEP);
}

/** 第几层（一级标签是 1） */
export function tagDepth(tag: string): number {
    return splitTagPath(tag).length;
}

/** 父路径；一级标签没有父，返回 null */
export function tagParent(tag: string): string | null {
    const segs = splitTagPath(tag);
    if (segs.length <= 1) return null;
    return segs.slice(0, -1).join(TAG_PATH_SEP);
}

/** 末段（界面上子标签只显示这一截，否则一排全是「工作/…」前缀） */
export function tagLeaf(tag: string): string {
    const segs = splitTagPath(tag);
    return segs.length > 0 ? segs[segs.length - 1] : "";
}

/** 这一批标签里有没有层级（决定界面要不要按树排版） */
export function hasHierarchy(tags: string[]): boolean {
    return tags.some(t => tagDepth(t) > 1);
}

/**
 * 匹配：选中的标签是否命中这个标签。
 *   selected 是「工作」→ 命中「工作」「工作/项目A」「工作/项目A/后端」
 *   selected 是「工作/项目A」→ 只命中它自己和它的子级
 * ⚠️ 按**段**比较，不是字符串 startsWith —— 否则「工作」会命中「工作日晚高峰」
 *    （字符串前缀命中，但它俩毫无关系）。
 */
export function tagMatches(tag: string, selected: string): boolean {
    const own = splitTagPath(tag);
    const want = splitTagPath(selected);
    if (own.length === 0 || want.length === 0) return false;
    if (want.length > own.length) return false;
    return want.every((seg, i) => seg === own[i]);
}

/** 一组选中项里有没有命中（沿用「多个标签之间是且」的语义，单个内部是父级含子级） */
export function matchesAnySelected(tag: string, selected: string[]): boolean {
    return selected.some(s => tagMatches(tag, s));
}

export interface TagNode {
    /** 完整路径（唯一的键） */
    path: string;
    /** 末段（显示用） */
    label: string;
    depth: number;
    children: TagNode[];
}

/**
 * 由扁平标签列表建树。
 * ⚠️ 隐式父节点要补齐：用户可能只写了「工作/项目A」而从未单独打过「工作」标签，
 *    这时界面上必须有一个「工作」节点可点，否则那一支根本选不中。
 * ⚠️ 输出按路径排序（同层字典序），保证每次渲染顺序稳定 —— 顺序漂动会让
 *    用户「昨天在第三个的那个标签」今天跑到别处。
 */
export function buildTagTree(tags: string[]): TagNode[] {
    const roots: TagNode[] = [];
    const index = new Map<string, TagNode>();

    const ensure = (path: string): TagNode => {
        const hit = index.get(path);
        if (hit) return hit;
        const segs = splitTagPath(path);
        const node: TagNode = {
            path,
            label: segs[segs.length - 1] ?? path,
            depth: segs.length,
            children: [],
        };
        index.set(path, node);
        if (segs.length === 1) {
            roots.push(node);
        } else {
            const parent = ensure(segs.slice(0, -1).join(TAG_PATH_SEP));
            parent.children.push(node);
        }
        return node;
    };

    for (const raw of tags) {
        const path = normalizeTag(raw);
        if (path) ensure(path);
    }

    const sortDeep = (nodes: TagNode[]): TagNode[] => {
        nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const n of nodes) sortDeep(n.children);
        return nodes;
    };
    return sortDeep(roots);
}

/** 拍平成「父在前、子紧随其后」的一列（界面按缩进渲染用） */
export function flattenTagTree(nodes: TagNode[]): TagNode[] {
    const out: TagNode[] = [];
    const walk = (list: TagNode[]) => {
        for (const n of list) {
            out.push(n);
            walk(n.children);
        }
    };
    walk(nodes);
    return out;
}
