// src/components/SettingsDialog.tsx
// 全站设置弹窗。按「基本信息 / 外观 / 背景与毛玻璃 / 图标与缩略图 / 搜索 /
// 数据同步 / 高级」分组：组与组之间用分隔线隔开，组标题左侧有一小段
// 主色竖条，组内字段按「改动频率 + 语义」排序；短字段在宽屏并排成两列，纵向更紧凑。
// 所有值都走「临时副本 + 点保存才落库」，所以组件本身不碰 API，只负责渲染和回调。
import type { ChangeEvent } from "react";
import { Section, SwitchRow } from "./dialogSection";
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Divider,
    IconButton,
    Slider,
    FormControlLabel,
    Stack,
    Switch,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import VersionUpgradeSection from "./VersionUpgradeSection";
import { DEFAULT_ICON_API, DEFAULT_THUMB_API } from "../utils/iconApi";
import {
    RETENTION_DAYS,
    RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../API/http";
import type { FontScale, RadiusStyle } from "../context/uiPrefsStore";

// 内置壁纸预设：既可以是渐变（直接作为 CSS background-image），也可以留空表示不用
const WALLPAPER_PRESETS = [
    { label: "晨雾", value: "linear-gradient(135deg,#e0eafc 0%,#cfdef3 100%)" },
    { label: "暮色", value: "linear-gradient(135deg,#ff9a9e 0%,#fad0c4 55%,#fad0c4 100%)" },
    { label: "极光", value: "linear-gradient(135deg,#0f2027 0%,#203a43 45%,#2c5364 100%)" },
    { label: "森林", value: "linear-gradient(135deg,#134e5e 0%,#71b280 100%)" },
    { label: "紫夜", value: "linear-gradient(135deg,#42275a 0%,#734b6d 100%)" },
    { label: "砂丘", value: "linear-gradient(135deg,#f6d365 0%,#fda085 100%)" },
];

// 取色器预设色：覆盖蓝/青/绿/橙/红/紫/靛/灰几种常用取向
const PRESET_ACCENTS = [
    "#1976d2",
    "#00838f",
    "#2e7d32",
    "#ed6c02",
    "#c62828",
    "#7b1fa2",
    "#5c6bc0",
    "#455a64",
];

interface SettingsDialogProps {
    open: boolean;
    onClose: () => void;
    onSave: () => void;
    /** 未保存的配置副本 */
    tempConfigs: Record<string, string>;
    setTempConfigs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    onConfigInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
    /** 背景蒙版透明度滑块（直接接 MUI Slider 的 onChange 签名） */
    onMaskOpacityChange: (event: Event, value: number | number[]) => void;
    /** 选主色：同时写入临时配置和实时预览 */
    onPickAccent: (color: string) => void;
    radius: RadiusStyle;
    onRadiusChange: (value: RadiusStyle) => void;
    fontScale: FontScale;
    onFontScaleChange: (value: FontScale) => void;
    glassBlur: number;
    onGlassBlurChange: (event: Event, value: number | number[]) => void;
    /** 毛玻璃总开关（本机偏好）：关掉后模糊滑块不再有任何效果，界面得说明清楚 */
    glassEffects: boolean;
    onGlassEffectsChange: (enabled: boolean) => void;
    offlineFull: boolean;
    onOfflineFullChange: (enabled: boolean) => void;
    /** 清爽模式（本机偏好）：一并关掉毛玻璃、柔光背景、装饰动画，低性能设备更省 */
    liteMode: boolean;
    onLiteModeChange: (enabled: boolean) => void;
    /** 图标隐私模式（本机偏好）：打开后不再为取图标请求任何第三方 */
    iconPrivacy: boolean;
    onIconPrivacyChange: (enabled: boolean) => void;
    /** 正在保存：按钮禁用 + 文案变化，避免连点重复提交 */
    saving?: boolean;
    /** 拼音搜索（本机偏好，打开即生效，不需要点保存） */
    pinyinSearch: boolean;
    onPinyinSearchChange: (enabled: boolean) => void;
    /** 失效检测结果同步到服务端（打开即生效，不需要点保存） */
    syncHealth: boolean;
    onSyncHealthChange: (enabled: boolean) => void;
    /**
     * 本机偏好同步到服务端（同上）。
     * 一个开关管四样：星标 / 标签 / 访问统计 / 分组折叠 —— 它们同属「只存本机、
     * 清缓存就没了」的那类数据，拆成四个开关只会让人看不懂该开哪一个。
     */
    syncPrefs: boolean;
    onSyncPrefsChange: (enabled: boolean) => void;
    /**
     * 立刻跑一遍失效链接检测。
     *
     * 原先是「更多选项」里的一个菜单项，但它要跟上面那个「失效检测结果」开关一起看才说得通
     * （开关管的是结果要不要同步，这个按钮管的是结果从哪来），所以挪到同一节里。
     * 不传就不显示这一行。
     */
    onRunLinkCheck?: () => void;
    /**
     * 当前身份是不是站点所有者。
     *
     * 标题 / 主题 / 背景这些外观是**按账号保存**的：所有者那一份写在全站 configs，
     * 同时是「未登录时的登录页外观」和「新账号的初始外观」；其它账号改的是自己那份，
     * 既改不到别人的，也不会因为自己没配过而看到一片空白（没配就跟着站点所有者走）。
     * 不传默认 true（未启用登录的单账号部署没有「别人」可言）。
     */
    isSiteOwner?: boolean;
}

// Section / SwitchRow 已搬到 ./dialogSection（AI 助手弹窗要用同一套排版，
// 从本文件导入会把整个设置弹窗的代码块一起拖过去）。这里 re-export 保持老引用不动。
export { Section, SwitchRow } from "./dialogSection";

/** 窄屏堆叠、宽屏并排的两列栅格：短字段用它省掉一整行高度 */
function TwoCol({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{
                display: "grid",
                gap: 1.25,
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            }}
        >
            {children}
        </Box>
    );
}

export default function SettingsDialog({
    open,
    onClose,
    onSave,
    tempConfigs,
    setTempConfigs,
    onConfigInputChange,
    onMaskOpacityChange,
    onPickAccent,
    radius,
    onRadiusChange,
    fontScale,
    onFontScaleChange,
    glassBlur,
    onGlassBlurChange,
    glassEffects,
    onGlassEffectsChange,
    offlineFull,
    onOfflineFullChange,
    iconPrivacy,
    onIconPrivacyChange,
    liteMode,
    onLiteModeChange,
    saving = false,
    pinyinSearch,
    onPinyinSearchChange,
    syncHealth,
    onSyncHealthChange,
    syncPrefs,
    onSyncPrefsChange,
    onRunLinkCheck,
    isSiteOwner = true,
}: SettingsDialogProps) {
    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                maxWidth='md'
                fullWidth
                slotProps={{
                    paper: {
                        sx: {
                            m: { xs: 2, sm: "auto" },
                            width: { xs: "calc(100% - 32px)", sm: "auto" },
                        },
                    }
                }}
            >
                <DialogTitle sx={{ px: 3, pt: 2, pb: 0.5 }}>
                    网站设置
                    <IconButton
                        aria-label='close'
                        onClick={onClose}
                        sx={{ position: "absolute", right: 8, top: 8 }}
                    >
                        <CloseIcon />
                    </IconButton>
                </DialogTitle>
                <DialogContent
                    sx={{
                        px: 3,
                        pt: 1,
                        pb: 2,
                        // 说明文字统一收紧：默认 helperText 的行高和上间距太占地方
                        "& .MuiFormHelperText-root": { mt: 0.5, fontSize: 11.5, lineHeight: 1.5 },
                        // 滑块默认上下各留一段内边距，压掉一半换密度
                        "& .MuiSlider-root": { py: 0.75 },
                    }}
                >
                    <DialogContentText sx={{ mb: 1.5, fontSize: 13.5 }}>
                        带「即时生效」的开关改完立刻生效；其余为草稿，需点「保存设置」。
                    </DialogContentText>
                    {!isSiteOwner ? (
                        // 外观现在是按账号保存的，改得动；但「改的是谁的」得说清楚，
                        // 否则会以为自己这一改整站都变了（或者反过来以为改了也白改）
                        <Alert severity='info' sx={{ mb: 1.5 }}>
                            外观按账号保存，仅影响你自己；站点所有者的设置还会作为新账号的默认外观。
                        </Alert>
                    ) : null}
                    <Stack spacing={2} divider={<Divider />}>
                        {/* 1. 基本信息：最常改，放最上面 */}
                        <Section title='基本信息'>
                            <TwoCol>
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='site-title'
                                    name='site.title'
                                    label='网站标题 (浏览器标签)'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.title"]}
                                    onChange={onConfigInputChange}
                                />
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='site-name'
                                    name='site.name'
                                    label='网站名称 (显示在页面中)'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.name"]}
                                    onChange={onConfigInputChange}
                                />
                            </TwoCol>
                        </Section>

                        {/* 2. 外观：配色（随备份走）+ 圆角/字号（只存本机） */}
                        <Section
                            title='外观'
                            hint='配色随备份同步；圆角与字号只存本机。'
                        >
                            <Box>
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 1,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    {PRESET_ACCENTS.map(color => {
                                        const picked =
                                            (tempConfigs["site.primaryColor"] || "").toLowerCase() ===
                                            color.toLowerCase();
                                        return (
                                            <IconButton
                                                key={color}
                                                size='small'
                                                aria-label={`使用配色 ${color}`}
                                                aria-pressed={picked}
                                                onClick={() => onPickAccent(color)}
                                                sx={{
                                                    width: 26,
                                                    height: 26,
                                                    minWidth: 26,
                                                    bgcolor: color,
                                                    border: "2px solid",
                                                    borderColor: picked ? "text.primary" : "transparent",
                                                    boxShadow: picked
                                                        ? `0 0 0 2px ${color}55`
                                                        : "var(--shadow-chip)",
                                                    "&:hover": { bgcolor: color },
                                                }}
                                            />
                                        );
                                    })}

                                    {/* 原生取色器：可任选任意颜色 */}
                                    <Box
                                        component='input'
                                        type='color'
                                        name='site.primaryColor'
                                        aria-label='自定义主色'
                                        value={
                                            /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(
                                                tempConfigs["site.primaryColor"] || ""
                                            )
                                                ? tempConfigs["site.primaryColor"]
                                                : "#1976d2"
                                        }
                                        onChange={e => onPickAccent(e.target.value)}
                                        sx={{
                                            width: 34,
                                            height: 26,
                                            p: 0,
                                            cursor: "pointer",
                                            bgcolor: "transparent",
                                            border: "1px solid",
                                            borderColor: "divider",
                                            borderRadius: 1,
                                        }}
                                    />

                                    <Button size='small' variant='text' onClick={() => onPickAccent("")}>
                                        恢复默认
                                    </Button>
                                </Box>
                                <Typography
                                    variant='caption'
                                    sx={{
                                        color: 'text.secondary',
                                        display: "block",
                                        mt: 0.5
                                    }}>
                                    留空则用默认蓝色。
                                </Typography>
                            </Box>

                            <TwoCol>
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 1,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <Typography variant='body2' sx={{ minWidth: 40 }}>
                                        圆角
                                    </Typography>
                                    <ToggleButtonGroup
                                        size='small'
                                        exclusive
                                        value={radius}
                                        onChange={(_e, value) => value && onRadiusChange(value)}
                                        aria-label='圆角风格'
                                    >
                                        <ToggleButton value='soft' aria-label='圆润圆角'>
                                            圆润
                                        </ToggleButton>
                                        <ToggleButton value='standard' aria-label='标准圆角'>
                                            标准
                                        </ToggleButton>
                                        <ToggleButton value='sharp' aria-label='锐利圆角'>
                                            锐利
                                        </ToggleButton>
                                    </ToggleButtonGroup>
                                </Box>
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 1,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <Typography variant='body2' sx={{ minWidth: 40 }}>
                                        字号
                                    </Typography>
                                    <ToggleButtonGroup
                                        size='small'
                                        exclusive
                                        value={fontScale}
                                        onChange={(_e, value) => value && onFontScaleChange(value)}
                                        aria-label='字号档位'
                                    >
                                        <ToggleButton value='compact' aria-label='紧凑字号'>
                                            紧凑
                                        </ToggleButton>
                                        <ToggleButton value='normal' aria-label='标准字号'>
                                            标准
                                        </ToggleButton>
                                        <ToggleButton value='large' aria-label='宽松字号'>
                                            宽松
                                        </ToggleButton>
                                    </ToggleButtonGroup>
                                </Box>
                            </TwoCol>
                        </Section>

                        {/* 3. 背景与毛玻璃：都属于「背后的画面」，合成一组。
                            毛玻璃总开关原本在「更多选项」菜单里，菜单变短后移到这里和强度滑块作伴。 */}
                        <Section title='背景与毛玻璃'>
                            {/* 内置壁纸预设：点一下即用，也可以自己在下面填图片 URL */}
                            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                                {WALLPAPER_PRESETS.map(preset => {
                                    const picked =
                                        (tempConfigs["site.backgroundImage"] || "") === preset.value;
                                    return (
                                        <Tooltip key={preset.label} title={preset.label}>
                                            <IconButton
                                                size='small'
                                                aria-label={`使用壁纸 ${preset.label}`}
                                                onClick={() =>
                                                    setTempConfigs(prev => ({
                                                        ...prev,
                                                        "site.backgroundImage": picked
                                                            ? ""
                                                            : preset.value,
                                                    }))
                                                }
                                                sx={{
                                                    width: 34,
                                                    height: 34,
                                                    background: preset.value,
                                                    border: "2px solid",
                                                    borderColor: picked
                                                        ? "text.primary"
                                                        : "transparent",
                                                    "&:hover": { background: preset.value },
                                                }}
                                            />
                                        </Tooltip>
                                    );
                                })}
                            </Box>

                            <TextField
                                margin='dense'
                                size='small'
                                id='site-background-image'
                                name='site.backgroundImage'
                                label='背景图片URL'
                                type='text'
                                fullWidth
                                variant='outlined'
                                value={tempConfigs["site.backgroundImage"]}
                                onChange={onConfigInputChange}
                                placeholder='https://example.com/background.jpg'
                                helperText='留空则不用背景图。'
                            />

                            <Box>
                                <Typography variant='body2' sx={{
                                    color: 'text.secondary'
                                }}>
                                    背景蒙版透明度:{" "}
                                    {Number(tempConfigs["site.backgroundMaskOpacity"]) || 0}
                                </Typography>
                                <Slider
                                    value={Number(tempConfigs["site.backgroundMaskOpacity"]) || 0}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    onChange={onMaskOpacityChange}
                                    aria-label='背景蒙版透明度'
                                    valueLabelDisplay='auto'
                                    size='small'
                                />
                                <Typography variant='caption' sx={{
                                    color: 'text.secondary'
                                }}>
                                    值越大背景越清晰，文字可读性越低。
                                </Typography>
                            </Box>

                            <Box>
                                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                    <Typography variant='body2'>毛玻璃特效</Typography>
                                    <Box sx={{ flex: 1 }} />
                                    <FormControlLabel
                                        control={
                                            <Switch
                                                checked={glassEffects}
                                                size='small'
                                                onChange={e => onGlassEffectsChange(e.target.checked)}
                                                slotProps={{ input: { "aria-label": "毛玻璃特效" } }}
                                            />
                                        }
                                        label={
                                            <Typography variant='body2'>
                                                {glassEffects ? "开" : "关"}
                                            </Typography>
                                        }
                                        sx={{ m: 0 }}
                                    />
                                </Box>
                                <Typography variant='body2' sx={{
                                    color: 'text.secondary'
                                }}>
                                    模糊半径: {glassBlur}px（0 = 完全不模糊）
                                </Typography>
                                <Slider
                                    value={glassBlur}
                                    min={0}
                                    max={24}
                                    step={1}
                                    onChange={onGlassBlurChange}
                                    aria-label='毛玻璃强度'
                                    valueLabelDisplay='auto'
                                    size='small'
                                    disabled={!glassEffects}
                                />
                                <Typography variant='caption' sx={{
                                    color: 'text.secondary'
                                }}>
                                    数值越大越朦胧，看不清内容时调小或拖到 0。关闭总开关后滑块不生效，滚动更省。
                                </Typography>
                            </Box>

                            <Box>
                                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                    <Typography variant='body2'>清爽模式</Typography>
                                    <Box sx={{ flex: 1 }} />
                                    <FormControlLabel
                                        control={
                                            <Switch
                                                checked={liteMode}
                                                size='small'
                                                onChange={e => onLiteModeChange(e.target.checked)}
                                                slotProps={{ input: { "aria-label": "清爽模式" } }}
                                            />
                                        }
                                        label={
                                            <Typography variant='body2'>
                                                {liteMode ? "开" : "关"}
                                            </Typography>
                                        }
                                        sx={{ m: 0 }}
                                    />
                                </Box>
                                <Typography variant='caption' sx={{
                                    color: 'text.secondary'
                                }}>
                                    一并关掉毛玻璃、柔光背景与装饰动画，只留纯色底和静态卡片。
                                    老设备、省电模式或滚动发烫时开这个；开了之后上面的模糊滑块不再生效。
                                </Typography>
                            </Box>
                        </Section>

                        {/* 4. 图标与缩略图：两个 URL 模板，规则相似，并排放 */}
                        <Section
                            title='图标与缩略图'
                            hint='支持占位符，留空用默认值。'
                        >
                            <TwoCol>
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='site-icon-api'
                                    name='site.iconApi'
                                    label='获取图标API URL'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.iconApi"]}
                                    onChange={onConfigInputChange}
                                    placeholder={DEFAULT_ICON_API}
                                    helperText='域名字符串用 {domain} 占位，例：https://www.faviconextractor.com/favicon/{domain}'
                                    // 帮助文字里带长 URL，不断行会伸出输入框
                                    // （375 视口下实测溢出 16px，见 docs/dialogs-audit-2026-10-16.md）
                                    sx={{
                                        "& .MuiFormHelperText-root": {
                                            overflowWrap: "anywhere",
                                            wordBreak: "break-word",
                                        },
                                    }}
                                />
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='site-thumb-api'
                                    name='site.thumbApi'
                                    label='缩略图API URL'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.thumbApi"] || ""}
                                    onChange={onConfigInputChange}
                                    placeholder={DEFAULT_THUMB_API}
                                    helperText='留空则不显示缩略图。占位符：{url}、{domain}、{origin}'
                                    // 同上：占位符示例里有长 token，统一断词
                                    sx={{
                                        "& .MuiFormHelperText-root": {
                                            overflowWrap: "anywhere",
                                            wordBreak: "break-word",
                                        },
                                    }}
                                />
                            </TwoCol>
                            {/* 图标隐私跟着「取图标」这件事走，所以放在这一节，
                                而不是和离线缓存混在一起：它管的是同一个外站请求 */}
                            <SwitchRow
                                checked={iconPrivacy}
                                onChange={onIconPrivacyChange}
                                label='图标隐私模式（不为取图标访问外站）'
                                ariaLabel='图标隐私模式'
                                caption='打开后改用首字母块，不再为取图标访问外站；已缓存的图标仍可用。'
                            />
                        </Section>

                        {/* 5. 搜索 */}
                        <Section title='搜索'>
                            <SwitchRow
                                checked={pinyinSearch}
                                onChange={onPinyinSearchChange}
                                label='拼音搜索'
                                ariaLabel='拼音搜索'
                                caption='可用首字母搜中文站点（如「bd」→「百度」）。'
                            />
                        </Section>

                        {/* 5.5 离线与缓存（图标隐私已挪进「图标与缩略图」，它管的是同一件事） */}
                        <Section
                            title='离线与缓存'
                            hint='默认按需加载，首屏更快、更省流量。'
                        >
                            <SwitchRow
                                checked={offlineFull}
                                onChange={onOfflineFullChange}
                                label='离线增强（预下载全部功能）'
                                ariaLabel='离线增强'
                                caption='预下载全部功能代码，断网也能打开；首次多下载约几百 KB。'
                            />
                        </Section>

                        {/* 6. 数据同步：两项都是可选，默认关（关着的时候数据只在本机，不上传） */}
                        <Section
                            title='数据同步'
                            hint='关闭时数据只存本机；打开后写入服务端，可跨设备查看。'
                        >
                            <SwitchRow
                                checked={syncHealth}
                                onChange={onSyncHealthChange}
                                label='失效检测结果'
                                ariaLabel='同步失效检测结果'
                                caption='同步失效链接的白名单，换设备不用重测。'
                            />
                            <SwitchRow
                                checked={syncPrefs}
                                onChange={onSyncPrefsChange}
                                label='星标、标签与访问记录'
                                ariaLabel='同步星标、标签与访问记录'
                                caption='默认只存本机；开启后跨设备同步（星标/标签取并集，访问数取最大值）。'
                            />
                        </Section>

                        {/* 维护：这里是「点一下就干活」的动作，不是开关，
                            单独一节才不会被上面一排同步开关埋掉 */}
                        {onRunLinkCheck && (
                            <Section title='维护' hint='按需执行的检查动作，不会自动跑。'>
                                <Box>
                                    <Button
                                        size='small'
                                        variant='outlined'
                                        startIcon={<LinkOffIcon fontSize='small' />}
                                        onClick={onRunLinkCheck}
                                    >
                                        检测失效链接
                                    </Button>
                                    <Typography
                                        variant='caption'
                                        sx={{
                                            color: 'text.secondary',
                                            display: "block",
                                            mt: 0.5
                                        }}>
                                        逐个访问已收录的链接，把访问不通的标在卡片上。站点多时要点时间，后台跑完会提示结果。
                                    </Typography>
                                </Box>
                            </Section>
                        )}

                        {/* AI 助手已挪走：「更多选项 → AI 助手」单独一个弹窗。
                            它的配置跟着登录账号走、凭据加密且不进备份，
                            跟这里管的「站点长什么样」不是一回事，混在一起容易误改。 */}

                        {/* 7. 数据保留：这三项决定「过期数据什么时候真的消失」，
                            都是全站共享配置 —— 服务端只认站点所有者，这里同步禁用并说明原因。
                            沉睡治理两个阈值（v3.1.1 按用户要求恢复给所有者配置）：普通账号
                            仍会被自动停用/清除，所有者本人永不被治理，但阈值归所有者调。 */}
                        <Section
                            title='数据保留'
                            hint='设定审计日志、回收站与沉睡账号的保留天数。'
                        >
                            {!isSiteOwner ? (
                                <Alert severity='info' sx={{ mb: 1 }}>
                                    这几项是全站设置，只有站点所有者可以修改；保存时服务端也会拒绝。
                                </Alert>
                            ) : null}
                            <TwoCol>
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='retention-days'
                                    name='retention.days'
                                    label='审计与回收站保留（天）'
                                    type='number'
                                    fullWidth
                                    variant='outlined'
                                    disabled={!isSiteOwner}
                                    value={tempConfigs["retention.days"] ?? String(RETENTION_DAYS)}
                                    onChange={onConfigInputChange}
                                    helperText={`到期自动清除（${RETENTION_DAYS_MIN}-${RETENTION_DAYS_MAX}，默认 ${RETENTION_DAYS}）`}
                                    slotProps={{
                                        htmlInput: { min: RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX }
                                    }}
                                />
                                <TextField
                                    margin='dense'
                                    size='small'
                                    id='inactive-disable-days'
                                    name='inactive.disableDays'
                                    label='多久没登录算沉睡（天）'
                                    type='number'
                                    fullWidth
                                    variant='outlined'
                                    disabled={!isSiteOwner}
                                    value={tempConfigs["inactive.disableDays"] ?? ""}
                                    onChange={onConfigInputChange}
                                    placeholder={String(INACTIVE_DISABLE_DAYS_DEFAULT)}
                                    helperText={`停用沉睡账号，数据保留（默认 ${INACTIVE_DISABLE_DAYS_DEFAULT} 天）；所有者不受影响。`}
                                    slotProps={{
                                        htmlInput: { min: 30 }
                                    }}
                                />
                            </TwoCol>
                            <TextField
                                margin='dense'
                                size='small'
                                id='inactive-grace-days'
                                name='inactive.deleteGraceDays'
                                label='停用后再过多久彻底删除（天）'
                                type='number'
                                fullWidth
                                variant='outlined'
                                disabled={!isSiteOwner}
                                value={tempConfigs["inactive.deleteGraceDays"] ?? ""}
                                onChange={onConfigInputChange}
                                placeholder={String(INACTIVE_DELETE_GRACE_DAYS_DEFAULT)}
                                helperText={`期间重新登录即可恢复，到期才彻底删除（默认 ${INACTIVE_DELETE_GRACE_DAYS_DEFAULT} 天）。`}
                                slotProps={{
                                    htmlInput: { min: 1 }
                                }}
                            />
                        </Section>

                        {/* 8. 高级 */}
                        <Section title='高级' hint='直接注入页面，写错可能影响显示。'>
                            <TextField
                                margin='dense'
                                size='small'
                                id='site-custom-css'
                                name='site.customCss'
                                label='自定义CSS'
                                type='text'
                                fullWidth
                                multiline
                                rows={5}
                                variant='outlined'
                                value={tempConfigs["site.customCss"]}
                                onChange={onConfigInputChange}
                                placeholder={'/* 自定义样式 */\nbody { }'}
                            />
                        </Section>
                        {/* 9. 版本与升级：显示当前运行版本 + 检查 GitHub 最新版本。
                            自包含组件（不碰本站 API、无 props），放最后 —— 低频操作。 */}
                        <VersionUpgradeSection />
                    </Stack>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 3, pt: 1 }}>
                    <Button onClick={onClose} variant='outlined'>
                        取消
                    </Button>
                    <Button
                        onClick={onSave}
                        variant='contained'
                        color='primary'
                        disabled={saving}
                    >
                        {saving ? "保存中…" : "保存设置"}
                    </Button>
                </DialogActions>
            </Dialog>

        </>
    );
}
