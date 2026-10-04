// src/components/DisplayControls.tsx
// 顶栏那条玻璃胶囊：只看星标 + 当前视图（点开是显示面板）+ 批量多选。
//
// 和以前的区别：视图三选、密度、主题不再是 8 个常驻图标，而是收进「视图」按钮
// 后面的面板里 —— 顶栏只留「当下是什么视图」这一个入口，剩下的都是低频偏好，
// 不该长期占着宽度。星标是筛选、多选是编辑模式，两个都保留在胶囊里但各自独立。
import { useState } from "react";
import {
    Box,
    Button,
    Divider,
    IconButton,
    ListItemIcon,
    ListItemText,
    ListSubheader,
    Menu,
    MenuItem,
    Tooltip,
} from "@mui/material";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import ViewListIcon from "@mui/icons-material/ViewList";
import ViewCompactIcon from "@mui/icons-material/ViewCompact";
import DensityMediumIcon from "@mui/icons-material/DensityMedium";
import DensitySmallIcon from "@mui/icons-material/DensitySmall";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import CheckIcon from "@mui/icons-material/Check";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import HistoryIcon from "@mui/icons-material/History";
import type { Density, ViewMode } from "../context/uiPrefsStore";
import { HEADER_CONTROL_H, HEADER_RADIUS } from "../constants";
import type { ThemeMode } from "./ThemeToggle";

export interface DisplayControlsProps {
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    density: Density;
    setDensity: (density: Density) => void;
    multiSelect: boolean;
    setMultiSelect: (enabled: boolean) => void;
    exitMultiSelect: () => void;
    starFilter: boolean;
    setStarFilter: (enabled: boolean) => void;
    /** 主题档位（浅色 / 深色 / 跟随系统）；现在收进显示面板 */
    themeMode: ThemeMode;
    /** 直接切到某一档，不再靠「点一下换下一个」的循环 */
    setThemeMode: (mode: ThemeMode) => void;
    /** 「最近访问置前」：浏览偏好，原来混在「更多选项」里，和星标那种筛选不是一回事 */
    favoritesEnabled: boolean;
    onFavoritesEnabledChange: (enabled: boolean) => void;
}

const VIEW_META: Record<ViewMode, { label: string; icon: typeof ViewModuleIcon }> = {
    card: { label: "卡片", icon: ViewModuleIcon },
    list: { label: "列表", icon: ViewListIcon },
    wall: { label: "图标墙", icon: ViewCompactIcon },
};

const DENSITY_META: Record<Density, { label: string; icon: typeof DensityMediumIcon }> = {
    comfortable: { label: "舒适", icon: DensityMediumIcon },
    compact: { label: "紧凑", icon: DensitySmallIcon },
};

const THEME_META: Record<ThemeMode, { label: string; icon: typeof LightModeIcon }> = {
    light: { label: "浅色", icon: LightModeIcon },
    dark: { label: "深色", icon: DarkModeIcon },
    system: { label: "跟随系统", icon: SettingsBrightnessIcon },
};

export default function DisplayControls({
    viewMode,
    setViewMode,
    density,
    setDensity,
    multiSelect,
    setMultiSelect,
    exitMultiSelect,
    starFilter,
    setStarFilter,
    themeMode,
    setThemeMode,
    favoritesEnabled,
    onFavoritesEnabledChange,
}: DisplayControlsProps) {
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
    const panelOpen = Boolean(anchorEl);

    const ViewIcon = VIEW_META[viewMode].icon;

    // 面板里改的是「怎么显示」，改完不关面板：这类偏好用户常常连着调两三项。
    // 只有点外面或者按 Esc 才关。
    return (
        <Box
            className='nav-display-pill'
            sx={{
                display: "flex",
                alignItems: "center",
                height: HEADER_CONTROL_H,
                p: "2px",
                gap: "2px",
                borderRadius: HEADER_RADIUS,
                bgcolor: "var(--glass-bg)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                flexShrink: 0,
            }}
        >
            {/* 「只看星标」：筛选类，和视图那一堆显示偏好分开摆。
                小屏（<=899.98px）底栏已经有一颗管同一件事的星标，顶部这颗就收起来，
                免得同一个筛选在两处各有一个按钮、状态还各记一份 */}
            <Box
                sx={{
                    display: { xs: "none", md: "flex" },
                    alignItems: "center",
                    gap: "2px",
                }}
            >
            <Tooltip title={starFilter ? "取消只看星标" : "只看星标"}>
                <IconButton
                    className='nav-star-filter'
                    data-active={starFilter ? "true" : "false"}
                    aria-label={starFilter ? "取消只看星标" : "只看星标"}
                    aria-pressed={starFilter}
                    onClick={() => setStarFilter(!starFilter)}
                    sx={{
                        width: HEADER_CONTROL_H - 4,
                        height: HEADER_CONTROL_H - 4,
                        borderRadius: "11px",
                        flexShrink: 0,
                        color: starFilter ? "primary.main" : "text.secondary",
                        bgcolor: starFilter ? "var(--glass-bg-hover)" : "transparent",
                    }}
                >
                    {starFilter ? (
                        <StarIcon fontSize='small' />
                    ) : (
                        <StarBorderIcon fontSize='small' />
                    )}
                </IconButton>
            </Tooltip>

            <Divider
                orientation='vertical'
                flexItem
                aria-hidden
                sx={{ my: 0.75, borderColor: "var(--glass-border)" }}
            />
            </Box>

            {/* 「当前视图」按钮：点开是显示面板（视图 / 密度 / 主题） */}
            <Button
                className='nav-view-menu-btn'
                size='small'
                onClick={event => setAnchorEl(event.currentTarget)}
                aria-haspopup='menu'
                aria-expanded={panelOpen ? "true" : undefined}
                aria-controls={panelOpen ? "display-panel" : undefined}
                // 窄屏上按钮里的文字会被藏掉，图标本身没有名字，这里补一个可访问名称
                aria-label={`显示设置，当前${VIEW_META[viewMode].label}视图`}
                startIcon={<ViewIcon fontSize='small' />}
                endIcon={<ArrowDropDownIcon fontSize='small' />}
                sx={{
                    height: HEADER_CONTROL_H - 4,
                    minWidth: "auto",
                    px: 1,
                    borderRadius: "11px",
                    color: "text.primary",
                    textTransform: "none",
                    // 窄屏只留图标，别让「图标墙」三个字把工具行挤换行
                    "& .MuiButton-endIcon": { ml: 0.25 },
                }}
            >
                <Box component='span' sx={{ display: { xs: "none", sm: "inline" } }}>
                    {VIEW_META[viewMode].label}
                </Box>
            </Button>

            <Divider
                orientation='vertical'
                flexItem
                aria-hidden
                sx={{ my: 0.75, borderColor: "var(--glass-border)" }}
            />

            {/* 批量多选：编辑模式开关，紧挨显示面板右边 */}
            <Tooltip title={multiSelect ? "退出多选" : "批量多选"}>
                <IconButton
                    className='nav-multiselect-btn'
                    data-active={multiSelect ? "true" : "false"}
                    aria-label={multiSelect ? "退出多选模式" : "进入多选模式"}
                    aria-pressed={multiSelect}
                    color={multiSelect ? "primary" : "default"}
                    onClick={() =>
                        multiSelect ? exitMultiSelect() : setMultiSelect(true)
                    }
                    sx={{
                        width: HEADER_CONTROL_H - 4,
                        height: HEADER_CONTROL_H - 4,
                        borderRadius: "11px",
                        flexShrink: 0,
                        bgcolor: multiSelect ? "var(--glass-bg-hover)" : "transparent",
                    }}
                >
                    {multiSelect ? (
                        <CheckBoxIcon fontSize='small' />
                    ) : (
                        <CheckBoxOutlineBlankIcon fontSize='small' />
                    )}
                </IconButton>
            </Tooltip>

            <Menu
                id='display-panel'
                anchorEl={anchorEl}
                open={panelOpen}
                onClose={() => setAnchorEl(null)}
                slotProps={{
                    paper: {
                        sx: {
                            "& .MuiListSubheader-root": {
                                fontSize: 11,
                                lineHeight: "24px",
                                color: "text.secondary",
                                bgcolor: "transparent",
                            },
                        },
                    },

                    list: { "aria-label": "显示设置", dense: true }
                }}>
                {/* 分区写清楚是「视图 / 密度 / 主题 / 排序」四类，
                    一眼能看出哪一项会改什么，不用先点一下猜 */}
                <ListSubheader>视图</ListSubheader>
                {(Object.keys(VIEW_META) as ViewMode[]).map(mode => {
                    const meta = VIEW_META[mode];
                    const Icon = meta.icon;
                    return (
                        <MenuItem
                            key={mode}
                            selected={viewMode === mode}
                            onClick={() => setViewMode(mode)}
                        >
                            <ListItemIcon>
                                <Icon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>{meta.label}</ListItemText>
                            {viewMode === mode && (
                                <ListItemIcon sx={{ minWidth: "auto", ml: 1 }}>
                                    <CheckIcon fontSize='small' />
                                </ListItemIcon>
                            )}
                        </MenuItem>
                    );
                })}

                <Divider />

                <ListSubheader>密度</ListSubheader>
                {(Object.keys(DENSITY_META) as Density[]).map(value => {
                    const meta = DENSITY_META[value];
                    const Icon = meta.icon;
                    return (
                        <MenuItem
                            key={value}
                            selected={density === value}
                            onClick={() => setDensity(value)}
                        >
                            <ListItemIcon>
                                <Icon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>{meta.label}</ListItemText>
                            {density === value && (
                                <ListItemIcon sx={{ minWidth: "auto", ml: 1 }}>
                                    <CheckIcon fontSize='small' />
                                </ListItemIcon>
                            )}
                        </MenuItem>
                    );
                })}

                <Divider />

                {/* 主题改成三档直选：原来点一下换下一档，用户得记住顺序才知道会变成什么 */}
                <ListSubheader>主题</ListSubheader>
                {(Object.keys(THEME_META) as ThemeMode[]).map(mode => {
                    const meta = THEME_META[mode];
                    const Icon = meta.icon;
                    return (
                        <MenuItem
                            key={mode}
                            selected={themeMode === mode}
                            onClick={() => setThemeMode(mode)}
                        >
                            <ListItemIcon>
                                <Icon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>{meta.label}</ListItemText>
                            {themeMode === mode && (
                                <ListItemIcon sx={{ minWidth: "auto", ml: 1 }}>
                                    <CheckIcon fontSize='small' />
                                </ListItemIcon>
                            )}
                        </MenuItem>
                    );
                })}

                <Divider />

                <ListSubheader>排序</ListSubheader>
                <MenuItem
                    onClick={() => onFavoritesEnabledChange(!favoritesEnabled)}
                    aria-pressed={favoritesEnabled}
                >
                    <ListItemIcon>
                        <HistoryIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>最近访问置前</ListItemText>
                    {favoritesEnabled && (
                        <ListItemIcon sx={{ minWidth: "auto", ml: 1 }}>
                            <CheckIcon fontSize='small' />
                        </ListItemIcon>
                    )}
                </MenuItem>
            </Menu>
        </Box>
    );
}
