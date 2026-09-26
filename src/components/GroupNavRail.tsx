// src/components/GroupNavRail.tsx
// 分组锚点导航条：分组一多时不用一路往下滚，点一下直接跳到对应分组，
// 滚动时当前分组会自动高亮。窄屏隐藏（那里用底部导航栏的「分组」入口）。
// 面板底部挂了「折叠 / 展开全部分组」开关：和分组列表放一起，比藏进「更多选项」更好找。
// 整条可以收成一根窄条（只留分组圆点），把空间还给内容区，收起状态记在本机。
import { Box, Divider, Tooltip, Typography, IconButton } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { groupAccent } from "../utils/groupColor";
import UnfoldLessIcon from "@mui/icons-material/UnfoldLess";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useUIPrefs } from "../context/UIPrefsContext";

export interface RailGroup {
    id: number;
    name: string;
    count: number;
}

interface GroupNavRailProps {
    groups: RailGroup[];
    activeId: number | null;
    onJump: (groupId: number) => void;
    /** 是否所有（真实）分组都处于收起状态 */
    allCollapsed: boolean;
    onToggleCollapseAll: () => void;
}

const railItemSx = {
    display: "flex",
    alignItems: "center",
    gap: 0.75,
    width: "100%",
    minWidth: 0,
    maxWidth: 148,
    px: 1,
    // 高度给到 32px 以上：原来 py 0.6 只有 28px，比 WCAG 建议的点击尺寸还小
    py: 0.85,
    border: "1px solid transparent",
    borderRadius: "10px",
    cursor: "pointer",
    textAlign: "left",
    // 只过渡会真的变的这几个属性。写 transition: all 会把 outline-offset 也拉进补间：
    // 下面那条「环向内收」的规则一变，环就从中途的 +2px 慢慢挪到 -2px，
    // 过渡期间它还在容器外面，正好被滚动容器的 overflow 剪掉。
    transition: "background-color .18s ease, color .18s ease, border-color .18s ease",
    "&:hover": {
        bgcolor: "var(--glass-bg-hover)",
        color: "text.primary",
    },
} as const;

export default function GroupNavRail({
    groups,
    activeId,
    onJump,
    allCollapsed,
    onToggleCollapseAll,
}: GroupNavRailProps) {
    const { railCollapsed, setRailCollapsed } = useUIPrefs();
    const mode = useTheme().palette.mode;

    if (groups.length < 2) return null;

    // 收起态：一根窄条，只剩分组圆点，点圆点照样跳转
    if (railCollapsed) {
        return (
            <Box
                component='nav'
                className='nav-group-rail'
                data-collapsed='true'
                aria-label='分组快速跳转（已收起）'
                sx={{
                    position: "fixed",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    zIndex: (t) => t.zIndex.appBar - 1,
                    display: { xs: "none", lg: "flex" },
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 0.5,
                    p: 0.5,
                    maxHeight: "74vh",
                    borderRadius: "16px",
                    bgcolor: "var(--glass-bg)",
                    border: "1px solid var(--glass-border)",
                    backdropFilter: "blur(12px) saturate(1.4)",
                    WebkitBackdropFilter: "blur(12px) saturate(1.4)",
                    boxShadow: "var(--glass-shadow)",
                    // 收起态只有圆点，宽度给够 + 横向不滚动：
                    // 只写 overflowY:auto 时 overflow-x 会被算成 auto，
                    // 竖排滚动条一出现就会挤出一条横向滚动条
                    width: 46,
                    minWidth: 46,
                    overflowX: "hidden",
                    overflowY: "auto",
                    scrollbarWidth: "thin",
                }}
            >
                <Tooltip title='展开分组栏' placement='right'>
                    <IconButton
                        size='small'
                        className='nav-rail-collapse-btn'
                        aria-label='展开分组栏'
                        aria-expanded={false}
                        onClick={() => setRailCollapsed(false)}
                        sx={{ color: "text.secondary" }}
                    >
                        <ChevronRightIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                </Tooltip>

                {groups.map(group => {
                    const active = group.id === activeId;
                    const tone = groupAccent(group.id, mode);
                    return (
                        <Tooltip key={group.id} title={group.name} placement='right'>
                            <Box
                                component='button'
                                type='button'
                                onClick={() => onJump(group.id)}
                                aria-current={active ? "true" : undefined}
                                className='nav-rail-dot'
                                data-active={active ? "true" : "false"}
                                aria-label={group.name}
                                sx={{
                                    width: 10,
                                    height: 10,
                                    p: 0,
                                    my: 0.25,
                                    borderRadius: "50%",
                                    border: "1px solid transparent",
                                    cursor: "pointer",
                                    flexShrink: 0,
                                    // 同上：别用 all，否则焦点环会跟着 outline-offset 一起补间
                                    transition: "opacity .18s ease, transform .18s ease, background-color .18s ease",
                                    transform: active ? "scale(1.35)" : "scale(1)",
                                    bgcolor: tone,
                                    opacity: active ? 1 : 0.45,
                                    "&:hover": {
                                        opacity: 1,
                                        transform: "scale(1.35)",
                                    },
                                }}
                            />
                        </Tooltip>
                    );
                })}
            </Box>
        );
    }

    return (
        <Box
            className='nav-group-rail'
            component='nav'
            data-collapsed='false'
            aria-label='分组快速跳转'
            sx={{
                position: "fixed",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                zIndex: (t) => t.zIndex.appBar - 1,
                display: { xs: "none", lg: "flex" },
                flexDirection: "column",
                gap: 0.5,
                p: 0.75,
                maxHeight: "74vh",
                borderRadius: "16px",
                bgcolor: "var(--glass-bg)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(12px) saturate(1.4)",
                WebkitBackdropFilter: "blur(12px) saturate(1.4)",
                boxShadow: "var(--glass-shadow)",
                scrollbarWidth: "thin",
            }}
        >
            {/* 分组列表：分组特别多时这里单独滚动，底部开关始终留在原位 */}
            <Box
                className='nav-rail-list'
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 0.5,
                    overflowX: "hidden",
                    overflowY: "auto",
                    maxHeight: "60vh",
                    scrollbarWidth: "thin",
                }}
            >
                {groups.map(group => {
                    const active = group.id === activeId;
                    // 每个分组一个稳定的颜色，扫一眼就能分清自己在哪一组
                    const tone = groupAccent(group.id, mode);
                    return (
                        <Tooltip key={group.id} title={group.name} placement='right'>
                            <Box
                                component='button'
                                type='button'
                                onClick={() => onJump(group.id)}
                                aria-current={active ? "true" : undefined}
                                className='nav-rail-item'
                                data-active={active ? "true" : "false"}
                                style={{ ["--group-accent" as string]: tone }}
                                sx={{
                                    ...railItemSx,
                                    bgcolor: active ? "var(--glass-bg-hover)" : "transparent",
                                    borderColor: active ? tone : "transparent",
                                    color: active ? tone : "text.secondary",
                                }}
                            >
                                <Box
                                    className='nav-rail-dot-mini'
                                    sx={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: "50%",
                                        flexShrink: 0,
                                        bgcolor: tone,
                                        opacity: active ? 1 : 0.45,
                                    }}
                                />
                                <Typography
                                    variant='caption'
                                    noWrap
                                    sx={{ fontSize: 12, lineHeight: 1.4 }}
                                >
                                    {group.name}
                                </Typography>
                            </Box>
                        </Tooltip>
                    );
                })}
            </Box>

            <Divider sx={{ my: 0.25, borderColor: "var(--glass-border)" }} />

            {/* 一键折叠 / 展开全部分组 */}
            <Tooltip title={allCollapsed ? "展开全部分组" : "折叠全部分组"} placement='right'>
                <Box
                    component='button'
                    type='button'
                    onClick={onToggleCollapseAll}
                    className='nav-rail-toggle'
                    data-collapsed={allCollapsed ? "true" : "false"}
                    aria-label={allCollapsed ? "展开全部分组" : "折叠全部分组"}
                    aria-pressed={allCollapsed}
                    sx={{
                        ...railItemSx,
                        bgcolor: "transparent",
                        color: "text.secondary",
                    }}
                >
                    {allCollapsed ? (
                        <UnfoldMoreIcon sx={{ fontSize: 16, flexShrink: 0 }} />
                    ) : (
                        <UnfoldLessIcon sx={{ fontSize: 16, flexShrink: 0 }} />
                    )}
                    <Typography
                        variant='caption'
                        noWrap
                        sx={{ fontSize: 12, lineHeight: 1.4 }}
                    >
                        {allCollapsed ? "展开全部" : "折叠全部"}
                    </Typography>
                </Box>
            </Tooltip>

            {/* 收起整条导航：让内容区更宽 */}
            <Tooltip title='收起分组栏' placement='right'>
                <Box
                    component='button'
                    type='button'
                    onClick={() => setRailCollapsed(true)}
                    className='nav-rail-collapse-btn'
                    aria-label='收起分组栏'
                    aria-expanded
                    sx={{
                        ...railItemSx,
                        bgcolor: "transparent",
                        color: "text.secondary",
                    }}
                >
                    <ChevronLeftIcon sx={{ fontSize: 16, flexShrink: 0 }} />
                    <Typography
                        variant='caption'
                        noWrap
                        sx={{ fontSize: 12, lineHeight: 1.4 }}
                    >
                        收起
                    </Typography>
                </Box>
            </Tooltip>
        </Box>
    );
}
