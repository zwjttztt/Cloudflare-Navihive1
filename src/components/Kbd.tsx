// 快捷键提示（inkstone 的 `Kbd`，src/client/components/primitives.tsx）。
//
// 用**真正的 `<kbd>` 标签**而不是自定义 div：读屏软件会念它，用户也能选中复制。
// 逐键渲染成一个个小方块（而不是拼成 "Ctrl+Shift+X" 一串），
// 是因为多键组合拼成一行在窄菜单里会换行，方块不会。
import { prettyCombo } from "../utils/editorShortcuts";

export function Kbd({ combo, keys }: { combo?: string; keys?: string[] }) {
    const parts = keys ?? (combo ? prettyCombo(combo) : []);
    if (parts.length === 0) return null;
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            {parts.map((key, i) => (
                <kbd
                    key={`${key}-${i}`}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        height: 18,
                        minWidth: 18,
                        padding: "0 5px",
                        borderRadius: 5,
                        border: "1px solid var(--border-default)",
                        background: "var(--surface-raised)",
                        color: "var(--text-muted)",
                        fontSize: 10.5,
                        fontWeight: 500,
                        lineHeight: 1,
                        fontFamily: "inherit",
                    }}
                >
                    {key}
                </kbd>
            ))}
        </span>
    );
}
