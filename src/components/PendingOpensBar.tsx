// src/components/PendingOpensBar.tsx
// 底部悬浮的「待打开」胶囊：把攒起来的链接列出来，一键打开或清空。
// 这样点卡片按钮时页面完全不动，攒够了再统一打开。
import { Box, Button, IconButton, Tooltip, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import CloseIcon from "@mui/icons-material/Close";
import { useOpenQueue } from "../context/OpenQueueContext";

export default function PendingOpensBar() {
    const { queue, openAll, clear, remove } = useOpenQueue();

    if (queue.length === 0) return null;

    const preview = queue
        .slice(0, 4)
        .map(item => item.name)
        .join("、");
    const rest = queue.length - 4;

    return (
        <Box
            className='nav-pending-bar'
            sx={{
                position: "fixed",
                left: "50%",
                bottom: { xs: 12, sm: 20 },
                transform: "translateX(-50%)",
                zIndex: (theme) => theme.zIndex.snackbar + 1,
                display: "flex",
                alignItems: "center",
                gap: { xs: 1, sm: 1.5 },
                maxWidth: "calc(100vw - 24px)",
                px: { xs: 1.5, sm: 2 },
                py: 1,
                borderRadius: "18px",
                bgcolor: "var(--glass-bg-hover)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                boxShadow: "0 10px 30px rgba(15,23,42,0.22)",
            }}
        >
            <OpenInNewIcon fontSize='small' color='primary' />

            <Box sx={{ minWidth: 0 }}>
                <Typography variant='body2' fontWeight={600} noWrap>
                    待打开 {queue.length} 个
                </Typography>
                <Typography variant='caption' color='text.secondary' noWrap sx={{ display: "block" }}>
                    {preview}
                    {rest > 0 ? ` 等 ${queue.length} 个` : ""}
                </Typography>
            </Box>

            <Button
                size='small'
                variant='contained'
                onClick={openAll}
                startIcon={<OpenInNewIcon />}
                sx={{ borderRadius: "12px", textTransform: "none", flexShrink: 0 }}
            >
                全部打开
            </Button>

            <Tooltip title='清空列表'>
                <IconButton size='small' onClick={clear} aria-label='清空待打开列表'>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </Tooltip>

            {/* 悬停列表：可直接移除单个条目 */}
            {queue.length > 1 && (
                <Box
                    sx={{
                        display: { xs: "none", md: "flex" },
                        gap: 0.5,
                        maxWidth: 220,
                        overflow: "hidden",
                    }}
                >
                    {queue.slice(0, 3).map(item => (
                        <Box
                            key={item.id}
                            onClick={() => remove(item.id)}
                            sx={{
                                px: 1,
                                py: 0.25,
                                borderRadius: "10px",
                                bgcolor: "action.selected",
                                cursor: "pointer",
                                fontSize: 11,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                maxWidth: 70,
                            }}
                            title={`移除 ${item.name}`}
                        >
                            {item.name}
                        </Box>
                    ))}
                </Box>
            )}
        </Box>
    );
}
