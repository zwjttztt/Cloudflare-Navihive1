// src/components/GroupNavRail.tsx
// 分组锚点导航条：分组一多时不用一路往下滚，点一下直接跳到对应分组，
// 滚动时当前分组会自动高亮。窄屏隐藏（那里用底部导航栏的「分组」入口）。
import { Box, Tooltip, Typography } from "@mui/material";

export interface RailGroup {
    id: number;
    name: string;
    count: number;
}

interface GroupNavRailProps {
    groups: RailGroup[];
    activeId: number | null;
    onJump: (groupId: number) => void;
}

export default function GroupNavRail({ groups, activeId, onJump }: GroupNavRailProps) {
    if (groups.length < 2) return null;

    return (
        <Box
            className='nav-group-rail'
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
                maxHeight: "72vh",
                overflowY: "auto",
                borderRadius: "16px",
                bgcolor: "var(--glass-bg)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(12px) saturate(1.4)",
                WebkitBackdropFilter: "blur(12px) saturate(1.4)",
                boxShadow: "var(--glass-shadow)",
                scrollbarWidth: "thin",
            }}
        >
            {groups.map(group => {
                const active = group.id === activeId;
                return (
                    <Tooltip key={group.id} title={group.name} placement='right'>
                        <Box
                            component='button'
                            type='button'
                            onClick={() => onJump(group.id)}
                            aria-current={active ? "true" : undefined}
                            className='nav-rail-item'
                            data-active={active ? "true" : "false"}
                            sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 0.75,
                                width: "100%",
                                minWidth: 0,
                                maxWidth: 148,
                                px: 1,
                                py: 0.6,
                                border: "1px solid transparent",
                                borderRadius: "10px",
                                cursor: "pointer",
                                textAlign: "left",
                                bgcolor: active
                                    ? "var(--glass-bg-hover)"
                                    : "transparent",
                                borderColor: active ? "var(--accent)" : "transparent",
                                color: active ? "primary.main" : "text.secondary",
                                transition: "all .18s ease",
                                "&:hover": {
                                    bgcolor: "var(--glass-bg-hover)",
                                    color: "text.primary",
                                },
                            }}
                        >
                            <Box
                                sx={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: "50%",
                                    flexShrink: 0,
                                    bgcolor: active ? "var(--accent)" : "text.disabled",
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
    );
}
