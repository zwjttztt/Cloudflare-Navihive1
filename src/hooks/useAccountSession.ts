// 认证与账号治理：注册 / 登录 / 登出 / 恢复密钥、邀请码、会话踢线、
// 沉睡治理阈值、注销账号。原来内联在 App 里（约 465 行），连它自己的一组
// state 一起搬出来；App 只剩一次调用。搬迁是原样搬运（只做整词改名）。
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { NavigationClient } from "../API/client";
import type { MockNavigationClient } from "../API/mock";
import type { AccountInfo, SessionInfo } from "../API/http";
import {
    INACTIVE_DISABLE_DAYS_KEY,
    INACTIVE_DELETE_GRACE_DAYS_KEY,
} from "../API/http";
import { setAccountUid } from "../API/offlineQueue";
import { setUndoAccountUid } from "../utils/undoPersist";
import { clearSessionBoundary } from "../utils/sessionBoundary";
import { clearBootstrapCache } from "../utils/firstPaintCache";
import {
    algLabel,
    checkWebCryptoSupport,
    downloadRecoveryKeyFile,
    generateRecoveryKeyPair,
} from "../utils/recoveryKey";
import { clearRememberedLogin, saveRememberedLogin } from "../utils/rememberedLogin";
import {
    classifyAuthFailure,
    cookieRejectedMessage,
    readSweepResult,
    resolveInactivePolicy,
} from "../utils/authFlow";
import { reportError } from "../utils/errorReporter";
import type { NotifySeverity } from "./useNotify";
import type { GroupWithSites } from "../types";

type AuthApi = NavigationClient | MockNavigationClient;

type UseAccountSessionParams = {
    api: AuthApi;
    notify: (text: string, level?: NotifySeverity) => void;
    /** 统一的错误提示（App 里是 notify + reportError） */
    onError: (message: string) => void;
    /** 登出前先收起「更多选项」菜单，否则菜单会失去锚点跑到左上角 */
    onMenuClose: () => void;
    /** 数据层错误提示（被踢回登录页时要说明原因） */
    onDataError: (message: string) => void;
    /** 重新拉一次全量数据（silent=true 时不显示全屏 loading、不弹错误提示） */
    fetchData: (opts?: { silent?: boolean }) => Promise<unknown>;
    /** 登录 / 注册成功后把可能还开着的提示条收掉 */
    onCloseSnackbar: () => void;
    /** 换账号时统一收拾本地状态（离线队列 / 撤销快照 / 偏好 / 撤销栈 / 折叠态） */
    onSwitchAccount: (uid: number | null) => void;
    onExitMultiSelect: () => void;
    clearHistory: () => void;
    onResetCollapsed: () => void;
    setGroups: Dispatch<SetStateAction<GroupWithSites[]>>;
    setPrefsAccountUid: (uid: number | null) => void;

    /** 这两个开关留在 App：useSites 的鉴权失败回调比本 hook 更早用到它们的 setter */
    isAuthenticated: boolean;
    setIsAuthenticated: Dispatch<SetStateAction<boolean>>;
    setIsAuthRequired: Dispatch<SetStateAction<boolean>>;
};

export function useAccountSession({
    api,
    notify,
    onError,
    onMenuClose,
    onDataError,
    fetchData,
    onCloseSnackbar,
    onSwitchAccount,
    onExitMultiSelect,
    clearHistory,
    onResetCollapsed,
    setGroups,
    setPrefsAccountUid,
    isAuthenticated,
    setIsAuthenticated,
    setIsAuthRequired,
}: UseAccountSessionParams) {
    // 新增认证状态
    const [isAuthChecking, setIsAuthChecking] = useState(true);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [loginLoading, setLoginLoading] = useState(false);
    // 是否已配置恢复公钥（未登录也能查，决定是否在登录页显示「用恢复密钥找回账号」）
    const [recoveryConfigured, setRecoveryConfigured] = useState(false);
    // 当前登录账号（多账号后要能显示「我是谁」）。
    // id 是本地存储（离线队列 / 撤销快照 / 偏好）分账号的依据，改名或换人都靠它分辨。
    const [currentUser, setCurrentUser] = useState<{
        id: number;
        username: string;
        role: "owner" | "user";
    } | null>(null);
    // 生成的邀请码（含过期时间），只留在内存里，刷新页面即消失
    const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
    // 注销账号：二次确认弹窗 + 确认密码
    const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
    const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
    const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);

    // 账号清单（仅 owner 拿得到）：每个账号的沉睡治理状态，给「账号管理」里那份列表用
    const [accountList, setAccountList] = useState<AccountInfo[]>([]);
    // 登录设备（当前账号自己的会话）：有了它才能只踢某一台设备，
    // 不用靠改密把自己其它设备一起踢掉
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    /** 沉睡治理阈值（天）：owner 在「账号管理」里可改，读不到就按服务端默认显示 */
    const [inactivePolicy, setInactivePolicy] = useState<{
        disableDays: number;
        graceDays: number;
    } | null>(null);

    /**
     * 用邀请码注册。成功后服务端已经下发会话 cookie，
     * 这里直接切进应用、拉一次数据即可，不用再回登录页输一遍。
     */
    const handleRegister = async (
        username: string,
        password: string,
        inviteCode: string
    ): Promise<{ success: boolean; message?: string }> => {
        try {
            setLoginLoading(true);
            setLoginError(null);
            const result = await api.register(username, password, inviteCode);
            if (result.success) {
                setIsAuthenticated(true);
                setIsAuthRequired(false);
                // 服务端已经建号并发下会话，账号 id 要问一次才拿得到：
                // 本地数据分账号靠的是这个 id，不能拿账号名凑（改名就对不上了）
                const me = await api.getMe();
                setCurrentUser(
                    me ?? { id: 0, username: result.username || username, role: "user" }
                );
                // 新账号是另一个身份：本地数据从这一刻起归新账号
                onSwitchAccount(me ? me.id : 0);
                onCloseSnackbar();
                await fetchData();
                // 新账号是干净的：上一个账号生成的邀请码、配置过的恢复密钥都不能跟着带过来
                setInvite(null);
                refreshRecoveryStatus();
                // 不再弹「注册成功，已自动登录」：注册完直接进入页面，本身就是结果，
                // 多一个 toast 反而把界面挡住
                return { success: true };
            }
            return { success: false, message: result.message || "注册失败" };
        } catch (error) {
            reportError(error, { source: "auth-register" });
            return {
                success: false,
                message: "注册失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        } finally {
            setLoginLoading(false);
        }
    };

    /** 生成邀请码（30 分钟有效）。只在这个会话里显示，不落库也不缓存。 */
    const handleCreateInvite = async (): Promise<{
        success: boolean;
        message?: string;
        code?: string;
        expiresAt?: number;
    }> => {
        try {
            const result = await api.createInvite();
            if (result.success && result.code) {
                setInvite({ code: result.code, expiresAt: result.expiresAt || 0 });
            }
            return result;
        } catch (error) {
            return {
                success: false,
                message: "生成邀请码失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    };

    /** 拉账号清单（仅 owner）：打开「账号管理」时调一次，用来看哪些账号快被停用/清除 */
    const fetchAccountList = useCallback(async () => {
        if (currentUser?.role !== "owner") return;
        try {
            const res = await fetch("/api/users", { credentials: "same-origin" });
            if (!res.ok) return;
            const data = (await res.json()) as { success?: boolean; users?: AccountInfo[] };
            if (data.success) setAccountList(data.users || []);
        } catch {
            // 拉不到就当没有：账号管理里那一段直接不显示，不打扰正常功能
        }
        // 顺带把治理阈值读回来 —— 没配过就用服务端默认值，界面上显示的数字要和实际跑的一致
        const [disableRaw, graceRaw] = await Promise.all([
            api.getConfig(INACTIVE_DISABLE_DAYS_KEY),
            api.getConfig(INACTIVE_DELETE_GRACE_DAYS_KEY),
        ]);
        setInactivePolicy(resolveInactivePolicy(disableRaw, graceRaw));
    }, [api, currentUser?.role]);

    /**
     * 保存沉睡治理阈值。这两个键属于全站配置，服务端只放 owner 写
     * （configs/batch 里非 webdav. 前缀的键都会校验 owner），普通账号调不动。
     */
    const handleSaveInactivePolicy = useCallback(
        async (policy: { disableDays: number; graceDays: number }) => {
            try {
                const ok = await api.setConfigs({
                    [INACTIVE_DISABLE_DAYS_KEY]: String(policy.disableDays),
                    [INACTIVE_DELETE_GRACE_DAYS_KEY]: String(policy.graceDays),
                });
                if (!ok) return { success: false, message: "保存失败，请重试" };
                setInactivePolicy(policy);
                await fetchAccountList(); // 清单里的「约 N 天后停用」要跟着新阈值重算
                return { success: true };
            } catch (error) {
                return {
                    success: false,
                    message: "保存失败：" + (error instanceof Error ? error.message : "未知错误"),
                };
            }
        },
        [api, fetchAccountList]
    );

    /** 重新启用某个账号 = 给它豁免沉睡治理（服务端会顺带把活跃时间刷成现在） */
    const handleExemptUser = useCallback(
        async (uid: number) => {
            try {
                const res = await fetch(`/api/users/${uid}/status`, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: "active" }),
                });
                const data = (await res.json()) as { success?: boolean; message?: string };
                if (data.success) {
                    notify("已重新启用该账号", "success");
                    await fetchAccountList();
                } else {
                    notify(data.message || "操作失败", "error");
                }
            } catch (error) {
                notify("操作失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            }
        },
        [fetchAccountList, notify]
    );

    /**
     * 手动跑一次沉睡账号扫描（仅 owner）：等不及每周 cron 时用。
     * 扫完一定重拉清单 —— 有人刚被停用/清除，界面还停在扫描前的状态会让人以为没生效。
     */
    const handleSweepInactive = useCallback(async () => {
        try {
            const res = await fetch("/api/users/sweep", {
                method: "POST",
                credentials: "same-origin",
            });
            const data = (await res.json().catch(() => ({}))) as {
                success?: boolean;
                message?: string;
                disabled?: number;
                deleted?: number;
            };
            const result = readSweepResult(res.ok, data);
            if (result.success) await fetchAccountList();
            return result;
        } catch (error) {
            return {
                success: false,
                message: "扫描失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    }, [fetchAccountList]);

    /** 拉登录设备列表（当前账号自己的）：打开「账号管理」时调一次 */
    const fetchSessions = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            setSessions(await api.getSessions());
        } catch {
            // 拉不到就当没有：界面上那一段直接不显示，不打扰正常功能
        }
    }, [api, isAuthenticated]);

    /** 把某一台设备踢下线（只吊销那张令牌，别的设备不受影响） */
    const handleRevokeSession = useCallback(
        async (jti: string) => {
            try {
                const result = await api.revokeSession(jti);
                if (result.success) {
                    notify("已将该设备踢下线", "success");
                    await fetchSessions();
                } else {
                    notify(result.message || "操作失败", "error");
                }
            } catch (error) {
                notify(
                    "操作失败：" + (error instanceof Error ? error.message : "未知错误"),
                    "error"
                );
            }
        },
        [api, fetchSessions, notify]
    );

    /** 退出其它设备：除当前这台之外全部吊销 */
    const handleRevokeOthers = useCallback(async () => {
        try {
            const result = await api.revokeOtherSessions();
            if (result.success) {
                notify(`已退出 ${result.revoked} 台其它设备`, "success");
                await fetchSessions();
            } else {
                notify(result.message || "操作失败", "error");
            }
        } catch (error) {
            notify("操作失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        }
    }, [api, fetchSessions, notify]);

    /** 注销账号：确认密码 → 服务端删号删数据 → 本地回到登录页 */
    const handleDeleteAccount = async (): Promise<{ success: boolean; message?: string }> => {
        if (!deleteAccountPassword) {
            return { success: false, message: "请输入当前密码以确认注销" };
        }
        try {
            setDeleteAccountBusy(true);
            const result = await api.deleteAccount(deleteAccountPassword);
            if (result.success) {
                setDeleteAccountOpen(false);
                setDeleteAccountPassword("");
                setInvite(null);
                // 账号都没了，本地数据必须一起清空，否则会看到上一个账号的残留
                clearRememberedLogin();
                setGroups([]);
                setIsAuthenticated(false);
                setIsAuthRequired(true);
                setCurrentUser(null);
                clearBootstrapCache();
                onDataError(result.message || "账号已注销");
            }
            return result;
        } catch (error) {
            return {
                success: false,
                message: "注销失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        } finally {
            setDeleteAccountBusy(false);
        }
    };

    /**
     * 重新问一次「当前账号有没有配恢复密钥」。
     * 公钥是每个账号自己的，换账号（登录 / 注册 / 退出）后必须重新取，
     * 否则上一个账号的「已配置」会串到新账号的设置页上。
     */
    const refreshRecoveryStatus = () => {
        api
            .getRecoveryStatus()
            .then(status => setRecoveryConfigured(status?.configured === true))
            .catch(() => setRecoveryConfigured(false));
    };

    // 检查认证状态
    // 优化点：不再单独发一次 checkAuthStatus 请求，直接拉 bootstrap
    // —— 拿得到数据即已登录，401 就是未登录/令牌失效，整个启动过程只花 1 次请求
    const checkAuthStatus = async () => {
        try {
            setIsAuthChecking(true);

            const ok = await fetchData();

            // 顺带确认是否配置了恢复公钥（未登录也能查，失败就当作未配置，不影响登录）
            refreshRecoveryStatus();

            if (ok) {
                setIsAuthenticated(true);
                setIsAuthRequired(false);
                // 拿得到数据 = 已登录，顺带把「我是谁」取回来（失败不影响正常使用）。
                // id 同时用来给本地数据划账号边界：换账号 / 换浏览器存档都要靠它分辨。
                api.getMe()
                    .then(me => {
                        setCurrentUser(me);
                        onSwitchAccount(me ? me.id : null);
                    })
                    .catch(() => setCurrentUser(null));
            } else if (!api.isLoggedIn()) {
                // 本地没有可用令牌
                setIsAuthenticated(false);
                setIsAuthRequired(true);
            }
        } catch (error) {
            reportError(error, { source: "auth-check" });
            // 令牌失效 / 账号已注销：退回登录页；
            // 账号被停用（403）也是一个道理 —— 停在这里只会看到一片空白，
            // 把服务端那句「可以怎么用恢复密钥找回」原样带过去。
            if (error instanceof Error && (error.message.includes("认证") || error.message.includes("HTTP 403"))) {
                const failure = classifyAuthFailure(error);
                setIsAuthenticated(false);
                setIsAuthRequired(true);
                if (failure.message) onDataError(failure.message);
            }
        } finally {
            setIsAuthChecking(false);
        }
    };

    // 登录功能
    const handleLogin = async (username: string, password: string, remember = false) => {
        try {
            setLoginLoading(true);
            setLoginError(null);

            // 调用登录接口（返回的是 LoginResponse 对象，必须判断 success 字段）
            const result = await api.login(username, password, remember);

            if (result && result.success) {
                // 令牌是 httpOnly cookie，浏览器可能在服务端返回 200 之后仍然没把它存上：
                // 站点若经过反代，Worker 看到的是回源用的 https 于是下发带 Secure 的 cookie，
                // 而当前页面是 http —— 浏览器按规范直接丢弃，于是「登录成功」后第一个接口
                // 就 401，界面立刻弹回登录页。先确认一次再切换界面，
                // 确认不了就明说原因，别让人对着闪退干瞪眼。
                const sessionOk = await api.checkAuthStatus();
                if (!sessionOk) {
                    setLoginError(cookieRejectedMessage(location.protocol === "https:"));
                    setIsAuthenticated(false);
                    setIsAuthRequired(true);
                    return;
                }

                // 只记账号名；持续登录使用服务端 HttpOnly Cookie。
                if (remember) {
                    saveRememberedLogin({ username });
                } else {
                    clearRememberedLogin();
                }
                // 登录成功
                setIsAuthenticated(true);
                setIsAuthRequired(false);
                setLoginError(null);
                // 关掉可能残留的全局提示（比如上一次输错密码时弹出的「用户名或密码错误」）
                onCloseSnackbar();
                // 首次部署的凭据来自部署变量（等同半公开），服务端会拦住其它操作直到改密
                if (result.mustChangePassword) {
                    notify("请先到「更多选项 → 账号管理」修改密码", "info");
                }
                // 加载数据（一次 bootstrap 请求）
                await fetchData();
                // 登录成功也要确认「我是谁」：换账号时本地数据要跟着换一份
                const me = await api.getMe();
                if (me) {
                    setCurrentUser(me);
                    onSwitchAccount(me.id);
                }
                // 换账号了：恢复密钥状态要按新账号重新问一次
                refreshRecoveryStatus();
            } else {
                // 登录失败：账号或密码不对
                // 只在登录表单内提示，不再弹全局 Snackbar——否则提示会残留到下一次成功登录之后
                const message = result?.message || "用户名或密码错误";
                setLoginError(message);
                setIsAuthenticated(false);
                setIsAuthRequired(true);
            }
        } catch (error) {
            reportError(error, { source: "auth-login" });
            onError("登录失败: " + (error instanceof Error ? error.message : "未知错误"));
            setIsAuthenticated(false);
        } finally {
            setLoginLoading(false);
        }
    };

    // 用恢复令牌重置管理员密码（登录页「用恢复密钥找回账号」入口）
    const handleRecover = async (
        token: string
    ): Promise<{ success: boolean; message?: string }> => {
        try {
            const result = await api.recoverPassword(token);
            if (result?.success) {
                onCloseSnackbar();
                notify(result.message || "密码已重置，请用新密码登录", "success");
                clearRememberedLogin();
            }
            return result;
        } catch (error) {
            reportError(error, { source: "auth-recover" });
            return {
                success: false,
                message: "恢复失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    };

    /**
     * 生成恢复密钥对（更多选项 → 账号管理）。
     * 密钥在浏览器里生成：公钥交给服务器保存，私钥直接下载到本地，全程不上传。
     * 服务端要求校验当前密码，所以这里必须把用户填的当前密码一起传过去。
     */
    const handleGenerateRecoveryKey = async (
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }> => {
        try {
            const notSupported = checkWebCryptoSupport();
            if (notSupported) {
                return { success: false, message: notSupported };
            }

            const { alg, publicKey, privateKey } = await generateRecoveryKeyPair();
            const result = await api.setRecoveryPublicKey(publicKey, currentPassword);
            if (!result?.success) {
                return { success: false, message: result?.message || "保存恢复公钥失败" };
            }

            // 公钥落库成功才下载私钥：否则会出现「私钥存了但服务器不认」的情况
            const filename = downloadRecoveryKeyFile(alg, publicKey, privateKey);
            setRecoveryConfigured(true);
            return {
                success: true,
                message: `私钥已下载为 ${filename}（${algLabel(alg)}），请离线妥善保管；旧私钥已失效`,
            };
        } catch (error) {
            reportError(error, { source: "auth-recovery-key" });
            return {
                success: false,
                message: "生成恢复密钥失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    };

    // 登出功能
    const handleLogout = () => {
        api.logout();
        // 账号边界归零（与换账号共用同一条清单，见 utils/sessionBoundary.ts）：
        // 撤销栈、撤销快照、离线队列全部解绑当前账号。队列不删 —— 那可能是还没
        // 同步出去的编辑，等本人下次登录接着重放；但绝不能留在「任何人都能重放」
        // 的全局键里。首屏缓存也在这一步清掉，退出后不该再把上一个人的数据画出来。
        clearSessionBoundary({
            setQueueAccount: setAccountUid,
            setUndoAccount: setUndoAccountUid,
            setPrefsAccount: setPrefsAccountUid,
            clearHistory,
            resetCollapsed: () => onResetCollapsed(),
        });
        setIsAuthenticated(false);
        setIsAuthRequired(true);

        // 清空数据
        setGroups([]);
        onMenuClose();

        // 上一个账号的痕迹一并清掉：邀请码是「当前会话刚生成的那枚」，
        // 换个账号登录后不该还在设置页里露出来；恢复密钥状态同理，下次登录重新问
        setInvite(null);
        setCurrentUser(null);
        setRecoveryConfigured(false);

        // 多选模式是 App 本地 state，登出时不卸载组件，不会自动复位——
        // 不在这里清掉，重登后还会停在「批量多选」态。退出时连勾选一并清空。
        onExitMultiSelect();

        // 显示提示信息
        onDataError("已退出登录，请重新登录");
    };
    return {
        isAuthChecking,
        loginError,
        loginLoading,
        recoveryConfigured,
        currentUser,
        setCurrentUser,
        invite,
        setInvite,
        deleteAccountOpen,
        setDeleteAccountOpen,
        deleteAccountPassword,
        setDeleteAccountPassword,
        deleteAccountBusy,
        setDeleteAccountBusy,
        accountList,
        sessions,
        inactivePolicy,
        handleRegister,
        handleCreateInvite,
        fetchAccountList,
        handleSaveInactivePolicy,
        handleExemptUser,
        handleSweepInactive,
        fetchSessions,
        handleRevokeSession,
        handleRevokeOthers,
        handleDeleteAccount,
        refreshRecoveryStatus,
        checkAuthStatus,
        handleLogin,
        handleRecover,
        handleGenerateRecoveryKey,
        handleLogout,
    };
}
