// src/components/ThemeToggle.tsx
// 三档循环：浅色 → 深色 → 跟随系统 → 浅色
import { IconButton, Tooltip } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";

type ThemeMode = "light" | "dark" | "system";

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
                onClick={onToggle}
                color='inherit'
                aria-label={`主题：${LABEL[mode]}`}
                sx={{
                    p: 1.5,
                    borderRadius: "50%",
                    bgcolor: "background.paper",
                    boxShadow: 1,
                    color: "text.primary",
                    "&:hover": {
                        bgcolor: "action.hover",
                    },
                }}
            >
                <Icon />
            </IconButton>
        </Tooltip>
    );
}
