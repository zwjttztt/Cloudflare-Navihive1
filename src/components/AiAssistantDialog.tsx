// src/components/AiAssistantDialog.tsx
// 「更多选项 → AI 助手」：AI 的开关、provider、凭据与模型，以及一次「测试连接」。
//
// 为什么单独成弹窗而不是塞进「网站设置」：
//   这里的字段是**跟着登录账号走**的私密凭据（user_configs，不进备份），
//   和「站点长什么样」那类全站配置是两回事，混在一起会让人以为改一次全站都变。
//   而且字段有六个，塞进设置弹窗会把它再撑长一截。
//
// 两点硬规矩：
//   1. 默认关。开关没显式打开，一个字节都不往外发。
//   2. 测试连接用**当前填的这份**（不必先保存）—— 用户就是想先试通再决定要不要存。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    InputAdornment,
    LinearProgress,
    MenuItem,
    TextField,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { Section, SwitchRow } from "./dialogSection";
import { dialogActionsSx, dialogContentSx, dialogPaperSx, dialogTitleSx } from "./dialogShell";
import type { AiAssistant, AiTestOutcome } from "../hooks/useAiAssistant";
import { AI_PROVIDERS, aiConfigProblem, aiSettingsFromConfigs, type AiProvider } from "../utils/aiConfig";
import { SECRET_IGNORE_ATTRS, secretInputSx, secretInputType } from "../utils/secretInput";
import {
    AI_API_KEY_KEY,
    AI_CF_ACCOUNT_KEY,
    AI_CF_TOKEN_KEY,
    AI_EMBED_MODEL_KEY,
    AI_ENABLED_KEY,
    AI_ENDPOINT_KEY,
    AI_PROVIDER_KEY,
    AI_TEXT_MODEL_KEY,
} from "../API/configKeys";

/** 这一弹窗管的全部配置键：读写都只碰这些，别的配置项一个不动 */
const AI_KEYS = [
    AI_ENABLED_KEY,
    AI_PROVIDER_KEY,
    AI_ENDPOINT_KEY,
    AI_TEXT_MODEL_KEY,
    AI_EMBED_MODEL_KEY,
    AI_API_KEY_KEY,
    AI_CF_TOKEN_KEY,
    AI_CF_ACCOUNT_KEY,
];

export interface AiConfigClient {
    getConfigs(): Promise<Record<string, string>>;
    setConfigs(configs: Record<string, string>): Promise<boolean>;
}

interface AiAssistantDialogProps {
    open: boolean;
    onClose: () => void;
    /** 只用到读配置与批量写配置两件事 */
    api: AiConfigClient;
    ai: AiAssistant;
    /** 保存成功后回调：App 拿它刷新 /api/ai/status（界面上的 AI 按钮才跟着变可用） */
    onSaved?: () => void;
    /** 当前生效状态的一句话说明，由 App 从 /api/ai/status 拼好传进来 */
    statusText?: string;
}

function Field({
    label,
    value,
    onChange,
    placeholder,
    secret,
    caption,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    /** 凭据字段：默认遮成圆点，右边给一个「显示 / 隐藏」的眼睛 */
    secret?: boolean;
    caption?: string;
}) {
    const [visible, setVisible] = useState(false);
    return (
        <Box>
            <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 0.25 }}>
                {label}
            </Typography>
            <TextField
                size='small'
                fullWidth
                value={value}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
                // 遮蔽走 CSS 而不是 type=password：浏览器认不出这是密码字段，
                // 就不会弹「要不要保存密码」，也不会拿导航站的登录账号来自动填充
                type={secret ? secretInputType(visible) : "text"}
                sx={secret ? secretInputSx(visible) : undefined}
                slotProps={{
                    input: {
                        "aria-label": label,
                        autoComplete: "off",
                        endAdornment: secret ? (
                            <InputAdornment position='end'>
                                <IconButton
                                    size='small'
                                    edge='end'
                                    onClick={() => setVisible(v => !v)}
                                    aria-label={`${visible ? "隐藏" : "显示"}${label}`}
                                >
                                    {visible ? (
                                        <VisibilityOffIcon fontSize='small' />
                                    ) : (
                                        <VisibilityIcon fontSize='small' />
                                    )}
                                </IconButton>
                            </InputAdornment>
                        ) : undefined,
                    },
                    htmlInput: secret ? { ...SECRET_IGNORE_ATTRS } : undefined,
                }}
            />
            {caption ? (
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.25 }}>
                    {caption}
                </Typography>
            ) : null}
        </Box>
    );
}

export default function AiAssistantDialog({
    open,
    onClose,
    api,
    ai,
    onSaved,
    statusText,
}: AiAssistantDialogProps) {
    const [form, setForm] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<AiTestOutcome | null>(null);

    // 每次打开重读：配置可能被别的设备改过，拿一份旧的来编辑会覆盖掉新的
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setSaved(false);
        setTestResult(null);
        void (async () => {
            const all = await api.getConfigs().catch(() => ({} as Record<string, string>));
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const key of AI_KEYS) next[key] = all[key] ?? "";
            setForm(next);
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // api 每次渲染都是新引用，故意只在 open 变化时重跑
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const set = useCallback((key: string) => (value: string) => {
        setForm(prev => ({ ...prev, [key]: value }));
        setSaved(false);
        // 改了配置，上一次的测试结果就不算数了
        setTestResult(null);
    }, []);

    const enabled = (form[AI_ENABLED_KEY] || "") === "true";
    const provider: AiProvider =
        (form[AI_PROVIDER_KEY] || "") === "openai-compatible" ? "openai-compatible" : "workers-ai";

    /** 拿当前填的这份去判「还缺什么」：缺什么就把测试按钮置灰并写清原因 */
    const problem = useMemo(
        () => aiConfigProblem({ ...aiSettingsFromConfigs(form), enabled: true }),
        [form]
    );

    const runTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            setTestResult(await ai.test(form));
        } catch (error) {
            setTestResult({ ok: false, message: (error as Error).message || "测试连接失败" });
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        setSaving(true);
        setSaved(false);
        try {
            const payload: Record<string, string> = {};
            for (const key of AI_KEYS) payload[key] = form[key] ?? "";
            await api.setConfigs(payload);
            setSaved(true);
            onSaved?.();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='xs'
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                AI 助手
                <Box sx={{ flexGrow: 1 }} />
                <Button
                    size='small'
                    onClick={onClose}
                    aria-label='关闭 AI 助手'
                    sx={{ minWidth: 0, p: 0.5 }}
                >
                    <CloseIcon fontSize='small' />
                </Button>
            </DialogTitle>

            <DialogContent sx={dialogContentSx}>
                {loading && <LinearProgress sx={{ mb: 1.5, borderRadius: 1 }} />}

                <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                    打开后，站点的名称与链接会送到你填的那个模型服务去分析。
                    这些配置<b>跟着你的登录账号走</b>（换一个账号看不到这份配置），
                    令牌加密存库，也<b>不会写进备份文件</b>。关掉不会删掉已经生成的内容，只是不再调用。
                </Typography>

                <Section title='开关'>
                    <SwitchRow
                        checked={enabled}
                        onChange={checked => set(AI_ENABLED_KEY)(checked ? "true" : "false")}
                        label='启用 AI 助手'
                        ariaLabel='启用 AI 助手'
                        caption='没开的时候，所有 AI 按钮都只是置灰，一个字节都不会往外发。'
                    />
                    {statusText ? (
                        <Typography variant='caption' color='text.secondary' sx={{ display: "block" }}>
                            当前生效：{statusText}
                        </Typography>
                    ) : null}
                </Section>

                <Box sx={{ mt: 2 }}>
                    <Section title='模型服务' hint='补全站点信息、整理标签、按意思搜站点都走这里'>
                        <Box>
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ display: "block", mb: 0.25 }}
                            >
                                用哪家模型
                            </Typography>
                            <TextField
                                select
                                size='small'
                                fullWidth
                                value={provider}
                                onChange={e => set(AI_PROVIDER_KEY)(e.target.value)}
                                slotProps={{ input: { "aria-label": "AI 服务商" } }}
                            >
                                {AI_PROVIDERS.map(item => (
                                    <MenuItem key={item.value} value={item.value}>
                                        {item.label}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ display: "block", mt: 0.5 }}
                            >
                                {AI_PROVIDERS.find(p => p.value === provider)?.hint}
                            </Typography>
                        </Box>

                        {provider === "workers-ai" ? (
                            <>
                                <Field
                                    label='Cloudflare 账号 ID'
                                    value={form[AI_CF_ACCOUNT_KEY] || ""}
                                    onChange={set(AI_CF_ACCOUNT_KEY)}
                                    placeholder='32 位十六进制'
                                    caption='在 Cloudflare 控制台右下角能看到（Account ID）。'
                                />
                                <Field
                                    label='Cloudflare API token'
                                    value={form[AI_CF_TOKEN_KEY] || ""}
                                    onChange={set(AI_CF_TOKEN_KEY)}
                                    secret
                                    caption='需要有 Workers AI 的读取与运行权限。点右边的眼睛可以核对填没填错。'
                                />
                            </>
                        ) : (
                            <>
                                <Field
                                    label='接口地址'
                                    value={form[AI_ENDPOINT_KEY] || ""}
                                    onChange={set(AI_ENDPOINT_KEY)}
                                    placeholder='https://api.deepseek.com/v1'
                                    caption='只支持公网 http(s) 地址（内网地址会被拦下）。'
                                />
                                <Field
                                    label='API 密钥'
                                    value={form[AI_API_KEY_KEY] || ""}
                                    onChange={set(AI_API_KEY_KEY)}
                                    secret
                                    caption='点右边的眼睛可以核对填没填错。'
                                />
                            </>
                        )}

                        <Field
                            label='文本模型（补全与整理用）'
                            value={form[AI_TEXT_MODEL_KEY] || ""}
                            onChange={set(AI_TEXT_MODEL_KEY)}
                            placeholder={
                                provider === "workers-ai"
                                    ? "@cf/meta/llama-3.1-8b-instruct"
                                    : "deepseek-chat"
                            }
                        />
                        <Field
                            label='嵌入模型（语义搜索用）'
                            value={form[AI_EMBED_MODEL_KEY] || ""}
                            onChange={set(AI_EMBED_MODEL_KEY)}
                            placeholder={
                                provider === "workers-ai"
                                    ? "@cf/baai/bge-base-en-v1.5"
                                    : "text-embedding-3-small"
                            }
                            caption='换了模型就要重算一次语义索引（旧的向量跟新的比不了）。'
                        />
                    </Section>
                </Box>

                {/* 测试连接：用上面填的这份真跑一次，不用先保存 */}
                <Box sx={{ mt: 2 }}>
                    <Button
                        size='small'
                        variant='outlined'
                        aria-label='测试连接'
                        disabled={testing || loading || problem !== null}
                        onClick={() => void runTest()}
                    >
                        {testing ? "正在测试…" : "测试连接"}
                    </Button>
                    <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{ display: "block", mt: 0.5 }}
                    >
                        {problem
                            ? `还不能测：${problem}`
                            : "用上面填的内容试一次（不用先保存），会各发一条最短的请求。"}
                    </Typography>

                    {testing && <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />}

                    {testResult ? (
                        <Alert severity={testResult.ok ? "success" : "warning"} sx={{ mt: 1 }}>
                            {testResult.message}
                            <Box component='ul' sx={{ m: 0.5, pl: 2.5 }}>
                                <li>
                                    文本模型（补全 / 整理）：
                                    {testResult.text?.ok ? "通" : testResult.text?.message || "没通"}
                                </li>
                                <li>
                                    嵌入模型（语义搜索）：
                                    {testResult.embed?.ok
                                        ? `通（${testResult.embed.dim ?? 0} 维）`
                                        : testResult.embed?.message || "没通"}
                                </li>
                            </Box>
                        </Alert>
                    ) : null}
                </Box>

                {saved ? (
                    <Alert severity='success' sx={{ mt: 1.5 }}>
                        已保存。界面上的 AI 按钮现在应该能点了。
                    </Alert>
                ) : null}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button size='small' onClick={onClose}>
                    关闭
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    disabled={saving || loading}
                    onClick={() => void save()}
                >
                    {saving ? "保存中…" : "保存"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
