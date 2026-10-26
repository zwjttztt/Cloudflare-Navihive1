// src/components/HeaderSearchBox.tsx
// 顶栏搜索框 + 结果下拉面板（含搜索历史）。原来内联在 App.tsx 里 152 行。
import { useState, type RefObject } from "react";
import {
    Box,
    Button,
    IconButton,
    InputAdornment,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Paper,
    Popper,
    TextField,
    Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import Tooltip from "@mui/material/Tooltip";
import CloseIcon from "@mui/icons-material/Close";
import type { Site } from "../API/http";
import { HEADER_CONTROL_H, HEADER_RADIUS } from "../constants";

/** 下拉面板里的一条结果：卡片本体 + 它所在的分组名（面板里要显示分组） */
export interface SearchResult {
    site: Site;
    groupName: string;
}

export interface HeaderSearchBoxProps {
    searchInputRef: RefObject<HTMLInputElement | null>;
    searchPanelRef: RefObject<HTMLDivElement | null>;
    searchQuery: string;
    setSearchQuery: (value: string) => void;
    setActiveResult: (index: number) => void;
    setSearchFocused: (focused: boolean) => void;
    searchAnchor: HTMLDivElement | null;
    setSearchAnchor: (el: HTMLDivElement | null) => void;
    /** 有关键词且聚焦：展示匹配结果 */
    dropdownOpen: boolean;
    /** 没关键词但聚焦且有历史：展示历史关键词 */
    historyOpen: boolean;
    /** 归一化后的关键词 */
    query: string;
    results: SearchResult[];
    activeResult: number;
    openResult: (site: Site) => void;
    searchHistory: string[];
    applyHistoryTerm: (term: string) => void;
    clearSearchHistory: () => void;
    /** 顶栏是否处于滚动收紧状态（收紧时搜索框也收一档） */
    headerCompact: boolean;
    /**
     * 语义搜索开关。不传就不显示那个按钮（AI 没配的时候不该有个点了才报错的入口）。
     * ready=false 时按钮置灰并用 reason 说明为什么。
     */
    semantic?: {
        enabled: boolean;
        onToggle: (on: boolean) => void;
        ready: boolean;
        reason: string | null;
        busy?: boolean;
    };
}

export default function HeaderSearchBox({
    searchInputRef,
    searchPanelRef,
    searchQuery,
    setSearchQuery,
    setActiveResult,
    setSearchFocused,
    searchAnchor,
    setSearchAnchor,
    dropdownOpen,
    historyOpen,
    query,
    results,
    activeResult,
    openResult,
    searchHistory,
    applyHistoryTerm,
    clearSearchHistory,
    headerCompact,
    semantic,
}: HeaderSearchBoxProps) {
    // ⚠️ 自动填充的最后一道保险：挂载时先锁成只读，用户真正要输入时再放开。
    //
    // 光有 autoComplete="off" 挡不住 Chrome —— 只要页面上同时出现了 password 字段
    // （备份弹窗、账号弹窗里都有），它就会做「用户名 + 密码」配对，把保存的登录
    // 账号填进页面上第一个文本框（2026-10-16 用户实测：搜索框又被填了 zwj）。
    // 浏览器对 readOnly 的输入框不做任何自动填充，这是它唯一老老实实遵守的信号。
    //
    // 解锁要抢在 focus 之前（mousedown / touchstart / keydown 都先于 focus）：
    // 移动端键盘是否弹出是按「聚焦那一刻输入框可不可编辑」决定的，
    // 等 onFocus 再解锁会第一次点不出键盘。
    const [autofillLocked, setAutofillLocked] = useState(true);
    const unlockAutofill = () => setAutofillLocked(false);
    return (
        <Box ref={setSearchAnchor} sx={{ position: "relative" }}>
            <TextField
                inputRef={searchInputRef}
                value={searchQuery}
                onChange={e => {
                    setSearchQuery(e.target.value);
                    setActiveResult(0);
                    // 输入即展开面板（不只依赖 onFocus，避免程序化赋值时面板不出现）
                    setSearchFocused(true);
                }}
                onFocus={() => {
                    unlockAutofill();
                    setSearchFocused(true);
                }}
                placeholder='搜索网站（按 /）'
                size='small'
                variant='outlined'
                sx={{
                    // 宽度交给外层那一格（headerSearchSlotSx）管：
                    // 这里撑满即可，滚动收紧时不再把搜索框压窄 —— 搜索是主操作，
                    // 宽度随滚动变化会让「点输入框」这件事的手感跟着变。
                    width: "100%",
                    // 毛玻璃底色必须和圆角一起挂在输入框本体上：
                    // 放在外层 FormControl 上会在圆角外面露出一块直角白底
                    "& .MuiOutlinedInput-root": {
                        height: HEADER_CONTROL_H,
                        borderRadius: HEADER_RADIUS,
                        bgcolor: headerCompact
                            ? "var(--glass-bg-hover)"
                            : "var(--glass-bg)",
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)",
                        transition: "background-color .25s ease",
                    },
                }}
                slotProps={{
                    input: {
                        // ⚠️ 必须显式关掉浏览器自动填充：本站同时是登录页所在源，
                        // Chrome 会把保存的登录用户名自动填进页面上第一个文本框
                        // （2026-10-15 用户实测：搜索框被填了账号名 zwj，还得手动删掉）。
                        // 搜索框永远不该被当作用户名输入框。
                        autoComplete: "off",
                        name: "site-search",
                        startAdornment: (
                            <InputAdornment position='start'>
                                <SearchIcon fontSize='small' />
                            </InputAdornment>
                        ),
                        endAdornment: semantic || searchQuery ? (
                            <InputAdornment position='end' sx={{ gap: 0 }}>
                                {semantic ? (
                                    <Tooltip
                                        title={
                                            semantic.ready
                                                ? semantic.enabled
                                                    ? "关掉语义搜索，回到关键词匹配"
                                                    : "按意思搜：搜「看图工具」也能找到没写这几个字的站点"
                                                : (semantic.reason ?? "AI 助手不可用")
                                        }
                                    >
                                        {/* 置灰时也要能看见提示，所以不用 disabled 包一层 Box */}
                                        <span>
                                            <IconButton
                                                size='small'
                                                aria-label='语义搜索'
                                                aria-pressed={semantic.enabled}
                                                disabled={!semantic.ready}
                                                onClick={() =>
                                                    semantic.onToggle(!semantic.enabled)
                                                }
                                                sx={{
                                                    color: semantic.enabled
                                                        ? "primary.main"
                                                        : "text.secondary",
                                                }}
                                            >
                                                <AutoAwesomeIcon fontSize='small' />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                ) : null}
                                {searchQuery ? (
                                    <IconButton
                                        size='small'
                                        aria-label='清空搜索'
                                        onClick={() => {
                                            setSearchQuery("");
                                            searchInputRef.current?.focus();
                                        }}
                                    >
                                        <CloseIcon fontSize='small' />
                                    </IconButton>
                                ) : null}
                            </InputAdornment>
                        ) : null,
                    },

                    htmlInput: {
                        "aria-label": "搜索网站",
                        title:
                            "支持条件筛选：tag:标签、group:分组、url:链接、is:starred（星标）、is:dead（失效）、-排除词",
                        // 防自动填充的锁挂在这里（htmlInput 才是原生 <input>，
                        // 挂到 TextField 顶层会被丢到外层 div 上不起作用）
                        readOnly: autofillLocked,
                        onMouseDown: unlockAutofill,
                        onTouchStart: unlockAutofill,
                        onKeyDown: unlockAutofill,
                    }
                }} />

            {/* 搜索结果下拉面板：↑↓ 选择，Enter 直接打开 */}
            <Popper
                open={dropdownOpen || historyOpen}
                anchorEl={searchAnchor}
                placement='bottom-start'
                sx={{ zIndex: (t) => t.zIndex.modal, width: "min(320px, calc(100vw - 32px))" }}
            >
                <Paper
                    ref={searchPanelRef}
                    elevation={6}
                    sx={{
                        mt: 0.5,
                        borderRadius: `calc(${HEADER_RADIUS} * 1.15)`,
                        overflow: "hidden",
                        border: "1px solid var(--glass-border)",
                        bgcolor: "var(--glass-bg-hover)",
                        backdropFilter: "blur(12px)",
                        WebkitBackdropFilter: "blur(12px)",
                    }}
                >
                    {query.length > 0 ? (
                    <List dense sx={{ py: 0.5 }}>
                        {results.map((item, idx) => (
                            <ListItemButton
                                key={`${item.groupName}-${item.site.id ?? idx}`}
                                selected={idx === activeResult}
                                onMouseEnter={() => setActiveResult(idx)}
                                onClick={() => openResult(item.site)}
                                sx={{ borderRadius: "var(--notes-radius-row, 12px)", mx: 0.5 }}
                            >
                                <ListItemIcon sx={{ minWidth: 32 }}>
                                    {item.site.icon ? (
                                        <Box
                                            component='img'
                                            src={item.site.icon}
                                            alt=''
                                            sx={{ width: 18, height: 18, objectFit: "contain" }}
                                        />
                                    ) : (
                                        <SearchIcon fontSize='small' />
                                    )}
                                </ListItemIcon>
                                <ListItemText
                                    primary={item.site.name}
                                    secondary={item.groupName}
                                    slotProps={{
                                        primary: { noWrap: true },
                                        secondary: { noWrap: true, sx: { fontSize: 11 } }
                                    }} />
                            </ListItemButton>
                        ))}
                    </List>
                    ) : (
                        <Box>
                            <Box
                                sx={{
                                    display: "flex",
                                    // baseline 而不是 center（P1-1 同类问题）：「最近搜索」是
                                    // 12px 的 caption，右边「清空」是个 ≥30px 的小按钮 ——
                                    // 用 center 是拿小字盒子的中心去对按钮盒子的中心，
                                    // 小字会看着偏高。两者都是文字，按基线对齐才是一条线。
                                    alignItems: "baseline",
                                    px: 1.5,
                                    pt: 1.25,
                                    pb: 0,
                                }}
                            >
                                <Typography
                                    variant='caption'
                                    sx={{
                                        color: 'text.secondary',
                                        flex: 1,
                                        fontWeight: 600
                                    }}>
                                    最近搜索
                                </Typography>
                                <Button
                                    size='small'
                                    color='inherit'
                                    onClick={clearSearchHistory}
                                    sx={{ minWidth: 0, fontSize: 11 }}
                                >
                                    清空
                                </Button>
                            </Box>
                            <Box className='nav-search-history'>
                                {searchHistory.map(term => (
                                    <button
                                        key={term}
                                        type='button'
                                        className='nav-history-chip'
                                        onClick={() => applyHistoryTerm(term)}
                                    >
                                        {term}
                                    </button>
                                ))}
                            </Box>
                        </Box>
                    )}
                </Paper>
            </Popper>
        </Box>
    );
}
