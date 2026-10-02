// src/components/SiteSettingsModal.tsx
import { useRef, useState } from "react";
import { Site, Group } from "../API/http";
import ConfirmDialog from "./ConfirmDialog";
// Material UI 导入
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
import { useUIPrefsPrefs, useUIPrefsStable } from "../context/UIPrefsContext";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useSiteAi } from "../context/AiContext";
import { copyToClipboard } from "../utils/clipboard";
import { resolveIconApiUrl } from "../utils/iconApi";
import { pickExistingTags, pickRecommendedTags } from "../utils/tagSuggest";
import { useAppConfig } from "../context/AppConfigContext";
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

}

export default function SiteSettingsModal({
    site,
    onUpdate,
    onDelete,
    onClose,
    groups = [],
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
    // AI 补全：进行中 + 「想说的坏消息」（失败原因 / 分组建议没法落地）；成功不说话
    const [aiBusy, setAiBusy] = useState(false);
    const [aiMessage, setAiMessage] = useState("");
    const [aiMessageError, setAiMessageError] = useState(false);

    /**
     * AI 补全：只填名称与描述，分组只做「选中已有分组」这一件事。
     * 建议的新分组名不自动建分组 —— 建了就是一次写操作，而用户还没点保存。
     * 填进去了就安静地填（值本身看得见，不用再播报一遍）；只有「想说的坏消息」才显示。
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
        const { name, description, group } = res.data;
        setFormData(prev => ({
            ...prev,
            name: name || prev.name,
            description: description || prev.description,
            // 只认已有分组：建议的新名字没这个分组，不能凭空造一个 id
            group_id: groupNames.includes(group) ? String(groups[groupNames.indexOf(group)].id) : prev.group_id,
        }));
        // 唯一值得开口的情况：模型给了分组名，但站点里还没有这个分组
        if (group && !groupNames.includes(group)) {
            setAiMessage(`AI 建议分组「${group}」，但还没有这个分组，没帮你改`);
        }
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
        <Dialog
            open={true}
            onClose={onClose}
            fullWidth
            maxWidth='sm'
            PaperProps={{
                className: "nav-settings-dialog",
                sx: {
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
            }}
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
                <Typography variant='h6' component='div' fontWeight='600'>
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
                                    imgProps={{
                                        onError: handleIconError,
                                        style: { objectFit: "cover" },
                                    }}
                                    variant='rounded'
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
                                InputLabelProps={{ shrink: true }}
                                fullWidth
                                value={formData.icon || ""}
                                onChange={handleIconChange}
                                placeholder='https://example.com/icon.png'
                                variant='outlined'
                                size='small'
                                InputProps={{
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
                                }}
                            />
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
                                    InputLabelProps={{ shrink: true }}
                                    placeholder='输入后回车'
                                    size='small'
                                    inputProps={{ "aria-label": "添加标签" }}
                                    sx={{ width: 128, "& .MuiInputBase-input": { fontSize: 13 } }}
                                />

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
                                color='text.secondary'
                                display='block'
                                sx={{ mt: 0.5 }}
                            >
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

                        {/* 备注：放在网站描述下方 */}
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
                                <Typography variant='subtitle2' fontWeight='600'>
                                    登录凭据
                                </Typography>
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    sx={{ textAlign: "right", flex: "1 1 auto" }}
                                >
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
                                    inputProps={{ ...SECRET_IGNORE_ATTRS }}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                {copyButton("username", "复制账号")}
                                            </InputAdornment>
                                        ),
                                    }}
                                />
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
                                    inputProps={{ ...SECRET_IGNORE_ATTRS }}
                                    InputProps={{
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
                                    }}
                                />
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
    );
}
