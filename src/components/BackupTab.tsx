// src/components/BackupTab.tsx
// 「数据备份」弹窗里的「备份」这一页：本地下载 / WebDAV 上传 / 每周定时备份。
//
// 从 BackupDialog.tsx 搬出来的纯渲染搬迁 —— 原本它是那个文件里两个巨大的 render
// 函数之一（renderBackupTab / renderRestoreTab，加起来 700 多行），把弹窗撑到 1381 行：
// 想在这两页里改一个开关，得先在一个上千行的文件里找到自己要的那一段。
// 搬出来之后每页一个文件，弹窗本体只剩状态编排。
//
// 这一页是纯受控渲染：状态与所有写操作都留在 BackupDialog 里，这里只负责画。
// props 看着多，是因为这一页确实有这么多开关（凭据 / 加密 / 口令 / 定时），
// 收敛成一个 ctx 对象只会把类型信息抹掉。

import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from "react";
import type { WebDavConfig, WebDavFile } from "../API/http";
import { AUTO_BACKUP_STALE_DAYS, daysSince, formatSize, formatTime } from "../utils/backupFormat";
// 口令类输入框统一走「text + CSS 遮蔽」：type=password 会被浏览器当成登录表单
// 自动填充（还连带把顶栏搜索框当用户名框），见 utils/secretInput.ts 的结论。
import { SECRET_IGNORE_ATTRS, secretInputSx, secretInputType } from "../utils/secretInput";
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Divider,
    FormControlLabel,
    IconButton,
    InputAdornment,
    Stack,
    Switch,
    TextField,
    Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOffOutlined";

export interface BackupTabProps {
    /** WebDAV 配置（弹窗里的临时副本，保存才写回） */
    config: WebDavConfig;
    setConfig: Dispatch<SetStateAction<WebDavConfig>>;
    handleConfigChange: (field: keyof WebDavConfig) => (e: ChangeEvent<HTMLInputElement>) => void;
    testing: boolean;
    testResult: { success: boolean; message: string } | null;
    handleTest: () => Promise<void>;
    uploading: boolean;
    handleUpload: () => Promise<void>;
    /** 开了「测试连接」的结果 Alert 会撑高内容区，用它把按钮行滚进可视区 */
    webdavActionsRef: RefObject<HTMLDivElement | null>;
    /** 是否开启每周自动备份 */
    autoBackup: boolean;
    onToggleAutoBackup?: (enabled: boolean) => Promise<void>;
    /** 上一次备份的时间（ISO 字符串）。⚠️ 手动备份也会刷新它，不能用来判断定时备份的死活 */
    lastBackupAt: string;
    lastBackupInfo?: string;
    /** 最近一次**自动**备份成功的时间（ISO）；没有记录时为空串 */
    lastAutoBackupAt: string;
    remoteFiles: WebDavFile[];
    /** 备份文件里是否带网站的账号密码 */
    includeCredentials: boolean;
    onIncludeCredentialsChange: (enabled: boolean) => void;
    encryptLocal: boolean;
    setEncryptLocal: Dispatch<SetStateAction<boolean>>;
    backupPassword: string;
    setBackupPassword: Dispatch<SetStateAction<string>>;
    backupPasswordConfirm: string;
    setBackupPasswordConfirm: Dispatch<SetStateAction<string>>;
    showBackupPassword: boolean;
    setShowBackupPassword: Dispatch<SetStateAction<boolean>>;
    showPassword: boolean;
    setShowPassword: Dispatch<SetStateAction<boolean>>;
    showWebdavBackupPassword: boolean;
    setShowWebdavBackupPassword: Dispatch<SetStateAction<boolean>>;
    onDownloadLocal: (password?: string) => void | Promise<void>;
    onNotify: (message: string, severity?: "success" | "error" | "info") => void;
}

/**
 * 上次备份详情（webdav.lastBackupInfo 的 JSON）。
 *
 * ⚠️ 这个值是**服务端写进来的用户配置**，不是编译期常量：老库里没有这个键、
 * 或者某次写入被截断，JSON.parse 会抛 —— 而这里在渲染路径上，抛出去就是整个
 * 备份对话框打不开。所以解析失败一律退化成「不知道详情」，只显示时间。
 */
function parseLastBackupInfo(raw: string): {
    size: number;
    durationMs: number;
    mode: string;
    /**
     * 那一份备份**实际**有没有加密：true / false / null（老记录没有这个字段 = 不知道）。
     *
     * 这是整个界面上唯一可信的加密状态来源：客户端读不到 webdav.backupPassword
     * （bootstrap 按 isPrivateUserConfigKey 把它过滤掉了），所以「当前配没配口令」
     * 前端无从判断；而「网盘上躺着的那份是不是明文」是历史事实，只有它能回答。
     * null 与 false 必须分开 —— 老记录猜成「未加密」会凭空造出一条假的警示。
     */
    encrypted: boolean | null;
} | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as {
            size?: unknown;
            durationMs?: unknown;
            mode?: unknown;
            encrypted?: unknown;
        };
        const size = typeof parsed.size === "number" && parsed.size > 0 ? parsed.size : 0;
        const durationMs =
            typeof parsed.durationMs === "number" && parsed.durationMs > 0 ? parsed.durationMs : 0;
        const mode = typeof parsed.mode === "string" ? parsed.mode : "";
        const encrypted = typeof parsed.encrypted === "boolean" ? parsed.encrypted : null;
        if (!size && !durationMs) return null;
        return { size, durationMs, mode, encrypted };
    } catch {
        return null;
    }
}

export default function BackupTab({
    config, setConfig, handleConfigChange, testing, testResult, handleTest, uploading, handleUpload, webdavActionsRef, autoBackup, onToggleAutoBackup, lastBackupAt, lastBackupInfo, lastAutoBackupAt, remoteFiles, includeCredentials, onIncludeCredentialsChange, encryptLocal, setEncryptLocal, backupPassword, setBackupPassword, backupPasswordConfirm, setBackupPasswordConfirm, showBackupPassword, setShowBackupPassword, showPassword, setShowPassword, showWebdavBackupPassword, setShowWebdavBackupPassword, onDownloadLocal, onNotify,
}: BackupTabProps) {
    const lastInfo = parseLastBackupInfo(lastBackupInfo ?? "");

    // ---- 「上次备份」那几行的原料 ----
    //
    // 老库（升级前）没有 webdav.lastAutoBackupAt，但 lastBackupInfo.mode === "auto"
    // 说明最后一次备份就是自动备份 —— 拿 lastBackupAt 兜底，免得升级后第一眼
    // 看到「还没有自动备份记录」，那会让人以为定时备份从来没跑过。
    const autoAt = lastAutoBackupAt || (lastInfo?.mode === "auto" ? lastBackupAt : "");
    const autoDays = autoAt ? daysSince(autoAt, Date.now()) : null;
    // 体积 / 耗时说的是「那一次备份」，所以要挂到它所属的那一行（自动 or 手动）上，
    // 混在一句里会出现「最近一次自动备份……（手动那次的体积）」这种错配
    const detail = lastInfo
        ? `，${formatSize(lastInfo.size)}${
              lastInfo.durationMs ? `，耗时 ${(lastInfo.durationMs / 1000).toFixed(1)} 秒` : ""
          }`
        : "";
    const autoLine = autoAt
        ? `最近一次自动备份：${formatTime(autoAt)}${
              autoDays === null ? "" : autoDays === 0 ? "（今天）" : `（${autoDays} 天前）`
          }${lastInfo?.mode === "auto" ? detail : ""}`
        : "还没有自动备份记录";
    // 只有 lastBackupInfo 说明那一次是手动，才谈得上「最近一次手动备份」：
    // lastBackupAt 只记最后一次（可能是自动也可能是手动），没有 mode 就无法判断，
    // 硬凑一句只会是错的（会让用户以为手动备份时间比实际更近）
    const manualLine =
        lastInfo?.mode === "manual" && lastBackupAt
            ? `最近一次手动备份：${formatTime(lastBackupAt)}${detail}`
            : "";
    // 第三种情况：lastBackupInfo 缺失 / 损坏 / mode 认不出（老库、写入被截断）。
    // 这时分不清那一次是自动还是手动，但**时间仍然是有用的信息** ——
    // 直接不显示等于把「上次备份是什么时候」这条丢掉了，所以给一句老实的话说清楚。
    const unknownKind = lastInfo?.mode === "auto" || lastInfo?.mode === "manual";
    const unknownLine =
        !unknownKind && lastBackupAt
            ? `最近一次备份：${formatTime(lastBackupAt)}（无法判断是自动还是手动）`
            : "";
    // 加密状态只跟着「最后一次备份」那一行走（它描述的就是那一份文件）
    const encryptionNote =
        lastInfo?.encrypted === null || lastInfo?.encrypted === undefined
            ? ""
            : lastInfo.encrypted
              ? "，已加密"
              : "，未加密";
    // 定时备份开着的账户，超过 8 天没成功就是该有人去看网盘配置了。
    // 这个提示存在的理由：线上就出现过「自动备份静默死了两周、界面一切正常」——
    // 因为 lastBackupAt 被手动备份刷成了新时间。
    const autoStale = autoBackup && autoDays !== null && autoDays > AUTO_BACKUP_STALE_DAYS;

    return (
        <Stack spacing={0.75} sx={{ mt: 0.5, flex: 1, minHeight: 0 }}>
            <Box>
                {/* 顺序是「先选怎么导，再导出」：下载按钮排在配置项之后。
                    原来按钮压在标题右边，用户常常先点了下载，才发现下面的
                    凭据开关和加密还没设，白下一份不带密码 / 不带加密的文件。 */}
                <Typography variant='subtitle2' sx={{
                    fontWeight: '600'
                }}>
                    备份到本地
                </Typography>
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mt: 0.25,
                        mb: 0.5
                    }}>
                    导出分组、站点、网站设置，以及本机的星标与标签。
                </Typography>
                {/* 2026-10-24 用户问「AI 设置 / 全站设置会不会跟着导入导出」——
                    界面上原来一个字都没写，换台机器恢复完发现 AI 还得重配，只能靠猜。
                    当天用户进一步要求 AI 设置整组也进备份，于是它从「不会跟着走」
                    挪到了「会跟着走」；密钥会写进备份文件，这句提醒就是它的代价说明。 */}
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mb: 1,
                        lineHeight: 1.7
                    }}>
                    会跟着走：站点 / 分组、全站外观与常规设置（标题、主题、背景、搜索、离线缓存等）、
                    <b>AI 设置整组</b>（模型服务、端点、API 密钥 —— 按账号各存一份）。
                    <br />
                    不会跟着走：各类凭据（本站账号密码、WebDAV、备份口令），以及记事本（笔记有自己独立的备份）。
                    <br />
                    ⚠️ AI 密钥会写进备份文件：建议在下面设一个备份口令（不设则导出的是明文 JSON），
                    文件本身也要妥善保管 —— 谁拿到它谁就拿到你的 AI 密钥。
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
                <Stack
                    direction='row'
                    spacing={0.5}
                    sx={{
                        alignItems: 'center',
                        mt: 0.75
                    }}>
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
                            sx={{
                                color: 'success.dark',
                                display: "block",
                                ml: 5.5,
                                mb: 0.5
                            }}>
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
                                name='backup-passphrase-new'
                                type={secretInputType(showBackupPassword)}
                                size='small'
                                fullWidth
                                value={backupPassword}
                                onChange={e => setBackupPassword(e.target.value)}
                                autoComplete='off'
                                sx={secretInputSx(showBackupPassword)}
                                slotProps={{ input: { ...SECRET_IGNORE_ATTRS } }}
                            />
                            <TextField
                                id='backup-encrypt-password-confirm'
                                label='确认备份密码'
                                name='backup-passphrase-confirm'
                                type={secretInputType(showBackupPassword)}
                                size='small'
                                fullWidth
                                value={backupPasswordConfirm}
                                onChange={e => setBackupPasswordConfirm(e.target.value)}
                                autoComplete='off'
                                sx={secretInputSx(showBackupPassword)}
                                slotProps={{
                                    input: {
                                        ...SECRET_IGNORE_ATTRS,
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

                {/* 下载动作收在这一块的最后：把上面两项定完再点 */}
                <Stack
                    direction='row'
                    sx={{
                        justifyContent: 'flex-end',
                        mt: 1.5
                    }}>
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
            </Box>

            <Divider />

            <Box>
                <Typography variant='subtitle2' gutterBottom sx={{
                    fontWeight: '600'
                }}>
                    备份到 WebDAV
                </Typography>
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mb: 0.75
                    }}>
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
                            name='webdav-app-passphrase'
                            type={secretInputType(showPassword)}
                            placeholder='建议使用应用专用密码'
                            value={config.password}
                            onChange={handleConfigChange("password")}
                            size='small'
                            fullWidth
                            autoComplete='off'
                            sx={secretInputSx(showPassword)}
                            // 应用密码一长串随机字符，粘进去看不到内容很容易粘错；
                            // 点眼睛就能核对。默认仍然遮住
                            slotProps={{
                                input: {
                                    ...SECRET_IGNORE_ATTRS,
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
                        name='webdav-backup-passphrase'
                        type={secretInputType(showWebdavBackupPassword)}
                        placeholder='留空则备份不加密'
                        value={config.backupPassword || ""}
                        onChange={handleConfigChange("backupPassword")}
                        size='small'
                        fullWidth
                        autoComplete='off'
                        sx={secretInputSx(showWebdavBackupPassword)}
                        slotProps={{
                            input: {
                                ...SECRET_IGNORE_ATTRS,
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
                    <Typography
                        variant='caption'
                        sx={{
                            color: 'text.secondary',
                            display: 'block',
                            mt: -0.5
                        }}>
                        设了就用它加密上传（恢复时要填同一个密码，无法找回）。
                        手动 / 自动 / 远端恢复共用，与服务端的 AUTH_SECRET 无关。
                    </Typography>
                    {/* 留空的后果必须**常驻**说清楚（2026-10-29 补）。
                        此前这里只有一句「留空则明文上传」，没人知道明文里到底是什么 ——
                        而实测线上 backupPassword 就是没配的，网盘上那一份是**明文 gzip**：
                        里面有站点的账号密码（受「含账号密码」开关控制）**和 AI 密钥**
                        （走 ownConfigs 那条独立通道，完全不受那个开关影响）。
                        ⚠️ 不要试图按「当前有没有设口令」来决定这句显不显示：客户端读不到
                        webdav.backupPassword（bootstrap 按 isPrivateUserConfigKey 过滤掉了），
                        判断不出来。所以这句一律常驻，加密与否看上一段的 lastBackupInfo.encrypted。 */}
                    <Typography
                        variant='caption'
                        className='nav-backup-encrypt-warning'
                        sx={{
                            display: 'block',
                            mt: -0.25,
                            color: 'warning.main'
                        }}>
                        留空 = 备份文件不加密。文件里有
                        {includeCredentials ? "站点账号密码（当前设置下会导出）与 " : ""}
                        AI 密钥，会以可读形式存在网盘上。
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
                        <Typography
                            variant='caption'
                            sx={{
                                color: 'text.secondary',
                                display: 'block'
                            }}>
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
                        <Typography
                            variant='caption'
                            sx={{
                                color: 'text.secondary',
                                display: 'block'
                            }}>
                            {/* 2026-10-29 措辞改了：到点判定不再是「周一 10:00 那一小时」，
                                而是「距上次成功满 6.5 天」（每小时检查一次，错过会顺延补上）。
                                老文案写死了那个钟点，改完判定后它就是错的。 */}
                            按「距上次成功满 6.5 天」自动上传一次（每小时检查，错过了会在下一小时补上），
                            会替换掉上一次的自动备份；手动备份不会被删除。
                        </Typography>
                        {/* 「自动」与「手动」分两行：
                            以前只有一句「上次备份」，而 lastBackupAt 只记最后一次 ——
                            手动备份会把自动备份的失败完全盖住（线上就漏了整整一周）。
                            字体用 body2 而不是 caption：这是这一页最该被看见的一块信息。 */}
                        <Typography
                            variant='body2'
                            className='nav-backup-last-auto'
                            sx={{
                                display: 'block',
                                mt: 0.25,
                                color: 'text.secondary'
                            }}>
                            {autoLine}
                            {lastInfo?.mode === "auto" && encryptionNote ? (
                                <Box
                                    component='span'
                                    sx={{
                                        color: lastInfo.encrypted ? "text.secondary" : "warning.main",
                                        fontWeight: lastInfo.encrypted ? 400 : 600
                                    }}>
                                    {encryptionNote}
                                </Box>
                            ) : null}
                        </Typography>
                        {unknownLine && (
                            <Typography
                                variant='body2'
                                className='nav-backup-last-unknown'
                                sx={{
                                    display: 'block',
                                    color: 'text.secondary'
                                }}>
                                {unknownLine}
                            </Typography>
                        )}
                        {manualLine && (
                            <Typography
                                variant='body2'
                                className='nav-backup-last-manual'
                                sx={{
                                    display: 'block',
                                    color: 'text.secondary'
                                }}>
                                {manualLine}
                                {encryptionNote ? (
                                    <Box
                                        component='span'
                                        sx={{
                                            color: lastInfo?.encrypted
                                                ? "text.secondary"
                                                : "warning.main",
                                            fontWeight: lastInfo?.encrypted ? 400 : 600
                                        }}>
                                        {encryptionNote}
                                    </Box>
                                ) : null}
                            </Typography>
                        )}
                        {/* 定时备份开着、却超过 8 天没有成功：这行必须显眼，
                            它正是「自动备份静默死了」唯一会在界面上露头的地方 */}
                        {autoStale && (
                            <Typography
                                variant='body2'
                                className='nav-backup-auto-stale'
                                sx={{
                                    display: 'block',
                                    color: 'warning.main',
                                    fontWeight: 600
                                }}>
                                自动备份已 {autoDays} 天没有成功，请检查网盘配置
                            </Typography>
                        )}
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
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
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
}
