// src/components/ThemeToggle.tsx
// 三档循环：浅色 → 深色 → 跟随系统 → 浅色。
//
// 现在它渲染在顶栏那条显示胶囊（DisplayControls）内部，和视图/密度/星标并排，
// 所以尺寸与圆角都按「胶囊内控件」来（高 32、圆角 11、透明底 + 悬停玻璃色），
// 不再自带圆形底和投影——那样会从半透明的玻璃胶囊里「鼓」出来一块。
import { IconButton, Tooltip } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import { HEADER_CONTROL_H } from "../constants";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeToggleProps {
    mode: ThemeMode;
    onToggle: () => void;
}

const LABEL: Record<ThemeMode, string> = {
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
};

const NEXT: Record<ThemeMode, string> = {
    light: "深色",
    dark: "跟随系统",
    system: "浅色",
};

export default function ThemeToggle({ mode, onToggle }: ThemeToggleProps) {
    const Icon =
        mode === "light" ? LightModeIcon : mode === "dark" ? DarkModeIcon : SettingsBrightnessIcon;

    return (
        <Tooltip title={`当前${LABEL[mode]} · 点击切到${NEXT[mode]}`}>
            <IconButton
                className='nav-theme-toggle'
                onClick={onToggle}
                color='inherit'
                aria-label={`主题：${LABEL[mode]}`}
                sx={{
                    width: HEADER_CONTROL_H - 4,
                    height: HEADER_CONTROL_H - 4,
                    p: 0,
                    flexShrink: 0,
                    borderRadius: "11px",
                    bgcolor: "transparent",
                    "&:hover": {
                        bgcolor: "var(--glass-bg-hover)",
                    },
                }}
            >
                <Icon fontSize='small' />
            </IconButton>
        </Tooltip>
    );
}
