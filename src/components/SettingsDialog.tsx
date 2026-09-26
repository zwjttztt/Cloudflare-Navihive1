// src/components/SettingsDialog.tsx
// 全站设置弹窗：标题 / 名称、主题配色、外观风格、图标与缩略图 API、背景、毛玻璃强度、
// 管理员凭据、自定义 CSS。原来内联在 App.tsx 里，是那个文件最大的一块，抽出来单独维护。
// 所有值都走「临时副本 + 点保存才落库」，所以组件本身不碰 API，只负责渲染和回调。
import type { ChangeEvent } from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
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
import { DEFAULT_ICON_API } from "../utils/iconApi";
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

export interface SettingsAuthDraft {
    username: string;
    currentPassword: string;
    newPassword: string;
}

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
    auth: SettingsAuthDraft;
    onAuthChange: (field: keyof SettingsAuthDraft, value: string) => void;
    /** 正在保存：按钮禁用 + 文案变化，避免连点重复提交 */
    saving?: boolean;
    /** 拼音搜索（本机偏好，打开即生效，不需要点保存） */
    pinyinSearch: boolean;
    onPinyinSearchChange: (enabled: boolean) => void;
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
    auth,
    onAuthChange,
    saving = false,
    pinyinSearch,
    onPinyinSearchChange,
}: SettingsDialogProps) {
    return (
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
            <DialogTitle>
                网站设置
                <IconButton
                    aria-label='close'
                    onClick={onClose}
                    sx={{ position: "absolute", right: 8, top: 8 }}
                >
                    <CloseIcon />
                </IconButton>
            </DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ mb: 2 }}>
                    配置网站的基本信息和外观
                </DialogContentText>
                <Stack spacing={2.5}>
                    <TextField
                        margin='dense'
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
                        id='site-name'
                        name='site.name'
                        label='网站名称 (显示在页面中)'
                        type='text'
                        fullWidth
                        variant='outlined'
                        value={tempConfigs["site.name"]}
                        onChange={onConfigInputChange}
                    />

                    {/* 主题配色：预设色 + 取色器，实时预览后点保存生效 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            主题配色
                        </Typography>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
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
                        <Typography variant='caption' color='text.secondary'>
                            影响按钮、链接高亮、焦点环与卡片悬停色。留空则跟随默认蓝色（暗色模式自动切换）。
                        </Typography>
                    </Box>

                    {/* 外观：圆角风格与字号档位，只影响本机显示 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            外观风格
                        </Typography>
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                                <Typography variant='body2' sx={{ minWidth: 56 }}>
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
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                                <Typography variant='body2' sx={{ minWidth: 56 }}>
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
                        </Box>
                        <Typography variant='caption' color='text.secondary'>
                            这两项只存在本机，换设备或换浏览器不会跟随。
                        </Typography>
                    </Box>

                    {/* 拼音搜索：默认关，打开后才加载词典 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 0.5 }}>
                            搜索设置
                        </Typography>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={pinyinSearch}
                                    onChange={e => onPinyinSearchChange(e.target.checked)}
                                    size='small'
                                />
                            }
                            label='拼音搜索'
                        />
                        <Typography variant='caption' color='text.secondary' sx={{ display: "block" }}>
                            开启后可以用首字母搜中文站点（例如「bd」命中「百度」），词典约 28KB，按需加载。
                        </Typography>
                    </Box>

                    {/* 获取图标 API 设置 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            获取图标API设置
                        </Typography>
                        <TextField
                            margin='dense'
                            id='site-icon-api'
                            name='site.iconApi'
                            label='获取图标API URL'
                            type='text'
                            fullWidth
                            variant='outlined'
                            value={tempConfigs["site.iconApi"]}
                            onChange={onConfigInputChange}
                            placeholder={DEFAULT_ICON_API}
                            helperText='输入获取图标API的地址，使用 {domain} 作为域名占位符（例如 https://www.faviconextractor.com/favicon/{domain}?larger=true）'
                        />
                    </Box>

                    {/* 站点缩略图设置 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            站点缩略图设置
                        </Typography>
                        <TextField
                            margin='dense'
                            id='site-thumb-api'
                            name='site.thumbApi'
                            label='缩略图API URL'
                            type='text'
                            fullWidth
                            variant='outlined'
                            value={tempConfigs["site.thumbApi"] || ""}
                            onChange={onConfigInputChange}
                            placeholder='https://example.com/shot?url={url}'
                            helperText='留空则不显示缩略图。可用占位符：{url} 完整链接、{domain} 域名、{origin} 协议+域名'
                        />
                    </Box>

                    {/* 背景图片设置 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            背景图片设置
                        </Typography>
                        {/* 内置壁纸预设：点一下即用，也可以自己在下面填图片 URL */}
                        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
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
                            id='site-background-image'
                            name='site.backgroundImage'
                            label='背景图片URL'
                            type='text'
                            fullWidth
                            variant='outlined'
                            value={tempConfigs["site.backgroundImage"]}
                            onChange={onConfigInputChange}
                            placeholder='https://example.com/background.jpg'
                            helperText='输入图片URL，留空则不使用背景图片（也可以直接用上面的预设壁纸）'
                        />
                        <Box sx={{ mt: 2 }}>
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
                            />
                            <Typography variant='caption' color='text.secondary'>
                                值越大，背景图片越清晰，内容可能越难看清
                            </Typography>
                        </Box>
                    </Box>

                    {/* 毛玻璃：总开关 + 模糊强度 */}
                    <Box>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                            <Typography variant='subtitle1' fontWeight='600'>
                                毛玻璃特效
                            </Typography>
                            <Box sx={{ flex: 1 }} />
                            <FormControlLabel
                                control={
                                    <Switch
                                        checked={glassEffects}
                                        size='small'
                                        onChange={e => onGlassEffectsChange(e.target.checked)}
                                        inputProps={{ "aria-label": "毛玻璃特效" }}
                                    />
                                }
                                label={glassEffects ? "开" : "关"}
                                sx={{ mr: 0 }}
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
                            disabled={!glassEffects}
                        />
                        <Typography variant='caption' color='text.secondary'>
                            {glassEffects
                                ? "数值越大越朦胧。内容看不清时调小，或直接拖到 0 关掉模糊。"
                                : "特效已关闭：不再实时模糊背后的画面，滚动更省，也不会在圆角边缘露出暗边。滑块只在开启时生效。"}
                        </Typography>
                    </Box>

                    {/* 管理员账号与密码 */}
                    <Box>
                        <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                            管理员账号与密码
                        </Typography>
                        <Typography
                            variant='caption'
                            color='text.secondary'
                            sx={{ display: "block", mb: 1 }}
                        >
                            凭据保存在数据库中，只有第一次部署才会使用默认账号密码，之后重新部署不会覆盖；留空表示不修改。
                        </Typography>
                        <TextField
                            margin='dense'
                            id='auth-username'
                            label='管理员账号'
                            type='text'
                            fullWidth
                            variant='outlined'
                            value={auth.username}
                            onChange={e => onAuthChange("username", e.target.value)}
                            placeholder='留空则不修改账号'
                        />
                        <TextField
                            margin='dense'
                            id='auth-current-password'
                            label='当前密码'
                            type='password'
                            fullWidth
                            variant='outlined'
                            value={auth.currentPassword}
                            onChange={e => onAuthChange("currentPassword", e.target.value)}
                            placeholder='修改账号或密码时必须填写'
                        />
                        <TextField
                            margin='dense'
                            id='auth-new-password'
                            label='新密码'
                            type='password'
                            fullWidth
                            variant='outlined'
                            value={auth.newPassword}
                            onChange={e => onAuthChange("newPassword", e.target.value)}
                            placeholder='留空则不修改密码'
                        />
                    </Box>

                    <TextField
                        margin='dense'
                        id='site-custom-css'
                        name='site.customCss'
                        label='自定义CSS'
                        type='text'
                        fullWidth
                        multiline
                        rows={6}
                        variant='outlined'
                        value={tempConfigs["site.customCss"]}
                        onChange={onConfigInputChange}
                        placeholder='/* 自定义样式 */\nbody { }'
                    />
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 3 }}>
                <Button onClick={onClose} variant='outlined'>
                    取消
                </Button>
                <Button onClick={onSave} variant='contained' color='primary' disabled={saving}>
                    {saving ? "保存中…" : "保存设置"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
