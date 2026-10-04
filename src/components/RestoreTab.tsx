// src/components/RestoreTab.tsx
// 「数据备份」弹窗里的「恢复 / 导入」这一页：本地文件 / 加密备份 / WebDAV 远端 / 浏览器书签。
//
// 与 BackupTab 同期从 BackupDialog.tsx 搬出来的纯渲染搬迁（见那个文件头的说明）。
// 这一页同样是纯受控渲染：状态与写操作留在 BackupDialog，这里只负责画。

import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import type { ExportData, WebDavConfig, WebDavFile } from "../API/http";
import { formatSize, formatTime } from "../utils/backupFormat";
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Divider,
    FormControlLabel,
    IconButton,
    List,
    ListItemButton,
    ListItemText,
    Stack,
    Switch,
    TextField,
    Typography,
} from "@mui/material";
import BookmarkAddedIcon from "@mui/icons-material/BookmarkAdded";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadFileIcon from "@mui/icons-material/UploadFile";

export interface RestoreTabProps {
    /** 切到「备份」页：导入书签那一节会用到 */
    setTab: Dispatch<SetStateAction<number>>;
    /** 默认合并；覆盖会先清空现有数据，是这一页里唯一不可逆的动作 */
    overwrite: boolean;
    setOverwrite: Dispatch<SetStateAction<boolean>>;
    // ---- 从本地文件恢复 ----
    localFile: File | null;
    localData: ExportData | null;
    localError: string | null;
    handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
    encryptedBytes: Uint8Array | null;
    restorePassword: string;
    setRestorePassword: Dispatch<SetStateAction<string>>;
    decrypting: boolean;
    handleDecryptBackup: () => Promise<void>;
    handleRestoreLocal: () => Promise<void>;
    // ---- 从 WebDAV 远端恢复 ----
    config: WebDavConfig;
    remoteFiles: WebDavFile[];
    listLoading: boolean;
    loadRemoteFiles: (cfg: WebDavConfig, options?: { silent?: boolean }) => Promise<void>;
    selectedRemote: string;
    setSelectedRemote: Dispatch<SetStateAction<string>>;
    handleRestoreRemote: () => Promise<void>;
    handleDeleteRemote: (filename: string) => Promise<void>;
    deletingFiles: Set<string>;
    needsRemotePassword: boolean;
    remotePassword: string;
    setRemotePassword: Dispatch<SetStateAction<string>>;
    remoteError: string | null;
    // ---- 通用 ----
    restoring: boolean;
    /** 打开「导入浏览器书签」；不传就不显示那一节 */
    onOpenBookmark?: () => void;
}

export default function RestoreTab({
    setTab, overwrite, setOverwrite, localFile, localData, localError, handleFileSelect, encryptedBytes, restorePassword, setRestorePassword, decrypting, handleDecryptBackup, handleRestoreLocal, config, remoteFiles, listLoading, loadRemoteFiles, selectedRemote, setSelectedRemote, handleRestoreRemote, handleDeleteRemote, deletingFiles, needsRemotePassword, remotePassword, setRemotePassword, remoteError, restoring, onOpenBookmark,
}: RestoreTabProps) {
    return (
        <Stack spacing={1.5} sx={{ mt: 0.5, flex: 1, minHeight: 0 }}>
            <FormControlLabel
                control={
                    <Switch
                        checked={overwrite}
                        onChange={e => setOverwrite(e.target.checked)}
                        color={overwrite ? "error" : "primary"}
                        size='small'
                    />
                }
                label={
                    <Box>
                        <Typography
                            variant='body2'
                            color={overwrite ? "error.main" : "text.primary"}
                            sx={{
                                fontWeight: '600'
                            }}
                        >
                            {overwrite ? "覆盖恢复（清空现有数据后导入）" : "合并导入（保留现有数据并追加）"}
                        </Typography>
                        <Typography variant='caption' sx={{
                            color: 'text.secondary'
                        }}>
                            {overwrite
                                ? "先清空现在的分组与站点，再按备份重建；保留原有 ID 与星标 / 标签，用于把整站还原成备份那一刻的样子"
                                : "备份内容追加到现有数据后面，已有的分组与站点不动，重复链接会跳过"}
                        </Typography>
                    </Box>
                }
            />
            {/* 覆盖会删掉现有数据，把话说在动作之前，而不是等用户点了才发现 */}
            {overwrite && (
                <Alert severity='warning' sx={{ mt: -0.5 }}>
                    覆盖恢复会先清空现有的分组与站点，再导入备份内容。确定现在的导航站数据已经不需要了吗？
                </Alert>
            )}

            <Divider />

            <Box>
                <Typography variant='subtitle2' gutterBottom sx={{
                    fontWeight: '600'
                }}>
                    从本地文件恢复
                </Typography>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{
                    alignItems: { sm: "center" }
                }}>
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
                        sx={{
                            alignItems: { sm: "center" },
                            mt: 1
                        }}>
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

            {/* 浏览器书签单占一节：它跟「恢复备份」不是一回事（来源是书签 HTML，
                不是本站备份），挤在恢复按钮右边时很容易被当成「恢复的一种」而错过 */}
            {onOpenBookmark && (
                <>
                    <Divider />
                    <Box>
                        <Typography variant='subtitle2' gutterBottom sx={{
                            fontWeight: '600'
                        }}>
                            从浏览器导入
                        </Typography>
                        <Typography
                            variant='caption'
                            sx={{
                                color: 'text.secondary',
                                display: "block",
                                mb: 0.75
                            }}>
                            支持 Chrome / Edge / Firefox 导出的 HTML 书签文件，导入前可以先挑要哪些、归到哪个分组。
                        </Typography>
                        <Button
                            variant='outlined'
                            onClick={onOpenBookmark}
                            startIcon={<BookmarkAddedIcon fontSize='small' />}
                        >
                            导入浏览器书签
                        </Button>
                    </Box>
                </>
            )}

            <Divider />

            <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <Stack
                    direction='row'
                    sx={{
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        mb: 1
                    }}>
                    <Typography variant='subtitle2' sx={{
                        fontWeight: '600'
                    }}>
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
                        <Typography
                            variant='body2'
                            sx={{
                                color: 'text.secondary',
                                textAlign: 'center'
                            }}>
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
}
