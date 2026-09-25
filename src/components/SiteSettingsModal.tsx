// src/components/SiteSettingsModal.tsx
import { useState } from "react";
import { Site, Group } from "../API/http";
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
    useTheme,
    SelectChangeEvent,
    InputAdornment,
    Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { copyToClipboard } from "../utils/clipboard";
import { resolveIconApiUrl } from "../utils/iconApi";
import { useAppConfig } from "../context/AppConfigContext";

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

    // 存储字符串形式的group_id，与Material-UI的Select兼容
    const [formData, setFormData] = useState(() => {
        // 打开设置时若还没有图标，就先按「网站链接 + 获取图标API」自动补一个
        const initialIcon = site.icon || resolveIconApiUrl(iconApi, site.url || "");
        return {
            name: site.name,
            url: site.url,
            icon: initialIcon,
            description: site.description || "",
            notes: site.notes || "",
            username: site.username || "",
            password: site.password || "",
            group_id: String(site.group_id),
        };
    });

    // 用于预览图标
    const [iconPreview, setIconPreview] = useState<string | null>(
        site.icon || resolveIconApiUrl(iconApi, site.url || "") || null
    );

    // 密码是否明文显示
    const [showPassword, setShowPassword] = useState(false);
    // 复制成功提示（"" | "username" | "password"）
    const [copiedField, setCopiedField] = useState<"" | "username" | "password">("");
    // 一键获取图标的结果提示
    const [iconFetchMessage, setIconFetchMessage] = useState("");

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
        setFormData(prev => ({ ...prev, [name]: value }));
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
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // 更新网站信息，将group_id转为数字
        onUpdate({
            ...site,
            ...formData,
            group_id: Number(formData.group_id),
        });

        onClose();
    };

    // 确认删除
    const confirmDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm("确定要删除这个网站吗？此操作不可恢复。")) {
            onDelete(site.id!);
            onClose();
        }
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
                sx: {
                    borderRadius: 2,
                    backgroundColor: theme.palette.background.paper,
                },
            }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: 1.5,
                    pb: 1,
                }}
            >
                <Typography variant='h6' component='div' fontWeight='600'>
                    网站设置
                </Typography>
                <IconButton
                    edge='end'
                    color='inherit'
                    onClick={onClose}
                    aria-label='关闭'
                    size='small'
                >
                    <CloseIcon />
                </IconButton>
            </DialogTitle>

            <Divider />

            <form onSubmit={handleSubmit}>
                <DialogContent
                    sx={{
                        pt: 1.5,
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

                        {/* 网站链接 */}
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
                            helperText='填写后会自动按「网站设置 → 获取图标API」生成图标URL'
                            sx={{ "& .MuiFormHelperText-root": { fontSize: 12, mt: 0.3 } }}
                        />

                        {/* 网站图标 */}
                        <Box>
                            <Typography variant='body2' color='text.secondary' gutterBottom>
                                图标 URL
                            </Typography>
                            <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
                                {iconPreview ? (
                                    <Avatar
                                        src={iconPreview}
                                        alt={formData.name || "Icon Preview"}
                                        sx={{ width: 36, height: 36, borderRadius: 1.5 }}
                                        imgProps={{
                                            onError: handleIconError,
                                            style: { objectFit: "cover" },
                                        }}
                                        variant='rounded'
                                    />
                                ) : (
                                    <Avatar
                                        sx={{
                                            width: 36,
                                            height: 36,
                                            borderRadius: 1.5,
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
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                display='block'
                                sx={{ mt: 0.25 }}
                            >
                                修改网站链接时会自动更新；手动改过图标后需点右侧魔棒按钮重新获取
                            </Typography>
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

                        {/* 网站描述（单行窄栏）与备注并排，多余空间给备注 */}
                        <Box
                            sx={{
                                display: "flex",
                                gap: 1.5,
                                flexDirection: { xs: "column", sm: "row" },
                                alignItems: "flex-start",
                            }}
                        >
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
                                sx={{ flex: { xs: "unset", sm: 1 } }}
                            />
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
                                sx={{ flex: { xs: "unset", sm: 2 } }}
                            />
                        </Box>

                        <Divider />

                        {/* 登录凭据：账号 / 密码 + 一键复制 */}
                        <Box>
                            <Typography variant='subtitle2' fontWeight='600' gutterBottom>
                                登录凭据
                            </Typography>
                            <Typography variant='caption' color='text.secondary' display='block' sx={{ mb: 1 }}>
                                保存后可随时一键复制；凭据会随备份文件一起导出，请妥善保管备份。
                            </Typography>
                            <Stack
                                direction={{ xs: "column", sm: "row" }}
                                spacing={1.5}
                                sx={{ gap: { xs: 1.5, sm: 1.5 } }}
                            >
                                <TextField
                                    id='username'
                                    name='username'
                                    label='账号'
                                    fullWidth
                                    value={formData.username || ""}
                                    onChange={handleChange}
                                    placeholder='登录用户名 / 邮箱 / 手机号'
                                    variant='outlined'
                                    size='small'
                                    autoComplete='off'
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
                                    name='password'
                                    label='密码'
                                    fullWidth
                                    type={showPassword ? "text" : "password"}
                                    value={formData.password || ""}
                                    onChange={handleChange}
                                    placeholder='登录密码'
                                    variant='outlined'
                                    size='small'
                                    autoComplete='new-password'
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

                <DialogActions sx={{ px: 2, pb: 2, pt: 0.5, justifyContent: "space-between" }}>
                    <Button
                        onClick={confirmDelete}
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
                            type='submit'
                            color='primary'
                            variant='contained'
                            startIcon={<SaveIcon />}
                        >
                            保存
                        </Button>
                    </Box>
                </DialogActions>
            </form>
        </Dialog>
    );
}
