// src/utils/auditDetailText.ts
// 审计日志的展示层翻译：代码内部代号与上报 JSON 翻成人话。
//
// 为什么单独一份纯函数（不 import React / MUI）：这两块内容用 DOM 测很难钉住 ——
// 「前端错误」视图要真的崩一次才有数据，本地 mock 是空的；而翻译规则本身是纯字符串
// 变换，抽出来才能被单测逐条覆盖。
//
// ⚠️ 这里只做**展示**翻译，绝不回写：原始代号必须还能看到（前端错误行留了 title），
// 否则以后想按 source 去日志里查就找不到锚点了。

/** 拆词后各段之间的连接符 */
const WORD_SEPARATOR = " ";

/** 非 JSON 的老记录最多保留多少字（正常 detail 是一句话，超了基本是脏数据） */
const PLAIN_DETAIL_MAX = 160;
/** 任何输出的长度上限（列表行放不下更长的） */
const DETAIL_MAX = 200;
/** 平铺未知 JSON 时最多取几组（再多也没人读） */
const FLAT_FIELD_MAX = 4;

/**
 * 没法靠词表拼出来的来源代号。
 * 这些要么是「主体+动作」语义已经固化（save-error 不是「保存 错误」），
 * 要么压根不是代号（window.error / unhandledrejection 是事件名）。
 */
const IRREGULAR_SOURCES: Record<string, string> = {
    unknown: "未知来源",
    list: "列表加载",
    rail: "侧栏加载",
    render: "页面渲染",
    "save-error": "保存数据",
    "config-save": "保存配置",
    "window.error": "未捕获异常",
    unhandledrejection: "未处理的 Promise 拒绝",
};

/** 主语词表：说明「这块功能」 */
const SUBJECT_WORDS: Record<string, string> = {
    notes: "笔记",
    note: "笔记",
    site: "站点",
    auth: "账号",
    backup: "备份",
    group: "分组",
    config: "配置",
    account: "账号",
    recovery: "恢复",
    invite: "邀请码",
    tag: "标签",
    tags: "标签",
    folder: "文件夹",
    revision: "版本",
    trash: "回收站",
    sync: "同步",
    poll: "轮询",
    bulk: "批量",
    auto: "自动",
    settings: "设置",
    webdav: "WebDAV",
    credentials: "凭据",
};

/** 动作词表：说明「做了什么」 */
const ACTION_WORDS: Record<string, string> = {
    login: "登录",
    register: "注册",
    recover: "找回",
    check: "校验",
    key: "密钥",
    create: "新建",
    delete: "删除",
    update: "更新",
    save: "保存",
    order: "排序",
    reorder: "排序",
    move: "移动",
    export: "导出",
    import: "导入",
    list: "列表",
    search: "搜索",
    full: "正文",
    assign: "关联",
    style: "样式",
    restore: "还原",
    purge: "彻底删除",
    empty: "清空",
    html: "HTML",
    pdf: "PDF",
};

/**
 * 来源代号 -> 中文。
 *
 * 为什么是「词表组合」而不是 66 条手写映射：手写表每加一处上报就得同步改一次，
 * 忘改就裸奔（已经发生过）。词表拼不出来也没关系 —— 未登记的词原样保留，
 * 宁可半中半英，也不要丢掉可追溯性。
 */
export function errorSourceLabel(source: string): string {
    if (typeof source !== "string") return "未知来源";
    const raw = source.trim();
    if (!raw) return "未知来源";

    const irregular = IRREGULAR_SOURCES[raw];
    if (irregular) return irregular;

    const parts: string[] = [];
    let translated = false;

    raw.split("-").forEach((token, index) => {
        if (!token) return;
        const lower = token.toLowerCase();
        // 首个词优先当主语（notes-list / site-delete），后续词优先当动作（note-full）；
        // 两张表都收的词（list / save）靠这个先后才能落在正确的一侧。
        const word =
            index === 0
                ? (SUBJECT_WORDS[lower] ?? ACTION_WORDS[lower])
                : (ACTION_WORDS[lower] ?? SUBJECT_WORDS[lower]);
        if (!word) {
            parts.push(token);
            return;
        }
        translated = true;
        // 组合里重复命中同一个词只留一次（notes-note 之类不该读成「笔记 笔记」）
        if (!parts.includes(word)) parts.push(word);
    });

    // 一个词都译不出来：原样返回，别造一个「未知」把原始代号吃掉
    if (!translated) return raw;
    return parts.join(WORD_SEPARATOR);
}

/** 去首尾空白并按上限截断；截断处补省略号，让人看出后面还有 */
function clampText(text: string, max: number): string {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 取一个「可能不存在」的字符串字段：拿不到就是空串，不占位 */
function readStr(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** client-error 的上报体：说清「哪儿出的什么错」 */
function formatClientError(fields: Record<string, unknown>): string {
    const message = readStr(fields.message) || "（无错误信息）";
    const requestId = readStr(fields.requestId);

    const base = `${errorSourceLabel(readStr(fields.source))}：${message}`;
    // rid 是「去服务端日志里查哪一行」的唯一线索，有就必须给出来
    return requestId ? `${base}（请求号 ${requestId}）` : base;
}

/**
 * server-error 的上报体（`worker/index.ts` 落的）：`{ method, path, code, message, rid }`。
 *
 * 与前端上报**不共用**一套字段读取，有三处实际差异：
 *   · 来源不是 source，而是「方法 + API 路径」；
 *   · 请求号叫 rid，不叫 requestId；
 *   · 这里的 path 是 **API 路径**（`/api/sites`），不是页面路由 ——
 *     绝不能走 formatAuditPath，否则 `/` 会被译成「首页」。
 * `code` 是内部错误码，对用户没有意义，不显示。
 */
function formatServerError(fields: Record<string, unknown>): string {
    const message = readStr(fields.message) || "（无错误信息）";
    // 缺少哪段就整段不出：不留下多余空格或孤零零一个冒号
    const where = [readStr(fields.method), readStr(fields.path)].filter(Boolean).join(" ");
    const rid = readStr(fields.rid);

    const base = where ? `${where}：${message}` : message;
    return rid ? `${base}（请求号 ${rid}）` : base;
}

/** 其它 action 的 JSON：平铺成「键: 值」，嵌套结构看不懂就跳过 */
function flattenFields(fields: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (parts.length >= FLAT_FIELD_MAX) break;
        if (value === null || value === undefined) continue;
        // 数组也是 object：嵌套内容平铺出来只会更长更看不懂
        if (typeof value === "object") continue;
        if (typeof value === "string" && !value.trim()) continue;
        parts.push(`${key}: ${String(value).trim()}`);
    }
    return parts.join(" · ");
}

/**
 * 审计条目的 detail -> 一句话。
 *
 * 正常 detail 本来就是人话（`长期未登录，已停用`），**只有**前端/服务端错误上报
 * 是一小段 JSON —— 那种直接怼给用户就是一坨。所以：解析不了就原样返回，
 * 解析成功也只在「确实是上报体」时才重排。
 */
export function formatAuditDetail(action: string, detail: string | null | undefined): string {
    const raw = typeof detail === "string" ? detail : "";
    if (!raw.trim()) return "";
    const text = raw.trim();

    // 不以 { 开头的一定不是上报体（老记录 / 手写记录 / 中文句子），原样给出
    if (!text.startsWith("{")) return clampText(text, PLAIN_DETAIL_MAX);

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return clampText(text, PLAIN_DETAIL_MAX);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return clampText(text, PLAIN_DETAIL_MAX);
    }

    const fields = parsed as Record<string, unknown>;
    const rendered =
        action === "server-error"
            ? formatServerError(fields)
            : action === "client-error"
              ? formatClientError(fields)
              : flattenFields(fields);
    return clampText(rendered, DETAIL_MAX);
}

/**
 * 出错路径 -> 中文。
 * 首页的路由就是 `/`，直接显示会变成孤零零一个斜杠（截图里那个 `save-error /`）。
 */
export function formatAuditPath(path: string): string {
    if (typeof path !== "string") return "";
    if (path === "" || path === "/") return "首页";
    if (path === "/notes") return "记事本";
    return path;
}
