// src/components/dndA11y.ts
// dnd-kit 的中文无障碍播报配置（屏幕阅读器指令 + 拖拽过程播报）。
//
// 之前三个 DndContext（GroupCard 一个、SiteListBody 两个）都没配 accessibility，
// 拖拽对读屏用户完全静默。这里集中一套中文播报，大家共用 `dndAccessibility(items)`：
// `items` 是当前上下文里可拖拽条目的「id → 中文名」映射，播报时靠 `labelOf`
// 把拖拽中的 id 翻成「某某网站 / 某某分组」，而不是一堆 `site-123` 这样的机器串。
import type {
    Announcements,
    Active,
    Over,
    ScreenReaderInstructions,
    UniqueIdentifier,
} from "@dnd-kit/core";

/** 可拖拽条目的「id → 中文标签」映射；id 必须与 dnd-kit 里用的 id 完全一致。 */
export interface DndLabelItem {
    id: UniqueIdentifier;
    label: string;
}

/**
 * 把拖拽 / 放置目标的 id 翻成中文标签。
 * 找不到（例如分组投放区 `group-xxx`）就退回 id 本身，保证播报永远有内容。
 */
export function labelOf(
    items: readonly DndLabelItem[],
    id: UniqueIdentifier | null | undefined
): string {
    if (id == null) return "项目";
    const found = items.find(item => item.id === id);
    return found ? found.label : String(id);
}

/**
 * 构造一份中文的 dnd-kit accessibility 配置。
 * @param items 当前上下文里所有可拖拽条目的 id → 中文标签
 */
export function dndAccessibility(items: readonly DndLabelItem[]): {
    screenReaderInstructions: ScreenReaderInstructions;
    announcements: Announcements;
} {
    const label = (id: UniqueIdentifier | null | undefined) => labelOf(items, id);

    const announcements: Announcements = {
        onDragStart({ active }: { active: Active }) {
            return `已拾起 ${label(active.id)}，使用方向键移动，空格或回车放下，按 Esc 取消。`;
        },
        onDragOver({ active, over }: { active: Active; over: Over | null }) {
            if (over) {
                return `${label(active.id)} 正移动到 ${label(over.id)} 的位置。`;
            }
            return `${label(active.id)} 正在被拖动。`;
        },
        onDragEnd({ active, over }: { active: Active; over: Over | null }) {
            if (over) {
                return `${label(active.id)} 已放置到 ${label(over.id)} 的位置。`;
            }
            return `${label(active.id)} 已放下。`;
        },
        onDragCancel({ active }: { active: Active }) {
            return `已取消拖动 ${label(active.id)}。`;
        },
    };

    const screenReaderInstructions: ScreenReaderInstructions = {
        draggable:
            "要拖动项目，请按空格键或回车键将其拾起，使用方向键移动，再次按空格键或回车键放下，按 Esc 键取消。",
    };

    return { screenReaderInstructions, announcements };
}
