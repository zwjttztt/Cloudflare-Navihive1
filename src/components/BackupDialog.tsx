// src/components/BackupDialog.tsx
// 数据备份与恢复：支持备份到本地文件 / WebDAV，并支持从本地或 WebDAV 恢复
import { useState, useEffect } from "react";
import { ExportData, WebDavConfig, WebDavFile } from "../API/http";
import { NavigationClient } from "../API/client";
import { MockNavigationClient } from "../API/mock";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    IconButton,
    Typography,
    Box,
    Stack,
    Divider,
    TextField,
    Tabs,
    Tab,
    Alert,
    CircularProgress,
    Switch,
    FormControlLabel,
    List,
    ListItemButton,
    ListItemText,
    Chip,
    useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DownloadIcon from "@mui/icons-material/Download";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";

interface BackupDialogProps {
    open: boolean;
    initialTab?: number;
    client: NavigationClient | MockNavigationClient;
    webdavConfig: WebDavConfig;
    onSaveWebdavConfig: (config: WebDavConfig) => Promise<void>;
    /** 是否开启每周自动备份 */
    autoBackup?: boolean;
    /** 上一次备份的时间（ISO 字符串） */
    lastBackupAt?: string;
    onToggleAutoBackup?: (enabled: boolean) => Promise<void>;
    onBuildExportData: () => ExportData;
    onDownloadLocal: () => void;
    onImportData: (data: ExportData, overwrite: boolean) => Promise<void>;
    /**
     * 导入前先弹一次差异预览，返回用户确认后真正要导入的数据；
     * 返回 null 表示用户在预览里取消了。不传则直接导入（老行为）。
     */
    onRequestImportPreview?: (
        data: ExportData,
        overwrite: boolean
    ) => Promise<ExportData | null>;
    onNotify: (message: string, severity?: "success" | "error" | "info") => void;
    onClose: () => void;
    /** 备份文件里是否带上网站的账号密码（默认带；关掉后本地下载、WebDAV 上传、每周定时备份都不带） */
    includeCredentials: boolean;
    onIncludeCredentialsChange: (enabled: boolean) => void;
}

// 人类可读的文件大小
function formatSize(bytes: number): string {
    if (!bytes) return "未知大小";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// 远端备份时间格式化
function formatTime(value: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours()
    )}:${pad(date.getMinutes())}`;
}

export default function BackupDialog({
    open,
    initialTab = 0,
    client,
    webdavConfig,
    onSaveWebdavConfig,
    autoBackup = true,
    lastBackupAt = "",
    onToggleAutoBackup,
    onBuildExportData,
    onDownloadLocal,
    onImportData,
    onRequestImportPreview,
    onNotify,
    onClose,
    includeCredentials,
    onIncludeCredentialsChange,
}: BackupDialogProps) {
    const theme = useTheme();

    const [tab, setTab] = useState(initialTab);
    const [config, setConfig] = useState<WebDavConfig>(webdavConfig);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [uploading, setUploading] = useState(false);

    const [remoteFiles, setRemoteFiles] = useState<WebDavFile[]>([]);
    const [listLoading, setListLoading] = useState(false);
    const [selectedRemote, setSelectedRemote] = useState<string>("");

    const [localFile, setLocalFile] = useState<File | null>(null);
    const [localData, setLocalData] = useState<ExportData | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);
    const [restoring, setRestoring] = useState(false);
    const [overwrite, setOverwrite] = useState(true);

    // 打开时同步外部保存的 WebDAV 配置
    // 注意：不把 webdavConfig 放进依赖，避免保存配置后把连接测试结果清空
    useEffect(() => {
        if (open) {
            setConfig(webdavConfig);
            setTab(initialTab);
            setTestResult(null);
            setLocalFile(null);
            setLocalData(null);
            setLocalError(null);
            setSelectedRemote("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialTab]);

    const handleConfigChange = (field: keyof WebDavConfig) => (
        e: React.ChangeEvent<HTMLInputElement>
    ) => {
        setConfig(prev => ({ ...prev, [field]: e.target.value }));
        setTestResult(null);
    };

    // 测试 WebDAV 连接并保存配置
    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await client.webdavTest(config);
            setTestResult({ success: !!result.success, message: result.message || (result.success ? "连接成功" : "连接失败") });
            if (result.success) {
                await onSaveWebdavConfig(config);
            }
        } catch (error) {
            setTestResult({
                success: false,
                message: error instanceof Error ? error.message : "连接失败",
            });
        } finally {
            setTesting(false);
        }
    };

    // 备份到 WebDAV
    const handleUpload = async () => {
        setUploading(true);
        try {
            const result = await client.webdavUpload(config, onBuildExportData());
            if (result.success) {
                onNotify(result.message || "已备份到 WebDAV", "success");
                await loadRemoteFiles(config);
            } else {
                onNotify(result.message || "备份到 WebDAV 失败", "error");
            }
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "备份到 WebDAV 失败", "error");
        } finally {
            setUploading(false);
        }
    };

    // 加载远端备份列表
    const loadRemoteFiles = async (cfg: WebDavConfig) => {
        setListLoading(true);
        try {
            const result = await client.webdavList(cfg);
            if (result.success) {
                setRemoteFiles(result.data || []);
                if (!result.data || result.data.length === 0) {
                    onNotify("远端暂无备份文件", "info");
                }
            } else {
                onNotify(result.message || "获取备份列表失败", "error");
                setRemoteFiles([]);
            }
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "获取备份列表失败", "error");
        } finally {
            setListLoading(false);
        }
    };

    // 选择本地备份文件并解析
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files && e.target.files[0];
        setLocalError(null);
        setLocalData(null);
        setLocalFile(file || null);
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result || "").replace(/^\uFEFF/, "")) as ExportData;
                if (!parsed.groups || !Array.isArray(parsed.groups)) {
                    throw new Error("备份文件中缺少分组数据");
                }
                const siteCount =
                    Array.isArray(parsed.sites) && parsed.sites.length > 0
                        ? parsed.sites.length
                        : parsed.groups.reduce(
                              (sum, group) =>
                                  sum +
                                  (Array.isArray((group as unknown as { sites?: unknown[] }).sites)
                                      ? ((group as unknown as { sites?: unknown[] }).sites as unknown[]).length
                                      : 0),
                              0
                          );
                setLocalData(parsed);
                // 备份里如果带了本机偏好（星标 / 标签），顺带一句话说明，避免用户以为没导进来
                const localStarCount = parsed.localPrefs?.starred?.length ?? 0;
                const localTagCount = Object.keys(parsed.localPrefs?.tags ?? {}).length;
                const extra =
                    localStarCount || localTagCount
                        ? `，含 ${localStarCount} 个星标 / ${localTagCount} 个带标签的站点`
                        : "";
                onNotify(
                    `已读取备份：${parsed.groups.length} 个分组 / ${siteCount} 个站点${extra}`,
                    "info"
                );
            } catch (error) {
                setLocalError(error instanceof Error ? error.message : "备份文件解析失败");
            }
        };
        reader.onerror = () => setLocalError("读取文件失败");
        reader.readAsText(file, "UTF-8");
    };

    // 导入前先过一遍差异预览：用户可以在预览里挑要导入哪些，取消则返回 null
    const resolveImportData = async (data: ExportData, overwriteMode: boolean) =>
        onRequestImportPreview ? await onRequestImportPreview(data, overwriteMode) : data;

    // 从本地文件恢复
    const handleRestoreLocal = async () => {
        if (!localData) {
            onNotify("请先选择备份文件", "error");
            return;
        }
        setRestoring(true);
        try {
            const finalData = await resolveImportData(localData, overwrite);
            if (!finalData) return; // 用户在预览里点了取消
            await onImportData(finalData, overwrite);
            onNotify("已从本地备份恢复数据", "success");
            onClose();
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "恢复失败", "error");
        } finally {
            setRestoring(false);
        }
    };

    // 从 WebDAV 远端备份恢复
    const handleRestoreRemote = async () => {
        if (!selectedRemote) {
            onNotify("请先选择一个远端备份文件", "error");
            return;
        }
        setRestoring(true);
        try {
            const result = await client.webdavDownload(selectedRemote, config);
            if (!result.success || !result.data) {
                onNotify(result.message || "下载备份失败", "error");
                return;
            }
            const finalData = await resolveImportData(result.data, overwrite);
            if (!finalData) return; // 用户在预览里点了取消
            await onImportData(finalData, overwrite);
            onNotify(`已从 ${selectedRemote} 恢复数据`, "success");
            onClose();
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "恢复失败", "error");
        } finally {
            setRestoring(false);
        }
    };

    // 删除远端备份
    const handleDeleteRemote = async (filename: string) => {
        setListLoading(true);
        try {
            const result = await client.webdavDelete(filename, config);
            if (result.success) {
                onNotify(result.message || "已删除备份", "success");
                if (selectedRemote === filename) setSelectedRemote("");
            } else {
                onNotify(result.message || "删除失败", "error");
            }
            await loadRemoteFiles(config);
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "删除失败", "error");
            setListLoading(false);
        }
    };

    const renderBackupTab = () => (
        <Stack spacing={1.5} sx={{ mt: 0.5, flex: 1, minHeight: 0 }}>
            <Box>
                {/* 主按钮跟标题平齐：这块的操作就一个，放在区块底部反而要往下找 */}
                <Stack direction='row' alignItems='center' justifyContent='space-between' spacing={1}>
                    <Typography variant='subtitle2' fontWeight='600'>
                        备份到本地
                    </Typography>
                    <Button
                        size='small'
                        variant='contained'
                        startIcon={<DownloadIcon />}
                        onClick={() => {
                            onDownloadLocal();
                            onNotify("备份文件已开始下载", "success");
                        }}
                    >
                        下载备份文件
                    </Button>
                </Stack>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.5, mb: 1 }}>
                    导出分组、站点、网站设置，以及本机的星标与标签。
                </Typography>

                {/* 凭据开关：三处导出（本地下载 / WebDAV 上传 / 每周定时备份）共用同一个设置 */}
                <Box
                    sx={{
                        mb: 1,
                        p: 1,
                        borderRadius: 2,
                        border: 1,
                        // 带凭据是「有风险」的状态，边框用警告色提示一下
                        borderColor: includeCredentials ? "warning.main" : "divider",
                    }}
                >
                    <FormControlLabel
                        control={
                            <Switch
                                checked={includeCredentials}
                                size='small'
                                onChange={e => onIncludeCredentialsChange(e.target.checked)}
                                slotProps={{ input: { "aria-label": "备份包含网站登录凭据" } }}
                            />
                        }
                        label={
                            <Typography variant='body2'>
                                备份包含网站登录凭据（账号 / 密码）
                            </Typography>
                        }
                        sx={{ display: "flex", mr: 0 }}
                    />
                    {/* 两态文案长短不同，占位固定成两行 —— 否则每点一次开关，弹窗高度就跳一下 */}
                    <Typography
                        variant='caption'
                        color={includeCredentials ? "warning.dark" : "text.secondary"}
                        sx={{ display: "block", ml: 5.5, minHeight: 32 }}
                    >
                        {includeCredentials
                            ? "备份是明文 JSON，自动备份还会同步到网盘，请确认网盘账号本身可信。"
                            : "导出、上传、定时备份都不带网站的账号密码，恢复后需手动补填。"}
                    </Typography>
                </Box>
            </Box>

            <Divider />

            <Box>
                <Typography variant='subtitle2' fontWeight='600' gutterBottom>
                    备份到 WebDAV
                </Typography>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 1 }}>
                    支持坚果云、Nextcloud、ownCloud、群晖等；配置存在服务器，备份由服务端代理上传。
                </Typography>

                <Stack spacing={1.25}>
                    <TextField
                        label='WebDAV 地址'
                        placeholder='https://dav.jianguoyun.com/dav/'
                        value={config.url}
                        onChange={handleConfigChange("url")}
                        size='small'
                        fullWidth
                    />
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                        <TextField
                            label='账号'
                            placeholder='WebDAV 用户名'
                            value={config.username}
                            onChange={handleConfigChange("username")}
                            size='small'
                            fullWidth
                            autoComplete='off'
                        />
                        <TextField
                            label='密码 / 应用密码'
                            type='password'
                            placeholder='建议使用应用专用密码'
                            value={config.password}
                            onChange={handleConfigChange("password")}
                            size='small'
                            fullWidth
                            autoComplete='new-password'
                        />
                    </Stack>
                    <TextField
                        label='备份目录'
                        placeholder='navihive-backup'
                        value={config.path}
                        onChange={handleConfigChange("path")}
                        size='small'
                        fullWidth
                        helperText='目录不存在时会自动创建；每次备份后只保留最新一份'
                    />

                    <Box>
                        <FormControlLabel
                            control={
                                <Switch
                                    id='webdav-auto-backup'
                                    size='small'
                                    checked={autoBackup}
                                    onChange={e => onToggleAutoBackup?.(e.target.checked)}
                                    slotProps={{ input: { "aria-label": "每周自动备份" } }}
                                />
                            }
                            label='每周自动备份一次'
                        />
                        <Typography variant='caption' color='text.secondary' display='block' sx={{ minHeight: 32 }}>
                            每周一上午 10:00（北京时间）自动备份，上传后自动删除上一次的备份。
                            {lastBackupAt ? ` 上次备份：${formatTime(lastBackupAt)}` : " 还没有备份记录。"}
                        </Typography>
                    </Box>

                    {testResult && (
                        <Alert severity={testResult.success ? "success" : "error"} icon={testResult.success ? <CheckCircleIcon fontSize='inherit' /> : undefined}>
                            {testResult.message}
                        </Alert>
                    )}

                    <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                        <Button
                            variant='outlined'
                            onClick={handleTest}
                            disabled={testing || !config.url}
                            startIcon={testing ? <CircularProgress size={18} /> : <RefreshIcon />}
                        >
                            测试连接并保存
                        </Button>
                        <Button
                            variant='contained'
                            color='primary'
                            onClick={handleUpload}
                            disabled={uploading || !config.url}
                            startIcon={uploading ? <CircularProgress size={18} /> : <CloudUploadIcon />}
                        >
                            备份到 WebDAV
                        </Button>
                        <Button
                            variant='text'
                            onClick={() => loadRemoteFiles(config)}
                            disabled={listLoading || !config.url}
                            startIcon={listLoading ? <CircularProgress size={18} /> : <CloudDownloadIcon />}
                        >
                            查看远端备份
                        </Button>
                    </Stack>

                    {remoteFiles.length > 0 && (
                        <Box>
                            <Typography variant='caption' color='text.secondary'>
                                最近的远端备份：
                            </Typography>
                            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                                {remoteFiles.slice(0, 3).map(file => (
                                    <Typography key={file.name} variant='body2'>
                                        {file.name} · {formatSize(file.size)} · {formatTime(file.lastModified)}
                                    </Typography>
                                ))}
                            </Stack>
                        </Box>
                    )}
                </Stack>
            </Box>
        </Stack>
    );

    const renderRestoreTab = () => (
        <Stack spacing={1.5} sx={{ mt: 0.5, flex: 1, minHeight: 0 }}>
            <FormControlLabel
                control={
                    <Switch
                        checked={overwrite}
                        onChange={e => setOverwrite(e.target.checked)}
                        color='primary'
                        size='small'
                    />
                }
                label={
                    <Box>
                        <Typography variant='body2' fontWeight='600'>
                            {overwrite ? "覆盖恢复（清空现有数据后导入）" : "合并导入（保留现有数据并追加）"}
                        </Typography>
                        <Typography variant='caption' color='text.secondary'>
                            保留分组与站点的原有 ID，并连同备份里的星标 / 标签一起还原，推荐用于完整还原备份
                        </Typography>
                    </Box>
                }
            />

            <Divider />

            <Box>
                <Typography variant='subtitle2' fontWeight='600' gutterBottom>
                    从本地文件恢复
                </Typography>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
                    <Button variant='outlined' component='label' startIcon={<UploadFileIcon />}>
                        选择备份文件
                        <input type='file' hidden accept='.json,application/json' onChange={handleFileSelect} />
                    </Button>
                    <Button
                        variant='contained'
                        onClick={handleRestoreLocal}
                        disabled={!localData || restoring}
                        startIcon={restoring ? <CircularProgress size={18} /> : <UploadFileIcon />}
                    >
                        开始恢复
                    </Button>
                </Stack>
                {localFile && (
                    <Typography variant='body2' sx={{ mt: 1 }}>
                        已选择：{localFile.name}
                    </Typography>
                )}
                {localError && (
                    <Alert severity='error' sx={{ mt: 1 }}>
                        {localError}
                    </Alert>
                )}
            </Box>

            <Divider />

            <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
                    <Typography variant='subtitle2' fontWeight='600'>
                        从 WebDAV 恢复
                    </Typography>
                    <Button
                        size='small'
                        onClick={() => loadRemoteFiles(config)}
                        disabled={listLoading || !config.url}
                        startIcon={listLoading ? <CircularProgress size={18} /> : <RefreshIcon />}
                    >
                        刷新列表
                    </Button>
                </Stack>

                {/* 列表区撑满剩余高度：「恢复」页的内容本来只有「备份」页的一半高，
                    空态也给这块留位，切标签页、点开关时弹窗高矮才不会跳 */}
                <Box
                    sx={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        p: 1,
                        borderRadius: 2,
                        border: "1px solid",
                        borderColor: "divider",
                        bgcolor: "background.default",
                        overflow: "hidden",
                    }}
                >
                    {!config.url && (
                        <Alert severity='info'>
                            请先在「备份」标签页填写并测试 WebDAV 配置
                        </Alert>
                    )}

                    {config.url && remoteFiles.length === 0 && !listLoading && (
                        <Typography variant='body2' color='text.secondary' textAlign='center'>
                            暂无远端备份，点击「刷新列表」重新获取。
                        </Typography>
                    )}

                    {remoteFiles.length > 0 && (
                        <List
                            dense
                            sx={{
                                flex: 1,
                                minHeight: 0,
                                overflowY: "auto",
                            }}
                        >
                            {remoteFiles.map(file => (
                                <ListItemButton
                                    key={file.name}
                                    selected={selectedRemote === file.name}
                                    onClick={() => setSelectedRemote(file.name)}
                                    dense
                                >
                                    <ListItemText
                                        primary={file.name}
                                        secondary={
                                            selectedRemote === file.name
                                                ? `已选中 · ${formatSize(file.size)} · ${formatTime(file.lastModified)}`
                                                : `${formatSize(file.size)} · ${formatTime(file.lastModified)}`
                                        }
                                    />
                                    <IconButton
                                        edge='end'
                                        size='small'
                                        color='error'
                                        onClick={event => {
                                            event.stopPropagation();
                                            handleDeleteRemote(file.name);
                                        }}
                                        aria-label={`删除 ${file.name}`}
                                    >
                                        <DeleteIcon fontSize='small' />
                                    </IconButton>
                                </ListItemButton>
                            ))}
                        </List>
                    )}
                </Box>

                {remoteFiles.length > 0 && (
                    <Button
                        sx={{ mt: 1.5 }}
                        variant='contained'
                        onClick={handleRestoreRemote}
                        disabled={!selectedRemote || restoring}
                        startIcon={restoring ? <CircularProgress size={18} /> : <CloudDownloadIcon />}
                    >
                        从选中备份恢复
                    </Button>
                )}
            </Box>
        </Stack>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='md'
            PaperProps={{
                sx: {
                    borderRadius: 2,
                    backgroundColor: theme.palette.background.paper,
                    m: { xs: 2, sm: "auto" },
                    // 宽度也要写死：width:auto 时 paper 会跟着内容宽度走，
                    // 结果切标签页时弹窗宽度会跳（备份页 541 / 恢复页 560 实测）
                    width: { xs: "calc(100% - 32px)", sm: 600 },
                },
            }}
        >
            <DialogTitle sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", pb: 1 }}>
                <Typography variant='h6' component='div' fontWeight='600'>
                    数据备份与恢复
                </Typography>
                <IconButton edge='end' color='inherit' onClick={onClose} aria-label='关闭' size='small'>
                    <CloseIcon />
                </IconButton>
            </DialogTitle>

            <Divider />

            <Tabs
                value={tab}
                onChange={(_, value: number) => setTab(value)}
                sx={{ px: 2 }}
                variant='fullWidth'
            >
                <Tab label='备份' />
                <Tab label='恢复 / 导入' />
            </Tabs>

            {/* 内容区高度写死：备份页和恢复页、以及开关两态的高矮都不一样，
                放着让它自己撑，就会出现「一点开关弹窗跳一下」。固定后超出部分在区内滚动。
                590 是按「备份」页的自然高度（实测 567）留了点余量定的；
                「恢复」页内容只有一半高，靠下面那块列表区 flex 撑满，不留大片空白。 */}
            <DialogContent
                sx={{
                    pt: 1.5,
                    // 590 是「备份」页的自然高度（实测 567）+ 余量；矮屏上用 min() 让位给视口
                    height: { xs: "58vh", sm: "min(590px, 72vh)" },
                    display: "flex",
                    flexDirection: "column",
                }}
            >
                {tab === 0 ? renderBackupTab() : renderRestoreTab()}
            </DialogContent>

            <DialogActions sx={{ px: 2, pb: 2, pt: 1 }}>
                <Chip
                    size='small'
                    variant='outlined'
                    label={includeCredentials ? "备份含站点账号密码，请妥善保存" : "备份不含账号密码"}
                    sx={{ mr: "auto" }}
                />
                <Button onClick={onClose} variant='outlined' color='inherit'>
                    关闭
                </Button>
            </DialogActions>
        </Dialog>
    );
}
