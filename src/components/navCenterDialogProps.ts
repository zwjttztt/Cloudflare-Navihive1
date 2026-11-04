/**
 * NavigationCenterDialog 的 prop 组装器。
 *
 * 原先这一大坨内联对象（stats / backup / recycle / audit / config / ai / vault /
 * account / shortcuts 九个面板 + 一堆闭包）直接摊在 App.tsx 的 return 里，把 App
 * 的单函数撑到 2400+ 行。这里把它抽成纯函数：输入 App 作用域里的零散值，输出
 * NavigationCenterDialog 需要的完整 props。App 侧只剩一行 spread 调用，便于阅读，
 * 也把那些闭包（stats.nameOf / onChanged / onAuthChange 等）集中到一处。
 *
 * ⚠️ 纯搬运：行为、类型、闭包语义与原来逐字一致，不含任何逻辑改动。
 */
import type { NavigationClient } from "../API/client";
import type { MockNavigationClient } from "../API/mock";
import type { GroupWithSites } from "../types";
import type { NavCenterPanelId } from "./navigationCenter/model";
import type { AiAssistant } from "../hooks/useAiAssistant";
import {
    RETENTION_DAYS_KEY,
} from "../API/configKeys";
import {
    BACKUP_CREDENTIALS_CONFIG,
} from "../API/http";
import {
    WEBDAV_CONFIG_PREFIX,
    LINK_HEALTH_SYNC_CONFIG,
    PREF_SYNC_CONFIG,
} from "../appDefaults";
import type { useConfigController } from "../hooks/useConfigController";
import type { useUIPrefs } from "../context/uiPrefsStore";
import type { useSiteSettings } from "../hooks/useSiteSettings";
import type { useBackupController } from "../hooks/useBackupController";
import type { useAccountSession } from "../hooks/useAccountSession";

type ConfigController = ReturnType<typeof useConfigController>;
type UiPrefs = ReturnType<typeof useUIPrefs>;
type SiteSettings = ReturnType<typeof useSiteSettings>;
type BackupController = ReturnType<typeof useBackupController>;
type AccountSession = ReturnType<typeof useAccountSession>;

export type AuthField = "username" | "currentPassword" | "newPassword";

/**
 * ⚠️ 本文件对「懒块模块」（统一中心/面板/vaultSession）一律用内联 import() 类型，
 * 不写静态 import type —— 静态 type import 也会把懒块拖进入口模块图，
 * 面板用的 Tabs/Table/Slider/ToggleButton 等会因此被抬进首屏共享块（实测 +61KB）。
 * 内联 import() 类型只参与类型检查，不影响分块（App.tsx 对 VaultTransport 的既有写法同理）。
 */
/**
 * 「账号与安全」面板里三处输入框（用户名 / 当前密码 / 新密码）的 onChange 派发。
 * 原先在 NavigationCenterDialog 与 AccountDialog 两处各写了一遍逐字重复的 if/else，
 * 这里收成一份，两个调用点共用。
 */
export function makeAuthChangeHandlers(handlers: {
    setAuthUsername: (v: string) => void;
    setAuthCurrentPassword: (v: string) => void;
    setAuthNewPassword: (v: string) => void;
}): (field: AuthField, value: string) => void {
    return (field, value) => {
        if (field === "username") handlers.setAuthUsername(value);
        else if (field === "currentPassword") handlers.setAuthCurrentPassword(value);
        else handlers.setAuthNewPassword(value);
    };
}

export interface NavCenterDialogArgs {
    api: NavigationClient | MockNavigationClient;
    groups: GroupWithSites[];
    configs: Record<string, string>;
    isAuthenticated: boolean;
    currentUser: AccountSession["currentUser"];
    /**
     * 这次打开的目标面板。`null` / 不传 = 普通打开（用户点设置入口，没有指定屏），
     * 有值 = 命令面板指名直达那一屏（R09）。
     * 两种意图在中心里必须**分得开**，所以「没有目标」用 null 显式表达，
     * 不用「等于默认项 stats」去推断。
     */
    navCenterPanel?: NavCenterPanelId | null;
    /** 来自 App：中心自身的开合（原 NavigationCenterDialog 的 open/onClose） */
    open: boolean;
    onClose: () => void;
    setBookmarkOpen: (open: boolean) => void;

    clearVisits: UiPrefs["clearVisits"];
    fetchData: (opts?: { silent?: boolean }) => Promise<boolean> | void;
    notify: (msg: string, severity?: "success" | "error" | "info") => void;
    runLinkCheck: () => void;

    // config 面板
    handleSaveConfig: SiteSettings["handleSaveConfig"];
    tempConfigs: ConfigController["tempConfigs"];
    setTempConfigs: ConfigController["setTempConfigs"];
    handleConfigInputChange: SiteSettings["handleConfigInputChange"];
    handleConfigSliderChange: SiteSettings["handleConfigSliderChange"];
    pickAccent: SiteSettings["pickAccent"];
    setAccentPreview: ConfigController["setAccentPreview"];
    radius: UiPrefs["radius"];
    setRadius: UiPrefs["setRadius"];
    fontScale: UiPrefs["fontScale"];
    setFontScale: UiPrefs["setFontScale"];
    tempGlassBlur: SiteSettings["tempGlassBlur"];
    handleGlassBlurChange: SiteSettings["handleGlassBlurChange"];
    glassEffects: UiPrefs["glassEffects"];
    setGlassEffects: UiPrefs["setGlassEffects"];
    offlineFull: UiPrefs["offlineFull"];
    setOfflineFull: UiPrefs["setOfflineFull"];
    iconPrivacy: UiPrefs["iconPrivacy"];
    setIconPrivacy: UiPrefs["setIconPrivacy"];
    liteMode: UiPrefs["liteMode"];
    setLiteMode: UiPrefs["setLiteMode"];
    savingConfig: ConfigController["savingConfig"];
    pinyinSearch: UiPrefs["pinyinSearch"];
    setPinyinSearch: UiPrefs["setPinyinSearch"];
    prefSync: UiPrefs["prefSync"];
    handleTogglePrefSync: BackupController["handleTogglePrefSync"];
    handleToggleLinkHealthSync: BackupController["handleToggleLinkHealthSync"];

    // backup 面板
    backupTab: BackupController["backupTab"];
    webdavConfig: ConfigController["webdavConfig"];
    handleSaveWebdavConfig: BackupController["handleSaveWebdavConfig"];
    handleToggleAutoBackup: BackupController["handleToggleAutoBackup"];
    buildExportData: BackupController["buildExportData"];
    handleDownloadLocal: BackupController["handleDownloadLocal"];
    handleImportBackup: BackupController["handleImportBackup"];
    requestImportPreview: BackupController["requestImportPreview"];
    handleToggleIncludeCredentials: BackupController["handleToggleIncludeCredentials"];
    cronError: BackupController["cronError"];

    // ai 面板
    aiConfigClient: import("./navigationCenter/panels/AiPanel").AiCenterPanelProps["api"];
    ai: AiAssistant;
    aiStatusText: string;

    // account 面板
    allSitesWithCreds: import("./navigationCenter/panels/AccountPanel").AccountCenterPanelProps["sites"];
    authUsername: ConfigController["authUsername"];
    authCurrentPassword: ConfigController["authCurrentPassword"];
    authNewPassword: ConfigController["authNewPassword"];
    setAuthUsername: ConfigController["setAuthUsername"];
    setAuthCurrentPassword: ConfigController["setAuthCurrentPassword"];
    setAuthNewPassword: ConfigController["setAuthNewPassword"];
    handleSaveAuthCredentials: SiteSettings["handleSaveAuthCredentials"];
    savingAuth: ConfigController["savingAuth"];
    recoveryConfigured: AccountSession["recoveryConfigured"];
    handleGenerateRecoveryKey: AccountSession["handleGenerateRecoveryKey"];
    invite: AccountSession["invite"];
    handleCreateInvite: AccountSession["handleCreateInvite"];
    sessions: AccountSession["sessions"];
    handleRevokeSession: AccountSession["handleRevokeSession"];
    handleRevokeOthers: AccountSession["handleRevokeOthers"];
    accountList: AccountSession["accountList"];
    handleExemptUser: AccountSession["handleExemptUser"];
    inactivePolicy: AccountSession["inactivePolicy"];
    handleSaveInactivePolicy: AccountSession["handleSaveInactivePolicy"];
    handleSweepInactive: AccountSession["handleSweepInactive"];
    setNavCenterOpen: (open: boolean) => void;
    setDeleteAccountOpen: AccountSession["setDeleteAccountOpen"];

    // shortcuts / 退出 / 激活
    canInstall: boolean;
    handleInstallApp: () => void;
    handleLogout: AccountSession["handleLogout"];
    handleAccountActivate: () => void;
}

export function buildNavCenterDialogProps(args: NavCenterDialogArgs): import("./NavigationCenterDialog").NavigationCenterDialogProps {
    const {
        api,
        groups,
        configs,
        isAuthenticated,
        currentUser,
        navCenterPanel,
        open,
        onClose,
        setBookmarkOpen,
        clearVisits,
        fetchData,
        notify,
        runLinkCheck,
        handleSaveConfig,
        tempConfigs,
        setTempConfigs,
        handleConfigInputChange,
        handleConfigSliderChange,
        pickAccent,
        setAccentPreview,
        radius,
        setRadius,
        fontScale,
        setFontScale,
        tempGlassBlur,
        handleGlassBlurChange,
        glassEffects,
        setGlassEffects,
        offlineFull,
        setOfflineFull,
        iconPrivacy,
        setIconPrivacy,
        liteMode,
        setLiteMode,
        savingConfig,
        pinyinSearch,
        setPinyinSearch,
        prefSync,
        handleTogglePrefSync,
        handleToggleLinkHealthSync,
        backupTab,
        webdavConfig,
        handleSaveWebdavConfig,
        handleToggleAutoBackup,
        buildExportData,
        handleDownloadLocal,
        handleImportBackup,
        requestImportPreview,
        handleToggleIncludeCredentials,
        cronError,
        aiConfigClient,
        ai,
        aiStatusText,
        allSitesWithCreds,
        authUsername,
        authCurrentPassword,
        authNewPassword,
        setAuthUsername,
        setAuthCurrentPassword,
        setAuthNewPassword,
        handleSaveAuthCredentials,
        savingAuth,
        recoveryConfigured,
        handleGenerateRecoveryKey,
        invite,
        handleCreateInvite,
        sessions,
        handleRevokeSession,
        handleRevokeOthers,
        accountList,
        handleExemptUser,
        inactivePolicy,
        handleSaveInactivePolicy,
        handleSweepInactive,
        setNavCenterOpen,
        setDeleteAccountOpen,
        canInstall,
        handleInstallApp,
        handleLogout,
        handleAccountActivate,
    } = args;

    const onAuthChange = makeAuthChangeHandlers({
        setAuthUsername,
        setAuthCurrentPassword,
        setAuthNewPassword,
    });

    return {
        open,
        onClose,
        initialPanel: navCenterPanel ?? undefined,
        isAuthenticated,
        isSiteOwner: currentUser?.role === "owner",
        stats: {
            client: api as unknown as NavigationClient,
            isSiteOwner: currentUser?.role === "owner",
            nameOf: (id: string) => {
                for (const group of groups) {
                    const hit = group.sites.find(s => String(s.id) === id);
                    if (hit) return hit.name || hit.url || `#${id}`;
                }
                return `已删除的网站 #${id}`;
            },
            exists: (id: string) => groups.some(g => g.sites.some(s => String(s.id) === id)),
            syncEnabled: configs[PREF_SYNC_CONFIG] === "true",
            onClear: () => { clearVisits(); },
        },
        backup: {
            initialTab: backupTab,
            client: api,
            webdavConfig,
            onSaveWebdavConfig: handleSaveWebdavConfig,
            autoBackup: configs[`${WEBDAV_CONFIG_PREFIX}autoBackup`] !== "false",
            lastBackupAt: configs[`${WEBDAV_CONFIG_PREFIX}lastBackupAt`] || "",
            lastBackupInfo: configs[`${WEBDAV_CONFIG_PREFIX}lastBackupInfo`] || "",
            lastAutoBackupAt: configs[`${WEBDAV_CONFIG_PREFIX}lastAutoBackupAt`] || "",
            onToggleAutoBackup: handleToggleAutoBackup,
            onBuildExportData: buildExportData,
            onDownloadLocal: handleDownloadLocal,
            onImportData: handleImportBackup,
            onRequestImportPreview: requestImportPreview,
            onNotify: notify,
            includeCredentials: configs[BACKUP_CREDENTIALS_CONFIG] === "true",
            onIncludeCredentialsChange: handleToggleIncludeCredentials,
            onOpenBookmark: () => setBookmarkOpen(true),
            cronError,
        },
        recycle: {
            client: api as unknown as NavigationClient,
            retentionDays: Number(configs[RETENTION_DAYS_KEY]) || undefined,
            onChanged: () => void fetchData({ silent: true }),
            onNotify: (msg: string, severity?: "success" | "error" | "info") => notify(msg, severity || "info"),
        },
        audit: {
            client: api as unknown as NavigationClient,
            retentionDays: Number(configs[RETENTION_DAYS_KEY]) || undefined,
        },
        config: {
            onSave: handleSaveConfig,
            tempConfigs,
            setTempConfigs,
            onConfigInputChange: handleConfigInputChange,
            onMaskOpacityChange: handleConfigSliderChange,
            onPickAccent: pickAccent,
            onCancelAccentPreview: () => setAccentPreview(null),
            radius,
            onRadiusChange: setRadius,
            fontScale,
            onFontScaleChange: setFontScale,
            glassBlur: tempGlassBlur,
            onGlassBlurChange: handleGlassBlurChange,
            glassEffects,
            onGlassEffectsChange: setGlassEffects,
            offlineFull,
            onOfflineFullChange: setOfflineFull,
            iconPrivacy,
            onIconPrivacyChange: setIconPrivacy,
            liteMode,
            onLiteModeChange: setLiteMode,
            saving: savingConfig,
            pinyinSearch,
            onPinyinSearchChange: setPinyinSearch,
            syncHealth: configs[LINK_HEALTH_SYNC_CONFIG] === "true",
            onSyncHealthChange: handleToggleLinkHealthSync,
            syncPrefs: prefSync,
            onSyncPrefsChange: handleTogglePrefSync,
            onRunLinkCheck: () => void runLinkCheck(),
            isSiteOwner: !currentUser || currentUser.role === "owner",
        },
        ai: {
            api: aiConfigClient,
            ai,
            onSaved: () => void ai.refresh(),
            statusText: aiStatusText,
        },
        vault: {
            client: api as unknown as import("../utils/vaultSession").VaultTransport,
            onNotify: (m, s) => notify(m, s || "info"),
        },
        account: {
            open: true,
            onClose: () => {},
            sites: allSitesWithCreds,
            auth: {
                username: authUsername,
                currentPassword: authCurrentPassword,
                newPassword: authNewPassword,
            },
            onAuthChange,
            onSaveAuth: () => void handleSaveAuthCredentials(),
            saving: savingAuth,
            currentUser,
            recoveryKeyConfigured: recoveryConfigured,
            onGenerateRecoveryKey: handleGenerateRecoveryKey,
            invite,
            onCreateInvite: handleCreateInvite,
            sessions,
            onRevokeSession: jti => void handleRevokeSession(jti),
            onRevokeOthers: () => void handleRevokeOthers(),
            onDeleteAccount:
                currentUser && currentUser.role !== "owner"
                    ? () => {
                          setNavCenterOpen(false);
                          setDeleteAccountOpen(true);
                      }
                    : undefined,
            accounts: accountList,
            onExemptUser: uid => void handleExemptUser(uid),
            inactivePolicy: inactivePolicy ?? undefined,
            onSaveInactivePolicy: handleSaveInactivePolicy,
            onSweepInactive: handleSweepInactive,
        },
        onAccountActivate: handleAccountActivate,
        shortcuts: {
            canInstall,
            onInstallApp: () => void handleInstallApp(),
        },
        onLogout: handleLogout,
    };
}
