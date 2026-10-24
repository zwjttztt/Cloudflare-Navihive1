// src/components/notes/NotesEditorTab.tsx
// 记事本设置·编辑器页（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
// 只管「书写」侧：编辑器字体字号 / 行号 / 工具栏 / 专注模式 / 实时渲染 /
// 打字机 / 阅读位置 / 拼写检查 / 缩进宽度 / 自动保存延迟。

import Divider from "@mui/material/Divider";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { NotesUiSettings } from "../../utils/notesSettings";
import { SettingRow, SegOptions } from "./settingsShared";

export interface NotesEditorTabProps {
    settings: NotesUiSettings;
    set: <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) => void;
}

export default function NotesEditorTab({ settings, set }: NotesEditorTabProps) {
    return (
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
                                {/* 专注模式 / 编辑区实时渲染放这一组：都在「写东西」时用，
                                    埋在长列表底下要滚动才看见（实测点不到）。 */}
                                <SettingRow label='专注模式' description='淡化光标所在段落之外的内容，只留当前这段'>
                                    <Switch
                                        checked={settings.focusMode}
                                        onChange={e => set("focusMode", e.target.checked)}
                                        data-setting='focusMode'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='编辑区实时渲染' description='在编辑区里实时渲染：离开光标的那一段直接显示成渲染后的样子'>
                                    <Switch
                                        checked={settings.liveRender}
                                        onChange={e => set("liveRender", e.target.checked)}
                                        data-setting='liveRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='打字机模式' description='光标行始终居中'>
                                    <Switch
                                        checked={settings.typewriterMode}
                                        onChange={e => set("typewriterMode", e.target.checked)}
                                        data-setting='typewriterMode'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='记住阅读位置' description='重新打开一篇笔记时，回到上次读到的地方'>
                                    <Switch
                                        checked={settings.rememberPosition}
                                        onChange={e => set("rememberPosition", e.target.checked)}
                                        data-setting='rememberPosition'
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
                                <SettingRow label='缩进宽度' description='Tab 与自动缩进用几个空格'>
                                    <SegOptions
                                        dataKey='indentWidth'
                                        value={String(settings.indentWidth) as "2" | "4"}
                                        onChange={v => set("indentWidth", Number(v) as 2 | 4)}
                                        options={[
                                            { value: "2", label: "2" },
                                            { value: "4", label: "4" },
                                        ]}
                                    />
                                </SettingRow>
                                <SettingRow label='自动保存延迟' description='停止输入后等多久自动写库（越短越频繁）'>
                                    <Slider
                                        aria-label='自动保存延迟'
                                        data-setting='autosaveMs'
                                        value={settings.autosaveMs}
                                        min={500}
                                        max={8000}
                                        step={250}
                                        valueLabelDisplay='auto'
                                        onChange={(_, v) => set("autosaveMs", v as number)}
                                        sx={{ width: 150 }}
                                    />
                                    <Typography variant='caption' sx={{ width: 52, textAlign: "right" }}>
                                        {settings.autosaveMs}ms
                                    </Typography>
                                </SettingRow>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography variant='caption' color='text.secondary' sx={{ px: 0.5, display: "block", mb: 0.5 }}>
                                    预览
                                </Typography>
                                <SettingRow label='滚动同步' description='分栏时预览跟随源码滚动'>
                                    <Switch
                                        checked={settings.scrollSync}
                                        onChange={e => set("scrollSync", e.target.checked)}
                                        data-setting='scrollSync'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='数学公式' description='渲染 $行内$ 与 $$块级$$ 公式'>
                                    <Switch
                                        checked={settings.mathRender}
                                        onChange={e => set("mathRender", e.target.checked)}
                                        data-setting='mathRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='图表' description='把 Mermaid 代码块渲染为图表'>
                                    <Switch
                                        checked={settings.mermaidRender}
                                        onChange={e => set("mermaidRender", e.target.checked)}
                                        data-setting='mermaidRender'
                                        size='small'
                                    />
                                </SettingRow>
                                <SettingRow label='折叠较长的代码块' description='超过下面行数的代码块先折叠，点一下展开'>
                                    <Switch
                                        checked={settings.foldCode}
                                        onChange={e => set("foldCode", e.target.checked)}
                                        data-setting='foldCode'
                                        size='small'
                                    />
                                </SettingRow>
                                {settings.foldCode && (
                                    <SettingRow label='折叠阈值'>
                                        <Slider
                                            aria-label='折叠阈值'
                                            data-setting='foldCodeLines'
                                            value={settings.foldCodeLines}
                                            min={6}
                                            max={120}
                                            step={2}
                                            valueLabelDisplay='auto'
                                            onChange={(_, v) => set("foldCodeLines", v as number)}
                                            sx={{ width: 150 }}
                                        />
                                        <Typography variant='caption' sx={{ width: 32, textAlign: "right" }}>
                                            {settings.foldCodeLines} 行
                                        </Typography>
                                    </SettingRow>
                                )}
                                <SettingRow label='默认显示大纲' description='打开笔记时右侧就带着大纲面板'>
                                    <Switch
                                        checked={settings.defaultOutline}
                                        onChange={e => set("defaultOutline", e.target.checked)}
                                        data-setting='defaultOutline'
                                        size='small'
                                    />
                                </SettingRow>
                                <Divider sx={{ my: 1.5 }} />
                                <Typography variant='caption' color='text.secondary' sx={{ px: 0.5, display: "block" }}>
                                    字体与字号即时生效；行号、拼写检查与缩进宽度会重建编辑器（撤销历史会清空）。
                                </Typography>
        </>
    );
}
