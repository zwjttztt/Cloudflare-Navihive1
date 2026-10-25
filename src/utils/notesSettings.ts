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
    /**
     * 强调色（十六进制），作用域仅记事本页面：写在页面根元素的 --accent 上。
     *
     * **空串 = 跟随主题**（推荐默认）：此时注入的是 `var(--notes-accent)`，
     * 由 index.css 按亮/暗两态各给一个达标的红棕 —— 用户在「外观 → 强调色」
     * 里挑过之后才有具体色值。
     *
     * 为什么默认不是具体色值：同一个 `#b0433a` 在暖白底上只有 4.18:1、
     * 在暗底上 3.19:1，两头都不到 WCAG AA 的 4.5 —— 而它恰好是记事本过去的默认值，
     * 于是「默认外观」本身就是不达标的（2026-10-24 把审计扩到记事本时抓出来的）。
     */
    accent: string;
    /** 背景色：暖白（纸感）/ 纯白（inkstone「背景色」那一项） */
    bgcolor: "warm" | "pure";
    /** 界面密度：舒适 / 紧凑（行距与列表行高） */
    density: "comfortable" | "compact";
    /** 预览正文字体：无衬线 / 衬线 */
    previewFont: "sans" | "serif";
    /** 预览正文字号（px） */
    previewFontSize: number;
    /** 预览行高 */
    lineHeight: number;
    /** 预览内容宽度档位 */
    contentWidth: "narrow" | "standard" | "wide" | "full";
    /**
     * 列表行样式：无线（极简）/ 分隔线（高密度）/ 卡片（强扫描）。
     *
     * 2026-10-25「笔记美化」：以前只有一种——透明行 + 选中态描边。
     * 几百条笔记时相邻行的边界全靠留白，长列表里很难「一行一行看」；
     * 卡片模式边界最清楚但 128px 窄栏会显挤，所以做成三档让用户自己选。
     * 默认「分隔线」：变化最小、扫描性提升最明显。
     */
    listStyle: "plain" | "divider" | "card";
    /** 编辑器字体：等宽 / 无衬线 */
    editorFont: "mono" | "sans";
    /** 编辑器字号（px） */
    editorFontSize: number;
    /** 缩进宽度（空格数） */
    indentWidth: 2 | 4;
    /** 显示行号 */
    lineNumbers: boolean;
    /** 显示格式工具栏 */
    showToolbar: boolean;
    /** 拼写检查 */
    spellcheck: boolean;
    /** 分栏时预览跟随源码滚动 */
    scrollSync: boolean;
    /** 专注模式：淡化光标所在段落之外的内容 */
    focusMode: boolean;
    /** 编辑区实时渲染（非光标段落渲染成所见即所得） */
    liveRender: boolean;
    /** 打字机模式：光标行始终垂直居中（inkstone 同名功能） */
    typewriterMode: boolean;
    /** 记住每篇笔记的阅读滚动位置，重开恢复 */
    rememberPosition: boolean;
    /** 渲染数学公式 */
    mathRender: boolean;
    /** 渲染 Mermaid 图表 */
    mermaidRender: boolean;
    /** 折叠较长的代码块 */
    foldCode: boolean;
    /** 折叠阈值（行数） */
    foldCodeLines: number;
    /** 打开笔记时默认显示大纲面板 */
    defaultOutline: boolean;
    /** 自动保存延迟（ms） */
    autosaveMs: number;
}

export const DEFAULT_NOTES_SETTINGS: NotesUiSettings = {
    // 空 = 跟随主题（var(--notes-accent)），见接口注释里的对比度原因
    accent: "",
    bgcolor: "warm",
    density: "comfortable",
    previewFont: "sans",
    previewFontSize: 16,
    lineHeight: 1.7,
    contentWidth: "standard",
    listStyle: "divider",
    editorFont: "mono",
    editorFontSize: 14,
    indentWidth: 2,
    lineNumbers: true,
    showToolbar: true,
    spellcheck: false,
    scrollSync: true,
    focusMode: false,
    liveRender: true,
    typewriterMode: false,
    rememberPosition: true,
    mathRender: true,
    mermaidRender: true,
    foldCode: true,
    foldCodeLines: 24,
    defaultOutline: false,
    autosaveMs: 3000,
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
        // 强调色只认 #rgb / #rrggbb 或空串（空 = 跟随主题），别的（javascript: 之类）一律回落。
        //
        // ⚠️ `#b0433a` 是 2026-10-24 之前的默认值，**在亮/暗两态都不达 AA**
        // （亮 4.18:1 / 暗 3.19:1）。存量里存着这个值的用户其实从未主动挑过颜色 ——
        // 它只是当年的默认值被写进了 localStorage。所以这里把它当作「没设过」，
        // 让它跟着默认一起升级到分态的 --notes-accent。
        // 用户**自己**挑的其它颜色保持原样，不做二次加工。
        accent: (() => {
            const raw = o.accent;
            if (typeof raw !== "string") return d.accent;
            if (raw === "" || raw === "#b0433a") return "";
            return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw) ? raw : d.accent;
        })(),
        bgcolor: pick(o.bgcolor, ["warm", "pure"] as const, d.bgcolor),
        density: pick(o.density, ["comfortable", "compact"] as const, d.density),
        previewFont: pick(o.previewFont, ["sans", "serif"] as const, d.previewFont),
        previewFontSize: num(o.previewFontSize, d.previewFontSize, 12, 24),
        lineHeight: num(o.lineHeight, d.lineHeight, 1.2, 2.4),
        contentWidth: pick(o.contentWidth, ["narrow", "standard", "wide", "full"] as const, d.contentWidth),
        listStyle: pick(o.listStyle, ["plain", "divider", "card"] as const, d.listStyle),
        editorFont: pick(o.editorFont, ["mono", "sans"] as const, d.editorFont),
        editorFontSize: num(o.editorFontSize, d.editorFontSize, 12, 22),
        // 缩进宽度只认 2 / 4（其它数值回落默认，别让脏数据把编辑器搞成 3 空格）
        indentWidth: o.indentWidth === 4 ? 4 : o.indentWidth === 2 ? 2 : d.indentWidth,
        lineNumbers: bool(o.lineNumbers, d.lineNumbers),
        showToolbar: bool(o.showToolbar, d.showToolbar),
        spellcheck: bool(o.spellcheck, d.spellcheck),
        scrollSync: bool(o.scrollSync, d.scrollSync),
        focusMode: bool(o.focusMode, d.focusMode),
        liveRender: bool(o.liveRender, d.liveRender),
        typewriterMode: bool(o.typewriterMode, d.typewriterMode),
        rememberPosition: bool(o.rememberPosition, d.rememberPosition),
        mathRender: bool(o.mathRender, d.mathRender),
        mermaidRender: bool(o.mermaidRender, d.mermaidRender),
        foldCode: bool(o.foldCode, d.foldCode),
        foldCodeLines: num(o.foldCodeLines, d.foldCodeLines, 3, 200),
        defaultOutline: bool(o.defaultOutline, d.defaultOutline),
        // ⚠️ 自动保存延迟不能低于 500ms：低于这个值等于「每敲一下就发一次请求」，
        // 写限速会直接开始拒自己的写入（429），用户看到的是「改不动了」。
        autosaveMs: num(o.autosaveMs, d.autosaveMs, 500, 10000),
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
