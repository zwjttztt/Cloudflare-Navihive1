// src/components/notes/NotesAppearanceTab.tsx
// 记事本设置·外观页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 只管「阅读」侧的外观：强调色 / 背景色 / 密度 / 正文字体字号行高 / 内容宽度 + 效果预览。
// 受控组件：值全部由父级（设置弹窗）持有，这里只发 onChange。

import Box from "@mui/material/Box";
import Slider from "@mui/material/Slider";
import Typography from "@mui/material/Typography";
import { FOLDER_COLORS } from "../../utils/folderAppearance";
import type { NotesUiSettings } from "../../utils/notesSettings";
import { SettingRow, SegOptions } from "./settingsShared";

export interface NotesAppearanceTabProps {
    settings: NotesUiSettings;
    set: <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) => void;
}

export default function NotesAppearanceTab({ settings, set }: NotesAppearanceTabProps) {
    return (
                            <>
                                <SettingRow label='强调色' description='记事本内的选中态、链接与图标颜色'>
                                    <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
                                        {/* 「跟随主题」：空串 = 用 --notes-accent（亮/暗各一个达标的红棕）。
                                            没有这个按钮的话，默认（空串）时下面 8 个色点**一个都不高亮** ——
                                            用户看不出当前用的是哪一档。 */}
                                        <Box
                                            component='button'
                                            type='button'
                                            aria-label='强调色 跟随主题'
                                            data-setting='accent:'
                                            onClick={() => set("accent", "")}
                                            sx={{
                                                width: 22,
                                                height: 22,
                                                borderRadius: "50%",
                                                cursor: "pointer",
                                                appearance: "none",
                                                p: 0,
                                                // 半红半蓝，直观表达「跟着主题走」：
                                                // 红 = 记号（--notes-accent），蓝 = 操作（--accent-op，P1-4 方案 B）
                                                background:
                                                    "linear-gradient(135deg, var(--notes-accent) 50%, var(--accent-op) 50%)",
                                                border:
                                                    settings.accent === ""
                                                        ? "2px solid var(--accent-op)"
                                                        : "2px solid transparent",
                                                outline: "1px solid var(--neutral-border)",
                                            }}
                                        />
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
                                                            ? "2px solid var(--accent-op)"
                                                            : "2px solid transparent",
                                                    outline: "1px solid var(--neutral-border)",
                                                }}
                                            />
                                        ))}
                                    </Box>
                                </SettingRow>
                                {/* 背景色 / 密度 / 正文字体：inkstone「外观」页同名的三项 */}
                                <SettingRow label='背景色' description='纸感（暖白）或纯白'>
                                    <SegOptions
                                        dataKey='bgcolor'
                                        value={settings.bgcolor}
                                        onChange={v => set("bgcolor", v)}
                                        options={[
                                            { value: "warm", label: "暖白" },
                                            { value: "pure", label: "纯白" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='界面密度' description='紧凑模式下列表与行距更小，一屏能看到更多'>
                                    <SegOptions
                                        dataKey='density'
                                        value={settings.density}
                                        onChange={v => set("density", v)}
                                        options={[
                                            { value: "comfortable", label: "舒适" },
                                            { value: "compact", label: "紧凑" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='列表样式' description='中栏笔记行的分隔方式：无线最轻、分隔线最密、卡片最清楚'>
                                    <SegOptions
                                        dataKey='listStyle'
                                        value={settings.listStyle}
                                        onChange={v => set("listStyle", v)}
                                        options={[
                                            { value: "plain", label: "无线" },
                                            { value: "divider", label: "分隔线" },
                                            { value: "card", label: "卡片" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='正文字体' description='预览区正文用什么字体'>
                                    <SegOptions
                                        dataKey='previewFont'
                                        value={settings.previewFont}
                                        onChange={v => set("previewFont", v)}
                                        options={[
                                            { value: "sans", label: "无衬线" },
                                            { value: "serif", label: "衬线" },
                                        ]}
                                    />
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
                                            border: "1px solid var(--neutral-hairline)",
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
    );
}
