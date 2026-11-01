// src/components/settingsWorkspace/SettingsWorkspaceNav.tsx
// 设置工作区的**左栏分组导航**。
//
// 样子照笔记页的设置弹窗（components/NotesSettingsDialog.tsx:230-281）：
// 不用 MUI 的 Tabs / List，而是拿数组 `.map()` 渲染原生语义 `Box component="button"`。
// 理由与那边一样 —— 这是一列「选一个看一屏」的导航，不是表单控件：
// 用 button 就有免费的键盘可达性（Tab / 回车 / 空格）与读屏语义，
// 用 Tabs 就得再把 role=tablist / tabpanel 那一整套自己补齐。
//
// ── 尺寸（2026-10-31 视觉收敛）────────────────────────────────────────────
// 桌面：行高 36、图标 18、名称 13.5/500、条目间距 2、分组间 8px + 1px 细线。
// 窄屏：行高仍是 44（见 NavItem 里那段注释，别以为 36 是随手压的）。
//
// ── 分组标题为什么删了（2026-10-31）──────────────────────────────────────
// 9 条内容 44px/条 + 3 个分组标题 + 组间 16px 留白 ≈ 590px，而正文可用高约 600px
// —— 再加一条导航就得滚动，一个「一屏能看全的目录」开始需要滚动就失去了意义。
// 现在分组关系交给「8px 留白 + 1px 细线」表达，省下的 ~100px 换成不滚动。
// 但**语义没删**：每个分组仍是 `role="group"` + `aria-label`，读屏照样能念出
// 「数据与活动，共 4 项」；视觉上省，语义上不省。
//
// ── 搜索过滤为什么住在左栏里（2026-11-01）────────────────────────────────
// 外壳（SettingsWorkspaceDialog）对 nav 的认知只是一个**不透明的 ReactNode**，
// 它连 nav 里有几条、叫什么都不知道。要让它管过滤，就得在 props 上开一串
// `filterable` / `filterValue` / `onFilterChange`，而外壳是**所有中心共用**的 ——
// 下一个中心接进来，第一件事就是继承一个「打字过滤什么都没发生」的空框。
// 所以过滤、空态、结果播报全部留在这一层；外壳与中心零改动（中心只多拼一个
// `searchText` 字符串）。过滤本身是纯函数，在 navFilter.ts（.ts 不是 .tsx：
// 那里不导出组件，纯函数测试也不必为此拉进 React/MUI）。
import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import WorkspaceNavFilter from "./SettingsWorkspaceNavFilter";
import { filterNavGroups } from "./navFilter";

/**
 * 外壳 ↔ 导航的信号：窄屏两步式导航里，点中条目要把外壳切到「面板」那一步。
 *
 * 为什么走 context 而不是 props：导航节点是**调用方**（各个中心弹窗）当做
 * `nav` 属性塞进外壳的，外壳再往回塞一个 onNavigate 回调，等于每加一个中心
 * 就要在 props 表上再加一条；用 context 让外壳与导航自己说完这件事，
 * 调用方只管传 `groups / activeId / onSelect`。
 *
 * `compact` 也放这里：只有外壳知道自己是不是 fullScreen（窄屏），
 * 行高要在 36 / 44 之间切，但导航不该为此再开一次 useMediaQuery ——
 * 两处 media query 各自监听，边界值一旦不同步就会出现「外壳当窄屏、
 * 导航当桌面」的撕裂。
 */
export interface WorkspaceNavSignal {
    /** 条目被点中时通知外壳（窄屏据此切到面板步） */
    onNavigate: () => void;
    /**
     * 紧凑行高（36）。桌面用鼠标时省下的 8px × 9 条正好换回「不用滚动」；
     * 窄屏是手指，必须留 44。
     *
     * 默认 false（= 44，老行为）：万一有中心漏传，宁可挤一点也不能把
     * 触控目标做小。
     */
    compact: boolean;
}

const NOOP_SIGNAL: WorkspaceNavSignal = { onNavigate: () => {}, compact: false };

export const WorkspaceNavSignalContext =
    createContext<WorkspaceNavSignal>(NOOP_SIGNAL);

/** 取外壳的信号；不在外壳里渲染时退化为 no-op + 非紧凑（方便单测单独挂导航） */
export function useWorkspaceNavSignal(): WorkspaceNavSignal {
    return useContext(WorkspaceNavSignalContext);
}

export interface WorkspaceNavItem {
    /** 稳定 id：外壳用它比对选中态，也用作 data 属性给测试认人 */
    id: string;
    label: string;
    icon: ReactNode;
    /**
     * 过滤用的搜索面（名称 + 别名 + 一行说明拼成的一串）。
     *
     * 由调用方（导航中心）拼好传进来，导航自己只做 `includes`：
     * 左栏是纯展示件，不该知道 `model.ts` 里有 label / description / keywords 三件事，
     * 更不该为了拼它去 import 注册表（那会把整个注册表拖进左栏的依赖里）。
     * 不传 = 退化成只按 label 搜。
     */
    searchText?: string;
}

export interface WorkspaceNavGroup {
    /**
     * 分组名。视觉上**不再渲染成标题**（见文件头注释），只作为读屏的
     * `aria-label`；null = 底部危险区。
     */
    title: string | null;
    items: WorkspaceNavItem[];
}

export interface SettingsWorkspaceNavProps {
    groups: WorkspaceNavGroup[];
    activeId: string;
    onSelect: (id: string) => void;
    /** 沉在左栏最底部的危险动作（退出登录一类）：error 色 + 隔一条分隔线 */
    dangerItems?: WorkspaceNavItem[];
    onSelectDanger?: (id: string) => void;
}

/** 条目的按压态（三种：普通 / 选中 / 危险） */
type ItemTone = "normal" | "active" | "danger";

/**
 * 行高的两档。
 *
 * ⚠️ 桌面 36 不是随手压的，别「顺手统一」成 44 或 32：
 *   · script/a11y-audit.mjs 的硬判据是 WCAG 2.5.8 —— 目标 ≥ 24×24（小于 24 才是
 *     违规），32 以下只报 borderline。36 两档都过；
 *   · 44 是**触控**舒适底线（Apple HIG / Material 都取 44~48），鼠标点不需要；
 *   · 窄屏（fullScreen）是手指在点，所以窄屏必须回到 44 —— 那里也别为了
 *     「跟桌面一致」把它压下去。
 */
const ROW_HEIGHT_COMPACT = 36;
const ROW_HEIGHT_TOUCH = 44;

/** 分组之间：8px 留白 + 1px 细线（原来是 16px 留白 + 12/600 的小标题） */
const GROUP_GAP = "8px";
const RULE_COLOR = "var(--neutral-hover)";

/**
 * 视觉隐藏（只给读屏听）。
 *
 * MUI 9 不再导出 `VisuallyHidden`，手写一份。1×1 的尺寸还有个顺手的好处：
 * script/contrast-audit.mjs 会跳过 `width < 2 || height < 2` 的元素
 * （那段判据是给「看不见的装饰」开的），所以这个播报节点不会被算进对比度检查。
 */
const SR_ONLY = {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
} as const;

function NavItem({
    item,
    tone,
    onSelect,
}: {
    item: WorkspaceNavItem;
    tone: ItemTone;
    onSelect: (id: string) => void;
}) {
    const signal = useWorkspaceNavSignal();
    const active = tone === "active";
    const danger = tone === "danger";
    return (
        <Box
            component='button'
            type='button'
            data-workspace-nav={item.id}
            aria-current={active ? "true" : undefined}
            onClick={() => {
                signal.onNavigate();
                onSelect(item.id);
            }}
            sx={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                width: "100%",
                // 桌面 36 / 窄屏 44 —— 理由见上面 ROW_HEIGHT_* 那段
                minHeight: signal.compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_TOUCH,
                px: 1.5,
                py: 0.5,
                appearance: "none",
                border: "none",
                font: "inherit",
                cursor: "pointer",
                textAlign: "left",
                borderRadius: 1.5,
                fontSize: 13.5,
                fontWeight: 500,
                // 选中：淡强调底 + 淡底专用文字色；危险：错误色；其余用主文字色
                // ⚠️ 文字走 --accent-on-wash 而不是 --accent-op：后者压这层 10% 淡底
                // 亮色只有 4.04:1（小字线 4.5），换成前者 5.04:1。见 index.css 里那两行注释。
                // 指示器（下面 &::before）仍是 --accent-op —— 图形线 3:1，本来就过。
                bgcolor: active ? "var(--accent-wash)" : "transparent",
                color: active ? "var(--accent-on-wash)" : danger ? "error.main" : "text.primary",
                transition:
                    "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
                // 选中态别被 hover 顶掉：hover 只给未选中的条目
                "&:hover": {
                    bgcolor: active ? "var(--accent-wash)" : "var(--neutral-hover)",
                },
                // 左侧 3px 指示器：只画在选中项上，且画在条目内部
                // （左栏是 overflowY:auto，画到条目外会被裁掉并逼出横向滚动条）
                "&::before": {
                    content: '""',
                    position: "absolute",
                    left: 0,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 3,
                    height: 20,
                    borderRadius: 2,
                    bgcolor: active ? "var(--accent-op)" : "transparent",
                },
                "& .MuiSvgIcon-root": { fontSize: 18, flexShrink: 0 },
            }}
        >
            {item.icon}
            <Box component='span' sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.label}
            </Box>
        </Box>
    );
}

export default function SettingsWorkspaceNav({
    groups,
    activeId,
    onSelect,
    dangerItems = [],
    onSelectDanger,
}: SettingsWorkspaceNavProps) {
    const [keyword, setKeyword] = useState("");
    /** 分组滚动盒：`ArrowDown` 要把焦点交给里面第一个可见条目 */
    const listRef = useRef<HTMLDivElement | null>(null);

    // 空词时 filterNavGroups 原样返回 `groups` 这个引用 —— 清空搜索不会白重算一次
    const visible = useMemo(() => filterNavGroups(groups, keyword), [groups, keyword]);
    const filtering = keyword.trim().length > 0;
    /** 命中条目数（不是分组数：「找到 5 项」比「找到 2 项」更像人话） */
    const hitCount = visible.reduce((n, group) => n + group.items.length, 0);
    /**
     * 当前选中的那一屏被本次筛选挡在结果之外了吗？
     *
     * 会被挡：用户打开中心时停在外观与搜索，随手搜「备份」，
     * 右栏还是外观设置、左栏却找不到它 —— 看起来像「选中态丢了」。
     * 处理方式是**只提示、不动右栏**：用户一个东西都没点，
     * 右栏内容却换了，比看到一句提示糟糕得多（也不自动选中第一个命中）。
     */
    const activeHidden =
        filtering && !visible.some(group => group.items.some(item => item.id === activeId));
    /** 提示里的名字从**未过滤**的 groups 里取：被筛掉了也拿得到它叫什么 */
    const activeLabel = groups.flatMap(group => group.items).find(item => item.id === activeId)
        ?.label;

    const focusFirstItem = () => {
        // 用查询而不是「取第 0 项」：空态时它自然什么都不做，不需要额外判空
        //（写成 `items[0].focus()` 就会 undefined.focus() 崩）
        listRef.current?.querySelector<HTMLElement>("[data-workspace-nav]")?.focus();
    };

    return (
        <Box
            component='nav'
            aria-label='设置分组'
            sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
            {/* 搜索行：轻量、低调（无标签、无描边），有词时才亮出清除按钮 */}
            <WorkspaceNavFilter
                value={keyword}
                onChange={setKeyword}
                onArrowDown={focusFirstItem}
                sx={{ mb: 1, mx: 0.5 }}
            />
            {/* 结果播报：`polite` 而不是 `assertive` —— 每敲一个字都打断读屏太烦，
                polite 会等用户停手再念。视觉上 1×1 隐藏（见 SR_ONLY）。 */}
            <Box role='status' aria-live='polite' sx={SR_ONLY}>
                {filtering ? (hitCount > 0 ? `找到 ${hitCount} 项` : "没有匹配的设置项") : ""}
            </Box>
            {/* 选中项被筛掉时的提示。只提示不纠正 —— 见 activeHidden 那段注释 */}
            {activeHidden ? (
                <Box
                    sx={{
                        px: 1,
                        pb: 0.5,
                        fontSize: 12,
                        lineHeight: 1.45,
                        color: "text.secondary",
                    }}
                >
                    当前打开的是「{activeLabel ?? activeId}」，不在这次筛选结果里
                </Box>
            ) : null}
            {/* 分组区：撑满剩余高度，内容超长时自己滚 —— 这样下面的危险区才能钉在底部。
                分组标题删掉之后这里实际不会滚（9 条 36px + 3 条细线 ≈ 420px），
                但 overflowY 保留：窗口高度被压到 500px 以下时仍然要能滚到底。 */}
            <Box
                ref={listRef}
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    gap: GROUP_GAP,
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    overflowX: "hidden",
                }}
            >
                {visible.length === 0 ? (
                    // 空态：不放「清空」按钮 —— 输入框自带清除按钮、Esc 也能清，
                    // 再放一颗就变成「Tab 到一个什么都不做的按钮」。
                    <Box
                        sx={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 0.5,
                            flex: 1,
                            px: 2,
                            py: 3,
                            textAlign: "center",
                            fontSize: 13,
                            color: "text.primary",
                        }}
                    >
                        <Box component='span'>没有匹配的设置项</Box>
                        <Box component='span' sx={{ fontSize: 12, color: "text.secondary" }}>
                            换个词试试，或清空搜索框
                        </Box>
                    </Box>
                ) : (
                    // 🔴 这里 map 的是**过滤后**的 visible：分组间那条 1px 线按
                    // `index > 0` 画，下标必须是过滤后的。先 map 后 filter 会让
                    // 第一个可见分组带着一条分割线、上面什么都没有（假边界）。
                    visible.map((group, index) => (
                        <Box
                            key={group.title ?? "__danger__"}
                            // 视觉上省掉分组标题，语义上用 group + label 补回来：
                            // 读屏进到这一组会念「数据与活动，分组」，条目数也报得出来。
                            // ⚠️ 别给它加 aria-hidden —— 那会把组里所有条目一起从
                            // 无障碍树摘掉，而它们正是过滤要保住的东西。「只剩一个空组」
                            // 的问题已经由 filterNavGroups 丢掉空分组解决了。
                            role='group'
                            aria-label={group.title ?? undefined}
                            sx={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "2px",
                                // 第一组不画线（否则它会贴着左栏顶边，看起来像一条多余的框）
                                ...(index > 0
                                    ? {
                                          borderTop: `1px solid ${RULE_COLOR}`,
                                          pt: GROUP_GAP,
                                      }
                                    : null),
                            }}
                        >
                            {group.items.map(item => (
                                <NavItem
                                    key={item.id}
                                    item={item}
                                    tone={item.id === activeId ? "active" : "normal"}
                                    onSelect={onSelect}
                                />
                            ))}
                        </Box>
                    ))
                )}
            </Box>
            {/* 危险区：钉在左栏底部（退出登录）。分隔线改用 borderTop 与上面那几条
                同一种画法 —— 之前这里是一条 MUI <Divider/>（颜色取 theme.palette.divider），
                上面是 border（取 --neutral-hover），两条线深浅不一，是「分隔手段太多」的一种。

                ⚠️ 它**不参与过滤、始终常驻**：DOM 上它本来就在分组滚动盒之外，
                钉在底部；「退出登录」也不是设置项，没人会用「搜索设置」去找它。
                保持 `[data-workspace-nav="logout"]` 在任何过滤态下都在，
                既有用例（tests/navigationCenter.dom.test.tsx）才不用为过滤改判据。 */}
            {dangerItems.length > 0 && (
                <Box
                    role='group'
                    aria-label='会话'
                    sx={{
                        flexShrink: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px",
                        mt: GROUP_GAP,
                        pt: GROUP_GAP,
                        borderTop: `1px solid ${RULE_COLOR}`,
                    }}
                >
                    {dangerItems.map(item => (
                        <NavItem
                            key={item.id}
                            item={item}
                            tone={item.id === activeId ? "active" : "danger"}
                            onSelect={onSelectDanger ?? onSelect}
                        />
                    ))}
                </Box>
            )}
        </Box>
    );
}
