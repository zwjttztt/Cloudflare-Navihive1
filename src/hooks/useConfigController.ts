// src/hooks/useConfigController.ts
// 「网站设置 / 管理员凭据 / WebDAV 备份配置」这一整套**状态**的归口。
//
// App 里原来是一长串 useState 摊在组件顶部（十几行），谁都能改、改了影响谁全靠读代码。
// 收进来之后 App 只剩一次解构。写逻辑（保存配置 / 提交凭据）在 useSiteSettings，
// 本 hook 只持有状态 —— 这样 useSiteSettings 依然能在测试里塞假 state 单独跑。
//
// ⚠️ accent 必须留在这里（而不是塞进 useSiteSettings）：useThemeController 要读它，
// 而主题 hook 的调用点在 App 里比 useSiteSettings 靠前得多，换个位置就引用不到了。
import { useCallback, useState } from "react";
import type { WebDavConfig } from "../API/http";
import { DEFAULT_CONFIGS, DEFAULT_WEBDAV_CONFIG } from "../appDefaults";
import { splitIncomingConfigs } from "../utils/configMerge";
import { normalizeAccent } from "../utils/configForm";

export function useConfigController() {
    // 已保存的配置（驱动标题 / 背景 / 主题 / 自定义 CSS）
    const [configs, setConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    // 设置弹窗里的临时副本：关掉即丢，点保存才写回 configs
    const [tempConfigs, setTempConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    const [openConfig, setOpenConfig] = useState(false);
    // 账号管理弹窗（账号密码 / 恢复密钥 / 邀请码 / 注销）
    const [openAccount, setOpenAccount] = useState(false);
    const [savingAuth, setSavingAuth] = useState(false);
    // 保存网站设置的防连点守卫（同步 ref 拦同一轮连点，state 用于按钮禁用）
    const [savingConfig, setSavingConfig] = useState(false);
    // 设置弹窗里选色时的即时预览值（不落库，关闭弹窗即回滚）
    const [accentPreview, setAccentPreview] = useState<string | null>(null);

    // WebDAV 备份配置（单独存放，避免被写进备份文件）
    const [webdavConfig, setWebdavConfig] = useState<WebDavConfig>(DEFAULT_WEBDAV_CONFIG);

    // 管理员账号密码修改（不写入 configs，走独立的 auth/credentials 接口）
    const [authUsername, setAuthUsername] = useState("");
    const [authCurrentPassword, setAuthCurrentPassword] = useState("");
    const [authNewPassword, setAuthNewPassword] = useState("");

    // 自定义主色：只有合法的 #rgb / #rrggbb 才采用，避免脏数据把主题搞坏。
    // 预览值优先；校验与去空格的规矩在 utils/configForm（那里有单测盯着）。
    const accent = normalizeAccent(accentPreview, configs["site.primaryColor"]);

    /**
     * 落地一次 bootstrap 拉回来的配置。
     * WebDAV 配置单独拆出来存放，避免被写进备份文件（拆分规则见 utils/configMerge）。
     */
    const applyConfigs = useCallback(
        (configsData: Record<string, string> | null | undefined) => {
            const { configs: nextConfigs, webdav: nextWebdav } =
                splitIncomingConfigs(configsData);
            setConfigs(nextConfigs);
            setTempConfigs({ ...nextConfigs });
            setWebdavConfig(nextWebdav);
        },
        []
    );

    return {
        configs,
        setConfigs,
        tempConfigs,
        setTempConfigs,
        openConfig,
        setOpenConfig,
        openAccount,
        setOpenAccount,
        savingAuth,
        setSavingAuth,
        savingConfig,
        setSavingConfig,
        accentPreview,
        setAccentPreview,
        accent,
        webdavConfig,
        setWebdavConfig,
        authUsername,
        setAuthUsername,
        authCurrentPassword,
        setAuthCurrentPassword,
        authNewPassword,
        setAuthNewPassword,
        applyConfigs,
    };
}
