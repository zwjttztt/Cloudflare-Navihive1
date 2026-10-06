// src/components/NotesSettingsDialog.tsx
// 记事本自己的设置（左下角齿轮打开）—— **不与导航站设置页共用**。
//
// 导航站的设置是站点级的（标题、背景、账号、安全）；记事本要的是「阅读与书写
// 习惯」：字号、行高、强调色、编辑器字体、行号……两拨配置毫无交集，塞同一个
// 弹窗只会让两边都变长。所以这里是独立弹窗，样式参考 inkstone：左侧一列小节、
// 右侧是「一行标签 + 一行控件」的设置行，底部给效果预览。
//
// 只放**真的会生效**的开关：每个控件都能说出它改了哪个渲染行为；
// 「存了没用」的假开关比缺一个功能更糟。
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import PaletteIcon from "@mui/icons-material/Palette";
import TuneIcon from "@mui/icons-material/Tune";
import { FOLDER_COLORS } from "../utils/folderAppearance";
import type { NotesUiSettings } from "../utils/notesSettings";

type SettingsTab = "appearance" | "editor";

/** 一行设置：左标签（+可选说明）、右控件 —— inkstone 的设置行样式 */
function SettingRow({
    label,
    description,
    children,
}: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                py: 1.25,
                borderBottom: "1px solid rgba(128,128,128,0.12)",
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant='body2'>{label}</Typography>
                {description && (
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.25 }}>
                        {description}
                    </Typography>
                )}
            </Box>
            <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 0.75 }}>{children}</Box>
        </Box>
    );
}

/** 一组互斥的小段选择（暖纸/纯白 那种样式）：选中项描强调色 */
function SegOptions<T extends string>({
    value,
    options,
    onChange,
    dataKey,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    dataKey: string;
}) {
    return (
        <Box sx={{ display: "flex", gap: 0.5 }}>
            {options.map(opt => {
                const active = opt.value === value;
                return (
                    <Box
                        key={opt.value}
                        component='button'
                        type='button'
                        data-setting={`${dataKey}:${opt.value}`}
                        onClick={() => onChange(opt.value)}
                        sx={{
                            px: 1.25,
                            py: 0.4,
                            fontSize: 12,
                            borderRadius: 1.5,
                            cursor: "pointer",
                            appearance: "none",
                            font: "inherit",
                            border: active ? "1px solid var(--accent)" : "1px solid rgba(128,128,128,0.35)",
                            bgcolor: active ? "rgba(176,67,58,0.08)" : "transparent",
                            color: active ? "var(--accent)" : "text.secondary",
                        }}
                    >
                        {opt.label}
                    </Box>
                );
            })}
        </Box>
    );
}

export interface NotesSettingsDialogProps {
    open: boolean;
    settings: NotesUiSettings;
    onChange: (next: NotesUiSettings) => void;
    onClose: () => void;
}

export default function NotesSettingsDialog({ open, settings, onChange, onClose }: NotesSettingsDialogProps) {
    const [tab, setTab] = useState<SettingsTab>("appearance");
    const set = <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) =>
        onChange({ ...settings, [key]: value });

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth='md'
            fullWidth
            slotProps={{ paper: { sx: { height: 560, maxHeight: "86vh", borderRadius: 3 } } }}
        >
            <Box data-notes-settings='1' sx={{ display: "flex", height: "100%", minHeight: 0 }}>
                {/* 左列小节导航（inkstone 设置的样子） */}
                <Box
                    sx={{
                        width: 148,
                        flexShrink: 0,
                        borderRight: "1px solid rgba(128,128,128,0.12)",
                        py: 2,
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.5,
                        bgcolor: "rgba(128,128,128,0.04)",
                    }}
                >
                    <Typography variant='subtitle1' sx={{ px: 2, pb: 1, fontWeight: 600 }}>
                        设置
                    </Typography>
                    {(
                        [
                            ["appearance", "外观", <PaletteIcon fontSize='small' key='a' />],
                            ["editor", "编辑器", <TuneIcon fontSize='small' key='e' />],
                        ] as const
                    ).map(([key, label, icon]) => (
                        <Box
                            key={key}
                            component='button'
                            type='button'
                            data-settings-tab={key}
                            onClick={() => setTab(key)}
                            sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                                mx: 1,
                                px: 1.5,
                                py: 0.9,
                                appearance: "none",
                                border: "none",
                                font: "inherit",
                                cursor: "pointer",
                                borderRadius: 1.5,
                                textAlign: "left",
                                fontSize: 13.5,
                                bgcolor: tab === key ? "rgba(176,67,58,0.10)" : "transparent",
                                color: tab === key ? "var(--accent)" : "text.secondary",
                                "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                            }}
                        >
                            {icon}
                            {label}
                        </Box>
                    ))}
                </Box>

                {/* 右侧内容 */}
                <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <Box sx={{ display: "flex", alignItems: "center", px: 2.5, py: 1.5 }}>
                        <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600 }}>
                            {tab === "appearance" ? "外观" : "编辑器"}
                        </Typography>
                        <IconButton size='small' aria-label='关闭设置' onClick={onClose} data-settings-close='1'>
                            <CloseIcon fontSize='small' />
                        </IconButton>
                    </Box>
                    <Box sx={{ flex: 1, overflowY: "auto", px: 2.5, pb: 2 }}>
                        {tab === "appearance" ? (
                            <>
                                <SettingRow label='强调色' description='记事本内的选中态、链接与图标颜色'>
                                    <Box sx={{ display: "flex", gap: 0.75 }}>
                                        {FOLDER_COLORS.map(c => (
                                            <Box
                                                key={c}
                                                component='button'
                                                type='button'
                                                aria-label={`强调色 ${c}`}
                                                data-setting={`accent:${c}`}
                                                onClick={() => set("accent", c)}
                                                sx={{
                                                    width: 22,
                                                    height: 22,
                                                    borderRadius: "50%",
                                                    cursor: "pointer",
                                                    appearance: "none",
                                                    bgcolor: c,
                                                    border:
                                                        settings.accent === c
                                                            ? "2px solid var(--accent)"
                                                            : "2px solid transparent",
                                                    outline: "1px solid rgba(128,128,128,0.25)",
                                                }}
                                            />
                                        ))}
                                    </Box>
                                </SettingRow>
                                <SettingRow label='正文字号'>
                                    <Slider
                                        aria-label='正文字号'
                                        data-setting='previewFontSize'
                                        value={settings.previewFontSize}
                                        min={12}
                                        max={24}
                                        step={1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("previewFontSize", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.previewFontSize}px
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='行高'>
                                    <Slider
                                        aria-label='行高'
                                        data-setting='lineHeight'
                                        value={settings.lineHeight}
                                        min={1.2}
                                        max={2.4}
                                        step={0.1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("lineHeight", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.lineHeight.toFixed(1)}
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='内容宽度' description='预览区正文的排版宽度'>
                                    <SegOptions
                                        dataKey='contentWidth'
                                        value={settings.contentWidth}
                                        onChange={v => set("contentWidth", v)}
                                        options={[
                                            { value: "narrow", label: "窄" },
                                            { value: "standard", label: "标准" },
                                            { value: "wide", label: "宽" },
                                            { value: "full", label: "满" },
                                        ]}
                                    />
                                </SettingRow>
                                {/* 效果预览：设置行下方直接看当前字号/行高/宽度下的样子 */}
                                <Box sx={{ pt: 2 }}>
                                    <Typography variant='caption' sx={{ display: "block", mb: 1, color: "text.secondary" }}>
                                        效果预览
                                    </Typography>
                                    <Box
                                        data-settings-preview='1'
                                        sx={{
                                            border: "1px solid rgba(128,128,128,0.2)",
                                            borderRadius: 2,
                                            p: 1.5,
                                            maxWidth:
                                                settings.contentWidth === "narrow"
                                                    ? 320
                                                    : settings.contentWidth === "standard"
                                                      ? 440
                                                      : settings.contentWidth === "wide"
                                                        ? 560
                                                        : "100%",
                                            fontSize: settings.previewFontSize,
                                            lineHeight: settings.lineHeight,
                                        }}
                                    >
                                        <Typography component='div' sx={{ fontWeight: 600, fontSize: "1.2em", mb: 0.5 }}>
                                          山中问答
                                        </Typography>
                                        问余何意栖碧山，笑而不答心自闲。
                                        桃花流水窅然去，别有天地非人间。
                                    </Box>
                                </Box>
                            </>
                        ) : (
                            <>
                                <SettingRow label='编辑器字体'>
                                    <SegOptions
                                        dataKey='editorFont'
                                        value={settings.editorFont}
                                        onChange={v => set("editorFont", v)}
                                        options={[
                                            { value: "mono", label: "等宽" },
                                            { value: "sans", label: "无衬线" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='编辑器字号'>
                                    <Slider
                                        aria-label='编辑器字号'
                                        data-setting='editorFontSize'
                                        value={settings.editorFontSize}
                                        min={12}
                                        max={22}
                                        step={1}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("editorFontSize", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                        {settings.editorFontSize}px
                                    </Typography>
                                </SettingRow>
                                <SettingRow label='显示行号' description='在编辑区左侧显示行号'>
                                    <Switch
                                        checked={settings.lineNumbers}
                                        onChange={e => set("lineNumbers", e.target.checked)}
                                        data-setting='lineNumbers'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='显示工具栏' description='标题下方的 Markdown 格式工具栏'>
                                    <Switch
                                        checked={settings.showToolbar}
                                        onChange={e => set("showToolbar", e.target.checked)}
                                        data-setting='showToolbar'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='拼写检查' description='使用浏览器的原生拼写检查'>
                                    <Switch
                                        checked={settings.spellcheck}
                                        onChange={e => set("spellcheck", e.target.checked)}
                                        data-setting='spellcheck'
                                        size='small'
                                    />
                                </SettingRow>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography variant='caption' color='text.secondary' sx={{ px: 0.5, display: "block" }}>
                                    字体与字号即时生效；行号与拼写检查会重建编辑器（撤销历史会清空）。
                                </Typography>
                            </>
                        )}
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "flex-end", px: 2.5, py: 1.5, borderTop: "1px solid rgba(128,128,128,0.12)" }}>
                        <Button size='small' variant='contained' onClick={onClose} data-settings-done='1'>
                            完成
                        </Button>
                    </Box>
                </Box>
            </Box>
        </Dialog>
    );
}
