// src/components/LanguageSection.tsx
// 设置里的「界面语言」一小节 —— i18n 骨架的第一个接入口。
//
// 为什么先接这里：它本身就是「语言」这件事的开关，自成闭环，
// 不需要动任何既有文案；把它接上之后，t() 这条链路才是真的在跑，
// 而不是一套没人用的类型。
import { Box, Button, Stack, Typography } from "@mui/material";
import { LOCALES, type Locale } from "../i18n/locale";
import { useI18n } from "../i18n/localeStore";
import { Section } from "./dialogSection";

/** 语言自己的名字（各语言都写自己的名字，不翻译） */
const NATIVE_NAME: Record<Locale, string> = {
    zh: "中文",
    en: "English",
};

export default function LanguageSection() {
    const { locale, setLocale, t } = useI18n();
    return (
        <Section
            title={t("settings.language.title", "界面语言")}
            hint={t(
                "settings.language.hint",
                "只存在这台设备上；文案正在逐步接入，没接到的地方仍显示中文。"
            )}
        >
            <Stack direction='row' spacing={1} sx={{ mt: 0.5 }}>
                {LOCALES.map(item => (
                    <Button
                        key={item}
                        size='small'
                        variant={locale === item ? "contained" : "outlined"}
                        disableElevation
                        aria-pressed={locale === item}
                        data-locale-option={item}
                        onClick={() => setLocale(item)}
                        sx={{ minWidth: 84 }}
                    >
                        {NATIVE_NAME[item]}
                    </Button>
                ))}
            </Stack>
            <Box>
                <Typography variant='caption' color='text.secondary'>
                    {t("settings.language.note", "切换后立即生效，不需要刷新。")}
                </Typography>
            </Box>
        </Section>
    );
}
