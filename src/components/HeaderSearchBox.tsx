// src/components/HeaderSearchBox.tsx
// 顶栏搜索框 + 结果下拉面板（含搜索历史）。原来内联在 App.tsx 里 152 行。
import type { RefObject } from "react";
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
import CloseIcon from "@mui/icons-material/Close";
import type { Site } from "../API/http";
import { HEADER_CONTROL_H } from "../constants";

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
}: HeaderSearchBoxProps) {
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
                    onFocus={() => setSearchFocused(true)}
                    placeholder='搜索网站（按 /）'
                    inputProps={{ "aria-label": "搜索网站" }}
                    size='small'
                    variant='outlined'
                    InputProps={{
                        startAdornment: (
                            <InputAdornment position='start'>
                                <SearchIcon fontSize='small' />
                            </InputAdornment>
                        ),
                        endAdornment: searchQuery ? (
                            <InputAdornment position='end'>
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
                            </InputAdornment>
                        ) : null,
                    }}
                    sx={{
                        // 头部收紧时搜索框也收一档，和标题保持同步
                        width: headerCompact
                            ? { xs: "100%", sm: 150, md: 175 }
                            : { xs: "100%", sm: 190, md: 230 },
                        transition: "width .25s ease",
                        // 毛玻璃底色必须和圆角一起挂在输入框本体上：
                        // 放在外层 FormControl 上会在圆角外面露出一块直角白底
                        "& .MuiOutlinedInput-root": {
                            height: HEADER_CONTROL_H,
                            borderRadius: "14px",
                            bgcolor: headerCompact
                                ? "var(--glass-bg-hover)"
                                : "var(--glass-bg)",
                            backdropFilter: "blur(10px)",
                            WebkitBackdropFilter: "blur(10px)",
                            transition: "background-color .25s ease",
                        },
                    }}
                />

                {/* 搜索结果下拉面板：↑↓ 选择，Enter 直接打开 */}
                <Popper
                    open={dropdownOpen || historyOpen}
                    anchorEl={searchAnchor}
                    placement='bottom-start'
                    sx={{ zIndex: (t) => t.zIndex.modal, width: 320 }}
                >
                    <Paper
                        ref={searchPanelRef}
                        elevation={6}
                        sx={{
                            mt: 0.5,
                            borderRadius: "16px",
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
                                    sx={{ borderRadius: "12px", mx: 0.5 }}
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
                                        primaryTypographyProps={{ noWrap: true }}
                                        secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
                                    />
                                </ListItemButton>
                            ))}
                        </List>
                        ) : (
                            <Box>
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        px: 1.5,
                                        pt: 1.25,
                                        pb: 0,
                                    }}
                                >
                                    <Typography
                                        variant='caption'
                                        color='text.secondary'
                                        sx={{ flex: 1, fontWeight: 600 }}
                                    >
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
