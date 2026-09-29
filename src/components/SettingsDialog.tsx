// src/components/SettingsDialog.tsx
// 全站设置弹窗。按「基本信息 / 外观 / 背景与毛玻璃 / 图标与缩略图 / 搜索 /
// 数据同步 / 高级」分组：组与组之间用分隔线隔开，组标题左侧有一小段
// 主色竖条，组内字段按「改动频率 + 语义」排序；短字段在宽屏并排成两列，纵向更紧凑。
// 所有值都走「临时副本 + 点保存才落库」，所以组件本身不碰 API，只负责渲染和回调。
import type { ChangeEvent } from "react";
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
import { DEFAULT_ICON_API, DEFAULT_THUMB_API } from "../utils/iconApi";
import {
    RETENTION_DAYS,
    RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../API/http";
import type { FontScale, RadiusStyle } from "../context/UIPrefsContext";

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
    /** 正在保存：按钮禁用 + 文案变化，避免连点重复提交 */
    saving?: boolean;
    /** 拼音搜索（本机偏好，打开即生效，不需要点保存） */
    pinyinSearch: boolean;
    onPinyinSearchChange: (enabled: boolean) => void;
    /** 失效检测结果同步到服务端（打开即生效，不需要点保存） */
    syncHealth: boolean;
    onSyncHealthChange: (enabled: boolean) => void;
    /** 星标 / 标签同步到服务端（同上） */
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

/** 分组：左侧一小段主色竖条 + 组标题，可选一行组说明；组内字段纵向排布 */
function Section({
    title,
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                    sx={{
                        width: 3,
                        height: 14,
                        borderRadius: 0.5,
                        bgcolor: "primary.main",
                        opacity: 0.75,
                        flex: "none",
                    }}
                />
                <Typography variant='subtitle2' fontWeight='600'>
                    {title}
                </Typography>
            </Box>
            {hint ? (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", mt: 0.25, ml: "11px" }}
                >
                    {hint}
                </Typography>
            ) : null}
            <Stack spacing={1.25} sx={{ mt: 1.25 }}>
                {children}
            </Stack>
        </Box>
    );
}

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

/** 开关 + 说明的固定组合：说明统一缩进到标签文字下方，视觉上归成一类 */
function SwitchRow({
    checked,
    onChange,
    label,
    ariaLabel,
    caption,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    ariaLabel: string;
    caption?: string;
}) {
    return (
        <Box>
            <FormControlLabel
                sx={{ display: "flex", m: 0, minHeight: 26 }}
                control={
                    <Switch
                        checked={checked}
                        size='small'
                        onChange={e => onChange(e.target.checked)}
                        slotProps={{ input: { "aria-label": ariaLabel } }}
                    />
                }
                label={<Typography variant='body2'>{label}</Typography>}
            />
            {caption ? (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", ml: "42px", mt: -0.25 }}
                >
                    {caption}
                </Typography>
            ) : null}
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
            PaperProps={{
                sx: {
                    m: { xs: 2, sm: "auto" },
                    width: { xs: "calc(100% - 32px)", sm: "auto" },
                },
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
                    集中管理站点信息、外观风格、图标来源与数据同步。
                </DialogContentText>
                {!isSiteOwner ? (
                    // 外观现在是按账号保存的，改得动；但「改的是谁的」得说清楚，
                    // 否则会以为自己这一改整站都变了（或者反过来以为改了也白改）
                    <Alert severity='info' sx={{ mb: 1.5 }}>
                        外观按账号保存：这里的改动只影响你自己看到的标题、主题与背景。
                        站点所有者的设置同时是登录页与新账号的默认外观。
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
                        hint='配色会随备份同步；圆角与字号只存在这台设备，换设备或换浏览器不跟随。'
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
                                                    : "0 1px 3px rgba(15,23,42,0.18)",
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
                                color='text.secondary'
                                sx={{ display: "block", mt: 0.5 }}
                            >
                                影响按钮、链接高亮、焦点环与卡片悬停色；留空则跟随默认蓝色。
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
                            helperText='留空则不用背景图片，也可以直接点上面的预设壁纸。'
                        />

                        <Box>
                            <Typography variant='body2' color='text.secondary'>
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
                            <Typography variant='caption' color='text.secondary'>
                                值越大背景图越清晰，内容可能越难看清
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
                            <Typography variant='body2' color='text.secondary'>
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
                            <Typography variant='caption' color='text.secondary'>
                                数值越大越朦胧，看不清内容时调小或拖到 0。关闭总开关后滑块不生效，滚动更省。
                            </Typography>
                        </Box>
                    </Section>

                    {/* 4. 图标与缩略图：两个 URL 模板，规则相似，并排放 */}
                    <Section title='图标与缩略图' hint='两项都支持占位符，留空则回落到默认行为。'>
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
                                helperText='留空则不显示缩略图（也不向第三方发请求）。占位符：{url} 完整链接、{domain} 域名、{origin} 协议+域名'
                            />
                        </TwoCol>
                    </Section>

                    {/* 5. 搜索 */}
                    <Section title='搜索'>
                        <SwitchRow
                            checked={pinyinSearch}
                            onChange={onPinyinSearchChange}
                            label='拼音搜索'
                            ariaLabel='拼音搜索'
                            caption='开启后可用首字母搜中文站点（例如「bd」命中「百度」），词典约 28KB，按需加载。'
                        />
                    </Section>

                    {/* 6. 数据同步：两项都是可选，默认关（关着的时候数据只在本机，不上传） */}
                    <Section
                        title='数据同步'
                        hint='默认关闭，数据只留在这台设备的浏览器里；打开后写入服务端数据库，换设备也能看到。开关即时生效，不用点保存。'
                    >
                        <SwitchRow
                            checked={syncHealth}
                            onChange={onSyncHealthChange}
                            label='失效检测结果'
                            ariaLabel='同步失效检测结果'
                            caption='记住哪些链接探测失败过（含「标记为可访问」的白名单），换设备后不用整库重测。'
                        />
                        <SwitchRow
                            checked={syncPrefs}
                            onChange={onSyncPrefsChange}
                            label='星标与标签'
                            ariaLabel='同步星标与标签'
                            caption='这两项按设计只存本机，清掉浏览器数据就没了；打开同步后可找回，多设备之间取并集合并。'
                        />
                        {/* 检测失效链接：和上面的「失效检测结果」开关同属一件事，放在同一节里 */}
                        {onRunLinkCheck && (
                            <Box sx={{ mt: 1.5 }}>
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
                                    color='text.secondary'
                                    sx={{ display: "block", mt: 0.5 }}
                                >
                                    逐个访问已收录的链接，把访问不通的标在卡片上。站点多时要点时间，后台跑完会提示结果。
                                </Typography>
                            </Box>
                        )}
                    </Section>

                    {/* 7. 数据保留：这三项决定「过期数据什么时候真的消失」，
                        都是全站共享配置 —— 服务端只认站点所有者，这里同步禁用并说明原因 */}
                    <Section
                        title='数据保留'
                        hint='决定审计日志、回收站与长期不登录的账号各自保留多久。每周的定时任务按这里的天数清理。'
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
                                inputProps={{ min: RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX }}
                                helperText={`删掉的站点与审计日志留这么多天，到期自动清除（${RETENTION_DAYS_MIN}-${RETENTION_DAYS_MAX}，默认 ${RETENTION_DAYS}）`}
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
                                inputProps={{ min: 30 }}
                                placeholder={String(INACTIVE_DISABLE_DAYS_DEFAULT)}
                                helperText={`超过这个天数没活跃的账号会被停用（数据保留，默认 ${INACTIVE_DISABLE_DAYS_DEFAULT} 天）。站点所有者本人不受影响`}
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
                            inputProps={{ min: 1 }}
                            placeholder={String(INACTIVE_DELETE_GRACE_DAYS_DEFAULT)}
                            helperText={`停用之后还有这么长的反悔期，期间重新启用即可恢复；到期才真正删除并释放数据库空间（默认 ${INACTIVE_DELETE_GRACE_DAYS_DEFAULT} 天）`}
                        />
                    </Section>

                    {/* 8. 高级 */}
                    <Section title='高级' hint='自定义样式会直接注入页面，写错了可能影响显示。'>
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
