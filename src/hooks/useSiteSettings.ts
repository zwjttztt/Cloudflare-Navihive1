// 「网站设置 / 管理员凭据」这一块的写逻辑：打开弹窗时的初始化、临时配置的编辑、
// 管理员凭据提交、以及整批保存。原来内联在 App 里，抽出来后 App 只剩一次调用。
// 搬迁是纯机械的（只做整词改名），行为与抽取前逐行一致。
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { reportError } from "../utils/errorReporter";
import { clearRememberedLogin } from "../utils/rememberedLogin";
import { normalizeGlassBlur } from "../utils/configForm";
import type { NotifySeverity } from "./useNotify";

/** 只声明本域用到的两个接口，方便单测里塞一个假 api */
export type SettingsApi = {
    updateAuthCredentials(
        username: string,
        password: string,
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }>;
    setConfigs(configs: Record<string, string>): Promise<boolean>;
};

type UseSiteSettingsParams = {
    api: SettingsApi;
    notify: (text: string, level?: NotifySeverity) => void;
    /** 统一的错误提示（App 里是 notify + reportError） */
    onError: (message: string) => void;
    /** 打开设置弹窗前先收起「更多选项」菜单，否则菜单会失去锚点跑到左上角 */
    onMenuClose: () => void;
    /** 改完管理员凭据后服务端会把令牌版本 +1，当前令牌立刻失效 —— 踢回登录页 */
    onLogout: () => void;
    /** 数据层错误提示：踢回登录页后要说明「为什么被踢」 */
    onDataError: (message: string) => void;

    configs: Record<string, string>;
    setConfigs: Dispatch<SetStateAction<Record<string, string>>>;
    /** 弹窗里的临时配置：关掉即丢，保存时才写回 configs */
    tempConfigs: Record<string, string>;
    setTempConfigs: Dispatch<SetStateAction<Record<string, string>>>;
    /** 选色预览：不落库，关闭弹窗即回滚 */
    setAccentPreview: Dispatch<SetStateAction<string | null>>;
    setOpenConfig: Dispatch<SetStateAction<boolean>>;

    authUsername: string;
    authCurrentPassword: string;
    authNewPassword: string;
    setAuthUsername: Dispatch<SetStateAction<string>>;
    setAuthCurrentPassword: Dispatch<SetStateAction<string>>;
    setAuthNewPassword: Dispatch<SetStateAction<string>>;

    savingAuth: boolean;
    setSavingAuth: Dispatch<SetStateAction<boolean>>;
    setOpenAccount: Dispatch<SetStateAction<boolean>>;
    setSavingConfig: Dispatch<SetStateAction<boolean>>;
};

export function useSiteSettings({
    api,
    notify,
    onError,
    onMenuClose,
    onLogout,
    onDataError,
    configs,
    setConfigs,
    tempConfigs,
    setTempConfigs,
    setAccentPreview,
    setOpenConfig,
    authUsername,
    authCurrentPassword,
    authNewPassword,
    setAuthUsername,
    setAuthCurrentPassword,
    setAuthNewPassword,
    savingAuth,
    setSavingAuth,
    setOpenAccount,
    setSavingConfig,
}: UseSiteSettingsParams) {
    // 保存网站设置的防连点守卫（同步 ref 拦同一轮连点，state 用于按钮禁用）
    const savingConfigRef = useRef(false);

    // 配置相关函数
    const handleOpenConfig = useCallback(() => {
        onMenuClose();
        setTempConfigs({ ...configs });
        // 管理员凭据每次打开都重新填，避免误存上一次的输入
        setAuthUsername("");
        setAuthCurrentPassword("");
        setAuthNewPassword("");
        setOpenConfig(true);
        // setter 与 configs 都列齐全：这里读到的每个值变化时都要重算，
        // 而不是靠「setState 不会变」让 lint 闭嘴
    }, [
        onMenuClose,
        configs,
        setTempConfigs,
        setAuthUsername,
        setAuthCurrentPassword,
        setAuthNewPassword,
        setOpenConfig,
    ]);

    // 修改管理员账号密码：需要验证当前密码，空白字段表示保持不变
    const submitAuthCredentials = async (): Promise<boolean> => {
        const username = authUsername.trim();
        // 只有「要改账号」或「要改密码」时才提交。
        // 注意不能把 authCurrentPassword 算进「有改动」的判断：用户可能只是为了生成恢复私钥
        // 而填了当前密码，此时点「保存设置」会因为「既没新账号也没新密码」被服务端判成 400。
        if (!username && !authNewPassword) {
            return false;
        }
        if (!authCurrentPassword) {
            throw new Error("修改管理员账号或密码时，必须先填写当前密码");
        }
        const result = await api.updateAuthCredentials(username, authNewPassword, authCurrentPassword);
        if (!result.success) {
            throw new Error(result.message || "修改管理员凭据失败");
        }
        return true;
    };

    /**
     * 账号管理里单独保存「账号 / 密码」。
     * 改完服务端会把令牌版本 +1，当前令牌立刻失效 —— 所以要清掉「记住登录」并踢回登录页，
     * 否则留在页面里每个请求都是 401。
     */
    const handleSaveAuthCredentials = async () => {
        if (savingAuth) return;
        setSavingAuth(true);
        try {
            const changed = await submitAuthCredentials();
            if (!changed) {
                notify("没有需要保存的改动", "info");
                return;
            }
            setAuthUsername("");
            setAuthCurrentPassword("");
            setAuthNewPassword("");
            setOpenAccount(false);
            clearRememberedLogin(); // 「记住登录」里存的是旧账号密码，留着只会误导
            onLogout();
            onDataError("账号或密码已更新，请使用新凭据重新登录");
        } catch (error) {
            reportError(error, { source: "site-credentials-save" });
            onError("保存账号密码失败: " + (error as Error).message);
        } finally {
            setSavingAuth(false);
        }
    };

    const handleCloseConfig = () => {
        setOpenConfig(false);
        // 未保存的话，把预览的主色回滚掉
        setAccentPreview(null);
    };

    // 选色：同时写入临时配置（供保存）与预览值（即时生效）
    const pickAccent = (value: string) => {
        setTempConfigs(prev => ({ ...prev, "site.primaryColor": value }));
        setAccentPreview(value);
    };

    const handleConfigInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setTempConfigs({
            ...tempConfigs,
            [e.target.name]: e.target.value,
        });
    };

    // 背景蒙版透明度滑块
    const handleConfigSliderChange = (_event: Event, value: number | number[]) => {
        const next = Array.isArray(value) ? value[0] : value;
        setTempConfigs(prev => ({
            ...prev,
            "site.backgroundMaskOpacity": String(next),
        }));
    };

    // 毛玻璃强度：临时值为空/非法时按默认 14 显示。
    // 规矩统一在 utils/configForm（那里有单测）—— 原来这里内联了一份一模一样的判断，
    // 两份实现迟早会漂移到不一致。
    const tempGlassBlur = normalizeGlassBlur(tempConfigs["site.glassBlur"]);

    const handleGlassBlurChange = (_event: Event, value: number | number[]) => {
        const next = Array.isArray(value) ? value[0] : value;
        setTempConfigs(prev => ({ ...prev, "site.glassBlur": String(next) }));
    };

    const handleSaveConfig = async () => {
        // 防连点：同一轮里连点「保存设置」只提交一次
        if (savingConfigRef.current) return;
        savingConfigRef.current = true;
        setSavingConfig(true);

        try {
            // 只提交有变化的配置，并且一次请求写完
            // （原来每项各发一个请求，改十项就是十个网络往返）
            const changed = Object.entries(tempConfigs).filter(([key, value]) => configs[key] !== value);
            if (changed.length > 0) {
                const ok = await api.setConfigs(Object.fromEntries(changed));
                if (!ok) throw new Error("部分配置写入失败");
            }

            // 更新配置状态：标题 / 背景图 / 自定义 CSS 都由 React 响应式生效，无需刷新页面
            setConfigs({ ...tempConfigs });
            // 正式保存后撤掉预览，改由已保存的配置驱动主题
            setAccentPreview(null);
            setAuthUsername("");
            setAuthCurrentPassword("");
            setAuthNewPassword("");
            handleCloseConfig();

            if (changed.length > 0) {
                notify("设置已保存", "success");
            }
        } catch (error) {
            reportError(error, { source: "config-save" });
            onError("保存配置失败: " + (error as Error).message);
        } finally {
            savingConfigRef.current = false;
            setSavingConfig(false);
        }
    };
    return {
        handleOpenConfig,
        handleSaveAuthCredentials,
        handleCloseConfig,
        pickAccent,
        handleConfigInputChange,
        handleConfigSliderChange,
        tempGlassBlur,
        handleGlassBlurChange,
        handleSaveConfig,
    };
}
