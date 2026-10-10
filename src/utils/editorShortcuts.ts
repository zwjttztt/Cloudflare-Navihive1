// 编辑器快捷键 —— 照 inkstone 的 `src/client/editor/shortcuts.ts` 设计。
//
// 关键设计（也是这里唯一值得注意的地方）：**一张表同时驱动键盘绑定和 UI 显示**。
// `EDITOR_SHORTCUTS` 里的 `combo` 既喂给 CodeMirror 的 keymap，也被工具栏/tooltip
// 查出来显示在菜单项右侧。用两张表的话，加了快捷键忘了加显示（或者反过来），
// 用户按了没反应、或者菜单上写着一个按了不响的键 —— 这种 bug 极难发现。
//
// 平台差异用 `mod` 抽象：macOS 上是 ⌘，其他平台是 Ctrl。判定一次，全程用它。

/** macOS 判定。inkstone 也有同名常量，两边行为一致。 */
export const IS_MAC =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

export interface EditorShortcut {
    /** 稳定 id，工具栏用 `comboFor(id)` 反查 */
    id: string;
    /**
     * 组合键，语法同 inkstone：`mod` / `shift` / `alt` + 键名。
     *
     * ⚠️ 可选：有些动作**只声明不绑定**（比如「高亮」暂时没找到不打架的键），
     * 工具栏仍要能显示它的名字，只是右侧不画快捷键。`comboFor` 返回
     * `string | undefined` 就是这个缘故 —— 这里要是写成必填，那张表就得
     * 硬塞一个按了不响的键上去，恰好制造出最坑的那类 bug。
     */
    combo?: string;
    /** 中文名，tooltip 用 */
    label: string;
}

/**
 * 全部编辑器快捷键。
 *
 * ⚠️ 标题用 `mod+alt+N` 而不是 `mod+N`：数字键已经被 CodeMirror 自己的
 * `Mod-1..9`（切换标签页等）占着，而且 `mod+alt` 不会误伤浏览器。
 * inkstone 专门写了测试守这条（`leaves tab-number shortcuts alone`）。
 */
export const EDITOR_SHORTCUTS: EditorShortcut[] = [
    { id: "bold", combo: "mod+b", label: "加粗" },
    { id: "italic", combo: "mod+i", label: "斜体" },
    { id: "inline-code", combo: "mod+e", label: "行内代码" },
    { id: "strikethrough", combo: "mod+shift+x", label: "删除线" },
    { id: "highlight", label: "高亮" },
    { id: "link", combo: "mod+k", label: "链接" },
    { id: "comment", combo: "mod+/", label: "隐藏注释" },
    { id: "paragraph", combo: "mod+alt+0", label: "正文" },
    ...[1, 2, 3, 4, 5, 6].map(
        (level): EditorShortcut => ({
            id: `h${level}`,
            combo: `mod+alt+${level}`,
            label: `${level} 级标题`,
        })
    ),
    { id: "bullet-list", combo: "mod+shift+8", label: "无序列表" },
    { id: "ordered-list", combo: "mod+shift+7", label: "有序列表" },
    { id: "task-list", combo: "mod+shift+9", label: "任务列表" },
    { id: "quote", combo: "mod+shift+.", label: "引用" },
    { id: "task-done", combo: "mod+shift+enter", label: "切换任务完成" },
    { id: "move-line-up", combo: "alt+arrowup", label: "上移行" },
    { id: "move-line-down", combo: "alt+arrowdown", label: "下移行" },
    { id: "delete-line", combo: "mod+shift+k", label: "删除行" },
    { id: "indent", combo: "mod+]", label: "缩进" },
    { id: "outdent", combo: "mod+[", label: "取消缩进" },
    { id: "undo", combo: "mod+z", label: "撤销" },
    { id: "redo", combo: IS_MAC ? "mod+shift+z" : "mod+y", label: "重做" },
    { id: "select-next-occurrence", combo: "mod+d", label: "选择下一相同文本" },
    { id: "find", combo: "mod+f", label: "查找 / 替换" },
];

/** 按 id 查快捷键组合；没有就返回 undefined（UI 据此决定「不显示 kbd」） */
export function comboFor(id: string): string | undefined {
    return EDITOR_SHORTCUTS.find(s => s.id === id)?.combo;
}

/**
 * inkstone 语法 → CodeMirror keymap 语法。
 * 例：`mod+shift+x` → `Mod-Shift-x`，`alt+arrowup` → `Alt-ArrowUp`。
 */
export function toCodeMirrorKey(combo: string): string {
    const names: Record<string, string> = {
        mod: "Mod",
        ctrl: "Ctrl",
        alt: "Alt",
        shift: "Shift",
        enter: "Enter",
        escape: "Escape",
        tab: "Tab",
        arrowup: "ArrowUp",
        arrowdown: "ArrowDown",
        arrowleft: "ArrowLeft",
        arrowright: "ArrowRight",
    };
    return combo
        .split("+")
        .map(part => names[part.toLowerCase()] ?? part)
        .join("-");
}

/**
 * 组合键 → 显示用的分段（inkstone 的 `prettyCombo`）。
 * 返回数组而不是字符串，是为了能逐键渲染成独立 `<kbd>`。
 * 例：`mod+shift+x` 在 mac 上是 `["⌘", "⇧", "X"]`，其他平台 `["Ctrl", "Shift", "X"]`。
 */
export function prettyCombo(combo: string, isMac = IS_MAC): string[] {
    return combo.split("+").map(part => {
        switch (part.toLowerCase()) {
            case "mod":
                return isMac ? "⌘" : "Ctrl";
            case "shift":
                return isMac ? "⇧" : "Shift";
            case "alt":
                return isMac ? "⌥" : "Alt";
            case "ctrl":
                return "Ctrl";
            case "enter":
                return "↵";
            case "escape":
            case "esc":
                return "Esc";
            case "tab":
                return "Tab";
            case "delete":
                return "Delete";
            case "backspace":
                return isMac ? "⌫" : "Backspace";
            case "arrowup":
                return "↑";
            case "arrowdown":
                return "↓";
            case "arrowleft":
                return "←";
            case "arrowright":
                return "→";
            case ",":
                return ",";
            case ".":
                return ".";
            case "/":
                return "/";
            default:
                return part.length === 1 ? part.toUpperCase() : part;
        }
    });
}
