// src/utils/notesSettings.ts
// 记事本自己的 UI 设置（设置面板「外观 / 编辑器」两页）的持久化。
//
// 为什么不进 configs / user_configs：这些是**纯本机**的阅读习惯（字号、行高、
// 强调色），跟账号无关、也不该同步到别人的设备上 —— localStorage 就够了，
// 和列宽 / 分栏比例（notes.navColW 等）同一套思路。
//
// 形状演进：老版本可能存了缺字段的 JSON（或干脆不是对象），读取必须**逐字段**
// 兜底到默认值，绝不能直接 Object.assign 到默认值上 —— 那会把脏类型
//（字符串 "18"、null）原样带进运行时。

export interface NotesUiSettings {
    /** 强调色（十六进制）。作用域仅记事本页面：写在页面根元素的 --accent 上 */
    accent: string;
    /** 预览正文字号（px） */
    previewFontSize: number;
    /** 预览行高 */
    lineHeight: number;
    /** 预览内容宽度档位 */
    contentWidth: "narrow" | "standard" | "wide" | "full";
    /** 编辑器字体：等宽 / 无衬线 */
    editorFont: "mono" | "sans";
    /** 编辑器字号（px） */
    editorFontSize: number;
    /** 显示行号 */
    lineNumbers: boolean;
    /** 显示格式工具栏 */
    showToolbar: boolean;
    /** 拼写检查 */
    spellcheck: boolean;
}

export const DEFAULT_NOTES_SETTINGS: NotesUiSettings = {
    accent: "#b0433a",
    previewFontSize: 16,
    lineHeight: 1.7,
    contentWidth: "standard",
    editorFont: "mono",
    editorFontSize: 14,
    lineNumbers: true,
    showToolbar: true,
    spellcheck: false,
};

const KEY = "notes.uiSettings";

/** 逐字段清洗：类型不对就回落默认值，绝不让脏数据进运行时 */
function sanitize(raw: unknown): NotesUiSettings {
    const d = DEFAULT_NOTES_SETTINGS;
    if (!raw || typeof raw !== "object") return { ...d };
    const o = raw as Record<string, unknown>;
    const num = (v: unknown, fallback: number, min: number, max: number) =>
        typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
    const bool = (v: unknown, fallback: boolean) =>
        typeof v === "boolean" ? v : fallback;
    const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
        typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
    return {
        // 强调色只认 #rgb / #rrggbb，别的（javascript: 之类）一律回落
        accent:
            typeof o.accent === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(o.accent)
                ? o.accent
                : d.accent,
        previewFontSize: num(o.previewFontSize, d.previewFontSize, 12, 24),
        lineHeight: num(o.lineHeight, d.lineHeight, 1.2, 2.4),
        contentWidth: pick(o.contentWidth, ["narrow", "standard", "wide", "full"] as const, d.contentWidth),
        editorFont: pick(o.editorFont, ["mono", "sans"] as const, d.editorFont),
        editorFontSize: num(o.editorFontSize, d.editorFontSize, 12, 22),
        lineNumbers: bool(o.lineNumbers, d.lineNumbers),
        showToolbar: bool(o.showToolbar, d.showToolbar),
        spellcheck: bool(o.spellcheck, d.spellcheck),
    };
}

export function loadNotesSettings(): NotesUiSettings {
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        if (!raw) return { ...DEFAULT_NOTES_SETTINGS };
        return sanitize(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_NOTES_SETTINGS };
    }
}

export function saveNotesSettings(settings: NotesUiSettings): void {
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
    } catch {
        /* 隐私模式下写不了，忽略 */
    }
}
