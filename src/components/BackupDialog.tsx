// src/components/BackupDialog.tsx
// 数据备份与恢复：支持备份到本地文件 / WebDAV，并支持从本地或 WebDAV 恢复
import { useState, useEffect, useRef } from "react";
import { ExportData, WebDavConfig, WebDavFile, type ImportProgress } from "../API/http";
import { NavigationClient } from "../API/client";
import { MockNavigationClient } from "../API/mock";
import { decryptBackup, isEncryptedBackup } from "../API/crypto";
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
    InputAdornment,
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
    Tooltip,
    LinearProgress,
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
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import BookmarkAddedIcon from "@mui/icons-material/BookmarkAdded";

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
    /** 传了口令就用它加密备份文件再下载，不传则下载明文 JSON（兼容老备份） */
    onDownloadLocal: (password?: string) => void | Promise<void>;
    onImportData: (
        data: ExportData,
        overwrite: boolean,
        onProgress?: (progress: ImportProgress) => void
    ) => Promise<void>;
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
    /**
     * 打开「导入浏览器书签」。
     *
     * 原先是「更多选项」里的一个菜单项，但它本质上就是另一种「导入」，
     * 和本弹窗「恢复 / 导入」页的「从本地文件恢复」是同一类动作，放在一起更好找。
     * 不传就不显示这一块。
     */
    onOpenBookmark?: () => void;
    /**
     * 最近一次定时任务（每周自动备份 / 死链巡检）的失败留痕，没有就传 null。
     *
     * 定时任务跑在 Worker 里，失败了页面上毫无动静 —— 「自动备份其实已经连着失败
     * 好几个月」这种事只能靠这里说一句，否则要等到真要恢复那天才发现。
     */
    cronError?: { task: string; message: string; at?: string } | null;
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

/** 定时任务失败的时间：解析不出来就原样显示，别因为一行留痕把整个弹窗搞崩 */
function formatCronErrorTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("zh-CN", { hour12: false });
}

/** 导入各阶段的中文名。阶段本身由服务端推进，这里只负责说人话 */
export const IMPORT_STAGE_LABEL: Record<ImportProgress["stage"], string> = {
    verify: "正在校验备份文件…",
    encrypt: "正在加密站点密码…",
    write: "正在写入数据…",
    cleanup: "正在清理旧数据…",
    done: "正在收尾…",
};

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
    onOpenBookmark,
    cronError = null,
}: BackupDialogProps) {
    const theme = useTheme();

    const [tab, setTab] = useState(initialTab);
    const [config, setConfig] = useState<WebDavConfig>(webdavConfig);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    // WebDAV 操作按钮行（测试连接 / 备份）。测试结果 Alert 排在按钮下方。
    // 矮视口（125% 缩放 / 小窗口）下内容区会滚动：点「测试连接」后 Alert 把内容撑高，
    // 若不主动滚动，按钮行和它下面的 Alert 都停在内容区折叠线下面，
    // 视觉上像跟底部操作区叠在一起。
    const webdavActionsRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!testResult) return;
        // 直接滚到滚动区最底部：block:'nearest' 会把按钮底边贴到滚动口边缘，
        // 看起来还是和底部操作区叠在一起；滚到底则连内容末尾的留白一起带进可视区
        const el = webdavActionsRef.current;
        const scroller = el?.closest(".MuiDialogContent-root");
        if (scroller) {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        } else {
            el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [testResult]);

    const [remoteFiles, setRemoteFiles] = useState<WebDavFile[]>([]);
    const [listLoading, setListLoading] = useState(false);
    // 正在删除的远端备份文件名：乐观更新后这条已经从列表里消失，用它防重复点击
    const [deletingFiles, setDeletingFiles] = useState<Set<string>>(new Set());
    const [selectedRemote, setSelectedRemote] = useState<string>("");

    const [localFile, setLocalFile] = useState<File | null>(null);
    const [localData, setLocalData] = useState<ExportData | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);
    const [restoring, setRestoring] = useState(false);
    // 导入的真实进度（由服务端流式推回，或合并导入时本地逐条数出来）。
    // 没有进度时保持 null —— 界面只转圈，不画假进度条
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
    const [overwrite, setOverwrite] = useState(true);
    // 密码默认遮住，点眼睛才明文显示（仅影响本机显示）
    const [showPassword, setShowPassword] = useState(false);
    // 本地备份是否用口令加密 + 口令本身（不落盘、不上传，只用于当次下载）
    const [encryptLocal, setEncryptLocal] = useState(false);
    const [backupPassword, setBackupPassword] = useState("");
    const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");
    const [showBackupPassword, setShowBackupPassword] = useState(false);
    // WebDAV 备份口令（可选）：设了就加密上传，存服务器供定时备份与恢复复用；
    // 与 AUTH_SECRET 无关，换服务端密钥不影响已有备份
    const [showWebdavBackupPassword, setShowWebdavBackupPassword] = useState(false);
    // 选中的文件若是加密备份，先把原始字节留着，等用户输入口令再解
    const [encryptedBytes, setEncryptedBytes] = useState<Uint8Array | null>(null);
    const [restorePassword, setRestorePassword] = useState("");
    const [decrypting, setDecrypting] = useState(false);
    // 远端（WebDAV）备份的解密口令：网盘地址和备份口令都是每个账号各存一份，
    // 拿 A 账号传的备份到 B 账号恢复时，B 这边根本存着口令，只能就地输入
    const [remotePassword, setRemotePassword] = useState("");
    const [needsRemotePassword, setNeedsRemotePassword] = useState(false);
    const [remoteError, setRemoteError] = useState<string | null>(null);

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
            setShowPassword(false);
            setEncryptLocal(false);
            setBackupPassword("");
            setBackupPasswordConfirm("");
            setShowBackupPassword(false);
            setEncryptedBytes(null);
            setRestorePassword("");
            setRemotePassword("");
            setNeedsRemotePassword(false);
            setRemoteError(null);
            setShowWebdavBackupPassword(false);
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
        let result: Awaited<ReturnType<typeof client.webdavTest>>;
        try {
            result = await client.webdavTest(config);
        } catch (error) {
            setTesting(false);
            setTestResult({
                success: false,
                message: error instanceof Error ? error.message : "连接失败",
            });
            return;
        }
        // 探测一有结果就停转 + 出结论：保存配置还要写几项（网络慢/离线入队都可能拖住），
        // 拿它挡着反馈的话，保存一挂起按钮就永远在转，看起来像「连不上」
        setTesting(false);
        setTestResult({
            success: !!result.success,
            message: result.message || (result.success ? "连接成功" : "连接失败"),
        });
        if (!result.success) return;
        // 配置落库放后台：成了就静默，失败再把提示改成「连上了但没存下」
        void onSaveWebdavConfig(config).catch(error => {
            setTestResult({
                success: false,
                message:
                    "连接成功，但保存配置失败：" + (error instanceof Error ? error.message : "未知错误"),
            });
        });
    };

    // 备份到 WebDAV
    const handleUpload = async () => {
        // 口令不限长度：备份落到自己网盘上，多长由用户自己权衡（短口令的风险是忘了/被猜到）
        // 留空 = 不加密，走这条分支也是允许的
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

    // 加载远端备份列表。silent=true 用于删除后的后台校准：不置 loading、也不弹提示，
    // 否则连着删几份时界面一直在转圈、提示一条接一条
    const loadRemoteFiles = async (cfg: WebDavConfig, options?: { silent?: boolean }) => {
        const silent = options?.silent === true;
        if (!silent) setListLoading(true);
        try {
            const result = await client.webdavList(cfg);
            if (result.success) {
                setRemoteFiles(result.data || []);
                if (!silent && (!result.data || result.data.length === 0)) {
                    onNotify("远端暂无备份文件", "info");
                }
            } else {
                onNotify(result.message || "获取备份列表失败", "error");
                setRemoteFiles([]);
            }
        } catch (error) {
            if (!silent) {
                onNotify(error instanceof Error ? error.message : "获取备份列表失败", "error");
            }
        } finally {
            if (!silent) setListLoading(false);
        }
    };

    // 解析好的备份收下 + 统计一下给提示（明文 JSON 与解密后的内容共用这条）
    const applyParsedBackup = (parsed: ExportData) => {
        try {
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

    // 选择本地备份文件并解析。
    // 按字节读而不是按文本：加密备份是二进制（NAVIHIVE-ENC1/ENC2 开头），readAsText 会先
    // 把二进制按 UTF-8 解码成乱码，之后就再也分不清它到底是哪种格式了。
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files && e.target.files[0];
        setLocalError(null);
        setLocalData(null);
        setLocalFile(file || null);
        setEncryptedBytes(null);
        setRestorePassword("");
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const bytes = new Uint8Array(reader.result as ArrayBuffer);
            if (isEncryptedBackup(bytes)) {
                // 先留着原始字节，等用户输入口令再解
                setEncryptedBytes(bytes);
                onNotify("这是加密备份，请输入备份密码后解密", "info");
                return;
            }
            try {
                applyParsedBackup(
                    JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")) as ExportData
                );
            } catch (error) {
                setLocalError(error instanceof Error ? error.message : "备份文件解析失败");
            }
        };
        reader.onerror = () => setLocalError("读取文件失败");
        reader.readAsArrayBuffer(file);
    };

    // 用口令解开加密备份（口令只在本机内存里用一次，不上传也不落盘）
    const handleDecryptBackup = async () => {
        if (!encryptedBytes) return;
        if (!restorePassword) {
            onNotify("请输入备份密码", "error");
            return;
        }
        setDecrypting(true);
        setLocalError(null);
        try {
            const plain = await decryptBackup(encryptedBytes, restorePassword);
            applyParsedBackup(
                JSON.parse(new TextDecoder().decode(plain).replace(/^\uFEFF/, "")) as ExportData
            );
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : "解密失败");
        } finally {
            setDecrypting(false);
        }
    };

    // 导入前先过一遍差异预览：用户可以在预览里挑要导入哪些，取消则返回 null
    const resolveImportData = async (data: ExportData, overwriteMode: boolean) =>
        onRequestImportPreview ? await onRequestImportPreview(data, overwriteMode) : data;

    // 从本地文件恢复
    const handleRestoreLocal = async () => {
        if (!localData) {
            onNotify(
                encryptedBytes ? "这是加密备份，请先输入密码解密" : "请先选择备份文件",
                "error"
            );
            return;
        }
        setRestoring(true);
        setImportProgress(null);
        try {
            const finalData = await resolveImportData(localData, overwrite);
            if (!finalData) return; // 用户在预览里点了取消
            await onImportData(finalData, overwrite, setImportProgress);
            onNotify("已从本地备份恢复数据", "success");
            onClose();
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "恢复失败", "error");
        } finally {
            setRestoring(false);
            setImportProgress(null);
        }
    };

    // 从 WebDAV 远端备份恢复
    const handleRestoreRemote = async () => {
        if (!selectedRemote) {
            onNotify("请先选择一个远端备份文件", "error");
            return;
        }
        setRestoring(true);
        setImportProgress(null);
        setRemoteError(null);
        try {
            // 口令只用于这一次下载，不写进配置：恢复别人的备份不该把
            // 口令顺手存进本账号的网盘设置里
            const result = await client.webdavDownload(selectedRemote, {
                ...config,
                ...(remotePassword ? { backupPassword: remotePassword } : {}),
            });
            if (!result.success || !result.data) {
                // 加密备份 / 口令不对：就地弹口令框让用户补一次，别只丢一句「下载失败」
                if (result.code === "encrypted" || result.code === "badPassword") {
                    setNeedsRemotePassword(true);
                    setRemoteError(result.message || "这份备份需要备份密码");
                    return;
                }
                onNotify(result.message || "下载备份失败", "error");
                return;
            }
            const finalData = await resolveImportData(result.data, overwrite);
            if (!finalData) return; // 用户在预览里点了取消
            await onImportData(finalData, overwrite, setImportProgress);
            onNotify(`已从 ${selectedRemote} 恢复数据`, "success");
            onClose();
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "恢复失败", "error");
        } finally {
            setRestoring(false);
            setImportProgress(null);
        }
    };

    // 删除远端备份
    // 原来是「DELETE 回来 → 再 PROPFIND 重新列一遍目录 → 才更新界面」，
    // 两个 WebDAV 往返下来界面要卡几秒（中途整个列表还在转圈）。改成乐观更新：
    // 点下去先从列表里摘掉，删除请求在后台跑，跑完再静默校准一次真实列表。
    const handleDeleteRemote = async (filename: string) => {
        const snapshot = remoteFiles;
        setRemoteFiles(prev => prev.filter(file => file.name !== filename));
        if (selectedRemote === filename) setSelectedRemote("");
        setDeletingFiles(prev => new Set(prev).add(filename));
        try {
            const result = await client.webdavDelete(filename, config);
            if (result.success) {
                onNotify(result.message || "已删除备份", "success");
            } else {
                // 没删成就把这条放回去，别让界面和服务器对不上
                onNotify(result.message || "删除失败", "error");
                setRemoteFiles(snapshot);
            }
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "删除失败", "error");
            setRemoteFiles(snapshot);
        } finally {
            setDeletingFiles(prev => {
                const next = new Set(prev);
                next.delete(filename);
                return next;
            });
            // 后台校准：silent 模式不置 loading、也不弹「暂无备份」，免得打断连续删除
            void loadRemoteFiles(config, { silent: true });
        }
    };

    const renderBackupTab = () => (
        <Stack spacing={0.75} sx={{ mt: 0.5, flex: 1, minHeight: 0 }}>
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
                        onClick={async () => {
                            // 本机校验只留「填了没」和「两次一致」：口令长度由用户自己定，
                            // 唯一要挡的是「勾了加密却没给口令」——那会生成一个解不开的文件
                            if (encryptLocal) {
                                if (backupPassword.length === 0) {
                                    onNotify("请输入备份密码，或关掉加密开关", "error");
                                    return;
                                }
                                if (backupPassword !== backupPasswordConfirm) {
                                    onNotify("两次输入的备份密码不一致", "error");
                                    return;
                                }
                            }
                            await onDownloadLocal(encryptLocal ? backupPassword : undefined);
                            onNotify(
                                encryptLocal
                                    ? "加密备份已开始下载，请牢记备份密码"
                                    : "备份文件已开始下载",
                                "success"
                            );
                        }}
                    >
                        下载备份文件
                    </Button>
                </Stack>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.25, mb: 0.5 }}>
                    导出分组、站点、网站设置，以及本机的星标与标签。
                </Typography>

                {/* 凭据开关：三处导出（本地下载 / WebDAV 上传 / 每周定时备份）共用同一个设置 */}
                <Box
                    sx={{
                        mb: 1,
                        px: 1,
                        py: 0.5,
                        borderRadius: 2,
                        border: 1,
                        // 带凭据是「有风险」的状态，边框用警告色提示一下
                        borderColor: includeCredentials ? "warning.main" : "divider",
                    }}
                >
                    <FormControlLabel
                        sx={{ display: "flex", mr: 0, ml: 0 }}
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
                    />
                    {/* 两态文案长短不同。以前在这里 minHeight 占位防高度跳，
                        现在弹窗外框高度已写死（见下方 Dialog / DialogContent），
                        开关两态只会影响内部排布，不会再带得弹窗跳 */}
                    <Typography
                        variant='caption'
                        color={includeCredentials ? "warning.dark" : "text.secondary"}
                        sx={{ display: "block", ml: 5.5 }}
                    >
                        {includeCredentials
                            ? "本地下载为明文 JSON，上传与定时备份会再加密一层。"
                            : "导出、上传、定时备份都不带网站的账号密码，恢复后需手动补填。"}
                    </Typography>
                </Box>

                {/* 本地备份加密：明文 JSON 落盘那一刻就带着站点密码，进网盘同步目录
                    或被随手发出去就等于泄密。默认关闭，所以不套边框容器 ——
                    它是进阶选项，视觉层级比上面的凭据开关低一档，也省下纵向空间。 */}
                <Stack direction='row' alignItems='center' spacing={0.5} sx={{ mt: 0.75 }}>
                    <Switch
                        checked={encryptLocal}
                        size='small'
                        onChange={e => {
                            setEncryptLocal(e.target.checked);
                            // 关掉就清空口令，别让密码留在内存里等着被误用
                            if (!e.target.checked) {
                                setBackupPassword("");
                                setBackupPasswordConfirm("");
                            }
                        }}
                        slotProps={{ input: { "aria-label": "用密码加密备份文件" } }}
                    />
                    <Typography variant='body2'>用密码加密备份文件（.navihive）</Typography>
                </Stack>
                {encryptLocal && (
                    <>
                        <Typography
                            variant='caption'
                            color='success.dark'
                            sx={{ display: "block", ml: 5.5, mb: 0.5 }}
                        >
                            恢复时要输入这个密码；密码无法找回，请务必牢记。
                        </Typography>
                        <Stack
                            direction={{ xs: "column", sm: "row" }}
                            spacing={1}
                            sx={{ ml: 5.5 }}
                        >
                            <TextField
                                id='backup-encrypt-password'
                                label='备份密码'
                                type={showBackupPassword ? "text" : "password"}
                                size='small'
                                fullWidth
                                value={backupPassword}
                                onChange={e => setBackupPassword(e.target.value)}
                                autoComplete='new-password'
                            />
                            <TextField
                                id='backup-encrypt-password-confirm'
                                label='确认备份密码'
                                type={showBackupPassword ? "text" : "password"}
                                size='small'
                                fullWidth
                                value={backupPasswordConfirm}
                                onChange={e => setBackupPasswordConfirm(e.target.value)}
                                autoComplete='new-password'
                                slotProps={{
                                    input: {
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <IconButton
                                                    id='backup-toggle-password'
                                                    size='small'
                                                    onClick={() =>
                                                        setShowBackupPassword(prev => !prev)
                                                    }
                                                    aria-label='显示备份密码'
                                                >
                                                    {showBackupPassword ? (
                                                        <VisibilityOffIcon fontSize='small' />
                                                    ) : (
                                                        <VisibilityIcon fontSize='small' />
                                                    )}
                                                </IconButton>
                                            </InputAdornment>
                                        ),
                                    },
                                }}
                            />
                        </Stack>
                    </>
                )}
            </Box>

            <Divider />

            <Box>
                <Typography variant='subtitle2' fontWeight='600' gutterBottom>
                    备份到 WebDAV
                </Typography>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 0.75 }}>
                    配置存在服务器，由服务端代理上传；目录不存在会自动创建，自动备份只保留最新一份，手动备份全部保留。
                </Typography>

                <Stack spacing={0.75}>
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
                            type={showPassword ? "text" : "password"}
                            placeholder='建议使用应用专用密码'
                            value={config.password}
                            onChange={handleConfigChange("password")}
                            size='small'
                            fullWidth
                            autoComplete='new-password'
                            // 应用密码一长串随机字符，粘进去看不到内容很容易粘错；
                            // 点眼睛就能核对。默认仍然遮住
                            slotProps={{
                                input: {
                                    endAdornment: (
                                        <InputAdornment position='end'>
                                            <IconButton
                                                id='webdav-toggle-password'
                                                size='small'
                                                edge='end'
                                                onClick={() => setShowPassword(prev => !prev)}
                                                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                                            >
                                                {showPassword ? (
                                                    <VisibilityOffIcon fontSize='small' />
                                                ) : (
                                                    <VisibilityIcon fontSize='small' />
                                                )}
                                            </IconButton>
                                        </InputAdornment>
                                    ),
                                },
                            }}
                        />
                    </Stack>
                    <TextField
                        label='备份目录'
                        placeholder='navihive-backup'
                        value={config.path}
                        onChange={handleConfigChange("path")}
                        size='small'
                        fullWidth
                    />

                    {/* 备份口令：独立的加密密钥，不用服务端的 AUTH_SECRET ——
                        轮换 AUTH_SECRET 不该让此前所有备份变成解不开的废文件 */}
                    <TextField
                        id='webdav-backup-password'
                        label='备份密码（可选）'
                        type={showWebdavBackupPassword ? "text" : "password"}
                        placeholder='留空则备份不加密'
                        value={config.backupPassword || ""}
                        onChange={handleConfigChange("backupPassword")}
                        size='small'
                        fullWidth
                        autoComplete='new-password'
                        slotProps={{
                            input: {
                                endAdornment: (
                                    <InputAdornment position='end'>
                                        <IconButton
                                            id='webdav-toggle-backup-password'
                                            size='small'
                                            edge='end'
                                            onClick={() => setShowWebdavBackupPassword(prev => !prev)}
                                            aria-label={
                                                showWebdavBackupPassword ? "隐藏备份密码" : "显示备份密码"
                                            }
                                        >
                                            {showWebdavBackupPassword ? (
                                                <VisibilityOffIcon fontSize='small' />
                                            ) : (
                                                <VisibilityIcon fontSize='small' />
                                            )}
                                        </IconButton>
                                    </InputAdornment>
                                ),
                            },
                        }}
                    />
                    <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: -0.5 }}>
                        设了就用它加密上传（恢复时要填同一个密码，无法找回）；留空则明文上传。
                        手动 / 每周自动 / 远端恢复共用，与服务端的 AUTH_SECRET 无关。
                    </Typography>

                    <Box>
                        <FormControlLabel
                            sx={{ ml: 0 }}
                            control={
                                <Switch
                                    id='webdav-allow-private'
                                    size='small'
                                    checked={!!config.allowPrivateNetwork}
                                    onChange={e =>
                                        setConfig(c => ({ ...c, allowPrivateNetwork: e.target.checked }))
                                    }
                                    slotProps={{ input: { "aria-label": "允许内网地址" } }}
                                />
                            }
                            label='允许内网地址'
                        />
                        {/* 一行放得下（sm 宽度），别折行 */}
                        <Typography variant='caption' color='text.secondary' display='block'>
                            默认关闭；备份到内网地址（家庭 NAS 192.168.x.x、xxx.local）时才需要打开。
                        </Typography>
                    </Box>

                    <Box>
                        <FormControlLabel
                            sx={{ ml: 0 }}
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
                        <Typography variant='caption' color='text.secondary' display='block'>
                            每周一上午 10:00 自动备份，会替换掉上一次的自动备份；手动备份不会被删除。
                            {lastBackupAt ? ` 上次备份：${formatTime(lastBackupAt)}` : " 还没有备份记录。"}
                        </Typography>
                    </Box>

                    <Stack
                        ref={webdavActionsRef}
                        direction={{ xs: "column", sm: "row" }}
                        spacing={2}
                    >
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
                    </Stack>

                    {/* 测试结果放在按钮下方：点完按钮反馈就在手指底下，不用往回找 */}
                    {testResult && (
                        <Alert severity={testResult.success ? "success" : "error"} icon={testResult.success ? <CheckCircleIcon fontSize='inherit' /> : undefined}>
                            {testResult.message}
                        </Alert>
                    )}

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
            {/* 滚动内容末尾的留白：矮视口下自动滚到底后，按钮行不贴内容区底边。
                必须是真实元素——容器 padding 会被 flex 溢出吃掉，margin 不计入
                可滚动区域，只有占位元素能稳定撑出这段空间 */}
            <Box sx={{ height: 12, flexShrink: 0 }} />
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
                        <input
                            type='file'
                            hidden
                            accept='.json,.navihive,application/json'
                            onChange={handleFileSelect}
                        />
                    </Button>
                    <Button
                        variant='contained'
                        onClick={handleRestoreLocal}
                        disabled={!localData || restoring}
                        startIcon={restoring ? <CircularProgress size={18} /> : <UploadFileIcon />}
                    >
                        开始恢复
                    </Button>
                    {/* 浏览器书签本质上也是「导入」，和上面的本地文件同类。
                        挤在按钮行右侧而不是单占一段，省下的纵向空间都留给下面的 WebDAV 列表 */}
                    {onOpenBookmark && (
                        <Tooltip title='支持 Chrome / Edge / Firefox 导出的 HTML 书签文件，导入前可以先挑要哪些、归到哪个分组'>
                            <Button
                                variant='text'
                                onClick={onOpenBookmark}
                                startIcon={<BookmarkAddedIcon fontSize='small' />}
                                sx={{ ml: { sm: "auto" }, color: "text.secondary", flexShrink: 0 }}
                            >
                                导入浏览器书签
                            </Button>
                        </Tooltip>
                    )}
                </Stack>
                {localFile && (
                    <Typography variant='body2' sx={{ mt: 1 }}>
                        已选择：{localFile.name}
                    </Typography>
                )}
                {/* 加密备份：先输口令解开，再走和明文一样的恢复流程 */}
                {encryptedBytes && !localData && (
                    <Stack
                        direction={{ xs: "column", sm: "row" }}
                        spacing={1}
                        alignItems={{ sm: "center" }}
                        sx={{ mt: 1 }}
                    >
                        <TextField
                            id='backup-restore-password'
                            label='备份密码'
                            type='password'
                            size='small'
                            value={restorePassword}
                            onChange={e => setRestorePassword(e.target.value)}
                            autoComplete='off'
                            sx={{ flex: 1 }}
                        />
                        <Button
                            variant='outlined'
                            onClick={handleDecryptBackup}
                            disabled={decrypting}
                            startIcon={decrypting ? <CircularProgress size={18} /> : undefined}
                        >
                            解密
                        </Button>
                    </Stack>
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
                        startIcon={listLoading ? <CircularProgress size={18} /> : <CloudDownloadIcon />}
                    >
                        查看远端备份
                    </Button>
                </Stack>

                {/* 列表区撑满剩余高度：「恢复」页的内容本来只有「备份」页的一半高，
                    空态也给这块留位，切标签页、点开关时弹窗高矮才不会跳 */}
                <Box
                    sx={{
                        flex: 1,
                        minHeight: 220,
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
                        <Alert
                            severity='info'
                            action={
                                <Button color='inherit' size='small' onClick={() => setTab(0)}>
                                    去填写
                                </Button>
                            }
                        >
                            网盘配置按账号各自保存：本账号还没填过，请先在「备份」标签页填写并测试 WebDAV 配置
                        </Alert>
                    )}

                    {config.url && remoteFiles.length === 0 && !listLoading && (
                        <Typography variant='body2' color='text.secondary' textAlign='center'>
                            暂无远端备份，点击「查看远端备份」重新获取。
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
                                        // 删除中的那条已经被移出列表了，这里只是兜底防连点
                                        disabled={deletingFiles.has(file.name)}
                                        onClick={event => {
                                            event.stopPropagation();
                                            handleDeleteRemote(file.name);
                                        }}
                                        aria-label={`删除 ${file.name}`}
                                    >
                                        {deletingFiles.has(file.name) ? (
                                            <CircularProgress size={16} />
                                        ) : (
                                            <DeleteIcon fontSize='small' />
                                        )}
                                    </IconButton>
                                </ListItemButton>
                            ))}
                        </List>
                    )}
                </Box>

                {needsRemotePassword && (
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
                        <TextField
                            id='backup-remote-restore-password'
                            label='备份密码'
                            type='password'
                            size='small'
                            value={remotePassword}
                            onChange={e => setRemotePassword(e.target.value)}
                            autoComplete='off'
                            sx={{ flex: 1 }}
                        />
                        <Button
                            variant='outlined'
                            onClick={handleRestoreRemote}
                            disabled={!remotePassword || restoring}
                        >
                            解密并恢复
                        </Button>
                    </Stack>
                )}

                {remoteError && (
                    <Alert severity='error' sx={{ mt: 1 }}>
                        {remoteError}
                    </Alert>
                )}

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
            <Box sx={{ height: 24, flexShrink: 0 }} />
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
                    // 高度写在 paper 层而不是内容层：内容层写死的话，遇到小视口 /
                    // 系统 125% 缩放（CSS 视口只有 ~830px 高），弹窗整体会顶满甚至
                    // 超出屏幕，底部按钮区和页面底栏叠在一起。
                    // 高度写在这里，弹窗在任何视口下上下至少各留 24px，永远不顶满；
                    // 内容区 flex 填剩余高度，内容装不下时在区内滚动。
                    // 上限取 880：备份页自然高 ~640（含末尾留白），扣掉标题/标签页/
                    // 按钮行约 166px 后需要 ~806 才装得下，880 让 1000px 左右的常见
                    // 视口完全不出滚动条；更矮的视口仍在区内滚动，外框不超屏幕。
                    height: { xs: "auto", sm: "min(880px, calc(100% - 48px))" },
                    maxHeight: { sm: "calc(100% - 48px)" },
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

            {/* 内容区不再写死高度：sm 以上由弹窗 paper（定高）扣掉标题/标签页/按钮区
                后 flex 填满；xs 维持 58vh。
                备份页自然高实测 ~640（含末尾留白）：CSS 视口 ≥ 950px 时外框取到 880，
                扣掉约 166px 的标题/标签/按钮后还有 ~714，整页装得下、不出滚动条；
                更矮的视口（如 900px 只能给到 852）在区内滚动，外框依然不超屏幕。
                再往备份页加控件时先跑 harness/backup-dialog-probe.mjs 看自然高度。 */}
            <DialogContent
                sx={{
                    pt: 1,
                    height: { xs: "58vh" },
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                }}
            >
                {/* 定时任务失败的提示：只在真失败过一次时出现，平时不占地方。
                    任务下一次跑成功会自动撤掉（见 worker/cron.ts 的 clearCronError）。 */}
                {cronError ? (
                    <Alert severity='warning' sx={{ mb: 1.5, flexShrink: 0 }}>
                        <Typography variant='body2' fontWeight={600}>
                            {cronError.task === "backup" ? "每周自动备份" : "死链巡检"}未成功
                            {cronError.at
                                ? `（${formatCronErrorTime(cronError.at)}）`
                                : ""}
                        </Typography>
                        <Typography variant='caption' color='text.secondary'>
                            {cronError.message}
                        </Typography>
                    </Alert>
                ) : null}
                {tab === 0 ? renderBackupTab() : renderRestoreTab()}

                {/* 导入进度：只有服务端/本机真的报了条数才显示百分比 ——
                    拿不到进度时宁可只转圈，也不画一根「按时间匀速前进」的假进度条 */}
                {restoring && importProgress ? (
                    <Box sx={{ mt: 1.5, flexShrink: 0 }}>
                        <Stack direction='row' justifyContent='space-between' sx={{ mb: 0.5 }}>
                            <Typography variant='caption' color='text.secondary'>
                                {IMPORT_STAGE_LABEL[importProgress.stage]}
                            </Typography>
                            <Typography variant='caption' color='text.secondary'>
                                {importProgress.done} / {importProgress.total}
                            </Typography>
                        </Stack>
                        <LinearProgress
                            variant='determinate'
                            value={
                                importProgress.total > 0
                                    ? Math.min(
                                          100,
                                          (importProgress.done / importProgress.total) * 100
                                      )
                                    : 0
                            }
                        />
                    </Box>
                ) : null}
            </DialogContent>

            {/* 顶部分隔线：内容滚动到底时按钮行离底部只剩几 px，容易和这里
                的「关闭」行视觉上叠在一起；一条线把两个区域明确隔开 */}
            <DialogActions
                sx={{
                    px: 2,
                    pb: 1.5,
                    pt: 1,
                    borderTop: "1px solid",
                    borderColor: "divider",
                }}
            >
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
