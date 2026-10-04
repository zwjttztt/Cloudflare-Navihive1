// src/components/BackupDialog.tsx
// 数据备份与恢复：支持备份到本地文件 / WebDAV，并支持从本地或 WebDAV 恢复
import { useState, useEffect, useRef } from "react";
import { ExportData, WebDavConfig, WebDavFile, type ImportProgress } from "../API/http";
import { NavigationClient } from "../API/client";
import { MockNavigationClient } from "../API/mock";
import { decryptBackup, isEncryptedBackup } from "../API/crypto";
import BackupTab from "./BackupTab";
import RestoreTab from "./RestoreTab";
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
    Tabs,
    Tab,
    Alert,
    Chip,
    LinearProgress,
    useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";

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


/** 定时任务失败的时间：解析不出来就原样显示，别因为一行留痕把整个弹窗搞崩 */
function formatCronErrorTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("zh-CN", { hour12: false });
}

/** 导入各阶段的中文名。阶段本身由服务端推进，这里只负责说人话 */
const IMPORT_STAGE_LABEL: Record<ImportProgress["stage"], string> = {
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
    // 默认合并而不是覆盖：覆盖会先清空现有数据，是这一页里唯一不可逆的动作。
    // 真要「整站还原成备份那样」再手动切过去，切过去时下面会给出红色提示。
    const [overwrite, setOverwrite] = useState(false);
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

    // 打开时同步外部保存的 WebDAV 配置，之后**不跟随** webdavConfig 的变化。
    // 这不是偷懒：「测试连接并保存」按钮就在本弹窗里，保存完外部配置会变，
    // 一旦跟随，这段就会把用户正在填的备份口令、本地文件选择一起清掉
    // （看起来像「保存完表单自己清空了」）。所以依赖里只放 open / initialTab。
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

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='md'
            slotProps={{
                paper: {
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
                }
            }}
        >
            <DialogTitle sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", pb: 1 }}>
                <Typography variant='h6' component='div' sx={{
                    fontWeight: '600'
                }}>
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
                        <Typography variant='body2' sx={{
                            fontWeight: 600
                        }}>
                            {cronError.task === "backup" ? "每周自动备份" : "死链巡检"}未成功
                            {cronError.at
                                ? `（${formatCronErrorTime(cronError.at)}）`
                                : ""}
                        </Typography>
                        <Typography variant='caption' sx={{
                            color: 'text.secondary'
                        }}>
                            {cronError.message}
                        </Typography>
                    </Alert>
                ) : null}
                tab === 0 ? (
                    <BackupTab
                        config={config}
                        setConfig={setConfig}
                        handleConfigChange={handleConfigChange}
                        testing={testing}
                        testResult={testResult}
                        handleTest={handleTest}
                        uploading={uploading}
                        handleUpload={handleUpload}
                        webdavActionsRef={webdavActionsRef}
                        autoBackup={autoBackup}
                        onToggleAutoBackup={onToggleAutoBackup}
                        lastBackupAt={lastBackupAt}
                        remoteFiles={remoteFiles}
                        includeCredentials={includeCredentials}
                        onIncludeCredentialsChange={onIncludeCredentialsChange}
                        encryptLocal={encryptLocal}
                        setEncryptLocal={setEncryptLocal}
                        backupPassword={backupPassword}
                        setBackupPassword={setBackupPassword}
                        backupPasswordConfirm={backupPasswordConfirm}
                        setBackupPasswordConfirm={setBackupPasswordConfirm}
                        showBackupPassword={showBackupPassword}
                        setShowBackupPassword={setShowBackupPassword}
                        showPassword={showPassword}
                        setShowPassword={setShowPassword}
                        showWebdavBackupPassword={showWebdavBackupPassword}
                        setShowWebdavBackupPassword={setShowWebdavBackupPassword}
                        onDownloadLocal={onDownloadLocal}
                        onNotify={onNotify}
                    />
                ) : (
                    <RestoreTab
                        setTab={setTab}
                        overwrite={overwrite}
                        setOverwrite={setOverwrite}
                        localFile={localFile}
                        localData={localData}
                        localError={localError}
                        handleFileSelect={handleFileSelect}
                        encryptedBytes={encryptedBytes}
                        restorePassword={restorePassword}
                        setRestorePassword={setRestorePassword}
                        decrypting={decrypting}
                        handleDecryptBackup={handleDecryptBackup}
                        handleRestoreLocal={handleRestoreLocal}
                        config={config}
                        remoteFiles={remoteFiles}
                        listLoading={listLoading}
                        loadRemoteFiles={loadRemoteFiles}
                        selectedRemote={selectedRemote}
                        setSelectedRemote={setSelectedRemote}
                        handleRestoreRemote={handleRestoreRemote}
                        handleDeleteRemote={handleDeleteRemote}
                        deletingFiles={deletingFiles}
                        needsRemotePassword={needsRemotePassword}
                        remotePassword={remotePassword}
                        setRemotePassword={setRemotePassword}
                        remoteError={remoteError}
                        restoring={restoring}
                        onOpenBookmark={onOpenBookmark}
                    />
                )

                {/* 导入进度：只有服务端/本机真的报了条数才显示百分比 ——
                    拿不到进度时宁可只转圈，也不画一根「按时间匀速前进」的假进度条 */}
                {restoring && importProgress ? (
                    <Box sx={{ mt: 1.5, flexShrink: 0 }}>
                        <Stack
                            direction='row'
                            sx={{
                                justifyContent: 'space-between',
                                mb: 0.5
                            }}>
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
                                {IMPORT_STAGE_LABEL[importProgress.stage]}
                            </Typography>
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
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
