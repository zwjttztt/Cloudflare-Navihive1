// src/components/notes/sidebarSection.tsx
// 记事本左栏的「导航」区块（第二批拆分，从 NotesPage.tsx 原文搬出，逻辑零改动）：
// NavRow（导航行）、FolderTagSection（文件夹/标签树 + 菜单）、
// 以及它们共用的标签工具（tagOf/tagNamesOf）与右键菜单锚点（MenuAnchor/anchorAtMouse）。
//
// 这些全是纯 props 驱动的组件，留在主文件只会撑行数 —— 拆出后 NotesPage 少约 800 行。

import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PopoverVirtualElement } from "@mui/material/Popover";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { isFolderColor, FOLDER_ICONS } from "../../utils/folderAppearance";
import type { Note, NoteTag } from "../../API/http";
/** 「这条笔记挂了哪些标签」。模块级常量，避免每次渲染新造一个 {} 让依赖失效 */
export const EMPTY_TAG_LINKS: Record<number, number[]> = {};

/** 某个笔记的标签Id集合。空的也返回空集合（不是 undefined）—— 列表里要无条件渲染 */
export function tagOf(note: Note, links: Record<number, number[]>): Set<number> {
    return new Set(links[note.id ?? 0] || []);
}

/** 某条笔记的标签**名字**列表（列表徽章 / 菜单里都要显示名字，不是 id） */
export function tagNamesOf(
    note: Note,
    links: Record<number, number[]>,
    allTags: NoteTag[]
): string[] {
    const ids = tagOf(note, links);
    if (ids.size === 0) return [];
    return allTags.filter(t => typeof t.id === "number" && ids.has(t.id!)).map(t => t.name);
}

/**
 * 左栏第一列里的一行导航（inkstone 的调子：名字靠左、条数靠右、选中整行变底色）。
 *
 * 刻意用**真 <button>**（Box component='button'）而不是 div + role='button'：
 * 原生 button 自带 Enter / 空格激活、焦点环、可访问名，一套都齐，
 * 不用自己补 tabIndex + onKeyDown（之前那两个手写补法漏过一次焦点规则）。
 * 样式上要按 button 默认值逐个压掉（背景 / 边框 / 字体 / 内边距 / 文本对齐），
 * 否则它在 128px 的窄列里会鼓成一块方砖。
 */
export function NavRow({
    label,
    count,
    selected,
    onClick,
    /** 可选的行首小图标（文件夹外观用）；不给就不渲染，保持原有两列排版 */
    icon,
    iconColor,
    ...rest
}: {
    label: string;
    count: number;
    selected: boolean;
    onClick: () => void;
    icon?: ReactNode;
    iconColor?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <Box
            component='button'
            type='button'
            onClick={onClick}
            // 「界面密度：紧凑」靠这个类名收紧上下留白（规则在 index.css）
            className='note-dense-row'
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 1.25,
                py: 0.45,
                width: "100%",
                borderRadius: 1.25,
                cursor: "pointer",
                minWidth: 0,
                // ---- 把 <button> 的默认外观压回「一张透明的行」----
                appearance: "none",
                border: "none",
                m: 0,
                font: "inherit",
                textAlign: "left",
                // inkstone 的选中态是「淡淡的强调色底」：比灰色底多一层「这是你正在看的」的指向
                bgcolor: selected ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
                color: selected ? "text.primary" : "text.secondary",
                transition: "background-color 120ms ease",
                "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                "&:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: 1 },
            }}
            {...rest}
        >
            {icon && (
                <Box
                    component='span'
                    aria-hidden
                    sx={{ display: "inline-flex", flexShrink: 0, color: iconColor ?? "inherit" }}
                >
                    {icon}
                </Box>
            )}
            <Typography
                variant='body2'
                sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: selected ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {label}
            </Typography>
            <Typography
                variant='caption'
                sx={{ fontSize: 11, color: "text.disabled", flexShrink: 0 }}
            >
                {count > 0 ? count : ""}
            </Typography>
        </Box>
    );
}

/**
 * 导航列里「文件夹 / 标签」这样一节：一个小节标题（右边跟一个 + 新建）＋ 若干条目。
 *
 * 条目自带 hover 菜单（重命名 / 删除）：128px 宽的列里塞不下按钮，
 * 所以把操作折进 hover 出现的 ⋯ 里。
 */

/**
 * `maybeChildId` 是不是 `ancestorId` 的后代（任意深度）。
 *
 * 拖文件夹进子文件夹会造出环（父的父变成子），后端会拒 —— 但界面先拦一道：
 * 让用户拖了半天再弹一个错，体验上等于「功能坏了」。
 * 数据里已有环时（脏数据）也不会死循环：seen 集合兜住。
 */
export function isDescendant(
    items: readonly { id: number; parent_id?: number | null }[],
    ancestorId: number,
    maybeChildId: number
): boolean {
    const byId = new Map(items.map(i => [i.id, i.parent_id ?? null]));
    const seen = new Set<number>();
    let cursor = byId.get(maybeChildId) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
        if (cursor === ancestorId) return true;
        seen.add(cursor);
        cursor = byId.get(cursor) ?? null;
    }
    return false;
}

/**
 * 右键菜单的锚点：要么是「⋯」按钮本身（左键点按钮开的菜单），要么是
 * **鼠标坐标**造出来的虚拟元素（MUI Popover 支持任何带 getBoundingClientRect
 * 的对象，见 @mui/material/Popover 的 PopoverVirtualElement）。
 *
 * ⚠️ 为什么右键要用虚拟锚点（2026-10-07 用户报的两条一起修）：
 *  - 右键弹窗「都在固定位置」：原来锚的是整行元素，MUI 默认锚到它的左上角 ——
 *    行有多长、列表滚到哪，菜单就钉死在哪，跟鼠标没关系；
 *  - 左栏内联笔记右键「点其他地方才出现、还错位」：整行 button 是 100% 宽，
 *    右键点在行中下部，菜单却出现在行顶 —— 视觉上就是「错位」；而行在
 *    状态更新后重渲染，锚点元素可能被 React 换掉，菜单一度拿不到位置。
 *    虚拟元素不受渲染影响，坐标即点即所得。
 */
export type MenuAnchor = HTMLElement | PopoverVirtualElement;

/** 用鼠标坐标构造一个 0×0 的虚拟锚点（菜单左上角 = 指针位置） */

export function anchorAtMouse(x: number, y: number): PopoverVirtualElement {
    return {
        nodeType: 1,
        getBoundingClientRect: () =>
            ({
                x,
                y,
                left: x,
                top: y,
                right: x,
                bottom: y,
                width: 0,
                height: 0,
                toJSON: () => ({}),
            }) as DOMRect,
    };
}

export function FolderTagSection({
    title,
    items,
    selectedId,
    onSelect,
    onCreate,
    onCreateNote,
    onAskRename,
    onAskRemove,
    onAskColor,
    onCreateChild,
    onMove,
    onDropNote,
    childrenOf,
    activeNoteId,
    onOpenNote,
    onCreateNoteIn,
    onReorder,
    onAppearance,
    unfiledNotes,
    onNoteContext,
}: {
    title: string;
    items: {
        id: number;
        name: string;
        count: number;
        parent_id?: number | null;
        /** 文件夹外观（icon 名 / 颜色）—— 只有文件夹节会传 */
        icon?: string | null;
        color?: string | null;
    }[];
    onCreateChild?: (id: number) => void;
    onMove?: (id: number, parentId: number | null) => void;
    onDropNote?: (noteId: number, folderId: number) => void;
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onCreate: () => void;
    /**
     * 只有「文件夹」这一节传：把「新建笔记」挪到左栏文件夹标题右侧，
     * 和「新建文件夹」并排（参考 inkstone 布局），顶栏那个原位按钮就去掉了。
     */
    onCreateNote?: () => void;
    /**
     * 「重命名 / 删除」交给上层弹窗处理。
     * 之前这个组件内部直接调 window.prompt / window.confirm ——
     * 样式突兀，且部分 WebView 直接拦掉（点了没反应）。
     * 传 undefined 时菜单里就不给这两项（老部署的兜底）。
     */
    onAskRename?: (id: number, currentName: string) => void;
    onAskRemove?: (id: number, name: string) => void;
    /** 标签颜色：打开 TagColorDialog。只给「标签」节传 */
    onAskColor?: (id: number) => void;
    /**
     * inkstone 的文件夹树：**笔记直接长在文件夹下面**，选中文件夹时中间那栏不出现。
     * 只给「文件夹」这一节传；标签节不传（标签是交叉维度，没有父子归属）。
     *
     * @param folderId 要展开的那个文件夹
     * @returns 该文件夹下的笔记（已按更新时间排好序）
     */
    childrenOf?: (folderId: number) => { id: number; title: string }[];
    /** 当前打开的笔记：内联那几条里要给它高亮 */
    activeNoteId?: number | null;
    /** 点内联笔记 → 打开它（有未保存改动时上层会先存） */
    onOpenNote?: (id: number) => void;
    /** 在这个文件夹**里面**新建笔记（inkstone 菜单里的「在此新建笔记」） */
    onCreateNoteIn?: (folderId: number) => void;
    /** 同级内前后挪一位（inkstone 的「向前/向后移动」） */
    onReorder?: (folderId: number, dir: -1 | 1) => void;
    /** 文件夹外观：打开图标/颜色选择弹窗 */
    onAppearance?: (folderId: number) => void;
    /**
     * 未归入任何文件夹的笔记（inkstone：直接列在文件夹树下）。
     * 只给「文件夹」节传；标签节没有归属概念。
     */
    unfiledNotes?: { id: number; title: string }[];
    /** 内联笔记（选中文件夹的 + 未归类的）右键菜单：交给上层统一弹。
     *  锚点用 MenuAnchor（右键=鼠标坐标虚拟元素，⋯按钮=元素本身）。 */
    onNoteContext?: (noteId: number, anchor: MenuAnchor) => void;
}) {
    const [menuId, setMenuId] = useState<number | null>(null);
    /** 「移动到…」二级菜单：要移动谁 + 锚点 */
    const [moveId, setMoveId] = useState<number | null>(null);
    const [moveAnchor, setMoveAnchor] = useState<MenuAnchor | null>(null);
    /**
     * 拖放反馈的两个状态（2026-10-06 补，之前完全没有）：
     *  - dragging 谁：拖起的那一行半透明，用户知道手上抓的是哪个
     *  - dropTarget 哪一行：可放置的目标行高亮，否则用户不知道能不能放、放在哪
     * 之前 `onDragOver` 只设了个 `dropEffect`，真机量下来目标行**样式毫无变化**，
     * 体验上等同于「拖了没反应」。
     */
    const [dragging, setDragging] = useState<number | null>(null);
    const [dropTarget, setDropTarget] = useState<number | null>(null);
    /** 拖拽结束后统一清理：dragend 在**源元素**上，drop 未必触发（拖到框外松手） */
    const endDrag = () => {
        setDragging(null);
        setDropTarget(null);
    };
    /**
     * 菜单锚点：**必须**是那个「⋯」按钮本身。
     * 之前这里是 `anchorEl={undefined}`，MUI 拿不到锚点就退化成锚到视口原点 ——
     * 真机实测菜单落在 `x:16 y:724`（屏幕左下角），而点击点在左栏上部，
     * 四个菜单项全都不在鼠标附近，用户只会以为「点击没反应」。
     * ⚠️ 这类错位 jsdom 测不出来（没有布局，getBoundingClientRect 全 0），
     * 所以 DOM 用例只能断言「菜单能打开」，位置必须真机量坐标。
     */
    const [anchorEl, setAnchorEl] = useState<MenuAnchor | null>(null);
    const treeItems = useMemo(() => {
        const output: (typeof items[number] & { depth: number })[] = [];
        const visited = new Set<number>();
        const visit = (item: typeof items[number], depth: number) => {
            if (visited.has(item.id)) return;
            visited.add(item.id);
            output.push({ ...item, depth });
            items.filter(child => child.parent_id === item.id).forEach(child => visit(child, depth + 1));
        };
        items.filter(item => !item.parent_id || !items.some(p => p.id === item.parent_id)).forEach(item => visit(item, 0));
        items.forEach(item => visit(item, 0));
        return output;
    }, [items]);
    return (
        <Box sx={{ px: 0.75, pb: 1 }}>
            <Box
                sx={{ display: "flex", alignItems: "center", px: 0.5, pb: 0.5, pt: 0.5 }}
            >
                <Typography variant='caption' sx={{ flex: 1, fontSize: 11, color: "text.disabled" }}>
                    {title}
                </Typography>
                <Tooltip title={`新建${title}`}>
                    <IconButton size='small' aria-label={`新建${title}`} onClick={onCreate} sx={{ p: 0.25 }}>
                        <AddIcon fontSize='inherit' />
                    </IconButton>
                    </Tooltip>
                {onCreateNote && (
                    <Tooltip title='新建笔记'>
                        <IconButton
                            size='small'
                            aria-label='新建笔记'
                            onClick={onCreateNote}
                            sx={{ p: 0.25 }}
                        >
                            <NoteAddIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                )}
            </Box>
            {treeItems.map(item => (
                <Box
                    key={item.id}
                    data-folder-depth={item.depth}
                    data-drop-active={dropTarget === item.id ? '1' : undefined}
                    data-dragging={dragging === item.id ? '1' : undefined}
                    sx={{
                        position: "relative",
                        // 层级缩进：1 级 10px 往后递增；超过 6 级封顶（再深也分不出层级了），
                        // 配合 data-folder-depth 供真机/测试判定。
                        pl: Math.min(item.depth, 6) * 10,
                        borderRadius: 1,
                        // 拖动中的目标行高亮 —— 这是「能不能放」的唯一直观信号
                        bgcolor:
                            dropTarget === item.id
                                ? "rgba(128,128,128,0.18)"
                                : "transparent",
                        outline: dropTarget === item.id ? "1px dashed var(--accent)" : "none",
                        outlineOffset: -1,
                        transition: "background-color 100ms ease",
                        opacity: dragging === item.id ? 0.45 : 1,
                    }}
                    onDragOver={onMove || onDropNote ? e => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        // dragover 会以很高的频率反复触发（鼠标一动就来一次），
                        // 同一个目标就别再 setState 了，否则整棵列表跟着重渲染。
                        if (dropTarget !== item.id) setDropTarget(item.id);
                    } : undefined}
                    onDragLeave={onMove || onDropNote ? () => {
                        // 只有「确实要离开这一行」才清：relatedTarget 在行内移动时
                        // 也会触发 dragleave，不判一下高亮会一直闪。
                        setDropTarget(cur => (cur === item.id ? null : cur));
                    } : undefined}
                    onDrop={onMove || onDropNote ? e => {
                        e.preventDefault(); e.stopPropagation();
                        const folder = Number(e.dataTransfer.getData("application/navihive-folder"));
                        const note = Number(e.dataTransfer.getData("application/navihive-note"));
                        endDrag();
                        // 不能把文件夹拖进它自己或自己的子文件夹 —— 后端会拒，
                        // 但界面先拦一道更省事（也避免「拖了半天弹个错」）。
                        if (folder > 0) {
                            if (folder !== item.id && !isDescendant(items, item.id, folder)) {
                                onMove?.(folder, item.id);
                            }
                        } else if (note > 0) {
                            onDropNote?.(note, item.id);
                        }
                    } : undefined}>
                    <NavRow
                        label={item.name}
                        count={item.count}
                        selected={selectedId === item.id}
                        // 给一个稳定的测试抓手：文件夹视图的筛选用例和未来的 e2e 都靠它定位，
                        // 别去按文字找（名字是用户自己起的，随时会变）
                        data-folder-id={item.id}
                        // 文件夹/标签外观：
                        //   文件夹 → 按存的 icon 名找组件（查不到就用「默认」那枚）
                        //   标签   → 画一枚米粒大的实心圆点；没设色就什么都不画
                        // 颜色不在调色板里就按默认画（脏数据不该把左栏画崩）
                        icon={
                            item.icon !== undefined
                                ? (() => {
                                      const spec =
                                          FOLDER_ICONS.find(i => i.key === (item.icon || "")) ??
                                          FOLDER_ICONS[0];
                                      const Icon = spec.icon;
                                      return <Icon fontSize='inherit' sx={{ fontSize: 14 }} />;
                                  })()
                                : item.color
                                  ? <Box data-tag-dot={item.color} sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: item.color }} />
                                  : undefined
                        }
                        iconColor={
                            isFolderColor(item.color)
                                ? item.color
                                : selectedId === item.id
                                  ? "var(--accent)"
                                  : "text.disabled"
                        }
                        draggable={Boolean(onMove)}
                        onDragStart={onMove ? e => {
                            e.dataTransfer.setData("application/navihive-folder", String(item.id));
                            e.dataTransfer.effectAllowed = "move";
                            setDragging(item.id);
                        } : undefined}
                        onDragEnd={onMove ? endDrag : undefined}
                        onClick={() => onSelect(selectedId === item.id ? null : item.id)}
                        onContextMenu={e => {
                            // 右键文件夹 = 直接开它的操作菜单（inkstone 同样支持右键）。
                            // ⚠️ 锚在鼠标处：锚到整行左上角的话，菜单位置与指针无关（用户报「固定位置」）。
                            e.preventDefault();
                            // 同列表行：右键后别让行一直留着焦点（否则「⋯」常驻成一颗白点）
                            (e.currentTarget as HTMLElement).blur();
                            setMenuId(item.id);
                            setAnchorEl(anchorAtMouse(e.clientX, e.clientY));
                        }}
                    />
                    <IconButton
                        size='small'
                        aria-label={`${item.name} 操作`}
                        onClick={e => {
                            setMenuId(item.id);
                            setAnchorEl(e.currentTarget);
                        }}
                        sx={{
                            position: "absolute",
                            right: 2,
                            top: "50%",
                            mt: "-14px",
                            p: 0.25,
                            opacity: 0,
                            // ⚠️ 不能写死 background.paper：页面背景色（暖白/纯白）是算出来的，
                            // 写死就会在暖白底上留一个纯白方块（用户报「颜色不会变」）。
                            bgcolor: "transparent",
                            "&:hover": { opacity: 1, bgcolor: "background.paper" },
                            // 触屏没有 hover：直接常显，否则在那边根本点不到
                            "@media (hover: none)": { opacity: 1 },
                        }}
                    >
                        <MoreVertIcon fontSize='inherit' />
                    </IconButton>
                </Box>
            ))}
            {/* 选中的文件夹把它的笔记直接列在下面（inkstone 的文件夹树）。
                ⚠️ 只展开**当前选中**的那一个：全展开的话左栏会被几十条笔记撑爆，
                而用户点开文件夹的目的就是「我要看这一份」。 */}
            {childrenOf &&
                selectedId !== null &&
                (() => {
                    const kids = childrenOf(selectedId);
                    if (kids.length === 0) return null;
                    const depth =
                        treeItems.find(i => i.id === selectedId)?.depth ?? 0;
                    return (
                        <Box data-folder-notes='1' sx={{ pb: 0.5 }}>
                            {kids.map(n => (
                                <Box
                                    key={n.id}
                                    component='button'
                                    type='button'
                                    data-folder-note={n.id}
                                    className='note-dense-row'
                                    aria-label={`打开笔记 ${n.title || "无标题"}`}
                                    onClick={() => onOpenNote?.(n.id)}
                                    onContextMenu={e => {
                                        if (!onNoteContext) return;
                                        e.preventDefault();
                                        // 菜单弹在鼠标处（原来锚整行顶部，右键行中下部会「错位」）
                                        onNoteContext(n.id, anchorAtMouse(e.clientX, e.clientY));
                                    }}
                                    sx={{
                                        display: "block",
                                        width: "100%",
                                        textAlign: "left",
                                        appearance: "none",
                                        border: "none",
                                        m: 0,
                                        font: "inherit",
                                        cursor: "pointer",
                                        minWidth: 0,
                                        px: 1.25,
                                        // 比文件夹行再缩进一档，父子关系一眼看得出。
                                        // ⚠️⚠️ 必须写**像素字符串**：这里的 pl 是 MUI 间距单位
                                        // （1 个单位 = 8px）。之前写成 1.25 + (depth+1)*10
                                        // → 第一层就是 90px 缩进，128px 宽的左栏里文字只剩
                                        // 25px，看起来就像「标题居中了」（用户报）。
                                        // 现在 22px 起步（与「未归类」那组基本齐平），每深一层 +12px。
                                        pl: `${22 + Math.min(depth, 4) * 12}px`,
                                        py: 0.35,
                                        borderRadius: 1.25,
                                        bgcolor:
                                            activeNoteId === n.id
                                                ? "rgba(128,128,128,0.14)"
                                                : "transparent",
                                        color:
                                            activeNoteId === n.id ? "text.primary" : "text.secondary",
                                        "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                                        "&:focus-visible": {
                                            outline: "2px solid var(--accent)",
                                            outlineOffset: 1,
                                        },
                                    }}
                                >
                                    <Typography
                                        component='span'
                                        sx={{
                                            display: "block",
                                            fontSize: 12.5,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {n.title || "无标题"}
                                    </Typography>
                                </Box>
                            ))}
                        </Box>
                    );
                })()}
            {/* 未归入任何文件夹的笔记（inkstone：直接列在文件夹树下，不占中间那栏）。
                右键可移动到文件夹（右侧抽屉）/归档/移到回收站。 */}
            {unfiledNotes && unfiledNotes.length > 0 && (
                <Box data-unfiled-notes='1' sx={{ pb: 0.5 }}>
                    <Typography
                        variant='caption'
                        sx={{ display: "block", px: 1.25, pt: 0.5, pb: 0.25, fontSize: 11, color: "text.disabled" }}
                    >
                        未归类
                    </Typography>
                    {unfiledNotes.map(n => (
                        <Box
                            key={n.id}
                            component='button'
                            type='button'
                            data-unfiled-note={n.id}
                            className='note-dense-row'
                            aria-label={`打开笔记 ${n.title || "无标题"}`}
                            onClick={() => onOpenNote?.(n.id)}
                            onContextMenu={e => {
                                if (!onNoteContext) return;
                                e.preventDefault();
                                // 菜单弹在鼠标处（同上）
                                onNoteContext(n.id, anchorAtMouse(e.clientX, e.clientY));
                            }}
                            sx={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                appearance: "none",
                                border: "none",
                                m: 0,
                                font: "inherit",
                                cursor: "pointer",
                                minWidth: 0,
                                px: 1.25,
                                pl: 2.25,
                                py: 0.35,
                                borderRadius: 1.25,
                                bgcolor:
                                    activeNoteId === n.id
                                        ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                        : "transparent",
                                color:
                                    activeNoteId === n.id ? "text.primary" : "text.secondary",
                                "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                                "&:focus-visible": {
                                    outline: "2px solid var(--accent)",
                                    outlineOffset: 1,
                                },
                            }}
                        >
                            <Typography
                                component='span'
                                sx={{
                                    display: "block",
                                    fontSize: 12.5,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {n.title || "无标题"}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
            {items.length === 0 && (
                <Typography variant='caption' sx={{ display: "block", px: 1, fontSize: 11, color: "text.disabled" }}>
                    还没有{title}
                </Typography>
            )}
            {/* 重命名 / 删除就用系统 prompt：为这两个动作单独做一个带校验的弹窗，
                在 128px 的窄列里是杀鸡用牛刀，而且重命名根本没有别的输入方式 */}
            <Menu
                open={menuId !== null}
                anchorEl={anchorEl}
                onClose={() => {
                    setMenuId(null);
                    setAnchorEl(null);
                }}
                slotProps={{ paper: { sx: { minWidth: 140 } } }}
            >
                {onAskRename && (
                    <MenuItem
                        data-folder-op='rename'
                        onClick={() => {
                            const item = items.find(i => i.id === menuId);
                            setMenuId(null);
                            // 交给上层弹窗：这里不再直接 prompt() ——
                            // 系统弹窗样式突兀，且部分 WebView 会拦（2026-10-06 换掉）。
                            if (item) onAskRename(item.id, item.name);
                        }}
                    >
                        重命名
                    </MenuItem>
                )}
                {/* 在这个文件夹**里面**新建笔记。inkstone 也有这一项。
                    ⚠️ 左栏标题那颗「新建笔记」只在**选中**了文件夹时才落到该文件夹，
                    没选中时落到「未归类」；这里是从具体某个文件夹的菜单进的，落点是明确的。 */}
                {onCreateNoteIn && (
                    <MenuItem
                        data-folder-op='new-note-here'
                        onClick={() => {
                            const id = menuId;
                            setMenuId(null);
                            if (id !== null) onCreateNoteIn(id);
                        }}
                    >
                        在此新建笔记
                    </MenuItem>
                )}
                {onCreateChild && (
                    <MenuItem data-folder-op='new-child' onClick={() => {
                        const id = menuId; setMenuId(null);
                        if (id !== null) onCreateChild(id);
                    }}>新建子文件夹</MenuItem>
                )}
                {onAppearance && (
                    <MenuItem
                        data-folder-op='appearance'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) onAppearance(id);
                        }}
                    >
                        文件夹外观
                    </MenuItem>
                )}
                {/* 标签颜色：同一个 delete-rename 菜单里，和文件夹外观平级。
                    只给「标签」这一节传 —— 文件夹已经有「文件夹外观」那一项了。 */}
                {onAskColor && (
                    <MenuItem
                        data-folder-op='tag-color'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) onAskColor(id);
                        }}
                    >
                        设置颜色
                    </MenuItem>
                )}
                {onMove && (
                    <MenuItem
                        data-folder-op='move-to'
                        onClick={() => {
                            // 二级菜单：目标文件夹得另开一个 Menu 列出来
                            setMoveId(menuId);
                            setMoveAnchor(anchorEl);
                        }}
                    >
                        移动到…
                    </MenuItem>
                )}
                {onReorder && (
                    <MenuItem
                        data-folder-op='move-up'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) void onReorder(id, -1);
                        }}
                    >
                        向前移动
                    </MenuItem>
                )}
                {onReorder && (
                    <MenuItem
                        data-folder-op='move-down'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) void onReorder(id, 1);
                        }}
                    >
                        向后移动
                    </MenuItem>
                )}
                {onMove && (
                    <MenuItem data-folder-op='move-root' onClick={() => {
                        const id = menuId; setMenuId(null);
                        if (id !== null) onMove(id, null);
                    }}>移到根目录</MenuItem>
                )}
                {onAskRemove && (
                    <MenuItem
                        data-folder-op='remove'
                        onClick={() => {
                            const id = menuId;
                            setMenuId(null);
                            // 同理，删除的二次确认也走上层的 ConfirmDialog
                            if (id !== null) onAskRemove(id, items.find(i => i.id === id)?.name ?? "");
                        }}
                        // 删除是危险动作：跟 inkstone 一样用红色示警
                        sx={{ color: "error.main" }}
                    >
                        删除文件夹
                    </MenuItem>
                )}
            </Menu>
            {/* 「移动到…」的二级菜单：根目录 + 其余**合法的**目标文件夹。
                ⚠️ 不能把自己、以及自己的后代列进去 —— 那会把父子关系绕成环
                （后端 validateFolderParent 会拒，但界面先拦一道更省事）。 */}
            <Menu
                open={moveId !== null}
                anchorEl={moveAnchor}
                onClose={() => {
                    setMoveId(null);
                    setMoveAnchor(null);
                    setMenuId(null);
                    setAnchorEl(null);
                }}
                slotProps={{ paper: { sx: { minWidth: 160, maxHeight: 320 } } }}
            >
                <MenuItem
                    data-move-target='root'
                    onClick={() => {
                        const id = moveId;
                        setMoveId(null);
                        setMoveAnchor(null);
                        setMenuId(null);
                        setAnchorEl(null);
                        if (id !== null) onMove?.(id, null);
                    }}
                >
                    根目录
                </MenuItem>
                {moveId !== null &&
                    items
                        .filter(f => f.id !== moveId && !isDescendant(items, f.id, moveId))
                        .map(f => (
                            <MenuItem
                                key={f.id}
                                data-move-target={f.id}
                                onClick={() => {
                                    const id = moveId;
                                    setMoveId(null);
                                    setMoveAnchor(null);
                                    setMenuId(null);
                                    setAnchorEl(null);
                                    if (id !== null) onMove?.(id, f.id);
                                }}
                            >
                                {f.name}
                            </MenuItem>
                        ))}
            </Menu>
        </Box>
    );
}
