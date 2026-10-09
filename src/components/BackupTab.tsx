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
import { formatSize, formatTime } from "../utils/backupFormat";
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
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";

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
    /** 上一次备份的时间（ISO 字符串） */
    lastBackupAt: string;
    remoteFiles: WebDavFile[];
    /** 备份文件里是否带网站的账号密码 */
    includeCredentials: boolean;
    onIncludeCredentialsChange: (enabled: boolean) => void;
    /** 备份文件里是否带记事本。默认 true（与凭据相反：笔记是主要内容，凭据才敏感） */
    includeNotes: boolean;
    onIncludeNotesChange: (enabled: boolean) => void;
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

export default function BackupTab({
    config, setConfig, handleConfigChange, testing, testResult, handleTest, uploading, handleUpload, webdavActionsRef, autoBackup, onToggleAutoBackup, lastBackupAt, remoteFiles, includeCredentials, onIncludeCredentialsChange, includeNotes, onIncludeNotesChange, encryptLocal, setEncryptLocal, backupPassword, setBackupPassword, backupPasswordConfirm, setBackupPasswordConfirm, showBackupPassword, setShowBackupPassword, showPassword, setShowPassword, showWebdavBackupPassword, setShowWebdavBackupPassword, onDownloadLocal, onNotify,
}: BackupTabProps) {
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

                {/* 记事本开关：默认**不含**。导航备份与笔记备份是两套独立备份
                    （见 worker/notesBackup.ts），笔记走自己的 WebDAV 备份；
                    这里默认关掉、想带要主动开。它与凭据刻意分成两个 ——
                    合并成一个的话，用户为了拿笔记就得把密码也导出去。
                    不套警告色边框：笔记是明文的，但不像密码那样属于「凭据」。 */}
                <Box
                    sx={{
                        mb: 1,
                        px: 1,
                        py: 0.5,
                        borderRadius: 2,
                        border: 1,
                        borderColor: "divider",
                    }}
                >
                    <FormControlLabel
                        sx={{ display: "flex", mr: 0, ml: 0 }}
                        control={
                            <Switch
                                checked={includeNotes}
                                size='small'
                                onChange={e => onIncludeNotesChange(e.target.checked)}
                                slotProps={{
                                    input: { "aria-label": "备份包含记事本" },
                                }}
                            />
                        }
                        label={<Typography variant='body2'>备份包含记事本</Typography>}
                    />
                    <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{ display: "block", ml: 5.5 }}
                    >
                        {includeNotes
                            ? "导出文件里会带上全部笔记（Markdown 源码）。"
                            : "导出文件不含笔记；导入这样的备份时，本地笔记保持不动。"}
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
                    <Typography
                        variant='caption'
                        sx={{
                            color: 'text.secondary',
                            display: 'block',
                            mt: -0.5
                        }}>
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
