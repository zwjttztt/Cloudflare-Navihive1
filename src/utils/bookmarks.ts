// src/utils/bookmarks.ts
// 解析浏览器导出的书签 HTML（Netscape 格式，Chrome / Edge / Firefox 通用），
// 顶层文件夹当分组，里面的链接当卡片。
//
// 导入前先做一遍「体检」：把每条链接分成 新增 / 重复 / 无效 三类，
// 免得几百条书签一股脑灌进来，把已经存在的卡片再复制一份。
// 判重用 utils/duplicate.ts 的 urlKey（忽略协议、www、末尾斜杠的差异）。
import { GroupWithSites } from "../types";
import { urlKey } from "./duplicate";

export interface ParsedBookmark {
    title: string;
    url: string;
    folder: string;
}

export interface ParsedBookmarkGroup {
    folder: string;
    items: ParsedBookmark[];
}

/** 一条书签的体检结论 */
export type BookmarkStatus = "new" | "duplicate" | "invalid";

export interface BookmarkEntry extends ParsedBookmark {
    status: BookmarkStatus;
    /** 重复/无效的说明：重复说清在哪儿已存在，无效说清为什么不能用 */
    note?: string;
}

export interface BookmarkStats {
    total: number;
    added: number;
    duplicate: number;
    invalid: number;
}

export interface BookmarkPlan {
    /** 全部条目，按文件中出现的顺序（含重复与无效） */
    entries: BookmarkEntry[];
    /** 可以直接导入的部分：默认只有新增，includeDuplicates 打开后连重复一起 */
    groups: ParsedBookmarkGroup[];
    stats: BookmarkStats;
}

/** 重复项列表最多展示多少行，再多就是滚动里翻不到底的长清单了 */
export const DUPLICATE_PREVIEW_LIMIT = 50;

const FALLBACK_FOLDER = "导入的书签";

/** 一个 DT 里的文件夹名（H3）；没有就返回空串 */
function headingOfDt(dt: Element | null): string {
    if (!dt || dt.tagName !== "DT") return "";
    return dt.querySelector("h3")?.textContent?.trim() || "";
}

/**
 * 往上找最近的文件夹名：书签里文件夹是 <DT><H3>名字</H3>，链接在它的 <DL> 里。
 *
 * 两种写法都要认，浏览器导出的是**嵌套**的：
 *   <DT><H3>工具栏</H3><DL>…链接…</DL></DT>   → 文件夹 DL 的爸爸就是那个 DT
 * 手写或者老一点的导出是**并列**的：
 *   <DT><H3>工具栏</H3></DT><DL>…链接…</DL>   → 文件夹 DT 是 DL 的前一个兄弟
 * 只认并列写法时，Chrome/Edge/Firefox 的导出会整份落进兜底分组 —— 之前就是这样。
 */
function folderOf(node: Element): string {
    let current: Element | null = node.parentElement;
    while (current) {
        if (current.tagName === "DL") {
            // 先看嵌套写法：文件夹名就挂在这个 DL 的父 DT 上
            const nested = headingOfDt(current.parentElement);
            if (nested) return nested;
            // 再看并列写法：往前找最近的、带 H3 的 DT
            let prev: Element | null = current.previousElementSibling;
            while (prev) {
                const sibling = headingOfDt(prev);
                if (sibling) return sibling;
                prev = prev.previousElementSibling;
            }
        }
        current = current.parentElement;
    }
    return FALLBACK_FOLDER;
}

const SAFE_SCHEME = /^https?:\/\//i;

/**
 * 这条链接能不能当卡片用。
 * 书签文件里除了网页，还会有 javascript: 书签脚本、place: 智能文件夹、
 * chrome: 内部页这些，导进来只会得到一张点了没反应的卡。
 */
export function bookmarkInvalidReason(rawUrl: string): string | null {
    const url = (rawUrl || "").trim();
    if (!url) return "链接为空";
    if (SAFE_SCHEME.test(url)) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
    if (scheme) return `${scheme.toLowerCase()}: 不是网页链接`;
    return "不是完整网址";
}

/** 待体检的一条书签：判重只需要这三个字段，跟 ParsedBookmark 同形但语义不同 */
export type BookmarkInput = ParsedBookmark;

/** 把 HTML 里所有带 href 的链接拎出来，先不判断好坏 */
function collectRaw(html: string): BookmarkInput[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    return anchors.map(a => {
        const url = (a.getAttribute("href") || "").trim();
        const title = (a.textContent || "").trim() || url;
        return { title, url, folder: folderOf(a) };
    });
}

/** 现有库里已有哪些链接：key -> 那张卡片所在的分组名 */
function indexExisting(groups: GroupWithSites[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const group of groups) {
        for (const site of group.sites ?? []) {
            const key = urlKey(site.url);
            if (!key || map.has(key)) continue;
            map.set(key, group.name || "未命名分组");
        }
    }
    return map;
}

/** 数一遍各类条目，统计口径只有这一份 */
export function countBookmarkStatus(entries: readonly BookmarkEntry[]): BookmarkStats {
    let added = 0;
    let duplicate = 0;
    let invalid = 0;
    for (const entry of entries) {
        if (entry.status === "new") added += 1;
        else if (entry.status === "duplicate") duplicate += 1;
        else invalid += 1;
    }
    return { total: entries.length, added, duplicate, invalid };
}

/**
 * 一份书签文件的导入计划。
 * 判定顺序是「无效 → 库里已有 → 文件内重复」：
 * 无效的根本不是链接，库里已有是用户最该知道的，最后才轮到文件内部撞车。
 */
export function planBookmarkImport(
    html: string,
    groups: GroupWithSites[],
    options?: { includeDuplicates?: boolean }
): BookmarkPlan {
    return classifyBookmarkEntries(collectRaw(html), groups, options);
}

/** 上面那套判定的纯计算部分：不碰 DOM，测试和 HTML 解析各走各的 */
export function classifyBookmarkEntries(
    raw: readonly BookmarkInput[],
    groups: GroupWithSites[],
    options?: { includeDuplicates?: boolean }
): BookmarkPlan {
    const existing = indexExisting(groups);
    const seen = new Map<string, BookmarkInput>();
    const entries: BookmarkEntry[] = [];

    for (const source of raw) {
        const item = { ...source, key: urlKey(source.url) };
        const reason = bookmarkInvalidReason(item.url);
        if (reason) {
            entries.push({ title: item.title, url: item.url, folder: item.folder, status: "invalid", note: reason });
            continue;
        }

        const hit = item.key ? existing.get(item.key) : undefined;
        if (hit) {
            entries.push({
                title: item.title,
                url: item.url,
                folder: item.folder,
                status: "duplicate",
                note: `已存在于「${hit}」`,
            });
            continue;
        }

        // 同一个链接在多个文件夹里各存一份时，只留第一次出现的那处
        const first = item.key ? seen.get(item.key) : undefined;
        if (first) {
            entries.push({
                title: item.title,
                url: item.url,
                folder: item.folder,
                status: "duplicate",
                note: `与「${first.folder}」里的同一链接重复`,
            });
            continue;
        }
        if (item.key) seen.set(item.key, item);

        entries.push({ title: item.title, url: item.url, folder: item.folder, status: "new" });
    }

    const includeDuplicates = options?.includeDuplicates === true;
    const picked = entries.filter(
        entry => entry.status === "new" || (includeDuplicates && entry.status === "duplicate")
    );

    // 按文件夹聚合，文件夹顺序取第一次出现的顺序
    const order: string[] = [];
    const byFolder = new Map<string, ParsedBookmark[]>();
    for (const entry of picked) {
        let list = byFolder.get(entry.folder);
        if (!list) {
            list = [];
            byFolder.set(entry.folder, list);
            order.push(entry.folder);
        }
        list.push({ title: entry.title, url: entry.url, folder: entry.folder });
    }

    return {
        entries,
        groups: order.map(folder => ({ folder, items: byFolder.get(folder) ?? [] })),
        stats: countBookmarkStatus(entries),
    };
}

/**
 * 老入口：只解析出「能用的链接」。
 * 现在走同一套判定，所以跨文件夹的同一链接也只会留一处。
 */
export function parseBookmarksHtml(html: string): ParsedBookmarkGroup[] {
    return planBookmarkImport(html, []).groups;
}
