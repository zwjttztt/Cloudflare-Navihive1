// src/components/settingsWorkspace/SettingsWorkspaceNav.tsx
// 设置工作区的**左栏分组导航**。
//
// 样子照笔记页的设置弹窗（components/NotesSettingsDialog.tsx:230-281）：
// 不用 MUI 的 Tabs / List，而是拿数组 `.map()` 渲染原生语义 `Box component="button"`。
// 理由与那边一样 —— 这是一列「选一个看一屏」的导航，不是表单控件：
// 用 button 就有免费的键盘可达性（Tab / 回车 / 空格）与读屏语义，
// 用 Tabs 就得再把 role=tablist / tabpanel 那一整套自己补齐。
//
// 尺寸全部钉在规格上（2026-10-29 导航页「设置」统一弹窗）：
//   条目最小高 44（触控目标底线，WCAG 2.5.8）、图标 20、名称 14/500、
//   条目间距 4、分组间距 var(--space-4)、分组标题 12/600 + text.secondary。
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";

/**
 * 外壳 ↔ 导航的信号：窄屏两步式导航里，点中条目要把外壳切到「面板」那一步。
 *
 * 为什么走 context 而不是 props：导航节点是**调用方**（各个中心弹窗）当做
 * `nav` 属性塞进外壳的，外壳再往回塞一个 onNavigate 回调，等于每加一个中心
 * 就要在 props 表上再加一条；用 context 让外壳与导航自己说完这件事，
 * 调用方只管传 `groups / activeId / onSelect`。
 */
export interface WorkspaceNavSignal {
    /** 条目被点中时通知外壳（窄屏据此切到面板步） */
    onNavigate: () => void;
}

const NOOP_SIGNAL: WorkspaceNavSignal = { onNavigate: () => {} };

export const WorkspaceNavSignalContext =
    createContext<WorkspaceNavSignal>(NOOP_SIGNAL);

/** 取外壳的信号；不在外壳里渲染时退化为 no-op（方便单测单独挂导航） */
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
    /** 分组小标题；null = 底部危险区（不渲染小标题，只隔一条分隔线） */
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
                // 44 是触控目标底线：条目看着只有一行字，手指点下去要有那么大
                minHeight: 44,
                px: 1.5,
                py: 0.5,
                appearance: "none",
                border: "none",
                font: "inherit",
                cursor: "pointer",
                textAlign: "left",
                borderRadius: 1.5,
                fontSize: 14,
                fontWeight: 500,
                // 选中：淡强调底 + 强调色文字；危险：错误色；其余用主文字色
                bgcolor: active ? "var(--accent-wash)" : "transparent",
                color: active ? "var(--accent-op)" : danger ? "error.main" : "text.primary",
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
                "& .MuiSvgIcon-root": { fontSize: 20, flexShrink: 0 },
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
            {/* 分组区：撑满剩余高度，内容超长时自己滚 —— 这样下面的危险区才能钉在底部 */}
            <Box
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-4)",
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    overflowX: "hidden",
                }}
            >
                {groups.map(group => (
                    <Box
                        key={group.title ?? "__danger__"}
                        sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
                    >
                        {group.title !== null && (
                            <Typography
                                component='h3'
                                sx={{ px: 1.5, pb: 0.5, fontSize: 12, fontWeight: 600 }}
                                color='text.secondary'
                            >
                                {group.title}
                            </Typography>
                        )}
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
            {/* 危险区：钉在左栏底部（退出登录） */}
            {dangerItems.length > 0 && (
                <Box sx={{ flexShrink: 0, pt: 1 }}>
                    <Divider />
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, pt: 1 }}>
                        {dangerItems.map(item => (
                            <NavItem
                                key={item.id}
                                item={item}
                                tone={item.id === activeId ? "active" : "danger"}
                                onSelect={onSelectDanger ?? onSelect}
                            />
                        ))}
                    </Box>
                </Box>
            )}
        </Box>
    );
}
