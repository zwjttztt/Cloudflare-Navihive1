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
import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import PaletteIcon from "@mui/icons-material/Palette";
import TuneIcon from "@mui/icons-material/Tune";
import ShareIcon from "@mui/icons-material/Share";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import LaunchIcon from "@mui/icons-material/Launch";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import LinkIcon from "@mui/icons-material/Link";
import { FOLDER_COLORS } from "../utils/folderAppearance";
import type { NotesUiSettings } from "../utils/notesSettings";
import type { NoteShareListItem } from "../API/types";

type SettingsTab = "appearance" | "editor" | "shares";

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
    /**
     * 分享列表要用的三个方法。没传就不显示「分享列表」这一页（老部署/未登录）。
     * 只取这三个，别把整个 api 塞进来 —— 设置弹窗不该有权限去干别的事。
     */
    shareApi?: {
        listNoteShares: () => Promise<NoteShareListItem[]>;
        revokeNoteShare: (id: number) => Promise<{ success: boolean }>;
    } | null;
    /** 撤销后回执（成功/失败都提示一下，别让用户猜） */
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
    /** 打开某条笔记（点「管理」时跳回编辑器） */
    onOpenNote?: (id: number) => void;
}

export default function NotesSettingsDialog({
    open,
    settings,
    onChange,
    onClose,
    shareApi = null,
    onNotify,
    onOpenNote,
}: NotesSettingsDialogProps) {
    const [tab, setTab] = useState<SettingsTab>("appearance");
    // ---- 分享列表（2026-07-07 参考 inkstone 新增）----
    const [shares, setShares] = useState<NoteShareListItem[] | null>(null);
    const [shareError, setShareError] = useState<string | null>(null);
    const [shareKeyword, setShareKeyword] = useState("");
    const reloadShares = useCallback(async () => {
        if (!shareApi) return;
        try {
            setShareError(null);
            setShares(await shareApi.listNoteShares());
        } catch (error) {
            setShares([]);
            setShareError(error instanceof Error ? error.message : "读取分享列表失败");
        }
    }, [shareApi]);
    // 打开设置或切到这一页时才拉 —— 首屏不需要它
    useEffect(() => {
        if (open && tab === "shares") void reloadShares();
    }, [open, tab, reloadShares]);
    const filteredShares = useMemo(() => {
        const kw = shareKeyword.trim().toLowerCase();
        if (!kw) return shares ?? [];
        return (shares ?? []).filter(s => (s.title || "").toLowerCase().includes(kw));
    }, [shares, shareKeyword]);
    const shareUrl = (token: string) => `${globalThis.location.origin}/note/${token}`;
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
                            ...(shareApi
                                ? [["shares", "分享列表", <ShareIcon fontSize='small' key='s' />] as const]
                                : []),
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
                            {tab === "appearance" ? "外观" : tab === "editor" ? "编辑器" : "分享列表"}
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
                        ) : tab === "editor" ? (
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
                                <SettingRow label='打字机模式' description='光标所在的那一行始终停在屏幕中间，写作时眼睛不用来回跳'>
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
                        ) : (
                            // 分享列表（inkstone 设置里同名那一页）：列出所有已分享的笔记 ——
                            // 链接、剩余有效期、创建/更新时间，以及复制/打开/管理/撤销四个动作。
                            <Box data-settings-shares='1'>
                                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
                                    <Typography variant='subtitle2' sx={{ flex: 1 }}>
                                        分享列表
                                    </Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        查看和管理你创建的公开链接
                                    </Typography>
                                    <IconButton
                                        size='small'
                                        aria-label='刷新分享列表'
                                        data-share-action='refresh'
                                        onClick={() => void reloadShares()}
                                        sx={{ p: 0.25 }}
                                    >
                                        <RefreshIcon fontSize='small' />
                                    </IconButton>
                                </Box>
                                <TextField
                                    fullWidth
                                    size='small'
                                    value={shareKeyword}
                                    onChange={e => setShareKeyword(e.target.value)}
                                    placeholder='搜索分享的笔记标题'
                                    slotProps={{
                                        input: {
                                            // ⚠️ aria-label 必须挂 input：直接写在 TextField 上
                                            // 会被 MUI 摊到外层 FormControl（div）上，读屏与
                                            // 选择器都找不到它（同一个坑踩第二次了）。
                                            "aria-label": '搜索分享的笔记标题',
                                            startAdornment: (
                                                <SearchIcon fontSize='small' sx={{ mr: 0.75, color: "text.disabled" }} />
                                            ),
                                        },
                                    }}
                                    sx={{ mb: 1.5, borderRadius: 2, bgcolor: "rgba(128,128,128,0.06)" }}
                                />
                                {shareError && (
                                    <Typography variant='body2' color='error' sx={{ mb: 1 }}>
                                        {shareError}
                                    </Typography>
                                )}
                                {shares === null ? (
                                    <Box sx={{ display: "grid", placeItems: "center", py: 4 }}>
                                        <CircularProgress size={20} />
                                    </Box>
                                ) : filteredShares.length === 0 ? (
                                    <Typography variant='body2' color='text.secondary' sx={{ py: 3, textAlign: "center" }}>
                                        {shareKeyword.trim() ? "没有匹配的分享。" : "还没有分享任何笔记。在笔记的「更多操作」里点「只读分享…」。"}
                                    </Typography>
                                ) : (
                                    filteredShares.map(item => {
                                        const url = shareUrl(item.token);
                                        const expired = item.expires_at !== null && item.expires_at <= Date.now();
                                        return (
                                            <Box
                                                key={item.note_id}
                                                data-share-row={item.note_id}
                                                sx={{
                                                    border: "1px solid var(--card-border, rgba(128,128,128,0.22))",
                                                    borderRadius: 2,
                                                    px: 1.5,
                                                    py: 1.25,
                                                    mb: 1,
                                                }}
                                            >
                                                <Typography variant='body2' sx={{ fontWeight: 600, mb: 0.25 }}>
                                                    {item.title || "（无标题）"}
                                                </Typography>
                                                <Typography
                                                    variant='caption'
                                                    color='text.secondary'
                                                    sx={{ display: "block", wordBreak: "break-all", mb: 0.5 }}
                                                >
                                                    {url}
                                                </Typography>
                                                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
                                                    <Typography variant='caption' sx={{ color: expired ? "error.main" : "success.main" }}>
                                                        {item.expires_at === null
                                                            ? "永久有效"
                                                            : expired
                                                              ? "已过期"
                                                              : `${Math.max(1, Math.ceil((item.expires_at - Date.now()) / 86_400_000))} 天后过期`}
                                                    </Typography>
                                                    {item.updated_at && (
                                                        <Typography variant='caption' color='text.disabled'>
                                                            更新于 {new Date(item.updated_at).toLocaleDateString("zh-CN")}
                                                        </Typography>
                                                    )}
                                                    <Box sx={{ flex: 1 }} />
                                                    <Button
                                                        size='small'
                                                        startIcon={<LinkIcon fontSize='small' />}
                                                        data-share-action='copy'
                                                        onClick={async () => {
                                                            try {
                                                                await navigator.clipboard.writeText(url);
                                                                onNotify?.("已复制分享链接", "success");
                                                            } catch {
                                                                onNotify?.("复制失败（浏览器拒绝了剪贴板访问）", "error");
                                                            }
                                                        }}
                                                    >
                                                        复制
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        startIcon={<LaunchIcon fontSize='small' />}
                                                        data-share-action='open'
                                                        onClick={() => globalThis.open(url, "_blank", "noopener")}
                                                    >
                                                        打开链接
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        startIcon={<TuneIcon fontSize='small' />}
                                                        data-share-action='manage'
                                                        onClick={() => {
                                                            onOpenNote?.(item.note_id);
                                                            onClose();
                                                        }}
                                                    >
                                                        管理
                                                    </Button>
                                                    <Button
                                                        size='small'
                                                        color='error'
                                                        startIcon={<LinkOffIcon fontSize='small' />}
                                                        data-share-action='revoke'
                                                        onClick={async () => {
                                                            if (!shareApi) return;
                                                            try {
                                                                await shareApi.revokeNoteShare(item.note_id);
                                                                onNotify?.("已撤销分享", "success");
                                                                await reloadShares();
                                                            } catch (error) {
                                                                onNotify?.(
                                                                    "撤销失败：" +
                                                                        (error instanceof Error ? error.message : "未知错误"),
                                                                    "error"
                                                                );
                                                            }
                                                        }}
                                                    >
                                                        撤销链接
                                                    </Button>
                                                </Box>
                                            </Box>
                                        );
                                    })
                                )}
                            </Box>
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
