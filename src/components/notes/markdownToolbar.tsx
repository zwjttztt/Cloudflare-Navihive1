// src/components/notes/markdownToolbar.tsx
// 记事本的 Markdown 工具栏 + 预览渲染（从 NotesPage.tsx 拆出）。
//
// 为什么拆：NotesPage.tsx 曾有 8595 行，主组件一个函数占 5834 行 ——
// 改一处的影响面不可控、编译与 HMR 变慢、code review 形同虚设
// （inkstone 的最大单文件是 2861 行，我们曾是它的 3 倍）。
// 这一批是「先拆文件、不改逻辑」：两个组件本来就是纯 props 驱动，
// 搬过来只需要补 import，行为零变化。

import { Fragment, useCallback, useEffect, useRef, useState, ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DataObjectIcon from "@mui/icons-material/DataObject";
import AddIcon from "@mui/icons-material/Add";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HorizontalRuleIcon from "@mui/icons-material/HorizontalRule";
import PolylineIcon from "@mui/icons-material/Polyline";
import TranslateIcon from "@mui/icons-material/Translate";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FormatColorTextIcon from "@mui/icons-material/FormatColorText";
import FormatListBulletedIcon from "@mui/icons-material/FormatListBulleted";
import FormatListNumberedIcon from "@mui/icons-material/FormatListNumbered";
import SubjectIcon from "@mui/icons-material/Subject";
import ViewHeadlineIcon from "@mui/icons-material/ViewHeadline";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import type { NoteEmbedTarget } from "../NoteEmbedNode";
import type { TableOp } from "../../hooks/useEditorTools";
import { Kbd } from "../Kbd";
import { comboFor } from "../../utils/editorShortcuts";
import { renderMarkdownToReact, type RenderFeatures } from "../../utils/markdownToReact";
import ChecklistIcon from "@mui/icons-material/Checklist";
import CodeIcon from "@mui/icons-material/Code";
import CalculateIcon from "@mui/icons-material/Calculate";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import ImageIcon from "@mui/icons-material/Image";
import LinkIcon from "@mui/icons-material/Link";
import StrikethroughIcon from "@mui/icons-material/StrikethroughS";
import TableRowsIcon from "@mui/icons-material/TableRows";

export function noteExcerpt(content: string): string {
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    return body
        .replace(/[#>*`_~[\]()!|-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
}

/**
 * Markdown 预览。
 *
 * 渲染是**异步**的：markdown-it 走动态 import（必须 lazy，否则进首屏）。
 * 所以先渲染一个占位，解析完再替换 —— 免得每次输入都闪一下。
 */
export function MarkdownPreview({
    source,
    resolveNote,
    onOpenNote,
    features,
    onToggleTask,
}: {
    source: string;
    /** 笔记嵌入 `![[标题]]` 按标题找目标 */
    resolveNote?: (title: string) => NoteEmbedTarget | null;
    /** 点嵌入标题跳到那篇笔记 */
    onOpenNote?: (title: string) => void;
    /** 预览功能开关（公式 / 图表 / 折叠代码块），来自设置面板 */
    features?: RenderFeatures;
    /** 预览里点任务复选框 → 回写那篇源码（0 基行号）。不传 = 只读 */
    onToggleTask?: (line: number, checked: boolean) => void;
}) {
    const [node, setNode] = useState<ReactNode>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!source) {
            setNode(null);
            return;
        }
        void renderMarkdownToReact(source, { resolveNote, onOpenNote, features, onToggleTask }).then(result => {
            if (cancelled) return;
            setNode(result);
            setReady(true);
        });
        return () => {
            // 输入很快时，旧的解析结果要丢掉，否则会闪回上一版内容
            cancelled = true;
        };
    }, [source, resolveNote, onOpenNote, features, onToggleTask]);

    if (!source) {
        return (
            <Typography variant='body2' color='text.disabled'>
                （空）
            </Typography>
        );
    }
    if (!ready) {
        return (
            <Typography variant='body2' color='text.disabled'>
                解析中…
            </Typography>
        );
    }
    // ⚠️ `overflowWrap: "anywhere"` 不是 `wordBreak: "break-word"`（2026-10-07 用户报
    // 「分栏时右侧内容超出屏幕」）。两者差别就在中文长句上：
    //   break-word  只在**词边界**断行 —— 而中文没有空格，
    //                 于是「## 引用内容引用内容…」这种一整串 CJK 被当成一个超长单词，
    //                 撑到 1000px 宽也不断，直接把预览层顶出屏幕且**没有滚动条**
    //                 （真机 1080 宽复现：预览层 377px，标题被切掉半个字）。
    //   anywhere     必要时在任意字符间断行 —— 正是 inkstone 用的
    //                 （prose.css:429/435/897/960 全是 `overflow-wrap: anywhere`）。
    // 源码区（CodeMirror）早就配了 `overflowWrap: "anywhere"`，只有预览层漏了。
    return (
        <Box sx={{ overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: 1.7 }}>
            {node}
        </Box>
    );
}

/** 一个工具按钮：icon / label 二选一，before/after 是包在选区两侧的语法 */
/** 表格菜单里的常用尺寸：给几个现成的，不逼用户先想行列数 */
const TABLE_PRESETS: { label: string; rows: number; cols: number }[] = [
    { label: "2 行 × 3 列", rows: 2, cols: 3 },
    { label: "3 行 × 4 列", rows: 3, cols: 4 },
    { label: "4 行 × 5 列", rows: 4, cols: 5 },
];

interface ToolSpec {
    key: string;
    icon?: ReactNode;
    label?: string;
    title: string;
    before: string;
    after?: string;
    placeholder?: string;
    /**
     * 对应 `EDITOR_SHORTCUTS` 的 id。有绑定 → tooltip 显示快捷键；
     * 没有（留空）→ 只显示名称，不显示一个按了没反应的键。
     */
    shortcutId?: string;
    /**
     * 这是**行首前缀**（引用 / 列表），不是「在光标处包一段」。
     * 必须走 toggleLinePrefix —— 否则光标停在行尾时前缀会掉在行中间。
     */
    linePrefix?: boolean;
}

/**
 * 工具栏分组：参照 inkstone 收成「强调 | 列表」两段独立图标。
 *
 * ⚠️ `shortcutId` 指向 `EDITOR_SHORTCUTS` 里的条目（不是快捷键字符串本身）。
 * 渲染时用 `comboFor(id)` 反查 —— 这样平台差异（mac ⌘ / 其它 Ctrl）只在一处处理，
 * 加新快捷键时也永远不会出现「菜单上写的和实际按的不一致」。
 */
const TOOL_GROUPS: { name: string; tools: ToolSpec[] }[] = [
    {
        name: "强调",
        tools: [
            {
                key: "bold",
                icon: <FormatBoldIcon fontSize='small' />,
                title: "加粗",
                before: "**",
                after: "**",
                placeholder: "粗体",
                shortcutId: "bold",
            },
            {
                key: "italic",
                icon: <FormatItalicIcon fontSize='small' />,
                title: "斜体",
                before: "*",
                after: "*",
                placeholder: "斜体",
                shortcutId: "italic",
            },
            {
                key: "strike",
                icon: <StrikethroughIcon fontSize='small' />,
                title: "删除线",
                before: "~~",
                after: "~~",
                placeholder: "删除",
                shortcutId: "strikethrough",
            },
            {
                key: "highlight",
                icon: <FormatColorTextIcon fontSize='small' />,
                title: "高亮",
                before: "==",
                after: "==",
                placeholder: "高亮",
            },
            {
                key: "code",
                icon: <CodeIcon fontSize='small' />,
                title: "行内代码",
                before: "`",
                after: "`",
                placeholder: "code",
                shortcutId: "inline-code",
            },
        ],
    },
    {
        name: "列表",
        tools: [
            {
                key: "ul",
                icon: <FormatListBulletedIcon fontSize='small' />,
                title: "无序列表",
                before: "- ",
                placeholder: "列表项",
                shortcutId: "bullet-list",
                linePrefix: true,
            },
            {
                key: "ol",
                icon: <FormatListNumberedIcon fontSize='small' />,
                title: "有序列表",
                before: "1. ",
                placeholder: "列表项",
                shortcutId: "ordered-list",
                linePrefix: true,
            },
            {
                key: "task",
                icon: <ChecklistIcon fontSize='small' />,
                title: "任务列表",
                before: "- [ ] ",
                placeholder: "要做的事",
                shortcutId: "task-list",
                linePrefix: true,
            },
            {
                key: "quote",
                icon: <FormatQuoteIcon fontSize='small' />,
                title: "引用",
                before: "> ",
                placeholder: "引用",
                shortcutId: "quote",
                linePrefix: true,
            },
        ],
    },
];

/**
 * 窄屏（`narrow`）第一行只留这 6 个图标按钮：加粗 / 斜体 / 删除线 + 无序 / 有序 / 任务。
 * 加上「标题层级」「链接」正好 8 个 —— 都是**写字时就地要用**的。
 *
 * 为什么不按整组留：强调组里的「高亮」、列表组里的「引用」都是一天用不了两次的，
 * 留在第一行只会把 390px 的工具栏从 1 行顶成 3 行（P2-1 的原始问题）。
 * 它们收进「插入」下拉后仍是两次点击可达，功能一个不丢。
 */
const NARROW_INLINE_KEYS = new Set(["bold", "italic", "strike", "ul", "ol", "task"]);

/**
 * 代码块语言下拉（阶段四第 12 条）。
 *
 * 预览层（markdown-it）本来就会把 ```js 渲染成 `<code class="language-js">`
 * —— 差的一直只是「怎么把语言标上去」这个入口，所以这里只做选择，不碰渲染。
 * 第一项留空 = 纯文本：不标语言时预览就是普通 <pre>，别逼用户非选一个。
 */
const CODE_LANGUAGES: { label: string; value: string }[] = [
    { label: "纯文本", value: "" },
    { label: "JavaScript", value: "js" },
    { label: "TypeScript", value: "ts" },
    { label: "Python", value: "python" },
    { label: "Bash / Shell", value: "bash" },
    { label: "JSON", value: "json" },
    { label: "HTML", value: "html" },
    { label: "CSS", value: "css" },
    { label: "SQL", value: "sql" },
    { label: "Java", value: "java" },
    { label: "Go", value: "go" },
    { label: "Rust", value: "rust" },
    { label: "C / C++", value: "cpp" },
    { label: "YAML", value: "yaml" },
    { label: "Markdown", value: "markdown" },
    { label: "Mermaid 图表", value: "mermaid" },
    { label: "Diff", value: "diff" },
];

/**
 * 下拉菜单项里「左边名字、右边快捷键」那套排版。
 *
 * ⚠️ 只能走 `sx`，**不能**写 `slotProps={{ root: { style: … } }}` ——
 * MUI v9 的 MenuItem 压根没有 slotProps 这个 prop（它不是 ButtonBase），
 * 写了 tsc -b 直接报 TS2769。之前 10 个菜单项各写一遍，也是同一个错。
 */
const menuRowSx = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
} as const;

/** 标题层级下拉（H1/H2/H3）—— 标题是「行首加前缀」，走另一条路径 */
/**
 * 标题下拉的 7 档（inkstone 的 `setHeading(0..6)`）。
 * `shortcutId` 用来查快捷键显示在菜单项右侧 —— 别在这里硬写 "Ctrl+Alt+2"，
 * 平台差异（mac 是 ⌘）由 editorShortcuts 统一处理。
 */
const HEADING_LEVELS: { level: string; label: string; prefix: string; value: number; shortcutId: string }[] = [
    // ⚠️ 2026-07 文案对齐 inkstone zh-CN：
    //   workspace.paragraph      = "正文"
    //   workspace.heading_value0 = "{value0} 级标题"
    // 之前写的是「正文（去掉标题）」「H1 一级标题」—— 那个 H1 冗余（菜单项在标题组里，
    // 「1 级标题」已经够了），而解释性文案该放 Tooltip 不该占菜单项文字。
    { level: "0", label: "正文", prefix: "", value: 0, shortcutId: "paragraph" },
    { level: "1", label: "1 级标题", prefix: "# ", value: 1, shortcutId: "h1" },
    { level: "2", label: "2 级标题", prefix: "## ", value: 2, shortcutId: "h2" },
    { level: "3", label: "3 级标题", prefix: "### ", value: 3, shortcutId: "h3" },
    { level: "4", label: "4 级标题", prefix: "#### ", value: 4, shortcutId: "h4" },
    { level: "5", label: "5 级标题", prefix: "##### ", value: 5, shortcutId: "h5" },
    { level: "6", label: "6 级标题", prefix: "###### ", value: 6, shortcutId: "h6" },
];

/**
 * Markdown 格式工具栏。
 *
 * 只在「源码」可见时出现 —— 预览模式下没有可编辑的文本，工具栏会让人以为能改。
 * 按钮用 `onMouseDown` 的 preventDefault 保住 textarea 的选区：
 * 默认的 mousedown 会让输入框失焦，selectionStart 就变成了 0，
 * 插入的位置会全跑到开头去。
 */
/**
 * Blob → data URI。
 *
 * 为什么需要：上传接口返回的 URL 走 cookie 鉴权，浏览器 `<img src>` 不会带
 * 我们自己的鉴权流程（它只带同源 cookie，但接口要求的是登录态 cookie ——
 * 同源下其实会带，真正的问题是**图片加载失败时无法区分是 401 还是 404**）。
 * 内嵌成 data URI 后图片成为正文的一部分，离线可读、不需要再发请求。
 * 代价见 pickImage 注释（25MB 上限、只内嵌小图）。
 */
function blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 上传一张图并解析出「最终可内嵌的 url」（N3 复用点）：
 * 小图（≤1MB）fetch 成 data URI 内嵌（离线可读），大图或返回非图片只插链接。
 * 模块级：工具栏「上传图片」按钮和编辑器粘贴/拖拽都走它 —— 同一套逻辑不会跑偏。
 */
export async function resolveImageUpload(
    file: File,
    upload: (file: File, noteId: number | null) => Promise<{ url: string; filename: string; size: number }>,
    noteId: number | null
): Promise<{ url: string; filename: string }> {
    const uploaded = await upload(file, noteId);
    const INLINE_MAX = 1024 * 1024;
    if (file.size <= INLINE_MAX) {
        try {
            const response = await fetch(uploaded.url, { credentials: "same-origin" });
            if (response.ok) {
                const blob = await response.blob();
                // ⚠️ 光看 response.ok 不够（2026-10-07 实测）：200 也可能是
                // 错误页 / SPA 兜底的 index.html。内嵌了它，正文里就是一坨
                // `data:text/html;base64,...`，比裂图还难排查。
                // 不是图片就退回插 URL，让浏览器自己去裂、至少是个正常链接。
                if (blob.type.startsWith("image/")) {
                    return { url: await blobToDataUri(blob), filename: uploaded.filename };
                }
                console.warn("附件地址返回的不是图片，改为插入链接", blob.type);
            }
        } catch {
            // fetch 失败（比如跨域）就退回插原链接
        }
    }
    return { url: uploaded.url, filename: uploaded.filename };
}

export function MarkdownToolbar({
    onInsert,
    onLinePrefix,
    onSetHeading,
    onCodeLanguage,
    onTable,
    onFormula,
    onFootnoteRef,
    onCallout,
    onInsertEmbed,
    onInsertBlockRef,
    onInsertBlockId,
    onInsertFrontMatter,
    onInsertTag,
    onInsertWikiLink,
    onInsertHiddenComment,
    onInsertCopyBlock,
    onNotify,
    activeId,
    onUploadImage,
    onAttachFile,
    canInsert,
    onInsertFold,
    onInsertTabs,
    onInsertDivider,
    narrow,
}: {
    onInsert: (before: string, after: string, placeholder: string) => void;
    /** 行首前缀的开关：引用 `> `、列表 `- `（再点一次摘掉） */
    onLinePrefix: (prefix: string) => void;
    /**
     * 设标题层级 0–6（inkstone 的 `setHeading`）。
     * 与 onLinePrefix 的区别：这个会**先剥掉已有前缀**再设，
     * 所以「二级标题上点一级标题」得到的是一级，不是三级。
     */
    onSetHeading: (level: number) => void;
    /** 阶段四第 12 条：给光标所在的（或新插入的）代码块定语言 */
    onCodeLanguage: (lang: string) => void;
    /** 阶段四第 12 条：表格的插入 / 增删行列 */
    onTable: (op: TableOp) => void;
    /** 阶段四第 12c 条：插入公式（行内 $…$ / 块级 $$…$$） */
    onFormula: (kind: "inline" | "block" | "inlineTex" | "blockTex") => void;
    /**
     * 「链接与引用」：把选中的文字变成脚注引用。
     * 它没法用 onInsert 那套 before/after 表达 —— 脚注要**两处**改动
     * （文末一条定义 + 正文一个引用），所以单开一个回调。
     */
    onFootnoteRef: () => void;
    /** 内容块：插 `> [!类型]` 骨架（inkstone 的「内容块」） */
    onCallout: (type: string) => void;
    /** 笔记嵌入 `![[标题]]`（块级，单独成行） */
    onInsertEmbed: () => void;
    /** 块引用 `![[标题#^块ID]]`（块级，单独成行） */
    onInsertBlockRef: () => void;
    /** 给当前行追加块 ID（` ^abc12`） */
    onInsertBlockId: () => void;
    /** 在笔记最前面插入 YAML 属性块 */
    onInsertFrontMatter: () => void;
    /** 插入标签 `#标签`（行内） */
    onInsertTag: () => void;
    /** 插入双链 `[[标题]]`（行内，可点跳转） */
    onInsertWikiLink: () => void;
    /** 插入隐藏注释 `%%…%%`（预览不显示） */
    onInsertHiddenComment: () => void;
    /** 插入折叠块 `> [!FOLD] 标题` */
    onInsertFold: () => void;
    /** 把选中内容包成可复制块 `> [!COPY]`（渲染后右侧常驻复制按钮） */
    onInsertCopyBlock: () => void;
    /** 插入标签页容器 `:::tabs … :::` */
    onInsertTabs: () => void;
    /** 插入分隔线 `---` */
    onInsertDivider: () => void;
    /** 上传进度 / 失败时提示（与页面同一套通知） */
    onNotify?: (message: string, level: "error" | "success" | "info") => void;
    /** 当前笔记 id（图片挂到这条笔记名下） */
    activeId?: number | null;
    /**
     * 上传一张图，返回可直接取图的 URL。
     *
     * ⚠️ 走**回调**而不是在工具栏里直接 import api：NotesPage 并不持有 api 实例
     * （数据读写都在父组件那一层）。做成回调后单测也能塞一个假的进去，
     * 不用起真实后端。
     */
    onUploadImage: (file: File, noteId: number | null) => Promise<{ url: string; filename: string; size: number }>;
    /**
     * 添加**真附件**（2026-10-18 用户报「工具栏加上添加附件按键可以选择 txt/json」）：
     * 走 notes/attachments 接口进附件管理器，**不插正文**（与「上传图片」插
     * markdown 的路径分开 —— 附件是资源，不是内容）。可选：不传则按钮不渲染
     * （后端没配存储时 uploadApi 不存在）。
     */
    onAttachFile?: (file: File, noteId: number | null) => Promise<void>;
    /**
     * 编辑器是否真的能接住插入（默认 true）。
     *
     * ⚠️ 「预览」模式下编辑器不挂载，insertAtCursor 会**静默 return** ——
     * 图传上去了正文却没变，用户看到的就是「预览窗里没有这张图」
     * （2026-10-08 用户连报两轮「上传后看不见图片」的一条真因）。
     * 主工具栏在预览模式下要传 false：先挡住并说明，别让人白传一次。
     */
    canInsert?: boolean;
    /**
     * 窄屏（手机）模式：第一行只留 8 个高频入口，其余收进「插入」下拉。
     *
     * ⚠️ 只影响**这一排按钮渲染什么**，不影响任何按钮的行为 ——
     * 宽屏（不传 / false）必须是原来那套全量铺开，既有单测和视觉都按那个写的。
     * 断点由调用方算好传进来（NotesEditorPane 的 `bp === "mobile"`），
     * 这里**不再**自己 useMediaQuery：同一件事两个来源，早晚会不一致。
     */
    narrow?: boolean;
}) {
    const canInsertOk = canInsert !== false;
    const [headingAnchor, setHeadingAnchor] = useState<HTMLElement | null>(null);
    const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
    const [imageAnchor, setImageAnchor] = useState<HTMLElement | null>(null);
    const [insertAnchor, setInsertAnchor] = useState<HTMLElement | null>(null);
    /**
     * 窄屏「插入」下拉的锚点。
     * 与上面那个 `insertAnchor`（「笔记工具」菜单）分开：窄屏下「笔记工具」
     * 那颗按钮不渲染，但它的菜单还在（从「插入」里第二次点开），
     * 两个菜单共用同一个 state 就会互相顶掉。
     */
    const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
    const [blockAnchor, setBlockAnchor] = useState<HTMLElement | null>(null);
    const [langAnchor, setLangAnchor] = useState<HTMLElement | null>(null);
    /**
     * 「代码语言」菜单的锚点（2026-07 新增）。
     * 为什么与 `langAnchor` 分开：inkstone 的 code 菜单只有 3 项
     * （代码块 / 增强代码块 / Mermaid），而我们有 17 种语言要选 ——
     * 塞进同一个菜单会变成 19 项，和 inkstone 完全不像。
     * 两个独立按钮 + 两个独立菜单：主按钮管「插什么」，语言按钮管「标什么」。
     */
    const [codeLangAnchor, setCodeLangAnchor] = useState<HTMLElement | null>(null);
    /** 「提示块」二级菜单的锚点（2026-07）：主菜单只 1 项「提示块」，5 种类型在二级里。 */
    const [calloutAnchor, setCalloutAnchor] = useState<HTMLElement | null>(null);
    const [tableAnchor, setTableAnchor] = useState<HTMLElement | null>(null);
    const [formulaAnchor, setFormulaAnchor] = useState<HTMLElement | null>(null);
    /** 隐藏的 `<input type=file>`：点「上传图片」时用它弹系统选择框 */
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    /** 隐藏的 `<input type=file>`：「添加附件」用（txt / json，进附件管理器不插正文） */
    const attachInputRef = useRef<HTMLInputElement | null>(null);
    /** 上传中：禁掉菜单项，避免连点把同一张图传两遍 */
    const [uploading, setUploading] = useState(false);
    /** 附件上传中：同样禁按钮防连点 */
    const [attaching, setAttaching] = useState(false);

    /**
     * 选一张图 → 上传 → 把 Markdown 插进正文。
     *
     * 三步链路上有两个容易踩的点：
     *
     *  1. **上传的是原始 File，不是 base64 / multipart**（见 worker/routes/data.ts
     *     的 handleUploadAttachment）：base64 撑大 33%，而单文件上限就是存储
     *     单条的 25MB，base64 之后必然超。
     *
     *  2. **返回的 url 走鉴权，`<img src>` 不能直接用它**（会 401）。
     *     所以这里把图片 fetch 成 blob、转成 data URI 再插进正文 ——
     *     代价是正文体积变大（图片内嵌），但这是「离线可读」与
     *     「不重复鉴权」换来的；真实部署更该用受保护的 URL + 一次性 token。
     *     ⚠️ 25MB 的图内嵌会让笔记正文膨胀到几十 MB（D1 单行上限 2MB），
     *     所以这里**只内嵌小于 1MB 的图**，更大的只插 URL 链接。
     */
    const pickImage = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    /** 上传 + 解析最终 url（模块级 resolveImageUpload 的组件内绑定） */
    const resolveImageUrl = useCallback(
        (file: File) => resolveImageUpload(file, onUploadImage, activeId ?? null),
        [onUploadImage, activeId]
    );

    /**
     * 「添加附件」：选 txt/json → **真附件**接口（notes/attachments）→
     * 附件管理器可见。与 handleFilePicked（插正文）是两条路：附件是资源，
     * 不是内容 —— 不占正文体积、不进 markdown，管理器里统一看。
     * 成功/失败提示由宿主的 onAttachFile 实现负责（它知道附件列表在哪）。
     */
    const handleAttachPicked = useCallback(
        async (file: File) => {
            if (!onAttachFile) return;
            setAttaching(true);
            try {
                await onAttachFile(file, activeId ?? null);
            } finally {
                setAttaching(false);
            }
        },
        [onAttachFile, activeId]
    );

    const handleFilePicked = useCallback(
        async (file: File) => {
            // ⚠️ 没有编辑器（预览模式）时 insertAtCursor 会**静默 return**：
            // 文件传上去了、正文没变，用户看到的就是「预览窗里什么都没有」。
            // 所以这里先把话说清楚，而不是让它悄悄过去。
            if (!canInsertOk) {
                onNotify?.("预览模式插不进正文：先切回「编辑」或「分栏」再传文件", "error");
                return;
            }
            // 先本地挡一道：与后端 ATTACHMENT_MAX_BYTES 一致（25MB）。
            // 不挡的话要等传完 25MB 才收到 413，用户干等半天还以为卡住了。
            if (file.size > 25 * 1024 * 1024) {
                onNotify?.("这个文件超过 25MB，换一个小一点的再传", "error");
                return;
            }
            // 纯文本（txt/json）插**下载链接**：markdown 图片语法对文本没有意义，
            // `![x](a.txt)` 在预览里只是一张裂开的图。图片仍走 `![]()`。
            const isText = file.type === "text/plain" || file.type === "application/json";
            setUploading(true);
            try {
                const { url, filename } = await resolveImageUrl(file);
                if (isText) {
                    onInsert(`[${filename}](`, ")", url);
                } else {
                    onInsert(`![${filename}](`, ")", url);
                }
                // ⚠️ 必须给一句反馈：之前插入完一点动静都没有，用户在预览里
                // 没立刻找到内容，就以为「上传没生效」（2026-10-08 用户连报两轮）。
                onNotify?.(isText ? `已插入文件「${filename}」（点击可下载）` : `已插入图片「${filename}」`, "success");
            } catch (error) {
                onNotify?.(
                    error instanceof Error ? error.message : "文件上传失败",
                    "error"
                );
            } finally {
                setUploading(false);
            }
        },
        [canInsertOk, onInsert, onNotify, resolveImageUrl]
    );

    /**
     * inkstone 的「菜单 + 主按钮」双态：一半的图标既能直接点（执行主功能），
     * 又带一个小箭头开下拉。之前我们只做了下拉，想插普通链接得点两下；
     * 现在点图标直接插链接、点小箭头才是完整列表。
     */
    const toolBtnSx = {
        width: 28,
        height: 28,
        color: "text.secondary",
        flexShrink: 0,
        "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
    } as const;
    /** 带下拉箭头的按钮：图标 + ChevronDown，整体一个圆角 hover 底 */
    const menuBtnSx = (open: boolean) => ({
        width: 30,
        height: 28,
        minWidth: 0,
        p: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 0.25,
        borderRadius: "var(--notes-radius-chip, 8px)",
        color: "text.secondary",
        ...(open ? { bgcolor: "var(--neutral-hover)", color: "text.primary" } : {}),
        "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
    }) as const;
    /** 分组之间的竖线（inkstone 的 Divider：mx-1、16px 高、1px 宽） */
    const divider = <Divider orientation='vertical' flexItem sx={{ mx: 0.5, my: 0.5 }} />;

    /**
     * 窄屏「插入」下拉里的一项：左图标、右名称。
     *
     * ⚠️ `data-tool` 沿用那颗按钮**原来的键**（table / formula / image…）：
     * 冒烟脚本、a11y 审计、单测都按它定位。收进下拉改的是「入口在哪」，
     * 不是「这个功能叫什么」—— 键名跟着布局变等于把它们全打瞎。
     */
    const insertItem = (tool: string, icon: ReactNode, label: string, action: () => void) => (
        <MenuItem
            key={tool}
            data-tool={tool}
            sx={menuRowSx}
            onClick={() => {
                // 先关菜单再执行：否则窄屏上菜单正好盖住刚插进去的那一行
                setMoreAnchor(null);
                action();
            }}
        >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {icon}
                <span>{label}</span>
            </span>
        </MenuItem>
    );

    return (
        <>
        {/* 隐藏的文件选择框。
            ⚠️ 为什么不用 `display:none` 的 `<input>` 直接放工具栏里：
            它会被 flexWrap 的布局当成第 28 个「按钮」占位（虽然 0 宽，
            但在换行计算里仍占一个 flex item），极端窄栏下会多折一行。
            放在 fragment 里、工具栏外面，布局就不算它。 */}
        <input
            ref={fileInputRef}
            type='file'
            // 2026-10-18 起支持纯文本（txt/json）：图片照旧插 markdown 图片，
            // 文本插下载链接（见 handleFilePicked）
            accept='image/png,image/jpeg,image/gif,image/webp,image/avif,text/plain,.txt,application/json,.json'
            style={{ display: "none" }}
            data-file-input='1'
            onChange={e => {
                const file = e.target.files?.[0];
                // ⚠️ 读完立刻清空 value：否则选同一张图第二次不会触发 change
                e.target.value = "";
                if (file) void handleFilePicked(file);
            }}
        />
        {/* 「添加附件」的隐藏选择框：txt / json（与上传图片分开的一条链路） */}
        <input
            ref={attachInputRef}
            type='file'
            accept='.txt,text/plain,.json,application/json'
            style={{ display: "none" }}
            data-attach-input='1'
            onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file && onAttachFile) void handleAttachPicked(file);
            }}
        />
        <Box
            role='toolbar'
            aria-label='Markdown 格式'
            sx={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 0.25,
                px: 1,
                py: 0.25,
                // ⚠️ 不能定高 + overflowX:auto（2026-10-07 用户报）：分屏时一栏只有
                // 半个屏宽，二十几个按钮塞一行必然溢出 —— overflowX:auto 会连带把
                // overflowY 也变成 auto，横滚动条一出现就把 40px 撑出**竖向滚动**，
                // 工具栏还会盖住标题。改成**换行铺开**：窄栏下自动折成两三行，
                // 高度自适应（编辑器是 flex:1 会自己让空间），永远不出现滚动条。
                // 2026-10-26（P2-1）：手机端不再靠这条兜底 —— `narrow` 下第一行只留
                // 8 个高频入口（约 317px），压根到不了换行那一步；flexWrap 留着是给
                // **宽屏分屏**（半屏仍要能折行）用的，别当成「手机端问题已解决」。
                minHeight: 36,
                flexShrink: 0,
                borderBottom: "1px solid var(--card-border)",
            }}
        >
            {/* ① 标题层级（inkstone 的 heading 菜单）。
                ⚠️ tooltip 一律写「会发生什么」，不写「这是什么」——
                用户看不懂的是**作用**，不是名词（2026-10-07 反馈）。 */}
            <Tooltip title='把这一行变成标题：一级 / 二级 / 三级 / 正文'>
            <Button
                size='small'
                aria-label='标题层级'
                aria-haspopup='menu'
                aria-expanded={headingAnchor ? true : undefined}
                onClick={e => setHeadingAnchor(e.currentTarget)}
                sx={{
                    width: 28,
                    height: 28,
                    minWidth: 0,
                    p: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 0.25,
                    borderRadius: "var(--notes-radius-chip, 8px)",
                    color: "text.secondary",
                    "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
                }}
            >
                <ViewHeadlineIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            <Menu
                open={Boolean(headingAnchor)}
                anchorEl={headingAnchor}
                onClose={() => setHeadingAnchor(null)}
            >
                {HEADING_LEVELS.map(h => (
                    <Fragment key={h.level}>
                        {/* ⚠️ inkstone 的 headingItems 在「正文」之后有一条分隔线
                            （EditorToolbar.tsx:46 `separatorBefore: level === 1`）——
                            「正文」是「去掉标题」，语义上跟 H1~H6 是两类，分开更清楚。 */}
                        {h.level === "1" && <Divider />}
                        <MenuItem
                            data-heading={h.level}
                            sx={menuRowSx}
                            onClick={() => {
                                onSetHeading(h.value);
                                setHeadingAnchor(null);
                            }}
                        >
                            <span>{h.label}</span>
                            <Kbd combo={comboFor(h.shortcutId)} />
                        </MenuItem>
                    </Fragment>
                ))}
            </Menu>

            {divider}

            {/* ⑦ 独立图标组（inkstone 的 ToolButton 群）：强调 → 行内代码 → 列表。
                ⚠️ 2026-10-07 把它从工具栏**末尾**挪到了这里（紧跟标题层级之后），
                对齐 inkstone EditorToolbar.tsx:101-112 的顺序：
                  标题 │ 加粗 斜体 删除线 高亮 行内代码 │ 无序 有序 任务 引用
                之前它在最后面，于是「加粗」这种最高频的按钮排在倒数第二，跟 inkstone 差得最远。
                ⚠️ tooltip 里带上快捷键（inkstone 的 Tooltip 支持 combo），
                这样「这个键是干什么的」不用去记 —— 但**只在真的有绑定时**才显示，
                高亮这类没绑定的就只写名称，不显示一个按了没反应的键。 */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
                {TOOL_GROUPS.map((group, gi) => {
                    // 窄屏只留 NARROW_INLINE_KEYS 那 6 个（两组各剩 3 个）。
                    // ⚠️ 过滤在**渲染时**做，TOOL_GROUPS 本身不动 ——「有哪些工具」
                    // 仍然只有一份定义，加新按钮时不用记两处。
                    const tools = narrow ? group.tools.filter(t => NARROW_INLINE_KEYS.has(t.key)) : group.tools;
                    if (tools.length === 0) return null;
                    return (
                    <Fragment key={group.name}>
                        {gi > 0 && <Divider orientation='vertical' flexItem sx={{ mx: 0.5, my: 0.5 }} />}
                        {tools.map(tool => {
                            const combo = comboFor(tool.shortcutId ?? "");
                            return (
                                <Tooltip
                                    key={tool.key}
                                    title={
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                            <span>{tool.title}</span>
                                            {combo && <Kbd combo={combo} />}
                                        </span>
                                    }
                                >
                                    <IconButton
                                        size='small'
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() =>
                                            tool.linePrefix
                                                ? onLinePrefix(tool.before)
                                                : onInsert(tool.before, tool.after ?? "", tool.placeholder ?? "")
                                        }
                                        data-tool={tool.key}
                                        aria-label={tool.title}
                                        sx={toolBtnSx}
                                    >
                                        {tool.icon ?? tool.label}
                                    </IconButton>
                            </Tooltip>
                            );
                        })}
                    </Fragment>
                    );
                })}
            </Box>

            {divider}

            {/* ② 链接与引用（inkstone 的 reference 菜单）：**图标直接插链接**，
                小箭头才开下拉 —— 想插最常见的普通链接不用点两次。
                data-tool='link' 挂在主按钮上，老的用例按它找按钮不丢。 */}
            {narrow ? (
                /* 窄屏：只留「直接插链接」这一颗 28px 宽的图标。
                   「链接与引用」菜单（双链 / 嵌入 / 块引用 / 脚注）收进「插入」下拉 ——
                   它一天用不了一次，却要额外占掉箭头那 26px（P2-1）。 */
                <Tooltip title='插入网址'>
                    <IconButton
                        size='small'
                        aria-label='链接'
                        data-tool='link'
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => onInsert("[", "](https://)", "链接文字")}
                        sx={toolBtnSx}
                    >
                        <LinkIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            ) : (
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入网址'>
                <IconButton
                    size='small'
                    aria-label='链接'
                    data-tool='link'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("[", "](https://)", "链接文字")}
                    sx={{ ...toolBtnSx, borderRadius: "var(--notes-radius-chip, 8px) 0 0 var(--notes-radius-chip, 8px)" }}
                >
                    <LinkIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='插入网址，或引用另一篇笔记（双链 / 嵌入 / 脚注）'>
                {/* ⚠️ width 从 16 提到 24（2026-10-24）：这是「主按钮 + 下拉箭头」
                    拼接控件的右半，16px 宽时实测 16×28，低于 WCAG 2.5.8 的 24px 底线
                    —— 记事本一进 a11y 审计就报了 3 处（链接与引用 / 插入图片 / 代码与图表）。
                    视觉上箭头区略宽，但拼接形态与圆角拼接都保持不变。 */}
                <IconButton
                    size='small'
                    aria-label='链接与引用'
                    data-tool='link-menu'
                    aria-haspopup='menu'
                    aria-expanded={linkAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setLinkAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 24, borderRadius: "0 var(--notes-radius-chip, 8px) var(--notes-radius-chip, 8px) 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            )}
            <Menu
                open={Boolean(linkAnchor)}
                anchorEl={linkAnchor}
                onClose={() => setLinkAnchor(null)}
            >
                <MenuItem
                    data-link-op='external'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsert("[", "](https://)", "链接文字");
                        setLinkAnchor(null);
                    }}
                >
                    <span>链接</span>
                    <Kbd combo={comboFor("link")} />
                </MenuItem>
                {/* ⚠️ inkstone 的 referenceItems 有两条分隔线（EditorToolbar.tsx:51/54）：
                    `链接` 是「插一个普通链接」，下面三项是「引用到别处的东西」，
                    `脚注` 又是另一类（要同时改文末定义）。分组比说明文字清楚。 */}
                <Divider />
                <MenuItem
                    data-link-op='wikilink'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertWikiLink();
                        setLinkAnchor(null);
                    }}
                >
                    <span>双链</span>
                </MenuItem>
                <MenuItem
                    data-link-op='embed'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertEmbed();
                        setLinkAnchor(null);
                    }}
                >
                    <span>笔记嵌入</span>
                </MenuItem>
                <MenuItem
                    data-link-op='blockref'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertBlockRef();
                        setLinkAnchor(null);
                    }}
                >
                    <span>块引用</span>
                </MenuItem>
                <Divider />
                {/* 脚注要同时改两处（文末定义 + 正文引用），和上面「包一层」不是一回事，
                    所以逻辑上归「引用」而不是「链接」。data-tool 保持不变，老用例能点到。 */}
                {/* 菜单项文字照 inkstone 的短名词（脚注 / 块 ID / 折叠内容…），
                    解释性文案搬进 tooltip —— 既对齐了 inkstone，又不丢可理解性。 */}
                <Tooltip title='把选中的文字变成脚注引用，定义自动放到文末'>
                <MenuItem
                    data-link-op='footnote'
                    data-tool='footnote-ref'
                    sx={menuRowSx}
                    onClick={() => {
                        onFootnoteRef();
                        setLinkAnchor(null);
                    }}
                >
                    <span>脚注</span>
                </MenuItem>
                </Tooltip>
            </Menu>

            {/* ⑧ 窄屏的「插入」：低频入口全部收在这一颗里。
                ⚠️ 上面那些按钮在窄屏下用 `{!narrow && …}` 整块不渲染，但它们的
                **Menu 照旧挂着** —— 下拉里同名的一项只要把 anchor 指过来
                （`setTableAnchor(moreAnchor)`），原来的菜单就原地开出来。
                菜单内容永远只有一份，不会出现「手机上一套、桌面上另一套」。

                宽度账（390 宽的屏，工具栏左右各 px:1 = 16）：
                  标题层级 28 │ 分隔线 1+8 │ 强调 3×28 │ 组内分隔线 1+8 │ 列表 3×28
                  │ 链接 28 │ 分隔线 1+8 │ 插入 28
                合计 28+9+84+9+84+28+9+28 = 279，加组内 6 个 gap(2px) = 12 → 291，
                再加根容器 5 个 gap(2px) = 10 → 301，加左右内边距 16 = **317px**。
                390 宽下 1 行、余量 73px；分屏到 320 也仍是 1 行（余量 3px）。
                再窄会折成 2 行 —— 验收要的就是 ≤2 行，可以接受，但**不要**为此
                退回 overflowX:auto（见根容器那段注释：会连带出竖向滚动条）。 */}
            {narrow && (
                <>
                    <Divider orientation='vertical' flexItem sx={{ mx: 0.5, my: 0.5 }} />
                    <Tooltip title='插入其他格式：代码、表格、公式、图片、内容块…'>
                        <IconButton
                            size='small'
                            aria-label='插入'
                            data-tool='insert-more'
                            aria-haspopup='menu'
                            aria-expanded={moreAnchor ? true : undefined}
                            onMouseDown={e => e.preventDefault()}
                            onClick={e => setMoreAnchor(e.currentTarget)}
                            sx={toolBtnSx}
                        >
                            <AddIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
                    <Menu
                        open={Boolean(moreAnchor)}
                        anchorEl={moreAnchor}
                        onClose={() => setMoreAnchor(null)}
                    >
                        {/* 行内：写字时顺手会用，但比「加粗 / 列表」低频一档 */}
                        {insertItem("code", <CodeIcon sx={{ fontSize: 18 }} />, "行内代码", () => onInsert("`", "`", "code"))}
                        {insertItem("highlight", <FormatColorTextIcon sx={{ fontSize: 18 }} />, "高亮", () => onInsert("==", "==", "高亮"))}
                        {insertItem("quote", <FormatQuoteIcon sx={{ fontSize: 18 }} />, "引用", () => onLinePrefix("> "))}
                        <Divider />
                        {/* 块级：插的是一段结构 */}
                        {insertItem("pre", <DataObjectIcon sx={{ fontSize: 18 }} />, "代码块", () => onInsert("```\n", "\n```", "代码"))}
                        {insertItem("code-menu", <PolylineIcon sx={{ fontSize: 18 }} />, "代码与图表", () => setLangAnchor(moreAnchor))}
                        {insertItem("code-lang-menu", <TranslateIcon sx={{ fontSize: 18 }} />, "代码语言", () => setCodeLangAnchor(moreAnchor))}
                        {insertItem("divider", <HorizontalRuleIcon sx={{ fontSize: 18 }} />, "分隔线", () => onInsertDivider())}
                        <Divider />
                        {/* 对象：插进来的是「东西」而不是语法 */}
                        {insertItem("table", <TableRowsIcon sx={{ fontSize: 18 }} />, "表格", () => setTableAnchor(moreAnchor))}
                        {insertItem("formula", <CalculateIcon sx={{ fontSize: 18 }} />, "公式", () => setFormulaAnchor(moreAnchor))}
                        {insertItem("image", <ImageIcon sx={{ fontSize: 18 }} />, "图片", () => setImageAnchor(moreAnchor))}
                        {onAttachFile && insertItem("attach", <AttachFileIcon sx={{ fontSize: 18 }} />, "添加附件", () => attachInputRef.current?.click())}
                        <Divider />
                        {/* 原本就是下拉的几组：点进去还是原来那个菜单 */}
                        {insertItem("link-menu", <LinkIcon sx={{ fontSize: 18 }} />, "链接与引用", () => setLinkAnchor(moreAnchor))}
                        {insertItem("note", <SubjectIcon sx={{ fontSize: 18 }} />, "笔记工具", () => setInsertAnchor(moreAnchor))}
                        {insertItem("callout", <ViewStreamIcon sx={{ fontSize: 18 }} />, "内容块", () => setBlockAnchor(moreAnchor))}
                        {insertItem("copyblock", <ContentCopyIcon sx={{ fontSize: 18 }} />, "复制块", () => onInsertCopyBlock())}
                    </Menu>
                </>
            )}

            {/* ③ 图片（inkstone 的 image 菜单）：同样是「主按钮 + 箭头」。
                2026-10-08 起本地上传已接上（KV 落地），下面的 Tooltip 别再写
                「还没开放」—— 用户会照着提示以为是坏的（真发生过）。 */}
            {!narrow && (
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入图片：点图标直接传本地图，点箭头选网络图片'>
                <IconButton
                    size='small'
                    aria-label='图片'
                    data-tool='image'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("![", "](https://)", "图片说明")}
                    sx={{ ...toolBtnSx, borderRadius: "var(--notes-radius-chip, 8px) 0 0 var(--notes-radius-chip, 8px)" }}
                >
                    <ImageIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='插入图片菜单：上传图片 / 网络图片'>
                <IconButton
                    size='small'
                    aria-label='插入图片'
                    data-tool='image-menu'
                    aria-haspopup='menu'
                    aria-expanded={imageAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setImageAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 24, borderRadius: "0 var(--notes-radius-chip, 8px) var(--notes-radius-chip, 8px) 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            )}

            {/* 添加附件（2026-10-18 用户报「工具栏上加上添加附件按键可以选择 txt 或 json」）：
                走真附件接口，并由宿主把下载链接插入目标笔记正文。
                没配存储（onAttachFile 缺席）时按钮整个不渲染。
                窄屏同理收进「插入」下拉（见上面 ⑧）。 */}
            {!narrow && onAttachFile && (
                <Tooltip title={canInsertOk ? '添加附件：上传 txt / json 并在笔记中插入下载链接' : '请切换到编辑或分栏模式添加附件'}>
                    <span>
                        <IconButton
                            size='small'
                            aria-label='添加附件'
                            data-tool='attach'
                            disabled={attaching || !canInsertOk}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => attachInputRef.current?.click()}
                            sx={{ ...toolBtnSx }}
                        >
                            <AttachFileIcon fontSize='small' />
                        </IconButton>
                    </span>
                </Tooltip>
            )}
            <Menu
                open={Boolean(imageAnchor)}
                anchorEl={imageAnchor}
                onClose={() => setImageAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:56-59 `imageItems`）：
                    上传图片在前、网络图片在后，且**没有分隔线**。
                    之前我们是「网络图片 → 分隔线 → 上传图片（置灰）」，顺序反了。
                    文案也照 inkstone 的 zh-CN 原文：`上传图片` / `网络图片`。
                    「暂未开放」这类说明搬进 Tooltip，不占菜单项文字。

                    ⚠️ 2026-10-07 后端就绪后**解除置灰**：存储走 KV（R2 未开通，
                    但接口留着 —— 开了只加一条 wrangler 绑定，前端不用动）。 */}
                <Tooltip
                    title={
                        uploading
                            ? '正在上传…'
                            : !canInsertOk
                              ? '预览模式插不进正文：先切回「编辑」或「分栏」再传图'
                              : '从本机选一张图片插进来（≤25MB，PNG / JPEG / GIF / WebP / AVIF）'
                    }
                >
                <MenuItem
                    data-image-op='upload'
                    disabled={uploading || !canInsertOk}
                    onClick={() => {
                        setImageAnchor(null);
                        pickImage();
                    }}
                >
                    上传图片
                </MenuItem>
                </Tooltip>
                <MenuItem
                    data-image-op='url'
                    onClick={() => {
                        onInsert("![", "](https://)", "图片说明");
                        setImageAnchor(null);
                    }}
                >
                    网络图片
                </MenuItem>
            </Menu>

            {!narrow && <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />}

            {/* ④ 笔记工具（inkstone 的 note 菜单）：标签 / 块 ID / 笔记属性 / 隐藏注释。
                从文字按钮「插入」改成图标 + 箭头，和左右两组的视觉重量对齐。
                窄屏收进「插入」下拉，但下面的 Menu 照旧留着（下拉里要用）。 */}
            {!narrow && (
            <Tooltip title='不太常用但有用的语法：标签、块 ID、笔记属性、隐藏注释'>
            <Button
                size='small'
                aria-label='笔记工具'
                data-tool='note'
                aria-haspopup='menu'
                aria-expanded={insertAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setInsertAnchor(e.currentTarget)}
                sx={menuBtnSx(Boolean(insertAnchor))}
            >
                <SubjectIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            )}
            <Menu
                open={Boolean(insertAnchor)}
                anchorEl={insertAnchor}
                onClose={() => setInsertAnchor(null)}
            >
                <Tooltip title='给这篇笔记加一个 #标签，便于检索'>
                <MenuItem
                    data-insert-op='tag'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertTag();
                        setInsertAnchor(null);
                    }}
                >
                    <span>插入标签</span>
                </MenuItem>
                </Tooltip>
                <Tooltip title='给这一段加个锚点（^标识），别处能引用它'>
                <MenuItem
                    data-insert-op='blockid'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertBlockId();
                        setInsertAnchor(null);
                    }}
                >
                    <span>块 ID</span>
                </MenuItem>
                </Tooltip>
                {/* ⚠️ inkstone 的 noteItems 也有两条分隔线（EditorToolbar.tsx:63/64）：
                    标签/块 ID 是「往正文里插东西」，属性是「改整篇笔记的元信息」，
                    隐藏注释又是另一类。 */}
                <Divider />
                <Tooltip title='给整篇笔记加标题、标签等信息（YAML 头部）'>
                <MenuItem
                    data-insert-op='frontmatter'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertFrontMatter();
                        setInsertAnchor(null);
                    }}
                >
                    <span>笔记属性（YAML）</span>
                </MenuItem>
                </Tooltip>
                <Divider />
                <Tooltip title='写给自己看的备注，预览里不显示'>
                <MenuItem
                    data-insert-op='hidden'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertHiddenComment();
                        setInsertAnchor(null);
                    }}
                >
                    <span>隐藏注释</span>
                    <Kbd combo={comboFor("comment")} />
                </MenuItem>
                </Tooltip>
            </Menu>

            {/* ⑤ 内容块（inkstone 的 block 菜单）：提示框 / 折叠 / 标签页 / 分隔线。
                ⚠️ 2026-10-07 删掉了前面那个**文字「块」按钮**：
                它和下面这个图标版都叫 aria-label='块'、都开同一个 blockAnchor 菜单，
                真机上就是两个按钮干同一件事（读屏也会念两遍「块」）。
                inkstone 那边只有图标 + ChevronDown 一个（EditorToolbar.tsx:121）。 */}
            {!narrow && (
            <Tooltip title='成块的语法：提示框、折叠内容、标签页、分隔线'>
            <Button
                size='small'
                aria-label='内容块'
                data-tool='callout'
                aria-haspopup='menu'
                aria-expanded={blockAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setBlockAnchor(e.currentTarget)}
                sx={menuBtnSx(Boolean(blockAnchor))}
            >
                <ViewStreamIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            )}

            {/* 复制块：把选中内容包成 `> [!COPY]`，渲染后块右上角**常驻**一颗复制按钮。
                为什么常驻而不是悬停显形：悬停那版在触屏（含被 nav-touch 判成触屏的
                笔记本）上永远点不到 —— 和「卡片浮层常显」那次踩的是同一个坑。
                为什么不挂在「选中文字右边」：即时渲染是块级的，一行文字在源码里
                没有自己的 DOM 节点，按钮只能挂在渲染出来的块上。 */}
            {!narrow && (
            <Tooltip title='复制块：把选中的内容包成带复制按钮的块'>
            <IconButton
                size='small'
                aria-label='复制块'
                data-tool='copyblock'
                onMouseDown={e => e.preventDefault()}
                onClick={() => onInsertCopyBlock()}
                sx={toolBtnSx}
            >
                <ContentCopyIcon fontSize='small' />
            </IconButton>
            </Tooltip>
            )}
            <Menu
                open={Boolean(blockAnchor)}
                anchorEl={blockAnchor}
                onClose={() => setBlockAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:75-80 `blockItems`）：
                    4 项 —— `提示块` / `折叠内容` / `标签页` /（分隔线）`分隔线`。
                    之前我们有 8 项：5 种提示框（提示/技巧/重要/警告/引用）+ 折叠 + 标签页 + 分隔线。
                    合并成 1 项「提示块」，5 种类型挪到**二级菜单** ——
                    菜单与 inkstone 一致，功能一个不丢。
                    文案也照 zh-CN 原文，说明搬进 Tooltip。 */}
                <MenuItem
                    data-block-op='callout-menu'
                    aria-label='提示块类型'
                    aria-haspopup='menu'
                    onClick={e => {
                        // 停住不让菜单关闭，然后在这项右侧开二级菜单
                        e.stopPropagation();
                        setCalloutAnchor(e.currentTarget);
                    }}
                    sx={{ position: "relative" }}
                >
                    提示块
                </MenuItem>
                {calloutAnchor && (
                    <Menu
                        open
                        anchorEl={calloutAnchor}
                        onClose={() => setCalloutAnchor(null)}
                        anchorOrigin={{ vertical: "center", horizontal: "right" }}
                        transformOrigin={{ vertical: "center", horizontal: "left" }}
                    >
                        {(
                            [
                                ["NOTE", "提示"],
                                ["TIP", "技巧"],
                                ["IMPORTANT", "重要"],
                                ["WARNING", "警告"],
                                ["QUOTE", "引用"],
                            ] as const
                        ).map(([type, label]) => (
                            <MenuItem
                                key={type}
                                data-block-op='callout'
                                data-callout-type={type}
                                onClick={() => {
                                    setCalloutAnchor(null);
                                    setBlockAnchor(null);
                                    onCallout(type);
                                }}
                            >
                                提示框 · {label}
                            </MenuItem>
                        ))}
                    </Menu>
                )}
                <Tooltip title='可点开 / 收起的一段'>
                <MenuItem
                    data-block-op='fold'
                    onClick={() => {
                        onInsertFold();
                        setBlockAnchor(null);
                    }}
                >
                    折叠内容
                </MenuItem>
                </Tooltip>
                <Tooltip title='把几段内容并排放，一页只显示一页'>
                <MenuItem
                    data-block-op='tabs'
                    onClick={() => {
                        onInsertTabs();
                        setBlockAnchor(null);
                    }}
                >
                    标签页
                </MenuItem>
                </Tooltip>
                <Divider />
                <Tooltip title='一条横线，把内容分段'>
                <MenuItem
                    data-block-op='divider'
                    onClick={() => {
                        onInsertDivider();
                        setBlockAnchor(null);
                    }}
                >
                    分隔线
                </MenuItem>
                </Tooltip>
            </Menu>

            {!narrow && divider}

            {/* ⚠️ 引用按钮不在这里 —— 它已经并进下面的 TOOL_GROUPS「列表」组
                （inkstone 也是把引用和无序/有序/任务列表放一组的）。
                之前这里单独放一个，工具栏因此比 inkstone 宽出一截。 */}

            {/* ⑥ 代码与图表（inkstone 的 code 菜单）：**图标直接插代码块**，
                箭头里是 inkstone 那 3 项（代码块 / 增强代码块 / Mermaid 图表）。
                ⚠️ 2026-10-07 菜单名从「代码块语言」改成 inkstone 的 zh-CN 原文
                「代码与图表」—— 原来那个名字是按「这菜单里能选语言」起的，
                拆出独立的语言按钮后它就不贴切了。
                窄屏收进「插入」下拉（Menu 照旧留在下面）。 */}
            {!narrow && (
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入代码块'>
                <IconButton
                    size='small'
                    aria-label='代码块'
                    data-tool='pre'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("```\n", "\n```", "代码")}
                    sx={{ ...toolBtnSx, borderRadius: "var(--notes-radius-chip, 8px) 0 0 var(--notes-radius-chip, 8px)" }}
                >
                    <DataObjectIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='代码与图表：插代码块、画 Mermaid 图'>
                <IconButton
                    size='small'
                    aria-label='代码与图表'
                    data-tool='code-menu'
                    aria-haspopup='menu'
                    aria-expanded={langAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setLangAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 24, borderRadius: "0 var(--notes-radius-chip, 8px) var(--notes-radius-chip, 8px) 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            )}
            <Menu
                open={Boolean(langAnchor)}
                anchorEl={langAnchor}
                onClose={() => setLangAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:66-70 `codeItems`）：菜单只有 3 项
                    —— `代码块` / `增强代码块` / `Mermaid 图表`，且 Mermaid 前有分隔线。
                    之前这里是「代码块 / Mermaid + 17 种语言列表」，语言选择器
                    把这个菜单撑到 19 项，跟 inkstone 差得很远。
                    语言选择器是真实功能（inkstone 没有 —— 它在「增强代码块」里处理），
                    所以**保留但拆成独立的「代码语言」按钮**，不塞进这个菜单。 */}
                <MenuItem
                    data-code-lang='block'
                    onClick={() => {
                        onInsert("```\n", "\n```", "代码");
                        setLangAnchor(null);
                    }}
                >
                    代码块
                </MenuItem>
                <MenuItem
                    data-code-lang='enhanced'
                    onClick={() => {
                        onInsert("```js title=example.js showLineNumbers\n", "\n```", "// 代码");
                        setLangAnchor(null);
                    }}
                >
                    增强代码块
                </MenuItem>
                <Divider />
                <MenuItem
                    data-code-lang='mermaid'
                    onClick={() => {
                        onInsert("```mermaid\n", "\n```", "flowchart LR\n  A --> B");
                        setLangAnchor(null);
                    }}
                >
                    Mermaid 图表
                </MenuItem>
            </Menu>

            {/* 代码语言（inkstone 没有这个入口，我们保留 —— 标语言是真需求）。
                独立成一个按钮，避免把上面那个菜单撑成 19 项。窄屏收进「插入」。 */}
            {!narrow && (
            <Tooltip title='给已有的代码块标语言（js / python / sql…）'>
            <IconButton
                size='small'
                aria-label='代码语言'
                data-tool='code-lang-menu'
                aria-haspopup='menu'
                aria-expanded={codeLangAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setCodeLangAnchor(e.currentTarget)}
                sx={{ ...toolBtnSx }}
            >
                <CodeIcon fontSize='small' />
            </IconButton>
            </Tooltip>
            )}
            <Menu
                open={Boolean(codeLangAnchor)}
                anchorEl={codeLangAnchor}
                onClose={() => setCodeLangAnchor(null)}
            >
                {CODE_LANGUAGES.map(item => (
                    <MenuItem
                        key={item.label}
                        data-code-lang={item.value || "plain"}
                        onClick={() => {
                            onCodeLanguage(item.value);
                            setCodeLangAnchor(null);
                        }}
                    >
                        {item.label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 公式下拉（窄屏收进「插入」，Menu 照旧留着） */}
            {!narrow && (
            <Tooltip title='插入公式：行内 $…$ 或单独一段的 $$…$$'>
                <IconButton
                    size='small'
                    aria-label='公式'
                    data-tool='formula'
                    aria-haspopup='menu'
                    aria-expanded={formulaAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setFormulaAnchor(e.currentTarget)}
                    sx={{
                        width: 28,
                        height: 28,
                        color: "text.secondary",
                        "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
                    }}
                >
                    <CalculateIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            )}
            <Menu
                open={Boolean(formulaAnchor)}
                anchorEl={formulaAnchor}
                onClose={() => setFormulaAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:71-74 `mathItems`）：只有两项
                    —— `行内公式` / `块级公式`。之前我们有 4 项，多出来的
                    `行内公式 \( … \)` / `独立公式 \[ … \]` 是 KaTeX 的第二套分隔符，
                    inkstone 不用（它只用 $…$ / $$…$$）。删掉以保持菜单一致。 */}
                <MenuItem
                    data-formula-op='inline'
                    onClick={() => {
                        onFormula("inline");
                        setFormulaAnchor(null);
                    }}
                >
                    行内公式
                </MenuItem>
                <MenuItem
                    data-formula-op='block'
                    onClick={() => {
                        onFormula("block");
                        setFormulaAnchor(null);
                    }}
                >
                    块级公式
                </MenuItem>
            </Menu>

            {/* 表格下拉（窄屏收进「插入」，Menu 照旧留着） */}
            {!narrow && (
            <Tooltip title='插入表格，或给已有表格增删行列'>
                <IconButton
                    size='small'
                    aria-label='表格'
                    data-tool='table'
                    aria-haspopup='menu'
                    aria-expanded={tableAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setTableAnchor(e.currentTarget)}
                    sx={{
                        width: 28,
                        height: 28,
                        color: "text.secondary",
                        "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
                    }}
                >
                    <TableRowsIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            )}
            <Menu
                open={Boolean(tableAnchor)}
                anchorEl={tableAnchor}
                onClose={() => setTableAnchor(null)}
            >
                {TABLE_PRESETS.map(p => (
                    <MenuItem
                        key={p.label}
                        data-table-preset={p.rows + "x" + p.cols}
                        onClick={() => {
                            onTable({ kind: "insert", rows: p.rows, cols: p.cols });
                            setTableAnchor(null);
                        }}
                    >
                        插入 {p.label}
                    </MenuItem>
                ))}
                <Divider />
                <MenuItem
                    data-table-op='addRow'
                    onClick={() => {
                        onTable({ kind: "addRow" });
                        setTableAnchor(null);
                    }}
                >
                    在下方插入一行
                </MenuItem>
                <MenuItem
                    data-table-op='delRow'
                    onClick={() => {
                        onTable({ kind: "delRow" });
                        setTableAnchor(null);
                    }}
                >
                    删除当前行
                </MenuItem>
                <MenuItem
                    data-table-op='addCol'
                    onClick={() => {
                        onTable({ kind: "addCol" });
                        setTableAnchor(null);
                    }}
                >
                    在右侧插入一列
                </MenuItem>
                <MenuItem
                    data-table-op='delCol'
                    onClick={() => {
                        onTable({ kind: "delCol" });
                        setTableAnchor(null);
                    }}
                >
                    删除当前列
                </MenuItem>
            </Menu>

        </Box>
        </>
    );
}
