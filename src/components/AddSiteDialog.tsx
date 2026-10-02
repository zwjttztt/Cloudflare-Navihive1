// src/components/AddSiteDialog.tsx
// 新增站点弹窗 —— 原本内联在 App.tsx 里（330 多行），抽出来单独维护。
// 字段顺序与「网站设置」保持一致：名称 → 链接 → 图标 → 描述 → 备注 → 登录凭据。
//
// 这个组件只管渲染：所有状态与提交逻辑仍由 App 通过 useSiteCreator 持有并通过 props 下发，
// 所以抽出来是纯搬移，行为不变。

import type { Dispatch, SetStateAction } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    InputAdornment,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import type { Site } from "../API/types";
import type { SiteAi } from "../context/AiContext";
import { SECRET_IGNORE_ATTRS, secretInputSx, secretInputType } from "../utils/secretInput";

export interface AddSiteDialogProps {
    open: boolean;
    onClose: () => void;
    site: Partial<Site>;
    onInputChange: (e: { target: { name: string; value: string } }) => void;
    showPassword: boolean;
    onTogglePassword: Dispatch<SetStateAction<boolean>>;
    creating: boolean;
    fetchingMeta: boolean;
    onFetchMeta: () => void;
    onFetchIcon: () => void;
    onCreate: () => void;
    /** null 表示这台机器上没有可用的 AI —— 入口不出现 */
    ai: SiteAi | null;
    aiBusy: boolean;
    aiMessage: string;
    aiMessageError: boolean;
    onAiComplete: () => void;
}

export default function AddSiteDialog(props: AddSiteDialogProps) {
    const {
        open,
        onClose,
        site,
        onInputChange,
        showPassword,
        onTogglePassword,
        creating,
        fetchingMeta,
        onFetchMeta,
        onFetchIcon,
        onCreate,
        ai,
        aiBusy,
        aiMessage,
        aiMessageError,
        onAiComplete,
    } = props;

    return (
        <>
                    {/* 新增站点对话框：字段顺序与「网站设置」对齐
                        （名称 → 链接 → 图标 → 描述 → 备注 → 分隔线 → 登录凭据），宽度也统一成 600px */}
                    <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
                        <DialogTitle
                            sx={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 1,
                                px: 3,
                                pt: 2,
                                pb: 1,
                            }}
                        >
                            <Typography variant='h6' component='div' fontWeight='600'>
                                新增站点
                            </Typography>
                            <IconButton
                                color='inherit'
                                onClick={onClose}
                                aria-label='关闭'
                                size='small'
                            >
                                <CloseIcon />
                            </IconButton>
                        </DialogTitle>

                        <Divider />

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
                            <Stack spacing={1.5}>
                                {/* 站点名称 + 站点 URL：最核心的两项并排，一眼就能填完 */}
                                <Box
                                    sx={{
                                        display: "flex",
                                        gap: 1.5,
                                        flexDirection: { xs: "column", sm: "row" },
                                    }}
                                >
                                <Box sx={{ flex: 1 }}>
                                    <TextField
                                        autoFocus
                                        id='site-name'
                                        name='name'
                                        label='站点名称'
                                        required
                                        fullWidth
                                        size='small'
                                        type='text'
                                        variant='outlined'
                                        placeholder='给它起个名字'
                                        value={site.name}
                                        onChange={onInputChange}
                                    />
                                </Box>
                                    <Box sx={{ flex: 1 }}>
                                        <TextField
                                            id='site-url'
                                            name='url'
                                            label='站点URL'
                                            required
                                            fullWidth
                                            size='small'
                                            type='url'
                                            variant='outlined'
                                            placeholder='https://example.com'
                                            value={site.url}
                                            onChange={onInputChange}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <Tooltip title='抓取这个网站的标题和描述'>
                                                    <span>
                                                        <IconButton
                                                            size='small'
                                                            edge='end'
                                                            onClick={
                                                                onFetchMeta
                                                            }
                                                            disabled={
                                                                !site.url ||
                                                                fetchingMeta
                                                            }
                                                            aria-label='抓取站点标题和描述'
                                                        >
                                                            {fetchingMeta ? (
                                                                <CircularProgress
                                                                    size={16}
                                                                />
                                                            ) : (
                                                                <CloudDownloadIcon fontSize='small' />
                                                            )}
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                                {ai?.enabled ? (
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
                                                                    !ai.ready ||
                                                                    aiBusy ||
                                                                    !site.url
                                                                }
                                                                onClick={() =>
                                                                    void onAiComplete()
                                                                }
                                                            >
                                                                {aiBusy ? (
                                                                    <CircularProgress
                                                                        size={16}
                                                                    />
                                                                ) : (
                                                                    <AutoAwesomeIcon fontSize='small' />
                                                                )}
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                ) : null}
                                            </InputAdornment>
                                        ),
                                    }}
                                        />
                                    </Box>
                                </Box>

                                {aiMessage ? (
                                    <Typography
                                        variant='caption'
                                        color={aiMessageError ? "error" : "text.secondary"}
                                        sx={{ display: "block", mt: -1 }}
                                    >
                                        {aiMessage}
                                    </Typography>
                                ) : null}

                                {/* 图标 URL：紧跟站点 URL（它由链接推导而来），魔棒按钮放进输入框内，不再悬在外面 */}
                                <TextField
                                    id='site-icon'
                                    name='icon'
                                    label='图标URL'
                                    InputLabelProps={{ shrink: true }}
                                    fullWidth
                                    size='small'
                                    type='url'
                                    variant='outlined'
                                    placeholder='填好站点URL后自动生成'
                                    value={site.icon}
                                    onChange={onInputChange}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <Tooltip title='根据网站链接一键获取图标URL'>
                                                    <span>
                                                        <IconButton
                                                            size='small'
                                                            edge='end'
                                                            onClick={onFetchIcon}
                                                            disabled={!site.url}
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

                                {/* 站点描述 + 备注：两块说明文字挨在一起 */}
                                <TextField
                                    id='site-description'
                                    name='description'
                                    label='站点描述'
                                    fullWidth
                                    size='small'
                                    type='text'
                                    variant='outlined'
                                    placeholder='一句话说明这个网站是干什么的'
                                    value={site.description}
                                    onChange={onInputChange}
                                />

                                <TextField
                                    id='site-notes'
                                    name='notes'
                                    label='备注'
                                    fullWidth
                                    size='small'
                                    multiline
                                    rows={2}
                                    variant='outlined'
                                    placeholder='可选的私人备注'
                                    value={site.notes}
                                    onChange={onInputChange}
                                />

                                <Divider />

                                {/* 登录凭据：可留空，所以放在最后 */}
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
                                            可留空，保存后能在卡片上一键复制。
                                        </Typography>
                                    </Box>
                                    <Box
                                        sx={{
                                            display: "flex",
                                            gap: 1.5,
                                            flexDirection: { xs: "column", sm: "row" },
                                        }}
                                    >
                                        <Box sx={{ flex: 1 }}>
                                            <TextField
                                                id='site-username'
                                                // name 不叫 username：浏览器靠「名字 + 类型」
                                                // 猜这是登录表单，叫了它就拿导航站自己的
                                                // 登录凭据来填这里
                                                name='site-account'
                                                label='网站账号'
                                                fullWidth
                                                size='small'
                                                type='text'
                                                variant='outlined'
                                                placeholder='登录用户名 / 邮箱（可留空）'
                                                value={site.username || ""}
                                                onChange={onInputChange}
                                                autoComplete='off'
                                                inputProps={{ ...SECRET_IGNORE_ATTRS }}
                                            />
                                        </Box>
                                        <Box sx={{ flex: 1 }}>
                                            <TextField
                                                id='site-password'
                                                // 不叫 password、更不写 autoComplete="new-password"
                                                // —— 后者等于邀请浏览器「存一下？」，原先
                                                // 「添加卡片弹保存密码」就是它招来的。
                                                // 真正的办法是让浏览器认不出这是密码字段：
                                                // type 换 text + CSS 遮蔽（utils/secretInput.ts）
                                                name='site-secret'
                                                label='网站密码'
                                                fullWidth
                                                size='small'
                                                type={secretInputType(showPassword)}
                                                sx={secretInputSx(showPassword)}
                                                variant='outlined'
                                                placeholder='登录密码（可留空）'
                                                value={site.password || ""}
                                                onChange={onInputChange}
                                                autoComplete='off'
                                                inputProps={{ ...SECRET_IGNORE_ATTRS }}
                                                InputProps={{
                                                    endAdornment: (
                                                        <InputAdornment position='end'>
                                                            <IconButton
                                                                size='small'
                                                                edge='end'
                                                                onClick={() =>
                                                                    onTogglePassword(prev => !prev)
                                                                }
                                                                aria-label={
                                                                    showPassword
                                                                        ? "隐藏密码"
                                                                        : "显示密码"
                                                                }
                                                            >
                                                                {showPassword ? (
                                                                    <VisibilityOffIcon fontSize='small' />
                                                                ) : (
                                                                    <VisibilityIcon fontSize='small' />
                                                                )}
                                                            </IconButton>
                                                        </InputAdornment>
                                                    ),
                                                }}
                                            />
                                        </Box>
                                    </Box>
                                </Box>
                            </Stack>
                        </DialogContent>

                        <DialogActions sx={{ px: 3, pb: 2.5, pt: 1, gap: 1.5 }}>
                            <Button onClick={onClose} variant='outlined'>
                                取消
                            </Button>
                            <Button
                                onClick={onCreate}
                                variant='contained'
                                color='primary'
                                disabled={creating}
                            >
                                {creating ? "创建中…" : "创建"}
                            </Button>
                        </DialogActions>
                    </Dialog>
        </>
    );
}
