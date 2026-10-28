// src/components/AddSiteDialog.tsx
// 新增站点弹窗 —— 原本内联在 App.tsx 里（330 多行），抽出来单独维护。
// 字段顺序与「网站设置」保持一致：名称（含图标预览 + 一键获取）→ 链接 → 描述 → 备注 → 登录凭据。
// 「图标地址」不再是常驻的一行：点名称左边的图标才展开（2026-10-28 合并）。
//
// 这个组件只管渲染：所有状态与提交逻辑仍由 App 通过 useSiteCreator 持有并通过 props 下发，
// 所以抽出来是纯搬移，行为不变。

import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import {
    Avatar,
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
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOffOutlined";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import type { Site } from "../API/types";
import type { SiteAi } from "../context/AiContext";
import DialogCloseButton from "./DialogCloseButton";
import { SECRET_IGNORE_ATTRS, secretInputSx, secretInputType } from "../utils/secretInput";
import { generatePassword } from "../utils/passwordGenerator";
import { dialogActionsSx, dialogTitleSx } from "./dialogShell";

export interface AddSiteDialogProps {
    open: boolean;
    onClose: () => void;
    site: Partial<Site>;
    onInputChange: (e: { target: { name: string; value: string } }) => void;
    showPassword: boolean;
    onTogglePassword: Dispatch<SetStateAction<boolean>>;
    creating: boolean;
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
        onFetchIcon,
        onCreate,
        ai,
        aiBusy,
        aiMessage,
        aiMessageError,
        onAiComplete,
    } = props;

    // 「图标地址」输入框是否展开（2026-10-28：图标并进站点名称那一行之后，
    // 手动改地址改成点左侧图标按需展开）。纯 UI 状态，留在本地就够，
    // 不必往 App 的 useSiteCreator 里塞。
    const [iconEditing, setIconEditing] = useState(false);
    // 哪个地址加载失败了 —— 存字符串而不是布尔：换了新地址自动就能重试预览
    const [brokenIcon, setBrokenIcon] = useState("");
    const previewIcon = site.icon && site.icon !== brokenIcon ? site.icon : "";
    // 站名首字兜底图标（没图 / 加载失败时显示）
    const fallbackIcon = (site.name || "").trim().charAt(0).toUpperCase() || "A";

    return (
        <>
            {/* 新增站点对话框：字段顺序与「网站设置」对齐
                （名称〔含图标〕→ 链接 → 描述 → 备注 → 分隔线 → 登录凭据），宽度也统一成 600px */}
            <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
                <DialogTitle sx={dialogTitleSx}>
                    <Typography component='div' sx={{
                        fontWeight: '600'
                    }}>
                        新增站点
                    </Typography>
                    {/* 换成全站统一的右上角「×」：位置（right/top 12）、Tooltip、
                        aria-label="关闭" 与另外十几个弹窗一致 */}
                    <DialogCloseButton onClose={onClose} />
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
                                /* 图标预览贴框内左侧、一键获取在框内右侧（与「网站设置」
                                   同一套摆放）。点左侧图标展开「图标地址」。 */
                                slotProps={{
                                    inputLabel: { shrink: true },
                                    input: {
                                        startAdornment: (
                                            <InputAdornment position='start'>
                                                <Tooltip
                                                    title={
                                                        iconEditing
                                                            ? "收起图标地址"
                                                            : "图标地址（点一下可手动改）"
                                                    }
                                                >
                                                    <IconButton
                                                        size='small'
                                                        edge='start'
                                                        aria-label='修改图标'
                                                        aria-expanded={iconEditing}
                                                        onClick={() =>
                                                            setIconEditing(v => !v)
                                                        }
                                                        sx={{ p: 0.25, mr: 0.25 }}
                                                    >
                                                        {previewIcon ? (
                                                            <Avatar
                                                                src={previewIcon}
                                                                alt=''
                                                                variant='rounded'
                                                                sx={{
                                                                    width: 26,
                                                                    height: 26,
                                                                    borderRadius: 1,
                                                                    fontSize: 13,
                                                                    // 底色 + 兜底字常挂：远程图标没到 / 拉不到时
                                                                    // 这一格不能是个白洞
                                                                    bgcolor: "primary.light",
                                                                    color: "primary.main",
                                                                    border: "1px solid",
                                                                    borderColor: "primary.main",
                                                                }}
                                                                slotProps={{
                                                                    img: {
                                                                        onError: () =>
                                                                            setBrokenIcon(
                                                                                site.icon || ""
                                                                            ),
                                                                        style: {
                                                                            objectFit: "cover",
                                                                        },
                                                                    },
                                                                }}
                                                            >
                                                                {fallbackIcon}
                                                            </Avatar>
                                                        ) : (
                                                            <Avatar
                                                                variant='rounded'
                                                                sx={{
                                                                    width: 26,
                                                                    height: 26,
                                                                    borderRadius: 1,
                                                                    fontSize: 13,
                                                                    bgcolor: "primary.light",
                                                                    color: "primary.main",
                                                                    border: "1px solid",
                                                                    borderColor: "primary.main",
                                                                }}
                                                            >
                                                                {fallbackIcon}
                                                            </Avatar>
                                                        )}
                                                    </IconButton>
                                                </Tooltip>
                                            </InputAdornment>
                                        ),
                                    },
                                }}
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
                            slotProps={{
                                input: {
                                    endAdornment: (
                                        <InputAdornment position='end'>
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
                                }
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

                        {/* 图标地址：并进上面那一行之后不再常驻 —— 点站点名称左侧的图标
                            才展开。留空就用站点首字当图标，所以它不是必填项。
                            「一键获取图标」也在这一格里（用户 2026-10-28 特意要求挪进来：
                            放名称行右边会和链接行的 AI ✨ 挤成两个魔法按钮，容易点错）。 */}
                        {iconEditing ? (
                            <TextField
                                id='site-icon'
                                name='icon'
                                label='图标地址（可选，留空用站名首字）'
                                fullWidth
                                size='small'
                                type='url'
                                variant='outlined'
                                placeholder='填好站点URL后自动生成'
                                value={site.icon}
                                onChange={onInputChange}
                                slotProps={{
                                    inputLabel: { shrink: true },
                                    input: {
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <Tooltip title='根据网站链接一键获取图标URL'>
                                                    <span>
                                                        <IconButton
                                                            size='small'
                                                            edge='end'
                                                            aria-label='根据网站链接获取图标URL'
                                                            disabled={!site.url}
                                                            onClick={onFetchIcon}
                                                        >
                                                            <AutorenewIcon fontSize='small' />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                            </InputAdornment>
                                        ),
                                    },
                                }}
                            />
                        ) : null}

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
                                        slotProps={{
                                            htmlInput: { ...SECRET_IGNORE_ATTRS }
                                        }}
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
                                        slotProps={{
                                            input: {
                                                endAdornment: (
                                                    <InputAdornment position='end'>
                                                        <Tooltip title='生成随机强密码（20 位，含大小写/数字/符号）'>
                                                            <IconButton
                                                                size='small'
                                                                edge='end'
                                                                aria-label='生成随机强密码'
                                                                onClick={() => {
                                                                    // 方案 A：一键生成并填入，顺手揭示方便复制。
                                                                    // 走 onInputChange({name:'site-secret'}) 复用既有映射
                                                                    // （site-secret → password，见 secretInput.formDataKey）。
                                                                    const pw = generatePassword();
                                                                    onInputChange({ target: { name: 'site-secret', value: pw } });
                                                                    onTogglePassword(true);
                                                                }}
                                                            >
                                                                <AutorenewIcon fontSize='small' />
                                                            </IconButton>
                                                        </Tooltip>
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
                                            },

                                            htmlInput: { ...SECRET_IGNORE_ATTRS }
                                        }} />
                                </Box>
                            </Box>
                        </Box>
                    </Stack>
                </DialogContent>

                <DialogActions sx={dialogActionsSx}>
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
