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
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";

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
    return (
        <Box
            component='nav'
            aria-label='设置分组'
            sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
            {/* 分组区：撑满剩余高度，内容超长时自己滚 —— 这样下面的危险区才能钉在底部。
                分组标题删掉之后这里实际不会滚（9 条 36px + 3 条细线 ≈ 420px），
                但 overflowY 保留：窗口高度被压到 500px 以下时仍然要能滚到底。 */}
            <Box
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
                {groups.map((group, index) => (
                    <Box
                        key={group.title ?? "__danger__"}
                        // 视觉上省掉分组标题，语义上用 group + label 补回来：
                        // 读屏进到这一组会念「数据与活动，分组」，条目数也报得出来
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
                ))}
            </Box>
            {/* 危险区：钉在左栏底部（退出登录）。分隔线改用 borderTop 与上面那几条
                同一种画法 —— 之前这里是一条 MUI <Divider/>（颜色取 theme.palette.divider），
                上面是 border（取 --neutral-hover），两条线深浅不一，是「分隔手段太多」的一种。 */}
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
