// src/utils/noteCompletion.ts
// 编辑器自动补全：`[[双链]]` / `#标签` / ```语言``` —— 照 inkstone 的
// `src/client/editor/completion.ts` 搬过来（三个 source 的判据与评分逐行一致）。
//
// 为什么必须有它：写笔记时「想到一半的标题」是全篇最贵的输入 ——
// 手打完整的 `[[某某笔记]]` 容易漏字，一旦写错就变**死链**（点了没反应）；
// `#标签` 同理，打错字会平白多出一个新标签（列表里出现 `工作` 和 `工作1`）。
// 输入中弹出候选被接受后，整件事就从「记住全名」降级成「认出来」。
//
// ⚠️ 三条 sourced 都设 `filter: false`：候选已经由 fuzzyMatch 自己排过序了，
// 再让 CodeMirror 内置过滤过一遍会把没命中子串的候选直接吞掉 ——
// inkstone 同样的写法，别手贱删掉。
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { fuzzyMatch } from "./fuzzy";

/** 补全要的数据。**用 getter 而不是快照**：笔记列表会增删改，传快照会越用越旧 */
export interface CompletionSources {
    notes: () => { id?: number; title: string; excerpt?: string }[];
    tags: () => { name: string; count: number }[];
}

/** 标题比较统一走这里：`[[API]]` 要能命中标题是「api」的那条 */
function normalizeLinkKey(title: string): string {
    return title.trim().toLowerCase();
}

function truncate(text: string, max: number): string {
    // Array.from 而不是 slice：中文/emoji 占两个 UTF-16 单元，slice 会切出半个字
    const chars = Array.from(text.trim());
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** 候选面板最多显示多少条（inkstone 也是 24 / 20 / 全部） */
const MAX_NOTES = 24;
const MAX_TAGS = 20;

/**
 * `[[` 之后：已有笔记标题的模糊补全，外加一条「新建笔记」。
 *
 * 「新建笔记」的 boost 是 **-20**：它只在没有任何标题更像时才排到前面，
 * 否则打一个字就把第一条挤成「新建」，等于逼用户每次都往下找。
 */
export function wikiLinkSource(
    getSources: () => CompletionSources
): (context: CompletionContext) => CompletionResult | null {
    return (context: CompletionContext): CompletionResult | null => {
        const before = context.matchBefore(/\[\[([^[\]\n]*)$/);
        if (!before) return null;
        if (before.from === before.to && !context.explicit) return null;

        const query = before.text.slice(2);
        const options: Completion[] = [];
        const seenTitles = new Set<string>();
        for (const note of getSources().notes()) {
            if (!note.title) continue;
            const titleKey = normalizeLinkKey(note.title);
            if (seenTitles.has(titleKey)) continue;
            seenTitles.add(titleKey);
            const match = query ? fuzzyMatch(note.title, query) : { score: 0, ranges: [] };
            if (!match) continue;
            options.push({
                label: note.title,
                detail: note.excerpt ? truncate(note.excerpt, 34) : undefined,
                boost: match.score / 10,
                apply: (view, _completion, from, to) => {
                    // ⚠️ 必须把右括号一起写上：只写标题的话，用户还得手打 `]]`，
                    // 而补全的意义就在于「一次按键交付完整语法」。光标落在 `]]` 之后。
                    const insert = `${note.title}]]`;
                    view.dispatch({
                        changes: { from, to, insert },
                        selection: { anchor: from + insert.length },
                    });
                },
            });
        }
        // 一个都没命中时给「新建笔记」：才打一半的词往往就是新建笔记的标题
        if (query.trim() && !options.some(o => o.label === query.trim())) {
            const fresh = query.trim();
            options.push({
                label: fresh,
                detail: "新建笔记",
                boost: -20,
                apply: (view, _completion, from, to) => {
                    const insert = `${fresh}]]`;
                    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
                },
            });
        }
        return {
            from: before.from + 2,
            options: options.slice(0, MAX_NOTES),
            filter: false,
            validFor: /^[^[\]\n]*$/,
        };
    };
}

/**
 * `#` 之后：已有标签补全。
 *
 * ⚠️ 必须排除**标题行**（`# 标题`）：行的第一个字符就是 `#`，
 * 不判的话一打标题就弹出标签面板，反而把输入挡住。
 * inkstone 的原句就是 `if (from - 1 === line.from && /^#{1,6}\s/.test(line.text)) return null`。
 */
export function tagSource(
    getSources: () => CompletionSources
): (context: CompletionContext) => CompletionResult | null {
    return (context: CompletionContext): CompletionResult | null => {
        const before = context.matchBefore(
            /(?:^|[\s(（【「『，,、；;])#([\p{L}\p{N}_\-/·]{0,60})$/u
        );
        if (!before) return null;
        const hashIndex = before.text.lastIndexOf("#");
        const from = before.from + hashIndex + 1;
        const query = before.text.slice(hashIndex + 1);
        const line = context.state.doc.lineAt(context.pos);
        if (from - 1 === line.from && /^#{1,6}\s/.test(line.text)) return null;

        const options: Completion[] = [];
        for (const tag of getSources().tags()) {
            // ⚠️ 名字缺失的标签必须在这里拦掉，不能当成候选交出去。
            // CodeMirror 的默认候选渲染里是 `off < label.length`（label 为空时循环不进），
            // label 是 undefined 会直接抛 TypeError —— 而 CM 捕获到插件异常后
            // 会 `destroy()` + `deactivate()`，**整个补全扩展当场下线**，
            // 后面再按 Ctrl-Space 也没反应了。一条脏数据不该废掉整条输入链路。
            const name = typeof tag.name === "string" ? tag.name.trim() : "";
            if (!name) continue;
            // count 同样兜一层：它要是 undefined，detail 会显示「undefined 篇笔记」，
            // boost 会变成 NaN（NaN 参与排序会把候选顺序搅乱）
            const count = typeof tag.count === "number" && Number.isFinite(tag.count) ? tag.count : 0;
            const match = query ? fuzzyMatch(name, query) : { score: count, ranges: [] };
            if (!match) continue;
            options.push({
                label: name,
                detail: `${count} 篇笔记`,
                // 用得多的标签排在前面（最多加 2 分，不至于压过字面匹配）
                boost: match.score / 10 + Math.min(count, 20) / 10,
                type: "keyword",
            });
        }
        if (!options.length) return null;
        return {
            from,
            options: options.slice(0, MAX_TAGS),
            filter: false,
            validFor: /^[\p{L}\p{N}_\-/·]{0,60}$/u,
        };
    };
}

/** ``` 之后能填的语言。与工具栏「代码块语言」下拉同源，不必再到别处维护一份 */
export const FENCE_LANGUAGES = [
    "javascript", "typescript", "tsx", "jsx", "python", "go", "rust", "java", "kotlin", "swift",
    "c", "cpp", "csharp", "php", "ruby", "sql", "bash", "shell", "powershell", "json", "yaml",
    "toml", "xml", "html", "css", "scss", "markdown", "diff", "dockerfile", "nginx", "mermaid",
];

/**
 * 行首 ``` 之后补语言名。
 *
 * ⚠️ 判据是 `^`（**行首**）：围栏必须是行首语法，段落里的 ```只是普通三个反引号，
 * 那里弹候选会让人莫名其妙。
 */
export function codeFenceSource(context: CompletionContext): CompletionResult | null {
    const before = context.matchBefore(/^```([a-zA-Z0-9+#-]*)$/);
    if (!before) return null;
    return {
        from: before.from + 3,
        options: FENCE_LANGUAGES.map(lang => ({ label: lang, type: "type" })),
        validFor: /^[a-zA-Z0-9+#-]*$/,
    };
}
