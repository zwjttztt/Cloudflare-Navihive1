// src/components/CommandPalette.tsx
// 命令面板（Ctrl / Cmd + K）：一个输入框打通「打开站点」和「执行操作」，
// 方向键选择、回车执行、Esc 关闭。
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Dialog,
    Box,
    TextField,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Typography,
    InputAdornment,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import BoltIcon from "@mui/icons-material/Bolt";
import {
    groupBySection,
    pushRecentCommand,
    rankCommands,
    readRecentCommands,
} from "../utils/commandMatch";
import { loadPinyinMatcher, matchesByPinyin } from "../utils/pinyin";

export interface CommandItem {
    id: string;
    label: string;
    hint?: string;
    section: string;
    keywords?: string;
    iconUrl?: string;
    run: () => void;
}

interface CommandPaletteProps {
    open: boolean;
    onClose: () => void;
    commands: CommandItem[];
}

const MAX_ROWS = 9;

export default function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
    const [keyword, setKeyword] = useState("");
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 最近用过的命令：打开面板时读一次（面板每次打开都是一次全新的会话）
    const [recent, setRecent] = useState<string[]>([]);
    useEffect(() => {
        if (open) setRecent(readRecentCommands());
    }, [open]);

    // 拼音词典按需加载：第一次打开面板才请求（与首页搜索同一份模块缓存）。
    // 就位后重算一次结果 —— 「sz → 设置」这类输入才有机会命中。
    const [pinyinReady, setPinyinReady] = useState(false);
    useEffect(() => {
        if (!open || pinyinReady) return;
        let cancelled = false;
        void loadPinyinMatcher().then(matcher => {
            if (!cancelled && matcher) setPinyinReady(true);
        });
        return () => {
            cancelled = true;
        };
    }, [open, pinyinReady]);

    // 打分排序：完全相等 > 前缀 > 包含 > 关键词 > 拼音（sz → 设置）> 跳字（gh → GitHub），
    // 同分时用过的靠前。以前是纯 includes + 生成顺序，输「设置」时真正想要的常常排在第四五行。
    const results = useMemo(
        () =>
            rankCommands(
                commands,
                keyword,
                recent,
                pinyinReady ? { pinyin: matchesByPinyin } : undefined
            ).slice(0, MAX_ROWS * 2),
        [commands, keyword, recent, pinyinReady]
    );

    // 分组展示：组按首次出现顺序，组内保持打分序；键盘导航仍按扁平下标走。
    const groups = useMemo(() => groupBySection(results), [results]);

    const runItem = (item: CommandItem) => {
        pushRecentCommand(item.id);
        setRecent(prev => [item.id, ...prev.filter(id => id !== item.id)]);
        onClose();
        item.run();
    };

    // 打开时重置状态并聚焦输入框
    useEffect(() => {
        if (!open) return;
        setKeyword("");
        setActive(0);
        const timer = setTimeout(() => inputRef.current?.focus(), 60);
        return () => clearTimeout(timer);
    }, [open]);

    useEffect(() => {
        setActive(0);
    }, [keyword]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(i => (i + 1) % Math.max(results.length, 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(i => (i - 1 + results.length) % Math.max(results.length, 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const item = results[active];
            if (item) runItem(item);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='sm'
            className='nav-command-palette'
            slotProps={{
                paper: {
                    sx: {
                        borderRadius: "18px",
                        overflow: "hidden",
                        bgcolor: "var(--glass-bg-hover)",
                        border: "1px solid var(--glass-border)",
                        backdropFilter: "blur(18px) saturate(1.5)",
                        WebkitBackdropFilter: "blur(18px) saturate(1.5)",
                        mt: "8vh",
                        alignSelf: "flex-start",
                    },
                },
            }}
        >
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
                <TextField
                    inputRef={inputRef}
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder='搜索站点或执行命令…'
                    fullWidth
                    size='small'
                    variant='outlined'
                    sx={{ "& .MuiOutlinedInput-root": { borderRadius: "14px" } }}
                    slotProps={{
                        input: {
                            startAdornment: (
                                <InputAdornment position='start'>
                                    <SearchIcon fontSize='small' />
                                </InputAdornment>
                            ),
                        },

                        htmlInput: { "aria-label": "命令面板搜索" }
                    }} />
            </Box>

            <List dense sx={{ maxHeight: 380, overflowY: "auto", px: 1, pb: 1 }}>
                {results.length === 0 && (
                    <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                        <Typography variant='body2' sx={{
                            color: 'text.secondary'
                        }}>
                            没有匹配的站点或命令
                        </Typography>
                        <Typography variant='caption' sx={{
                            color: 'text.secondary'
                        }}>
                            命令可以按「跳字」搜：输 gh 也能找到 GitHub
                        </Typography>
                    </Box>
                )}
                {/* 没有输入时，把「最近用过」标出来，省得用户以为顺序是随机的 */}
                {!keyword.trim() && recent.length > 0 && (
                    <Typography
                        variant='caption'
                        sx={{
                            color: 'text.secondary',
                            px: 1.5,
                            pb: 0.5,
                            display: "block"
                        }}>
                        最近用过（{Math.min(recent.length, MAX_ROWS * 2)}）
                    </Typography>
                )}
                {groups.map(group => (
                    <Box key={group.section || "_other"} component='section' data-palette-section={group.section || "_other"}>
                        <Typography
                            variant='caption'
                            sx={{
                                color: 'text.secondary',
                                px: 1.5,
                                pt: 0.5,
                                pb: 0.25,
                                display: "block"
                            }}>
                            {group.section || "其他"}
                        </Typography>
                        {group.entries.map(({ item, index }) => (
                            <ListItemButton
                                key={item.id}
                                selected={index === active}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => runItem(item)}
                                sx={{ borderRadius: "12px", mb: 0.25 }}
                            >
                                <ListItemIcon sx={{ minWidth: 34 }}>
                                    {item.iconUrl ? (
                                        <Box
                                            component='img'
                                            src={item.iconUrl}
                                            alt=''
                                            sx={{ width: 18, height: 18, objectFit: "contain" }}
                                        />
                                    ) : item.section === "打开网站" ? (
                                        <OpenInNewIcon fontSize='small' />
                                    ) : (
                                        <BoltIcon fontSize='small' />
                                    )}
                                </ListItemIcon>
                                <ListItemText
                                    primary={item.label}
                                    secondary={item.hint}
                                    slotProps={{
                                        primary: { noWrap: true },
                                        secondary: { noWrap: true, sx: { fontSize: 11 } }
                                    }} />
                            </ListItemButton>
                        ))}
                    </Box>
                ))}
            </List>

            <Box
                sx={{
                    px: 2,
                    py: 1,
                    borderTop: "1px solid var(--glass-border)",
                    display: "flex",
                    gap: 1.5,
                    flexWrap: "wrap",
                }}
            >
                <Typography variant='caption' sx={{
                    color: 'text.secondary'
                }}>
                    ↑↓ 选择 · Enter 执行 · Esc 关闭
                </Typography>
            </Box>
        </Dialog>
    );
}
