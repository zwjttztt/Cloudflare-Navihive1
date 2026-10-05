// src/components/SiteSettingsModal.tsx
import { useRef, useState } from "react";
import { Site, Group } from "../API/http";
import ConfirmDialog from "./ConfirmDialog";
// Material UI 导入
import type { Theme } from "@mui/material";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Button,
    IconButton,
    Typography,
    Box,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
    Stack,
    Divider,
    Avatar,
    CircularProgress,
    useTheme,
    SelectChangeEvent,
    InputAdornment,
    Tooltip,
    Chip,
} from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import { useUIPrefsPrefs, useUIPrefsStable } from "../context/uiPrefsStore";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import { useSiteAi } from "../context/AiContext";
import { copyToClipboard } from "../utils/clipboard";
import { resolveIconApiUrl } from "../utils/iconApi";
import { pickExistingTags, pickRecommendedTags } from "../utils/tagSuggest";
import { useAppConfig } from "../context/appConfigStore";
import {
    formDataKey,
    secretInputSx,
    secretInputType,
    SECRET_IGNORE_ATTRS,
} from "../utils/secretInput";

interface SiteSettingsModalProps {
    site: Site;
    onUpdate: (updatedSite: Site) => void;
    onDelete: (siteId: number) => void;
    onClose: () => void;
    groups?: Group[]; // 可选的分组列表
    /**
     * 打开就直接进「备注放大窗」。
     *
     * 卡片右键的「编辑备注」用它 —— 用户既然点了备注，就不该先看到一整屏设置再自己找备注框。
     * 只在**首次挂载**时生效：本组件是条件渲染（`showSettings && <Modal/>`），
     * 每次打开都是新挂载，所以 useState 的初始值刚好对上；
     * 万一将来改成常驻挂载，得改成「open 从 false→true 时同步」而不是只认初始值。
     */
    initiallyExpandNotes?: boolean;
    /**
     * **只显示备注窗**，不渲染网站设置主窗。
     *
     * 卡片右键「编辑备注」走这条：用户要的就是改备注，先给他糊一整屏设置再等他自己
     * 找到备注框，是把「三步」做成「五步」。
     *
     * 与 initiallyExpandNotes 分开而不是合并成一个 flag：两个诉求不同 ——
     * 「打开就是放大态」也可能是在主窗里点放大按钮（这时主窗要在下面垫着），
     * 而右键是**根本不要主窗**。合成一个 flag 就没法表达后者。
     */
    notesOnly?: boolean;

}

/**
 * 网站设置面板的样式，**主窗与「备注放大窗」共用同一份**。
 *
 * 为什么抽出来：之前放大窗只抄了 borderRadius，毛玻璃、边框、阴影、背景全没抄，
 * 结果它看起来比主窗「小了一号」—— 用户一看就觉得是两个不同的弹窗。
 * 这类「两个窗口要长得一样」的约定，最容易在只改了一处时悄悄漂移，
 * 所以让它们**共用同一个对象**，以后改主题只改这一处。
 */
function settingsPaper(theme: Theme) {
    return {
        className: "nav-settings-dialog",
        sx: {
            display: "flex",
            flexDirection: "column",
            // **固定高度**，两个窗因此永远一样大。
            //
            // 之前试过「点开时量主窗的 offsetHeight、当放大窗的 minHeight」，实测没生效
            // —— 那是动态测出来的：量不到（ref 没挂上 / 布局未完成）就静默退化成
            // 「按内容自适应」，于是又矮一截。为这件事用户反馈了三轮。
            // 固定高度是唯一可靠的做法：两窗用**同一个函数**，值来自同一处，不可能不一致。
            // 视口不够高时用 calc 收窄，小屏上不会超出屏幕。
            height: "min(700px, calc(100vh - 104px))",
            // 和确认弹窗/提示条同一套毛玻璃面板，视觉统一
            borderRadius: "var(--card-radius)",
            backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
            WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
            border: "1px solid var(--glass-panel-border)",
            boxShadow: "var(--glass-shadow-hover)",
            backgroundColor:
                theme.palette.mode === "dark"
                    ? "rgba(23,27,38,0.94)"
                    : "rgba(255,255,255,0.94)",
        },
    };
}

export default function SiteSettingsModal({
    site,
    onUpdate,
    onDelete,
    onClose,
    groups = [],
    initiallyExpandNotes,
    notesOnly = false,
}: SiteSettingsModalProps) {
    const theme = useTheme();
    // 全局「网站设置」里的获取图标 API 模板
    const { iconApi } = useAppConfig();
    // 星标与标签存本机（不在数据库表里），但会随备份文件一起导出/恢复
    // 星标 / 标签走 prefs 那份，写操作走 stable（引用恒定）：
    // 这个弹窗开着时点卡片记访问，不该让它整个重渲染
    const { isStarred, tags, allTags } = useUIPrefsPrefs();
    const { toggleStar, setSiteTags } = useUIPrefsStable();
    const starred = isStarred(site.id);
    const siteTags = tags[String(site.id)] ?? [];
    const [tagInput, setTagInput] = useState("");

    // 标签输入框右侧的快捷候选（点一下直接加进标签框）
    const existingSuggestions = pickExistingTags(allTags, siteTags);
    const recommendedSuggestions = pickRecommendedTags(allTags, siteTags);

    /** 把一个标签直接加到这张卡片上（候选点击 / 回车提交都走这里） */
    const addTags = (values: string[]) => {
        const next = Array.from(new Set([...siteTags, ...values]));
        if (next.length === siteTags.length) return;
        setSiteTags(site.id as number, next);
    };

    // 回车或逗号即确认：标签写进本机偏好，不需要点「保存」
    const commitTag = () => {
        const value = tagInput.trim().replace(/[,，]$/, "");
        if (!value) return;
        addTags(value.split(/[,，]/).map(t => t.trim()).filter(Boolean));
        setTagInput("");
    };

    // 打开设置时的初始表单值：用来判断「有没有真的改过」，没改就静默关闭
    const buildInitialForm = () => {
        // 打开设置时若还没有图标，就先按「网站链接 + 获取图标API」自动补一个
        const initialIcon = site.icon || resolveIconApiUrl(iconApi, site.url || "");
        return {
            name: site.name || "",
            url: site.url || "",
            icon: initialIcon || "",
            description: site.description || "",
            notes: site.notes || "",
            username: site.username || "",
            password: site.password || "",
            group_id: String(site.group_id),
        };
    };

    // 存储字符串形式的group_id，与Material-UI的Select兼容
    const [formData, setFormData] = useState(buildInitialForm);

    // 备注的放大编辑弹窗。备注是这一屏里唯一「可能写很长」的字段，
    // 两行框里改长文本很难受（要拖着框边角拉），所以给一个和本弹窗同尺寸的
    // 大输入框。共用同一份 formData.notes —— 不做两份再同步，少一处能写错的地方。
    const [notesExpanded, setNotesExpanded] = useState(!!initiallyExpandNotes);

    // 备注窗的「关闭」出口。notesOnly 时没有主窗垫着，关掉就是整个弹窗没了；
    // 普通情况下只是从放大态退回主窗，编辑还在原地。
    const closeNotes = () => {
        setNotesExpanded(false);
        if (notesOnly) onClose();
    };

    // 备注窗的「保存」出口。普通情况下改的是共享的 formData.notes，回主窗再点保存
    // 才真正写库；notesOnly 时没有主窗，所以这里就得直接把改动写回去。
    const saveNotes = () => {
        if (notesOnly) {
            onUpdate({ ...site, notes: formData.notes || "" });
            onClose();
            return;
        }
        setNotesExpanded(false);
    };

    // 初始快照只取第一次渲染的值，之后不再变
    const initialRef = useRef<ReturnType<typeof buildInitialForm> | null>(null);
    if (!initialRef.current) initialRef.current = { ...formData };

    // 有没有实际改动（含图标被自动补齐这类隐式变化）
    const isDirty = (Object.keys(formData) as (keyof typeof formData)[]).some(
        key => formData[key] !== initialRef.current![key]
    );

    // 用于预览图标
    const [iconPreview, setIconPreview] = useState<string | null>(
        site.icon || resolveIconApiUrl(iconApi, site.url || "") || null
    );

    // 密码是否明文显示
    // AI 补全走 context：卡片是 memo 的，把助手当 prop 一层层传下去会让所有卡片重渲染
    const ai = useSiteAi();
    const [showPassword, setShowPassword] = useState(false);
    // 复制成功提示（"" | "username" | "password"）
    const [copiedField, setCopiedField] = useState<"" | "username" | "password">("");
    // 一键获取图标的结果提示
    const [iconFetchMessage, setIconFetchMessage] = useState("");
    // AI 补全：进行中 + 「想说的坏消息」（只有失败原因）；成功不说话
    const [aiBusy, setAiBusy] = useState(false);
    const [aiMessage, setAiMessage] = useState("");
    const [aiMessageError, setAiMessageError] = useState(false);

    /**
     * AI 补全：只填名称与描述。不再建议分组 —— 偷偷改分组用户容易没察觉，
     * 而且建议的新分组名还会诱导「自动建分组」这种写操作。分组交给用户自己选。
     * 填进去了就安静地填（值本身看得见）；只有失败才显示原因。
     */
    const handleAiComplete = async () => {
        if (!ai || !formData.url) return;
        setAiBusy(true);
        setAiMessage("");
        setAiMessageError(false);
        const groupNames = groups.map(g => g.name);
        const res = await ai.siteMeta(formData.url, {
            name: formData.name || undefined,
            groups: groupNames,
            tags: allTags,
        });
        setAiBusy(false);
        if (!res.ok) {
            setAiMessage(res.message);
            setAiMessageError(true);
            return;
        }
        const { name, description } = res.data;
        setFormData(prev => ({
            ...prev,
            name: name || prev.name,
            description: description || prev.description,
        }));
    };

    // 一键根据「网站链接」生成图标 URL
    const handleFetchIcon = () => {
        const resolved = resolveIconApiUrl(iconApi, formData.url);
        if (!resolved) {
            setIconFetchMessage("请先填写有效的网站链接");
            window.setTimeout(() => setIconFetchMessage(""), 2000);
            return;
        }

        setFormData(prev => ({ ...prev, icon: resolved }));
        setIconPreview(resolved);
        setIconFetchMessage("已获取图标URL");
        window.setTimeout(() => setIconFetchMessage(""), 2000);
    };

    // 一键复制账号或密码
    const handleCopy = async (field: "username" | "password") => {
        const value = formData[field];
        if (!value) return;

        const ok = await copyToClipboard(value);
        if (ok) {
            setCopiedField(field);
            window.setTimeout(() => setCopiedField(""), 1500);
        }
    };

    const copyButton = (field: "username" | "password", label: string) => (
        <Tooltip title={copiedField === field ? "已复制" : label} open={copiedField === field || undefined}>
            <IconButton
                size='small'
                onClick={() => handleCopy(field)}
                disabled={!formData[field]}
                aria-label={label}
            >
                <ContentCopyIcon fontSize='small' />
            </IconButton>
        </Tooltip>
    );

    // 处理表单字段变化
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        // name 为避浏览器识别改叫 site-account / site-secret，状态里的键仍是 username / password
        setFormData(prev => ({ ...prev, [formDataKey(name)]: value }));
    };

    // 处理下拉列表变化
    const handleSelectChange = (e: SelectChangeEvent) => {
        setFormData(prev => ({
            ...prev,
            group_id: e.target.value,
        }));
    };

    // 修改「网站链接」时，自动按图标 API 模板同步图标 URL。
    // 只有图标为空、或图标仍是自动生成的值时才覆盖，用户手动填过的图标不会被冲掉。
    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        const autoIcon = resolveIconApiUrl(iconApi, value);
        const prevAutoIcon = resolveIconApiUrl(iconApi, formData.url);
        const canAutoFill = !formData.icon || formData.icon === prevAutoIcon;

        if (!canAutoFill) {
            setFormData(prev => ({ ...prev, url: value }));
            return;
        }

        setFormData(prev => ({ ...prev, url: value, icon: autoIcon }));
        setIconPreview(autoIcon || null);
    };

    // 处理图标上传或URL输入
    const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { value } = e.target;
        setFormData(prev => ({ ...prev, icon: value }));

        // 检查URL是否是有效的图片URL
        const isValidImageUrl = (url: string): boolean => {
            // 检查URL格式
            try {
                new URL(url);
                // 只要是 http(s) 或 data:image 就允许预览
                // （favicon 服务类的地址常常没有文件扩展名，加载失败时 onError 会自动清掉预览）
                return /^https?:\/\//i.test(url) || /^data:image\//i.test(url);
            } catch {
                return false;
            }
        };

        // 仅当输入看起来像有效的图片URL时才设置预览
        if (value && isValidImageUrl(value)) {
            setIconPreview(value);
        } else {
            setIconPreview(null);
        }
    };

    // 处理图标加载错误
    const handleIconError = () => {
        setIconPreview(null);
    };

    // 提交表单
    const handleSubmit = (e?: React.SyntheticEvent) => {
        e?.preventDefault();
        e?.stopPropagation();

        // 没有任何改动：不写库、不弹「卡片已更新」，直接关掉
        if (!isDirty) {
            onClose();
            return;
        }

        // 更新网站信息，将group_id转为数字
        onUpdate({
            ...site,
            ...formData,
            group_id: Number(formData.group_id),
        });

        onClose();
    };

    // 删除确认弹窗是否可见
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    // 点「删除」先弹站内确认框（替代浏览器原生 confirm）
    const handleDeleteClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setConfirmDeleteOpen(true);
    };

    // 确认删除
    const handleConfirmDelete = () => {
        setConfirmDeleteOpen(false);
        if (site.id == null) return;
        onDelete(site.id);
        onClose();
    };

    // 计算首字母图标
    const fallbackIcon = formData.name?.charAt(0).toUpperCase() || "A";

    return (
        <>
        {/* notesOnly：只要备注窗，主窗整个不渲染（少开一个遮罩，也少一层焦点陷阱） */}
        {!notesOnly && (
        <Dialog
            open={true}
            onClose={onClose}
            fullWidth
            maxWidth='sm'
            slotProps={{ paper: settingsPaper(theme) }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 1,
                    // 左右内边距和内容区（DialogContent 默认 24px）对齐，标题与下面字段同一竖直基准线
                    px: 3,
                    pt: 2,
                    pb: 1,
                }}
            >
                <Typography variant='h6' component='div' sx={{
                    fontWeight: '600'
                }}>
                    网站设置
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    {/* 星标置顶：从表单中部挪到标题右侧，一眼能看到、随手可点 */}
                    <Chip
                        icon={
                            starred ? (
                                <StarIcon />
                            ) : (
                                <StarBorderIcon />
                            )
                        }
                        label={starred ? "已加星标" : "加星标置顶"}
                        size='small'
                        variant={starred ? "filled" : "outlined"}
                        color={starred ? "primary" : "default"}
                        onClick={() => toggleStar(site.id)}
                        className='nav-settings-star'
                    />
                    <IconButton
                        color='inherit'
                        onClick={onClose}
                        aria-label='关闭'
                        size='small'
                    >
                        <CloseIcon />
                    </IconButton>
                </Box>
            </DialogTitle>

            <Divider />

            {/*
              这里刻意**不用 <form>**：表单里同时有「账号」和「密码」（type=password）两个
              输入框，浏览器会把它当成登录表单 —— 每次保存卡片都弹「要不要保存密码」，
              还会拿导航站自己的登录凭据来自动填充。改成容器 div + 按钮自己触发提交，
              浏览器就没有「表单被提交」这个信号了；回车提交在 onKeyDown 里补上，
              体验不变。
            */}
            <Box
                component='div'
                // 固定高度之后字段多就必须能滚，否则底部的凭据区会被挤出弹窗够不着。
                // minHeight:0 是 flex 子项能滚的前提 —— 少了它 flex:1 撑不开、overflow 也不生效。
                sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}
                onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key !== "Enter") return;
                    // 输入法正在拼字时的回车是「选词」，不能当成提交
                    if (e.nativeEvent.isComposing) return;
                    // 回车已经被里面的输入框用掉了（比如标签框拿它「确认输入」），
                    // 那是人家的语义，别再顺手把整个弹窗提交掉
                    if (e.defaultPrevented) return;
                    // 备注是多行文本，那里回车要换行
                    const target = e.target as HTMLElement | null;
                    if (target?.tagName === "TEXTAREA") return;
                    e.preventDefault();
                    handleSubmit();
                }}
            >
                <DialogContent
                    sx={{
                        pt: 2,
                        pb: 1,
                        // 整体收紧，避免出现上下滚动
                        "& .MuiInputBase-input": { fontSize: 14 },
                        "& .MuiInputLabel-root": { fontSize: 14 },
                        "& .MuiFormHelperText-root": { fontSize: 12 },
                    }}
                >
                    <Stack spacing={1.25}>
                        {/* 网站名称 */}
                        <TextField
                            id='name'
                            name='name'
                            label='网站名称'
                            required
                            fullWidth
                            value={formData.name || ""}
                            onChange={handleChange}
                            placeholder='输入网站名称'
                            variant='outlined'
                            size='small'
                        />

                        {/* 网站链接：AI 补全按钮在框右侧（要先把链接发给模型，所以按钮放这） */}
                        <TextField
                            id='url'
                            name='url'
                            label='网站链接'
                            required
                            fullWidth
                            value={formData.url || ""}
                            onChange={handleUrlChange}
                            placeholder='https://example.com'
                            variant='outlined'
                            size='small'
                            type='url'
                            slotProps={
                                ai?.enabled
                                    ? {
                                          input: {
                                              endAdornment: (
                                                  <InputAdornment position='end'>
                                                      <Tooltip
                                                          title={
                                                              ai.ready
                                                                  ? "让 AI 根据链接补全名称与简介（会先把链接发给模型）"
                                                                  : (ai.reason ?? "AI 助手不可用")
                                                          }
                                                      >
                                                          <span>
                                                              <IconButton
                                                                  size='small'
                                                                  edge='end'
                                                                  aria-label='AI 补全名称与简介'
                                                                  disabled={
                                                                      !ai.ready || aiBusy || !formData.url
                                                                  }
                                                                  onClick={() => void handleAiComplete()}
                                                              >
                                                                  {aiBusy ? (
                                                                      <CircularProgress size={16} />
                                                                  ) : (
                                                                      <AutoAwesomeIcon fontSize='small' />
                                                                  )}
                                                              </IconButton>
                                                          </span>
                                                      </Tooltip>
                                                  </InputAdornment>
                                              ),
                                          },
                                      }
                                    : undefined
                            }
                        />

                        {aiMessage ? (
                            <Typography
                                variant='caption'
                                color={aiMessageError ? "error" : "text.secondary"}
                                sx={{ display: "block", mt: -1 }}
                            >
                                {aiMessage}
                            </Typography>
                        ) : null}

                        {/* 网站图标：原来的「图标 URL」小标题直接做成输入框的浮动 label，省一整行 */}
                        <Box sx={{ display: "flex", gap: 1.25, alignItems: "center" }}>
                            {iconPreview ? (
                                <Avatar
                                    src={iconPreview}
                                    alt={formData.name || "Icon Preview"}
                                    sx={{ width: 34, height: 34, borderRadius: 1.5, flexShrink: 0 }}
                                    variant='rounded'
                                    slotProps={{
                                        img: {
                                            onError: handleIconError,
                                            style: { objectFit: "cover" },
                                        }
                                    }}
                                />
                            ) : (
                                <Avatar
                                    sx={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: 1.5,
                                        flexShrink: 0,
                                        bgcolor: "primary.light",
                                        color: "primary.main",
                                        border: "1px solid",
                                        borderColor: "primary.main",
                                    }}
                                    variant='rounded'
                                >
                                    {fallbackIcon}
                                </Avatar>
                            )}

                            <TextField
                                id='icon'
                                name='icon'
                                label='图标 URL'
                                fullWidth
                                value={formData.icon || ""}
                                onChange={handleIconChange}
                                placeholder='https://example.com/icon.png'
                                variant='outlined'
                                size='small'
                                slotProps={{
                                    input: {
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <Tooltip
                                                    title={
                                                        iconFetchMessage ||
                                                        "根据网站链接一键获取图标URL"
                                                    }
                                                    open={iconFetchMessage ? true : undefined}
                                                >
                                                    <span>
                                                        <IconButton
                                                            size='small'
                                                            edge='end'
                                                            onClick={handleFetchIcon}
                                                            disabled={!formData.url}
                                                            aria-label='根据网站链接获取图标URL'
                                                        >
                                                            <AutoFixHighIcon fontSize='small' />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                            </InputAdornment>
                                        ),
                                    },

                                    inputLabel: { shrink: true }
                                }} />
                        </Box>

                        {/* 分组选择 */}
                        {groups.length > 0 && (
                            <FormControl fullWidth size='small'>
                                <InputLabel id='group-select-label'>所属分组</InputLabel>
                                <Select
                                    labelId='group-select-label'
                                    id='group_id'
                                    name='group_id'
                                    value={formData.group_id}
                                    label='所属分组'
                                    onChange={handleSelectChange}
                                >
                                    {groups.map(group => (
                                        <MenuItem key={group.id} value={String(group.id)}>
                                            {group.name}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                        )}

                        {/* 标签：标题同样做成输入框的浮动 label；右边是已加标签 + 现有/推荐候选 */}
                        <Box>
                            <Box
                                sx={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 0.75,
                                    alignItems: "center",
                                }}
                            >
                                <TextField
                                    value={tagInput}
                                    onChange={e => setTagInput(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === "Enter" || e.key === ",") {
                                            e.preventDefault();
                                            commitTag();
                                        }
                                    }}
                                    onBlur={commitTag}
                                    label='标签'
                                    placeholder='输入后回车'
                                    size='small'
                                    sx={{ width: 128, "& .MuiInputBase-input": { fontSize: 13 } }}
                                    slotProps={{
                                        htmlInput: { "aria-label": "添加标签" },
                                        inputLabel: { shrink: true }
                                    }} />

                                {siteTags.map(tag => (
                                    <Chip
                                        key={tag}
                                        label={tag}
                                        size='small'
                                        variant='outlined'
                                        className='nav-tag-added'
                                        onDelete={() =>
                                            setSiteTags(
                                                site.id as number,
                                                siteTags.filter(item => item !== tag)
                                            )
                                        }
                                    />
                                ))}

                                {/* 输入框右侧：现有标签 / 推荐标签，点一下就加进标签框 */}
                                {existingSuggestions.length > 0 && (
                                    <Box
                                        className='nav-tag-suggest-group'
                                        data-kind='existing'
                                        sx={{
                                            display: "flex",
                                            flexWrap: "wrap",
                                            alignItems: "center",
                                            gap: 0.5,
                                        }}
                                    >
                                        <span className='nav-tag-suggest-label'>现有</span>
                                        {existingSuggestions.map(tag => (
                                            <Chip
                                                key={tag}
                                                label={tag}
                                                size='small'
                                                variant='outlined'
                                                className='nav-tag-suggest'
                                                onClick={() => addTags([tag])}
                                                aria-label={`添加标签 ${tag}`}
                                            />
                                        ))}
                                    </Box>
                                )}

                                {recommendedSuggestions.length > 0 && (
                                    <Box
                                        className='nav-tag-suggest-group'
                                        data-kind='recommend'
                                        sx={{
                                            display: "flex",
                                            flexWrap: "wrap",
                                            alignItems: "center",
                                            gap: 0.5,
                                        }}
                                    >
                                        <span className='nav-tag-suggest-label'>推荐</span>
                                        {recommendedSuggestions.map(tag => (
                                            <Chip
                                                key={tag}
                                                label={tag}
                                                size='small'
                                                variant='outlined'
                                                className='nav-tag-suggest'
                                                onClick={() => addTags([tag])}
                                                aria-label={`添加推荐标签 ${tag}`}
                                            />
                                        ))}
                                    </Box>
                                )}
                            </Box>
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    display: 'block',
                                    mt: 0.5
                                }}>
                                回车即可加标签（可一次输入多个，用逗号分隔），也可以直接点右侧的现有/推荐标签。
                            </Typography>
                        </Box>

                        {/* 网站描述：单行，长度与网站名称一致 */}
                        <TextField
                            id='description'
                            name='description'
                            label='网站描述'
                            fullWidth
                            value={formData.description || ""}
                            onChange={handleChange}
                            placeholder='简短的网站描述'
                            variant='outlined'
                            size='small'
                        />

                        {/* 备注：放在网站描述下方。右侧放大按钮开大输入框（见 notesExpanded） */}
                        <TextField
                            id='notes'
                            name='notes'
                            label='备注'
                            multiline
                            rows={2}
                            fullWidth
                            value={formData.notes || ""}
                            onChange={handleChange}
                            placeholder='可选的私人备注'
                            variant='outlined'
                            size='small'
                            slotProps={{
                                input: {
                                    endAdornment: (
                                        <InputAdornment position='end'>
                                            <Tooltip title='放大编辑'>
                                                <span>
                                                    <IconButton
                                                        size='small'
                                                        edge='end'
                                                        aria-label='放大编辑备注'
                                                        onClick={() => setNotesExpanded(true)}
                                                    >
                                                        <FullscreenIcon fontSize='small' />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </InputAdornment>
                                    ),
                                },
                            }}
                        />

                        <Divider />

                        {/* 登录凭据：账号 / 密码 + 一键复制；说明文字挪到标题右侧，不再单独占一行 */}
                        <Box>
                            <Box
                                sx={{
                                    display: "flex",
                                    alignItems: "baseline",
                                    justifyContent: "space-between",
                                    gap: 1,
                                    flexWrap: "wrap",
                                    mb: 1,
                                }}
                            >
                                <Typography variant='subtitle2' sx={{
                                    fontWeight: '600'
                                }}>
                                    登录凭据
                                </Typography>
                                <Typography
                                    variant='caption'
                                    sx={{
                                        color: 'text.secondary',
                                        textAlign: "right",
                                        flex: "1 1 auto"
                                    }}>
                                    保存后可随时一键复制；凭据会随备份文件一起导出，请妥善保管备份。
                                </Typography>
                            </Box>
                            <Stack
                                direction={{ xs: "column", sm: "row" }}
                                spacing={1.5}
                                sx={{ gap: { xs: 1.5, sm: 1.5 } }}
                            >
                                    <TextField
                                        id='username'
                                        // name 刻意不叫 username：浏览器靠「名字 + 类型」猜这是登录表单，
                                        // 叫了它就会拿导航站自己的登录凭据来填卡片的账号框
                                        name='site-account'
                                        label='账号'
                                        fullWidth
                                        value={formData.username || ""}
                                        onChange={handleChange}
                                        placeholder='登录用户名 / 邮箱 / 手机号'
                                        variant='outlined'
                                        size='small'
                                        autoComplete='off'
                                        slotProps={{
                                            input: {
                                                endAdornment: (
                                                    <InputAdornment position='end'>
                                                        {copyButton("username", "复制账号")}
                                                    </InputAdornment>
                                                ),
                                            },

                                            htmlInput: { ...SECRET_IGNORE_ATTRS }
                                        }} />
                                <TextField
                                    id='password'
                                    // 同上：不叫 password、不写 new-password。
                                    // 光靠名字和 autocomplete 挡不住 —— Chrome 有 formless 检测，
                                    // 没有 <form> 它照样提示保存。真正的办法是让浏览器认不出这是
                                    // 密码字段：type 换成 text + CSS 遮蔽（见 utils/secretInput.ts）
                                    name='site-secret'
                                    label='密码'
                                    fullWidth
                                    type={secretInputType(showPassword)}
                                    sx={secretInputSx(showPassword)}
                                    value={formData.password || ""}
                                    onChange={handleChange}
                                    placeholder='登录密码'
                                    variant='outlined'
                                    size='small'
                                    autoComplete='off'
                                    slotProps={{
                                        input: {
                                            endAdornment: (
                                                <InputAdornment position='end'>
                                                    <IconButton
                                                        size='small'
                                                        onClick={() => setShowPassword(prev => !prev)}
                                                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                                                        edge={formData.password ? undefined : "end"}
                                                    >
                                                        {showPassword ? (
                                                            <VisibilityOffIcon fontSize='small' />
                                                        ) : (
                                                            <VisibilityIcon fontSize='small' />
                                                        )}
                                                    </IconButton>
                                                    {copyButton("password", "复制密码")}
                                                </InputAdornment>
                                            ),
                                        },

                                        htmlInput: { ...SECRET_IGNORE_ATTRS }
                                    }} />
                            </Stack>
                        </Box>
                    </Stack>
                </DialogContent>

                <DialogActions sx={{ px: 3, pb: 2.5, pt: 1, justifyContent: "space-between" }}>
                    <Button
                        onClick={handleDeleteClick}
                        color='error'
                        variant='contained'
                        startIcon={<DeleteIcon />}
                    >
                        删除
                    </Button>

                    <Box>
                        <Button
                            onClick={onClose}
                            color='inherit'
                            variant='outlined'
                            sx={{ mr: 1.5 }}
                            startIcon={<CancelIcon />}
                        >
                            取消
                        </Button>
                        <Button
                            type='button'
                            onClick={() => handleSubmit()}
                            color='primary'
                            variant='contained'
                            startIcon={<SaveIcon />}
                        >
                            保存
                        </Button>
                    </Box>
                </DialogActions>
            </Box>

            {/* 删除确认：站内统一样式的确认弹窗（不再是浏览器原生 confirm） */}
            <ConfirmDialog
                open={confirmDeleteOpen}
                title='删除这个网站？'
                description={`删除后「${
                    formData.name || site.name || "这个网站"
                }」将无法恢复，保存的账号密码也会一并删除。`}
                confirmText='删除'
                danger
                impact={{ object: "网站", count: 1, undoable: false }}
                busyText='删除中…'
                onConfirm={handleConfirmDelete}
                onClose={() => setConfirmDeleteOpen(false)}
            />
        </Dialog>
        )}

        {/* 备注放大编辑：尺寸与网站设置一致（fullWidth + maxWidth='sm'），
            差别只在里面的输入框更高。放在主 Dialog **外面** —— 弹窗套弹窗时
            关掉大窗不会顺手把设置也关掉。共用 formData.notes，不做第二份状态。 */}
        <Dialog
            open={notesExpanded}
            onClose={closeNotes}
            fullWidth
            maxWidth='sm'
            slotProps={{ paper: settingsPaper(theme) }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 1,
                }}
            >
                备注
                <IconButton
                    aria-label='关闭'
                    onClick={closeNotes}
                    size='small'
                >
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ flex: 1, display: "flex" }}>
                <TextField
                    id='notes-expanded'
                    name='notes'
                    // 故意不给 label：窗口标题已经是「备注」了，再挂一个就成了重复标签，
                    // 而且 autoFocus 时 label 的收缩动画容易和 placeholder 叠字（真踩到过）。
                    // 可见标签由 DialogTitle 承担，这里补 aria-label 保住语义。
                    slotProps={{ htmlInput: { "aria-label": "备注" } }}
                    multiline
                    // 比主弹窗的两行宽裕得多：这就是这个弹窗存在的意义
                    rows={10}
                    // 定高之后输入框要吃掉多出来的那截，否则备注框下面空一大块，
                    // 看起来完全不像「放大」了。
                    // ⚠️ 只写 flex:1 不够 —— 那只能撑开 FormControl，textarea 在
                    // InputBase 内部有自己的高度，必须连它一起设成 100%。
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        "& .MuiInputBase-root": { height: "100%" },
                        // ⚠️ textarea 自己也要 100%：只设 InputBase 的话，textarea 仍是
                        // rows={10} 那个高度，框的下半截点不进焦点（用户报「只有当中能打字」）
                        "& textarea": { height: "100%" },
                    }}
                    fullWidth
                    value={formData.notes || ""}
                    onChange={handleChange}
                    placeholder='可选的私人备注'
                    variant='outlined'
                    size='small'
                    // 打开就把光标放进去接着写，不用再点一下
                    autoFocus
                />
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2.5, pt: 1 }}>
                <Button onClick={saveNotes} variant='contained' color='primary'>
                    保存
                </Button>
            </DialogActions>
        </Dialog>
        </>
    );
}