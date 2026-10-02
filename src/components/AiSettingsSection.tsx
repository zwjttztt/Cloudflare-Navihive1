// src/components/AiSettingsSection.tsx
// 设置里的「AI 助手」一节：开关、provider、端点与密钥。
//
// 单独成文件是因为这一节的字段比别的节多（六个输入），塞进 SettingsDialog 会把它
// 再撑长一截；而它跟 AI 的其它界面共用同一套「能不能用」的说法（useAiAssistant.reason）。
//
// 隐私说明写在这一节最上面：一旦打开，站点名称与链接会送到模型那边去。
// 这不是藏在文档里的小字，是决定要不要打开的那一句话。

import { Box, MenuItem, TextField, Typography } from "@mui/material";
import { AI_PROVIDERS, type AiProvider } from "../utils/aiConfig";
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
import { Section, SwitchRow } from "./SettingsDialog";

interface AiSettingsSectionProps {
    /** 未保存的配置副本（跟网站设置里其它项一样，点保存才生效） */
    configs: Record<string, string>;
    onChange: (key: string, value: string) => void;
    /** 当前可用状态的一句话说明（来自 /api/ai/status） */
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
    secret?: boolean;
    caption?: string;
}) {
    return (
        <Box sx={{ mb: 1.25 }}>
            <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 0.25 }}>
                {label}
            </Typography>
            <TextField
                size='small'
                fullWidth
                value={value}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
                type={secret ? "password" : "text"}
                slotProps={{
                    input: {
                        "aria-label": label,
                        // 凭据字段不让浏览器自作主张地记住/填充（跟卡片上的凭据同一套处理）
                        autoComplete: "off",
                    },
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

export default function AiSettingsSection({
    configs,
    onChange,
    statusText,
}: AiSettingsSectionProps) {
    const enabled = (configs[AI_ENABLED_KEY] || "") === "true";
    const provider: AiProvider =
        (configs[AI_PROVIDER_KEY] || "") === "openai-compatible" ? "openai-compatible" : "workers-ai";
    const set = (key: string) => (value: string) => onChange(key, value);

    return (
        <Section
            title='AI 助手'
            hint='帮你补全站点信息、整理标签、按意思搜站点。默认关闭。'
        >
            <Typography
                variant='caption'
                color='text.secondary'
                sx={{ display: "block", mb: 1.25 }}
            >
                打开后，站点的名称与链接会送到你填的那个模型服务去分析。
                关掉不会删掉已经生成的内容，只是不再调用。这些配置是**每个账号一份**，
                也不会写进备份文件（备份是会传给别人的）。
            </Typography>

            <SwitchRow
                checked={enabled}
                onChange={checked => onChange(AI_ENABLED_KEY, checked ? "true" : "false")}
                label='启用 AI 助手'
                ariaLabel='启用 AI 助手'
                caption='没开的时候，所有 AI 按钮都只是置灰，一个字节都不会往外发。'
            />

            {statusText ? (
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 1 }}>
                    当前状态：{statusText}
                </Typography>
            ) : null}

            {enabled ? (
                <Box sx={{ mt: 1.5 }}>
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 0.25 }}>
                        用哪家模型
                    </Typography>
                    <TextField
                        select
                        size='small'
                        fullWidth
                        value={provider}
                        onChange={e => onChange(AI_PROVIDER_KEY, e.target.value)}
                        slotProps={{ input: { "aria-label": "AI 服务商" } }}
                    >
                        {AI_PROVIDERS.map(item => (
                            <MenuItem key={item.value} value={item.value}>
                                {item.label}
                            </MenuItem>
                        ))}
                    </TextField>
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.5, mb: 1.5 }}>
                        {AI_PROVIDERS.find(p => p.value === provider)?.hint}
                    </Typography>

                    {provider === "workers-ai" ? (
                        <>
                            <Field
                                label='Cloudflare 账号 ID'
                                value={configs[AI_CF_ACCOUNT_KEY] || ""}
                                onChange={set(AI_CF_ACCOUNT_KEY)}
                                placeholder='32 位十六进制'
                                caption='在 Cloudflare 控制台右下角能看到（Account ID）。'
                            />
                            <Field
                                label='Cloudflare API token'
                                value={configs[AI_CF_TOKEN_KEY] || ""}
                                onChange={set(AI_CF_TOKEN_KEY)}
                                secret
                                caption='需要有 Workers AI 的读取与运行权限。加密存库，不进备份。'
                            />
                        </>
                    ) : (
                        <>
                            <Field
                                label='接口地址'
                                value={configs[AI_ENDPOINT_KEY] || ""}
                                onChange={set(AI_ENDPOINT_KEY)}
                                placeholder='https://api.deepseek.com/v1'
                                caption='只支持公网 http(s) 地址（内网地址会被拦下）。'
                            />
                            <Field
                                label='API 密钥'
                                value={configs[AI_API_KEY_KEY] || ""}
                                onChange={set(AI_API_KEY_KEY)}
                                secret
                                caption='加密存库，不进备份。'
                            />
                        </>
                    )}

                    <Field
                        label='文本模型（补全与整理用）'
                        value={configs[AI_TEXT_MODEL_KEY] || ""}
                        onChange={set(AI_TEXT_MODEL_KEY)}
                        placeholder={provider === "workers-ai" ? "@cf/meta/llama-3.1-8b-instruct" : "deepseek-chat"}
                    />
                    <Field
                        label='嵌入模型（语义搜索用）'
                        value={configs[AI_EMBED_MODEL_KEY] || ""}
                        onChange={set(AI_EMBED_MODEL_KEY)}
                        placeholder={provider === "workers-ai" ? "@cf/baai/bge-base-en-v1.5" : "text-embedding-3-small"}
                        caption='换了模型就要重算一次语义索引（旧的向量跟新的比不了）。'
                    />
                </Box>
            ) : null}
        </Section>
    );
}
