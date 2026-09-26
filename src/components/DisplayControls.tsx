// src/components/DisplayControls.tsx
// 顶栏右侧那条玻璃胶囊：视图（卡片/列表/图标墙）+ 密度 + 批量多选 + 只看星标。
// 原来内联在 App.tsx 里 161 行。
import {
    Box,
    IconButton,
    ToggleButton,
    ToggleButtonGroup,
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
import type { Density, ViewMode } from "../context/UIPrefsContext";
import { HEADER_CONTROL_H, HEADER_RADIUS } from "../constants";

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
}

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
}: DisplayControlsProps) {
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
                        <ToggleButtonGroup
                            size='small'
                            exclusive
                            value={viewMode}
                            onChange={(_e, value) => value && setViewMode(value)}
                            aria-label='视图切换'
                            sx={{
                                "& .MuiToggleButton-root": {
                                    border: 0,
                                    height: HEADER_CONTROL_H - 4,
                                    px: 1,
                                    borderRadius: "11px",
                                },
                            }}
                        >
                            <ToggleButton value='card' aria-label='卡片视图'>
                                <Tooltip title='卡片视图'>
                                    <ViewModuleIcon fontSize='small' />
                                </Tooltip>
                            </ToggleButton>
                            <ToggleButton value='list' aria-label='列表视图'>
                                <Tooltip title='紧凑列表'>
                                    <ViewListIcon fontSize='small' />
                                </Tooltip>
                            </ToggleButton>
                            <ToggleButton value='wall' aria-label='图标墙视图'>
                                <Tooltip title='图标墙'>
                                    <ViewCompactIcon fontSize='small' />
                                </Tooltip>
                            </ToggleButton>
                        </ToggleButtonGroup>

                        <Box
                            aria-hidden
                            sx={{
                                width: "1px",
                                height: 18,
                                bgcolor: "var(--glass-border)",
                                flexShrink: 0,
                            }}
                        />

                        <ToggleButtonGroup
                            size='small'
                            exclusive
                            value={density}
                            onChange={(_e, value) => value && setDensity(value)}
                            aria-label='显示密度'
                            sx={{
                                "& .MuiToggleButton-root": {
                                    border: 0,
                                    height: HEADER_CONTROL_H - 4,
                                    px: 1,
                                    borderRadius: "11px",
                                },
                            }}
                        >
                            <ToggleButton value='comfortable' aria-label='舒适密度'>
                                <Tooltip title='舒适'>
                                    <DensityMediumIcon fontSize='small' />
                                </Tooltip>
                            </ToggleButton>
                            <ToggleButton value='compact' aria-label='紧凑密度'>
                                <Tooltip title='紧凑'>
                                    <DensitySmallIcon fontSize='small' />
                                </Tooltip>
                            </ToggleButton>
                        </ToggleButtonGroup>

                        <Box
                            aria-hidden
                            sx={{
                                width: "1px",
                                height: 18,
                                bgcolor: "var(--glass-border)",
                                flexShrink: 0,
                            }}
                        />

                        {/* 批量多选：紧挨「只看星标」左边，和视图/密度同一条胶囊 */}
                        <Tooltip title={multiSelect ? "退出多选" : "批量多选"}>
                            <IconButton
                                className='nav-multiselect-btn'
                                data-active={multiSelect ? "true" : "false"}
                                aria-label={
                                    multiSelect ? "退出多选模式" : "进入多选模式"
                                }
                                aria-pressed={multiSelect}
                                color={multiSelect ? "primary" : "default"}
                                onClick={() =>
                                    multiSelect
                                        ? exitMultiSelect()
                                        : setMultiSelect(true)
                                }
                                sx={{
                                    width: HEADER_CONTROL_H - 4,
                                    height: HEADER_CONTROL_H - 4,
                                    borderRadius: "11px",
                                    flexShrink: 0,
                                    bgcolor: multiSelect
                                        ? "var(--glass-bg-hover)"
                                        : "transparent",
                                }}
                            >
                                {multiSelect ? (
                                    <CheckBoxIcon fontSize='small' />
                                ) : (
                                    <CheckBoxOutlineBlankIcon fontSize='small' />
                                )}
                            </IconButton>
                        </Tooltip>

                        {/* 「只看星标」：和视图/密度同一条胶囊，开着的星星是实心的 */}
                        <ToggleButtonGroup
                            size='small'
                            exclusive
                            value={starFilter ? "star" : ""}
                            onChange={(_e, value) => setStarFilter(Boolean(value))}
                            aria-label='只看星标'
                            sx={{
                                "& .MuiToggleButton-root": {
                                    border: 0,
                                    height: HEADER_CONTROL_H - 4,
                                    px: 1,
                                    borderRadius: "11px",
                                },
                            }}
                        >
                            <ToggleButton
                                value='star'
                                aria-label='只看星标'
                                className='nav-star-filter'
                                data-active={starFilter ? "true" : "false"}
                                selected={starFilter}
                            >
                                <Tooltip title='只看星标'>
                                    {starFilter ? (
                                        <StarIcon fontSize='small' />
                                    ) : (
                                        <StarBorderIcon fontSize='small' />
                                    )}
                                </Tooltip>
                            </ToggleButton>
                        </ToggleButtonGroup>
                    </Box>
    );
}
