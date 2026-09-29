import { reportError } from "./utils/errorReporter";
import {
    useState,
    useEffect,
    useMemo,
    useRef,
    useCallback,
    useDeferredValue,
    lazy,
    Suspense,
} from "react";
import { NavigationClient } from "./API/client";
import { MockNavigationClient } from "./API/mock";
import {
    Site,
    Group,
    ExportData,
    BootstrapData,
    WebDavConfig,
    BACKUP_CREDENTIALS_CONFIG,
    CRON_LAST_ERROR_KEY,
    EXPORT_VERSION,
    isSecretConfigKey,
    isUserScopedConfigKey,
    isPerUserAppearanceKey,
    normalizeImportData,
    INACTIVE_DISABLE_DAYS_KEY,
    INACTIVE_DELETE_GRACE_DAYS_KEY,
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "./API/http";
import type { AccountInfo } from "./API/http";
import { GroupWithSites } from "./types";
import { AppConfigProvider } from "./context/AppConfigContext";
import { NotifyContext } from "./context/NotifyContext";
import { useUIPrefs, RADIUS_PX, onLocalPrefsChange } from "./context/UIPrefsContext";
import SiteCard from "./components/SiteCard";
import GroupNavRail from "./components/GroupNavRail";
// 弹窗/面板类组件按需加载：首屏用不到它们，拆出去能让主包小一大截
// （命令面板与书签导入已随 OverlayHost 一起搬走，这里只留它们的类型）
import type { CommandItem } from "./components/CommandPalette";
import ScrollProgress from "./components/ScrollProgress";
import BackToTop from "./components/BackToTop";
import OfflineBanner from "./components/OfflineBanner";
import ConfirmDialog from "./components/ConfirmDialog";
// 提示条 / 背景装饰 / 浮层挂载点：三段纯渲染的 JSX，从 App 的渲染树里抽出来
import SnackbarHost from "./components/SnackbarHost";
import BackgroundLayers from "./components/BackgroundLayers";
import OverlayHost from "./components/OverlayHost";
import { usePwaInstall } from "./hooks/usePwaInstall";
import { useHistoryStack } from "./hooks/useHistoryStack";
import { useNotify } from "./hooks/useNotify";
import { useSites } from "./hooks/useSites";
import { useMultiSelect } from "./hooks/useMultiSelect";
import { useBulkActions } from "./hooks/useBulkActions";
import { useAppDialogs } from "./hooks/useAppDialogs";
import { wrapMutations, installOnlineListener, flushOfflineQueue, pendingCount, type MutationApi } from "./API/offlineQueue";
import { buildFavoritesGroup, deriveDisplayedGroups } from "./utils/siteView";
import {
    SortMode,
    headerDividerSx,
} from "./constants";
import HeaderSearchBox from "./components/HeaderSearchBox";
import HeaderActions from "./components/HeaderActions";
import MoreMenu from "./components/MoreMenu";
import DisplayControls from "./components/DisplayControls";
const SettingsDialog = lazy(() => import("./components/SettingsDialog"));
// 账号管理（改账号密码 / 恢复密钥 / 邀请码 / 注销）：从「更多选项」进入，懒加载
const AccountDialog = lazy(() => import("./components/AccountDialog"));
// 注销确认弹窗只有点「注销账号」才会用到，懒加载省首屏体积
const DeleteAccountDialog = lazy(() => import("./components/DeleteAccountDialog"));
const ImportPreviewDialog = lazy(() => import("./components/ImportPreviewDialog"));
const AuditDialog = lazy(() => import("./components/AuditDialog"));
const RecycleBinDialog = lazy(() => import("./components/RecycleBinDialog"));
import HeaderClock from "./components/HeaderClock";
import SiteListHeader from "./components/SiteListHeader";
import SiteListSkeleton from "./components/SiteListSkeleton";
import SiteListEmptyState from "./components/SiteListEmptyState";
const VisitsDialog = lazy(() => import("./components/VisitsDialog"));
import { COLLAPSED_EVENT, readCollapsedGroupIds, setAllCollapsed } from "./utils/collapse";
import { findDuplicateSite } from "./utils/duplicate";
import { loadPinyinMatcher } from "./utils/pinyin";
import {
    FRESH_WINDOW_MS,
    exportLinkHealth,
    mergeLinkHealth,
    onLinkHealthChange,
    probeLinks,
    readDeadLinks,
} from "./utils/linkHealth";
import { clearBootstrapCache, readBootstrapCache } from "./utils/firstPaintCache";
import { ParsedBookmarkGroup } from "./utils/bookmarks";
import { DEFAULT_ICON_API, resolveIconApiUrl } from "./utils/iconApi";
import { normalizeFailureText, normalizeUrl } from "./utils/url";
import { groupAccent } from "./utils/groupColor";
import { matchesGroupQuery, matchesSiteQuery } from "./utils/search";
import { saveRememberedLogin, clearRememberedLogin } from "./utils/rememberedLogin";
import { verifyBackupIntegrity, withBackupIntegrity } from "./utils/backupIntegrity";
import { loadPersistedUndo } from "./utils/undoPersist";
import {
    formDataKey,
    secretInputSx,
    secretInputType,
    SECRET_IGNORE_ATTRS,
} from "./utils/secretInput";
import type { ThemeMode } from "./components/ThemeToggle";
import GroupCard from "./components/GroupCard";
import EditGroupDialog from "./components/EditGroupDialog";
import LoginForm from "./components/LoginForm";
const BackupDialog = lazy(() => import("./components/BackupDialog"));
import "./App.css";
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    DragOverEvent,
    DragStartEvent,
    DragOverlay,
} from "@dnd-kit/core";
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import SortableGroupItem from "./components/SortableGroupItem";
// Material UI 导入
import {
    Container,
    Typography,
    Box,
    Button,
    CircularProgress,
    Stack,
    createTheme,
    ThemeProvider,
    CssBaseline,
    TextField,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Divider,
    Tooltip,
    InputAdornment,
} from "@mui/material";
import { encryptBackup } from "./API/crypto";
import {
    algLabel,
    checkWebCryptoSupport,
    downloadRecoveryKeyFile,
    generateRecoveryKeyPair,
} from "./utils/recoveryKey";
import CloseIcon from "@mui/icons-material/Close";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import TagBar from "./components/TagBar";
const ShortcutsDialog = lazy(() => import("./components/ShortcutsDialog"));

// 根据环境选择使用真实API还是模拟API
const isDevEnvironment = import.meta.env.DEV;
const useRealApi = import.meta.env.VITE_USE_REAL_API === "true";

const api =
    isDevEnvironment && !useRealApi
        ? new MockNavigationClient()
        : new NavigationClient(isDevEnvironment ? "http://localhost:8788/api" : "/api");

// 离线写入队列：给所有 mutation 方法包一层。离线 / 网络失败时把操作存本地，
// 恢复连接后由下面的 online 监听自动重放。模块级只跑一次。
wrapMutations(api as unknown as MutationApi);

// 默认配置
const DEFAULT_CONFIGS = {
    // 原来这里是脚手架的 "MyHomepage"：数据库里还没存过 site.title 时，
    // 应用一挂载就会把 <title> 从 index.html 里的「Navihive 导航站」改成它。
    // 用户没配过标题的话，看到的就是这个莫名其妙的名字，统一改成站点自己的名字。
    "site.title": "Navihive 导航站",
    "site.name": "Navihive",
    "site.customCss": "",
    // 一键获取图标所用的 API 模板，{domain} 会被替换成站点域名
    "site.iconApi": DEFAULT_ICON_API,
    // 背景图片与蒙版透明度（0~1，越大背景图越清晰）
    "site.backgroundImage": "",
    "site.backgroundMaskOpacity": "0.15",
    // 站点缩略图 API 模板（{url} / {domain} / {origin} 会被替换），留空表示不启用缩略图。
    // 默认留空：缩略图会把每个可见站点的链接交给第三方截图，不该是开箱即用的默认行为。
    // 想用的人在设置里填（输入框的占位提示就是 DEFAULT_THUMB_API，可直接采用）。
    "site.thumbApi": "",
    // 自定义主色（#rrggbb），留空表示跟随默认主题色
    "site.primaryColor": "",
    // 毛玻璃模糊强度（px，0~24），留空表示用默认 14
    "site.glassBlur": "",
};


// 背景值是不是 CSS 渐变的判定已随 BackgroundLayers 一起搬走


// WebDAV 备份默认配置（保存在服务端 configs 表中，不会写入备份文件）
const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
    url: "",
    username: "",
    password: "",
    path: "navihive-backup",
    // 备份口令：空 = 不加密上传（明文 gzip）。设了之后上传/恢复都用这个口令，
    // 与 AUTH_SECRET 无关
    backupPassword: "",
    // 默认不允许内网地址：WebDAV 多半是公网网盘，挡内网是白赚的防护
    allowPrivateNetwork: false,
};

// WebDAV 配置在 configs 表中的键名前缀
const WEBDAV_CONFIG_PREFIX = "webdav.";

// ---- 可选的多端同步（都存服务端 configs，默认关）----
// 失效检测结果：换设备不用重测一遍
const LINK_HEALTH_CONFIG = "link.health";
const LINK_HEALTH_SYNC_CONFIG = "link.healthSync";
// 本机偏好（星标 / 标签）：清了缓存也不至于全丢
const PREF_SYNC_CONFIG = "pref.sync";
const PREF_STARRED_CONFIG = "pref.starred";
const PREF_TAGS_CONFIG = "pref.tags";
/** 改动后多久推一次：拖星标、连续打标签时不该每个动作都发一个请求 */
const SYNC_DEBOUNCE_MS = 1500;

// ---- 顶部工具栏的统一尺寸 ----
// 之前搜索框（40px）比按钮（32px）高一截，一行里高矮不齐；现在统一成一个高度、一个圆角。
// 主题模式（ThemeMode）定义在 ThemeToggle 里，这里直接引用，避免两处联合类型各写一份。
function App() {
    // 主题模式状态（默认跟随系统；老用户存过的 light/dark 依然兼容）
    const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
        const saved = localStorage.getItem("theme");
        return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    });
    // 系统当前的深浅偏好
    const [systemDark, setSystemDark] = useState(() =>
        window.matchMedia("(prefers-color-scheme: dark)").matches
    );

    useEffect(() => {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);

    const darkMode = themeMode === "system" ? systemDark : themeMode === "dark";

    // 切换主题：每一档点下去都要有可见变化
    // 浅色 → 深色 → 跟随系统（系统深时则先给浅色，保证「点一下就有反应」）
    const toggleTheme = () => {
        const next: ThemeMode =
            themeMode === "light"
                ? "dark"
                : themeMode === "dark"
                  ? "system"
                  : systemDark
                    ? "light"
                    : "dark";
        setThemeMode(next);
        localStorage.setItem("theme", next);
    };

    // 只读数据层切片：分组 / 加载中 / 错误状态与 bootstrap 落地逻辑已抽到 useSites，
    // 配置落地 + 偏好 / 链接健康合并等需要其它 App 层状态的步骤交还给 onRemoteExtras。
    // 用解构保持原局部变量名不变，下面几十处引用无需改动。
    const {
        groups,
        setGroups,
        loading,
        setLoading,
        error,
        setError,
        fetchData,
        applyRemoteData,
        upsertSiteLocally,
        removeSiteLocally,
        removeSitesLocally,
    } = useSites({
        api,
        onRemoteExtras: applyRemoteExtras,
        onError: (msg) => handleError(msg),
        onAuthFail: () => {
            api.logout();
            setIsAuthRequired(true);
            setIsAuthenticated(false);
        },
    });

    // bootstrap 里「分组」之外的落地：配置、链接健康、星标 / 标签跨端合并。
    // 用函数声明（会被提升），这样上面 useSites 调用时就能引用它，而它内部用到的
    // applyConfigs / setDeadLinks 等虽在更后面定义，调用时才取值，不会触发 TDZ。
    function applyRemoteExtras(data: BootstrapData) {
        applyConfigs(data.configs);
        // ---- 可选的多端同步：把服务端那份合并回本机 ----
        // 都是「取并集 / 取较新」，所以重复合并不会丢数据，也不怕和上传打架
        const incoming = data.configs || {};

        if (incoming[LINK_HEALTH_SYNC_CONFIG] === "true" && incoming[LINK_HEALTH_CONFIG]) {
            try {
                mergeLinkHealth(JSON.parse(incoming[LINK_HEALTH_CONFIG]));
                setDeadLinks(readDeadLinks());
            } catch {
                // 云端那份坏了就当没有，不影响本机
            }
        }

        if (incoming[PREF_SYNC_CONFIG] === "true") {
            try {
                const remoteStarred = JSON.parse(incoming[PREF_STARRED_CONFIG] || "[]");
                const remoteTags = JSON.parse(incoming[PREF_TAGS_CONFIG] || "{}");
                mergeRemotePrefs(remoteStarred, remoteTags);
            } catch {
                // 同上
            }
        }
    }

    const [sortMode, setSortMode] = useState<SortMode>(SortMode.None);
    const [currentSortingGroupId, setCurrentSortingGroupId] = useState<number | null>(null);
    // 记录进入站点排序时每个站点所属的原始分组，用于保存时识别跨组移动
    const siteOriginalGroupRef = useRef<Map<number, number>>(new Map());
    // 用 ref 镜像最新的 groups：事件回调可以保持稳定引用（配合 memo 减少无谓重渲染）
    const groupsRef = useRef<GroupWithSites[]>([]);

    useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);

    // 新增认证状态
    const [isAuthChecking, setIsAuthChecking] = useState(true);
    const [isAuthRequired, setIsAuthRequired] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [loginLoading, setLoginLoading] = useState(false);
    // 是否已配置恢复公钥（未登录也能查，决定是否在登录页显示「用恢复密钥找回账号」）
    const [recoveryConfigured, setRecoveryConfigured] = useState(false);
    // 当前登录账号（多账号后要能显示「我是谁」）
    const [currentUser, setCurrentUser] = useState<{
        username: string;
        role: "owner" | "user";
    } | null>(null);
    // 生成的邀请码（含过期时间），只留在内存里，刷新页面即消失
    const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
    // 注销账号：二次确认弹窗 + 确认密码
    const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
    const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
    const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);

    // 配置状态
    const [configs, setConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    const [openConfig, setOpenConfig] = useState(false);
    const [tempConfigs, setTempConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    // 账号管理弹窗（账号密码 / 恢复密钥 / 邀请码 / 注销）
    const [openAccount, setOpenAccount] = useState(false);
    const [savingAuth, setSavingAuth] = useState(false);
    // 账号清单（仅 owner 拿得到）：每个账号的沉睡治理状态，给「账号管理」里那份列表用
    const [accountList, setAccountList] = useState<AccountInfo[]>([]);
    /** 沉睡治理阈值（天）：owner 在「账号管理」里可改，读不到就按服务端默认显示 */
    const [inactivePolicy, setInactivePolicy] = useState<{
        disableDays: number;
        graceDays: number;
    } | null>(null);

    // 设置弹窗里选色时的即时预览值（不落库，关闭弹窗即回滚）
    const [accentPreview, setAccentPreview] = useState<string | null>(null);
    // 保存网站设置的防连点守卫（同步 ref 拦同一轮连点，state 用于按钮禁用）
    const savingConfigRef = useRef(false);
    const [savingConfig, setSavingConfig] = useState(false);

    // 自定义主色：只有合法的 #rgb / #rrggbb 才采用，避免脏数据把主题搞坏
    const accentRaw = (accentPreview ?? (configs["site.primaryColor"] || "")).trim();
    const accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentRaw) ? accentRaw : "";

    // 创建Material UI主题（放在 configs 之后，才能读到自定义主色）
    const theme = useMemo(
        () =>
            createTheme({
                palette: {
                    mode: darkMode ? "dark" : "light",
                    // 未设置主色时保持默认（亮/暗各一套，暗色下自动换成更亮的蓝）
                    ...(accent ? { primary: { main: accent } } : {}),
                    // 次级文字（caption/说明文案）默认 rgba(0,0,0,.6)，在带底色的面板上
                    // 对比度 4.59 压线 AA（4.5）。各提半档留安全余量，视觉上几乎无差别
                    // （harness/contrast-audit.mjs 守着这条）
                    text:
                        darkMode
                            ? { secondary: "rgba(255,255,255,0.76)" }
                            : { secondary: "rgba(0,0,0,0.66)" },
                    // 凭据警告等 warning.dark 文案：MUI 亮色默认 orange[900]（#e65100）
                    // 在白底上只有 ~3.8:1，低于 AA(4.5)。main 保持默认只加深 dark，
                    // 暗色用 MUI 默认（contrast-audit 无不合格）
                    ...(!darkMode && { warning: { main: "#ed6c02", dark: "#9c4f00" } }),
                },
                typography: {
                    // 跟随全局字体栈（index.css 的 --font-sans）
                    fontFamily: 'var(--font-sans)',
                    h1: { fontWeight: 700, letterSpacing: "-0.02em" },
                    h2: { fontWeight: 600, letterSpacing: "-0.01em" },
                    h3: { fontWeight: 700, letterSpacing: "-0.02em" },
                    h4: { fontWeight: 600 },
                    h5: { fontWeight: 600 },
                    button: { fontWeight: 500, textTransform: "none" },
                },
                shape: {
                    // 统一放大圆角，观感更柔和
                    borderRadius: 14,
                },
                components: {
                    // 弹层（菜单/对话框/抽屉/下拉）一律不锁背景滚动。MUI 的滚动锁会
                    // 把 body 的滚动条收走再补 padding，开合之间有效宽度进出 10px ——
                    // 页面缩放时这 10px 刚好能跨过 900px 断点，顶栏字号档位跟着跳，
                    // 「导航站」一开菜单就从一行挤成两行。禁掉后滚动条从头到尾都在，
                    // 加上 index.css 的 scrollbar-gutter: stable，开合弹层零重排。
                    // 代价是弹层开着时背景还能滚 —— 菜单/弹窗跟随锚点重定位，无碍。
                    MuiPopover: { defaultProps: { disableScrollLock: true } },
                    MuiDrawer: { defaultProps: { disableScrollLock: true } },
                    // 键盘焦点环：index.css 里那条全局 :focus-visible 只对原生元素管用，
                    // MUI 组件的样式是运行时由 emotion 注入的，排在意料之外的位置把它压掉了 ——
                    // 实测 Tab 到搜索框 / 更多选项 / 视图切换时，computed outline 与 boxShadow 全是 none，
                    // 键盘用户过了左侧分组栏就彻底看不到自己在哪。这里按组件补回来。
                    MuiButtonBase: {
                        styleOverrides: {
                            root: {
                                "&:focus-visible": {
                                    outline: "2px solid var(--accent)",
                                    outlineOffset: 2,
                                },
                            },
                        },
                    },
                    // 所有弹窗默认走同一套毛玻璃面板：半透明底 + 模糊 + 细边框 + 柔和投影，
                    // 单个弹窗自己写了 paper sx 的话会覆盖这里（比如确认弹窗、命令面板）
                    MuiDialog: {
                        defaultProps: { disableScrollLock: true },
                        styleOverrides: {
                            paper: ({ theme }) => ({
                                borderRadius: "var(--card-radius)",
                                backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                                WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                                border: "1px solid var(--glass-panel-border)",
                                boxShadow: "var(--glass-shadow-hover)",
                                backgroundColor:
                                    theme.palette.mode === "dark"
                                        ? "rgba(23,27,38,0.94)"
                                        : "rgba(255,255,255,0.94)",
                                // 小屏别贴边
                                "@media (max-width:600px)": { margin: 12 },
                            }),
                        },
                    },
                    // 移动端触控尺寸：以前写在 App.css 里用 !important 全站强压
                    // （button/a/[role=button] padding 12px + min-height 36px），
                    // 结果是连左侧分组栏、卡片右上角的图标按钮都被撑成 32×36 的长方形。
                    // 改成按组件在断点里给尺寸后，组件自己写的 sx 优先级更高、可以覆盖，
                    // 只有没特别声明的按钮才拿到这套保底尺寸。
                    MuiButton: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    minHeight: 36,
                                    paddingInline: 12,
                                },
                            },
                        },
                    },
                    MuiIconButton: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    padding: 6,
                                    minWidth: 36,
                                    minHeight: 36,
                                },
                            },
                        },
                    },
                    MuiInputBase: {
                        styleOverrides: {
                            root: {
                                "@media (max-width:600px)": {
                                    "& .MuiInputBase-input": { padding: "10px 12px" },
                                },
                                // 输入框**不**补外圈 outline：
                                // outlined 输入框自己就有聚焦指示（边框 1px 灰 → 2px 主色），
                                // 之前额外给 root 补一圈 outline 后，两者叠成两道同心环——
                                // 点一下搜索框就看到「双红圈」。
                                // 统一交给 MUI 的边框后，任何主题、带不带 label 都只有一圈，
                                // 顺带也不再需要「带 label 的输入框单独排除 outline」那条例外
                                // （label 骑在边框线上、外圈横穿文字的问题一并消失）。
                            },
                        },
                    },
                    MuiDivider: {
                        styleOverrides: {
                            root: { "@media (max-width:600px)": { margin: "8px 0" } },
                        },
                    },
                    MuiMenu: {
                        defaultProps: { disableScrollLock: true },
                        styleOverrides: {
                            paper: { "@media (max-width:600px)": { minWidth: 200 } },
                        },
                    },
                },
            }),
        [darkMode, accent]
    );

    // WebDAV 备份配置
    const [webdavConfig, setWebdavConfig] = useState<WebDavConfig>(DEFAULT_WEBDAV_CONFIG);

    // 管理员账号密码修改（不写入 configs，走独立的 auth/credentials 接口）
    const [authUsername, setAuthUsername] = useState("");
    const [authCurrentPassword, setAuthCurrentPassword] = useState("");
    const [authNewPassword, setAuthNewPassword] = useState("");

    // 配置传感器，支持鼠标、触摸和键盘操作
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 1, // 降低激活阈值，使拖拽更敏感
                delay: 0, // 移除延迟
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 100, // 降低触摸延迟
                tolerance: 3, // 降低容忍值
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // 新增状态管理
    const [openAddGroup, setOpenAddGroup] = useState(false);
    const [openAddSite, setOpenAddSite] = useState(false);
    const [newSite, setNewSite] = useState<Partial<Site>>({
        name: "",
        url: "",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
        group_id: 0,
    });

    // 新增菜单状态
    const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
    const openMenu = Boolean(menuAnchorEl);

    // 备份/恢复对话框状态
    const [openBackup, setOpenBackup] = useState(false);
    const [backupTab, setBackupTab] = useState(0);

    // 审计日志 / 回收站对话框状态
    const [openAudit, setOpenAudit] = useState(false);
    const [openRecycle, setOpenRecycle] = useState(false);

    // 新增卡片时是否明文显示密码
    const [showNewSitePassword, setShowNewSitePassword] = useState(false);

    // 正在创建站点：按钮置灰 + 防止连点创建出多张卡片
    const [creatingSite, setCreatingSite] = useState(false);
    const [fetchingMeta, setFetchingMeta] = useState(false);
    // setState 要等下一次渲染才生效，连点两下时用 ref 同步兜住
    const creatingSiteRef = useRef(false);
    const fetchingMetaRef = useRef(false);

    // 全局提示条：状态与 notify 都挪进了 useNotify（App 只负责渲染 <Snackbar />）
    const {
        notify,
        close: handleCloseSnackbar,
        open: snackbarOpen,
        message: snackbarMessage,
        severity: snackbarSeverity,
        duration: snackbarDuration,
        action: snackbarAction,
        liveMessage,
    } = useNotify();
    // 搜索关键词：普通浏览模式下即时筛选卡片
    const [searchQuery, setSearchQuery] = useState("");
    const searchInputRef = useRef<HTMLInputElement>(null);
    // 搜索结果下拉面板：是否聚焦 + 当前高亮项
    const [searchFocused, setSearchFocused] = useState(false);
    const [activeResult, setActiveResult] = useState(0);
    // 下拉面板的锚点：必须用 state 存，ref.current 的变化不会触发重渲染，Popper 会拿不到 anchor
    const [searchAnchor, setSearchAnchor] = useState<HTMLDivElement | null>(null);
    const searchPanelRef = useRef<HTMLDivElement>(null);

    // 本机显示偏好与访问统计
    const {
        viewMode,
        setViewMode,
        density,
        setDensity,
    favoritesEnabled,
    setFavoritesEnabled,
    glassEffects,
    setGlassEffects,
    visits,
    recordVisit,
        clearVisits,
        radius,
        setRadius,
        fontScale,
        setFontScale,
        deadLinks,
        setDeadLinks,
        searchHistory,
        pushSearchHistory,
        clearSearchHistory,
        starred,
        setStarredMany,
        tags,
        setSiteTags,
        addTagsToMany,
        removeTagFromAll,
        forgetSites,
        allTags,
        tagCounts,
        railCollapsed,
        setRailCollapsed,
        pinyinSearch,
        setPinyinSearch,
        restoreLocalPrefs,
        prefSync,
        setPrefSync,
        mergeRemotePrefs,
    } = useUIPrefs();

    // 导入预览：备份恢复前先摊开差异让用户挑，确认/取消都通过 promise 回传给备份弹窗
    const [importPreview, setImportPreview] = useState<{
        data: ExportData;
        overwrite: boolean;
    } | null>(null);
    const importPreviewResolve = useRef<((result: ExportData | null) => void) | null>(null);

    // 拼音搜索：开关打开后才按需加载词典（约 28KB 的独立 chunk），加载完刷新一次筛选
    const [pinyinReady, setPinyinReady] = useState(false);
    useEffect(() => {
        if (!pinyinSearch) {
            setPinyinReady(false);
            return;
        }
        let cancelled = false;
        // 词典是 28KB 的独立 chunk，首开还要建索引。等一帧再加载，让开关先画出来——
        // 否则「点下去到看见开关动」之间会夹着这段工作，观感就是点了卡一下。
        // （不能改成打开设置弹窗就预加载：那会让从没开过拼音的人也白白下载这个 chunk。）
        const timer = window.setTimeout(() => {
            void loadPinyinMatcher().then(() => {
                if (!cancelled) setPinyinReady(true);
            });
        }, 0);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [pinyinSearch]);
    const usePinyin = pinyinSearch && pinyinReady;

    // 批量多选：进入后点卡片是「勾选」而不是打开网页。
    // 状态收进 useMultiSelect；批量动作（星标/标签/移动/删除）仍留在本组件——
    // 它们各自牵着通知/撤销/分组数据等多个子系统，收进 hook 只会变成上帝 hook。
    const {
        multiSelect,
        selectedIds,
        bulkDeleteOpen,
        setMultiSelect,
        setBulkDeleteOpen,
        exitMultiSelect,
        toggleSelect,
        clearSelection,
    } = useMultiSelect();
    // App 级弹窗的开关集中收进 useAppDialogs（命令面板/访问统计/快捷键/
    // 书签导入/标签管理/重复网址确认），各自的数据与提交逻辑仍留在本组件。
    const {
        commandOpen,
        openVisits,
        openShortcuts,
        bookmarkOpen,
        tagManagerOpen,
        dupPrompt,
        setCommandOpen,
        setOpenVisits,
        setOpenShortcuts,
        setBookmarkOpen,
        setTagManagerOpen,
        setDupPrompt,
    } = useAppDialogs();
    // 筛选：只看星标 + 标签（可多选，取交集）
    const [starFilter, setStarFilter] = useState(false);
    const [activeTags, setActiveTags] = useState<string[]>([]);
    // 「标签管理」弹窗的开关在 useAppDialogs 里
    // 「只看失效」：失效检测跑完后可以一键把可疑链接筛出来
    const [deadOnly, setDeadOnly] = useState(false);

    // 退出多选 / 勾选切换的逻辑在 useMultiSelect 里

    // 命令面板 / 访问统计 / 快捷键 / 书签导入的开关在 useAppDialogs 里
    // 分组锚点导航：当前视口里的分组
    const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
    // 向下滚动后头部收紧，让出更多内容空间
    const [headerCompact, setHeaderCompact] = useState(false);
    // 移动端「分组」菜单的锚点
    const [mobileGroupsAnchor, setMobileGroupsAnchor] = useState<HTMLElement | null>(
        null
    );

    // 滚动：更新头部收缩状态 + 当前分组高亮
    useEffect(() => {
        let raf = 0;
        let lastY = window.scrollY;

        const update = () => {
            raf = 0;
            const y = window.scrollY;
            // 往下滚且已经离开顶部一段距离才收紧，避免刚滚一点就跳
            setHeaderCompact(y > 90 && y > lastY + 2);
            lastY = y;

            const nodes = document.querySelectorAll<HTMLElement>("[data-group-anchor]");
            if (nodes.length === 0) return;
            const line = 160; // 视口上「当前位置」的判定线
            let current: number | null = null;
            nodes.forEach(node => {
                const rect = node.getBoundingClientRect();
                if (rect.top <= line) {
                    current = Number(node.dataset.groupAnchor);
                }
            });
            if (current === null) {
                const first = nodes[0];
                if (first) current = Number(first.dataset.groupAnchor);
            }
            setActiveGroupId(current);
        };

        const onScroll = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(update);
        };

        window.addEventListener("scroll", onScroll, { passive: true });
        update();
        return () => {
            window.removeEventListener("scroll", onScroll);
            if (raf) window.cancelAnimationFrame(raf);
        };
    }, [loading, groups.length]);

    // Ctrl / Cmd + K 打开命令面板（「/」聚焦搜索框的快捷键在下面那个全局监听里）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setCommandOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // 菜单打开关闭
    const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
        setMenuAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
        setMenuAnchorEl(null);
    };

    // 窗口尺寸变化会让底栏跨过 1344px 断点整个卸载（MobileTabBar 直接 return null），
    // 正开着的菜单 anchor 随之从 DOM 分离 —— MUI 下次重定位拿到全零坐标，
    // 菜单就飘到左上角（用户从窄窗口最大化时就撞到过）。resize 时凡是 anchor
    // 已经不在文档里的弹层一律收掉；底栏退场时自己也会通知一声（onExitViewport），
    // 因为 resize 事件跑在 React 卸载底栏之前，单靠这边可能晚一步。
    useEffect(() => {
        const onResize = () => {
            setMenuAnchorEl(prev => (prev && !prev.isConnected ? null : prev));
            setMobileGroupsAnchor(prev => (prev && !prev.isConnected ? null : prev));
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // 底栏退场（视口宽过 1344px）：只收掉挂在底栏按钮上的弹层，顶栏自己的别误伤
    const handleExitMobileViewport = useCallback(() => {
        setMenuAnchorEl(prev =>
            prev && prev.closest(".nav-mobile-tabbar") ? null : prev
        );
        setMobileGroupsAnchor(prev =>
            prev && prev.closest(".nav-mobile-tabbar") ? null : prev
        );
    }, []);

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
                setCurrentUser({ username: result.username || username, role: "user" });
                handleCloseSnackbar();
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
            console.error("注册失败:", error);
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
        const disableDays = Number.parseInt(disableRaw || "", 10);
        const graceDays = Number.parseInt(graceRaw || "", 10);
        setInactivePolicy({
            disableDays: disableDays > 0 ? disableDays : INACTIVE_DISABLE_DAYS_DEFAULT,
            graceDays: graceDays > 0 ? graceDays : INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
        });
    }, [currentUser?.role]);

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
        [fetchAccountList]
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
                setError(result.message || "账号已注销");
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
                // 拿得到数据 = 已登录，顺带把「我是谁」取回来（失败不影响正常使用）
                api.getMe()
                    .then(me => setCurrentUser(me))
                    .catch(() => setCurrentUser(null));
            } else if (!api.isLoggedIn()) {
                // 本地没有可用令牌
                setIsAuthenticated(false);
                setIsAuthRequired(true);
            }
        } catch (error) {
            console.error("认证检查失败:", error);
            reportError(error, { source: "auth-check" });
            // 令牌失效 / 账号已注销：退回登录页；
            // 账号被停用（403）也是一个道理 —— 停在这里只会看到一片空白，
            // 把服务端那句「可以怎么用恢复密钥找回」原样带过去。
            if (error instanceof Error && (error.message.includes("认证") || error.message.includes("HTTP 403"))) {
                setIsAuthenticated(false);
                setIsAuthRequired(true);
                if (error.message.includes("HTTP 403")) setError(error.message.replace(/\s*\(HTTP 403\)$/, ""));
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
                    setLoginError(
                        location.protocol === "https:"
                            ? "登录状态没能保存，请检查浏览器是否禁用了 Cookie 或拦截了本站 Cookie"
                            : "登录状态没能保存：当前通过 HTTP 访问，浏览器拒绝保存安全 Cookie。请改用 HTTPS（或 localhost）访问"
                    );
                    setIsAuthenticated(false);
                    setIsAuthRequired(true);
                    return;
                }

                // 「记住账号密码」：勾选则保存到本地供下次回填，未勾选则清除
                if (remember) {
                    saveRememberedLogin({ username, password });
                } else {
                    clearRememberedLogin();
                }
                // 登录成功
                setIsAuthenticated(true);
                setIsAuthRequired(false);
                setLoginError(null);
                // 关掉可能残留的全局提示（比如上一次输错密码时弹出的「用户名或密码错误」）
                handleCloseSnackbar();
                // 首次部署的凭据来自部署变量（等同半公开），服务端会拦住其它操作直到改密
                if (result.mustChangePassword) {
                    notify("请先到「更多选项 → 账号管理」修改密码", "info");
                }
                // 加载数据（一次 bootstrap 请求）
                await fetchData();
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
            console.error("登录失败:", error);
            reportError(error, { source: "auth-login" });
            handleError("登录失败: " + (error instanceof Error ? error.message : "未知错误"));
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
                handleCloseSnackbar();
                notify(result.message || "密码已重置，请用新密码登录", "success");
                clearRememberedLogin();
            }
            return result;
        } catch (error) {
            console.error("恢复密码失败:", error);
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
            console.error("生成恢复密钥失败:", error);
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
        setIsAuthenticated(false);
        setIsAuthRequired(true);

        // 退出登录后这份数据就不该再被渲染出来，清掉首屏缓存
        clearBootstrapCache();

        // 清空数据
        setGroups([]);
        handleMenuClose();

        // 上一个账号的痕迹一并清掉：邀请码是「当前会话刚生成的那枚」，
        // 换个账号登录后不该还在设置页里露出来；恢复密钥状态同理，下次登录重新问
        setInvite(null);
        setCurrentUser(null);
        setRecoveryConfigured(false);

        // 多选模式是 App 本地 state，登出时不卸载组件，不会自动复位——
        // 不在这里清掉，重登后还会停在「批量多选」态。退出时连勾选一并清空。
        exitMultiSelect();

        // 显示提示信息
        setError("已退出登录，请重新登录");
    };

    // 加载配置（WebDAV 配置单独存放，避免被写进备份文件）
    const applyConfigs = (configsData: Record<string, string> | null | undefined) => {
        const nextConfigs: Record<string, string> = { ...DEFAULT_CONFIGS };
        const nextWebdav: WebDavConfig = { ...DEFAULT_WEBDAV_CONFIG };

        Object.entries(configsData || {}).forEach(([key, value]) => {
            if (key.startsWith(WEBDAV_CONFIG_PREFIX)) {
                const field = key.slice(WEBDAV_CONFIG_PREFIX.length);
                if (
                    field === "url" ||
                    field === "username" ||
                    field === "password" ||
                    field === "backupPassword" ||
                    field === "path"
                ) {
                    nextWebdav[field] = value;
                } else if (field === "allowPrivateNetwork") {
                    // 布尔按项目惯例存 "1"/"0"，不是 "true"/"false"
                    nextWebdav.allowPrivateNetwork = value === "1";
                }
            } else {
                nextConfigs[key] = value;
            }
        });

        setConfigs(nextConfigs);
        setTempConfigs({ ...nextConfigs });
        setWebdavConfig(nextWebdav);
    };

    // 把一次 bootstrap 拉回的数据合并进本地状态
    // ---- 云端同步：上传（防抖 + 内容没变就不发）----
    // 只负责「本机 → 服务端」这一半；合并在 useSites 的 applyRemoteData（分组）与
    // 本文件的 applyRemoteExtras（配置 / 偏好 / 链接健康）里做。
    // 上传失败一律静默：同步是锦上添花，不能让网络问题干扰正常使用。
    const lastHealthPushRef = useRef("");
    useEffect(() => {
        if (configs[LINK_HEALTH_SYNC_CONFIG] !== "true") {
            onLinkHealthChange(null);
            return;
        }
        let timer: number | undefined;
        onLinkHealthChange(() => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const payload = JSON.stringify(exportLinkHealth());
                if (payload === lastHealthPushRef.current) return;
                lastHealthPushRef.current = payload;
                void api.setConfig(LINK_HEALTH_CONFIG, payload).catch(() => {});
            }, SYNC_DEBOUNCE_MS);
        });
        return () => {
            onLinkHealthChange(null);
            if (timer) window.clearTimeout(timer);
        };
    }, [configs[LINK_HEALTH_SYNC_CONFIG]]);

    const lastPrefPushRef = useRef("");
    useEffect(() => {
        if (!prefSync) {
            onLocalPrefsChange(null);
            return;
        }
        let timer: number | undefined;
        const push = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const payload = JSON.stringify({ starred, tags });
                // 打开同步时星标/标签刚合并过一轮，内容一样就不必再写一次库
                if (payload === lastPrefPushRef.current) return;
                lastPrefPushRef.current = payload;
                void Promise.all([
                    api.setConfig(PREF_STARRED_CONFIG, JSON.stringify(starred)),
                    api.setConfig(PREF_TAGS_CONFIG, JSON.stringify(tags)),
                ]).catch(() => {});
            }, SYNC_DEBOUNCE_MS);
        };
        onLocalPrefsChange(push);
        return () => {
            onLocalPrefsChange(null);
            if (timer) window.clearTimeout(timer);
        };
    }, [prefSync, starred, tags]);

    useEffect(() => {
        // 先用上一次的快照把界面画出来（已登录才有意义，未登录要直接走登录页），
        // 真正的请求照常发出，回来后再覆盖一次
        if (api.isLoggedIn()) {
            const cached = readBootstrapCache();
            if (cached) {
                applyRemoteData(cached);
                setLoading(false);
            }
        }

        // 检查认证状态
        checkAuthStatus();

        // 确保初始化时重置排序状态
        setSortMode(SortMode.None);
        setCurrentSortingGroupId(null);
    }, []);

    // 设置文档标题
    useEffect(() => {
        document.title = configs["site.title"] || "导航站";
    }, [configs]);

    // 应用自定义CSS
    useEffect(() => {
        const customCss = configs["site.customCss"];
        let styleElement = document.getElementById("custom-style");

        if (!styleElement) {
            styleElement = document.createElement("style");
            styleElement.id = "custom-style";
            document.head.appendChild(styleElement);
        }

        // 添加安全过滤，防止CSS注入攻击
        const sanitizedCss = sanitizeCSS(customCss || "");
        styleElement.textContent = sanitizedCss;
    }, [configs]);

    // CSS安全过滤函数
    const sanitizeCSS = (css: string): string => {
        if (!css) return "";

        // 移除可能导致XSS的内容
        return (
            css
                // 移除包含javascript:的URL
                .replace(/url\s*\(\s*(['"]?)javascript:/gi, "url($1invalid:")
                // 移除expression
                .replace(/expression\s*\(/gi, "invalid(")
                // 移除import
                .replace(/@import/gi, "/* @import */")
                // 移除behavior
                .replace(/behavior\s*:/gi, "/* behavior: */")
                // 过滤content属性中的不安全内容
                .replace(/content\s*:\s*(['"]?).*?url\s*\(\s*(['"]?)javascript:/gi, "content: $1")
        );
    };

    // 同步HTML的class以保持与现有CSS兼容
    useEffect(() => {
        if (darkMode) {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
    }, [darkMode]);

    // 把主色同步成 CSS 变量，供原生 CSS（如搜索高亮）跟随主题
    useEffect(() => {
        const root = document.documentElement;
        if (accent) {
            root.style.setProperty("--accent", accent);
        } else {
            // 清空后回退到 index.css 里亮/暗各自的默认值
            root.style.removeProperty("--accent");
        }
    }, [accent]);

    // 毛玻璃强度：0 表示关掉模糊（纯半透明），留空/非法值用默认 14px
    // 注意 Number("") === 0，所以必须先排除空字符串，否则默认配置会被算成「关闭模糊」
    const glassBlurRaw = configs["site.glassBlur"];
    const glassBlurParsed = Number(glassBlurRaw);
    const glassBlur =
        glassBlurRaw === undefined || glassBlurRaw === "" || !Number.isFinite(glassBlurParsed)
            ? 14
            : Math.min(24, Math.max(0, glassBlurParsed));
    useEffect(() => {
        document.documentElement.style.setProperty("--glass-blur", `${glassBlur}px`);
    }, [glassBlur]);

    // 毛玻璃总开关：打开时保持上面的 --glass-blur；关掉时给根节点挂 .nav-no-glass，
    // 由 index.css 统一摘掉 backdrop-filter 并换成接近不透明的底色。
    // 之前这里做的是「滚动时把模糊降到 1/3」——实测收益有限，但每次滚动都会让所有毛玻璃层
    // 重新采样背景，边缘反而更容易露出黑边，所以回退了，改成让用户自己决定要不要这层特效。
    useEffect(() => {
        document.documentElement.classList.toggle("nav-no-glass", !glassEffects);
    }, [glassEffects]);

    // 统一提示函数（引用稳定，便于被 memo 的子组件复用）
    // duration 可选：成功/信息类默认短暂停留 2.2s，错误类默认 6s（便于阅读），传入则覆盖
    // action 可选：在提示条上挂一个操作按钮（删除后的「撤销」就靠它）
    // 处理错误的函数
    const handleError = useCallback(
        (errorMessage: string) => {
            // 离线队列已接住的操作：温和不报错，告诉用户会在联网后自动同步即可
            const isOfflineQueued = errorMessage.includes("离线保存") || errorMessage.includes("OfflineQueued");
            notify(errorMessage, isOfflineQueued ? "info" : "error");
            if (!isOfflineQueued) console.error(errorMessage);
            reportError(errorMessage, { source: "save-error" });
        },
        [notify]
    );

    // PWA：把浏览器给的安装机会存下来，用户点「安装到桌面」时才弹原生安装框
    const { canInstall, promptInstall } = usePwaInstall();
    const handleInstallApp = useCallback(async () => {
        const accepted = await promptInstall();
        notify(accepted ? "已装到桌面，下次从桌面图标打开就行" : "已取消安装", accepted ? "success" : "info");
    }, [promptInstall, notify]);

    // ---- 撤销 / 重做 ----
    // 每个破坏性操作做完就往栈里压一条「怎么把自己倒回去」的记录，
    // 提示条上的「撤销」按钮和 Ctrl+Z 走同一份逻辑，所以能连续撤好几步。
    const {
        push: pushHistory,
        undo: undoHistory,
        redo: redoHistory,
        hydrate: hydrateHistory,
        canUndo,
        canRedo,
    } = useHistoryStack();

    /**
     * 刷新之后把上次留下的「可重放」撤销记录捞回来（见 utils/undoPersist）。
     *
     * 只恢复此刻还存在的卡片：中间已经被删掉 / 恢复过的，再写回去只会造出一张
     * 谁都不认识的脏卡片。删卡片不走这条路 —— 它有回收站兜底，那才是跨刷新的正解。
     */
    const restorePersistedUndo = useCallback(() => {
        const list = loadPersistedUndo();
        if (list.length === 0) return;
        hydrateHistory(list, item => {
            const stillThere = groupsRef.current.some(group =>
                group.sites.some(site => site.id === item.siteId)
            );
            if (!stillThere) return null;

            const apply = async (site: Site) => {
                await api.updateSite(item.siteId, { ...site, id: item.siteId });
                upsertSiteLocally({ ...site, id: item.siteId });
            };
            return {
                label: item.label,
                undo: () => apply(item.before),
                redo: () => apply(item.after),
                persist: item,
            };
        });
    }, [hydrateHistory, upsertSiteLocally, api]);

    // 数据第一次到位后恢复一次：早于这时候 groupsRef 还是空的，校验会全判成「卡片不在了」
    const restoredUndoRef = useRef(false);
    useEffect(() => {
        if (restoredUndoRef.current) return;
        if (groups.length === 0) return;
        restoredUndoRef.current = true;
        restorePersistedUndo();
    }, [groups, restorePersistedUndo]);
    const runUndo = useCallback(async () => {
        if (!undoHistory) return;
        try {
            const label = await undoHistory();
            notify(label ? `已撤销：${label}` : "没有可撤销的操作", label ? "success" : "info");
        } catch {
            notify("撤销失败", "error");
        }
    }, [undoHistory, notify]);
    const runRedo = useCallback(async () => {
        try {
            const label = await redoHistory();
            notify(label ? `已重做：${label}` : "没有可重做的操作", label ? "success" : "info");
        } catch {
            notify("重做失败", "error");
        }
    }, [redoHistory, notify]);

    // 拉取全量数据：一次 bootstrap 请求搞定（原来要 1 次分组 + 每个分组一次站点 + 1 次配置）
    // silent=true 时不显示全屏 loading、不弹错误提示，用于修改后的后台同步
    // 离线期间入队的写入，恢复连接后自动重放；重放完顺手后台刷新一次本地数据
    useEffect(() => {
        installOnlineListener(api as unknown as MutationApi, (done) => {
            notify(`已恢复连接，自动同步了 ${done} 项离线改动`, "success");
            fetchData({ silent: true });
        });
    }, [notify]);

    // 启动时就绪：若联网且仍有上次离线排队的改动（典型场景：离线时排队 → 关标签页 →
    // 联网后重新打开），此刻浏览器已处于 online、不会再触发 online 事件，这里主动重放一次
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.onLine) return;
        if (pendingCount() === 0) return;
        flushOfflineQueue(api as unknown as MutationApi).then(done => {
            if (done > 0) {
                notify(`已自动同步 ${done} 项离线改动`, "success");
                fetchData({ silent: true });
            }
        });
    }, [notify]);

    // 本地状态更新（upsertSiteLocally / removeSiteLocally / removeSitesLocally）已搬进 useSites，
    // 数组怎么变这类纯计算在 utils/siteMutations.ts，那里能脱离 React 单测。
    // 关键点不变：只重建真正受影响的分组对象，其它分组保持原引用，
    // 这样被 memo 的 GroupCard / SiteCard 不会因为无关改动而重渲染。
    /** 滚到某张卡片并闪一下轮廓（重复链接提示里的「跳到那张」用） */
    const jumpToSite = useCallback((siteId?: number) => {
        if (siteId == null) return;
        requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>(`[data-site-id="${siteId}"]`);
            if (!el) return;
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            const prevOutline = el.style.outline;
            const prevOffset = el.style.outlineOffset;
            el.style.outline = "2px solid var(--accent)";
            el.style.outlineOffset = "3px";
            window.setTimeout(() => {
                el.style.outline = prevOutline;
                el.style.outlineOffset = prevOffset;
            }, 1800);
        });
    }, []);

    /**
     * 重复网址守卫：新增 / 改链接时先看这张链接是不是已经有了。
     * 没撞车就直接执行 run；撞了先弹确认，用户点「仍然添加」才继续。
     * 返回 true 表示已经直接执行。
     */
    const guardDuplicate = useCallback(
        (url: string | undefined, excludeId: number | undefined, run: () => void | Promise<void>) => {
            const hit = findDuplicateSite(groupsRef.current, url, excludeId);
            if (!hit) {
                void run();
                return true;
            }
            setDupPrompt({ url: url || "", hit, run });
            return false;
        },
        []
    );

    // 更新站点：保存成功后直接用（本地这份 + 服务端回显）更新本地状态，界面即时生效，不再刷新页面
    const handleSiteUpdate = useCallback(
        async (siteInput: Site) => {
            // 网址规范化：不写协议时补 https://，javascript: 之类的伪协议直接挡掉
            // （编辑站点这条路径同样不走 type=url 校验，见 utils/url.ts 的说明）
            const urlCheck = normalizeUrl(siteInput.url || "");
            if (!urlCheck.ok) {
                handleError(normalizeFailureText(urlCheck.reason));
                return;
            }
            const updatedSite: Site = { ...siteInput, url: urlCheck.url };
            if (!updatedSite.id) return;

            const doUpdate = async () => {
                // 改之前先留一份快照，请求失败时用它把卡片改回去
                const snapshot =
                    groupsRef.current
                        .flatMap(group => group.sites)
                        .find(site => site.id === updatedSite.id) || null;

                // 乐观更新：不等网络往返就先改本地、弹提示，
                // 实测一次保存端到端 336ms 里有 311ms 是网络等待，没必要让界面陪着等
                upsertSiteLocally(updatedSite);
                notify("卡片已更新", "success");

                const siteId = updatedSite.id as number;

                try {
                    const saved = await api.updateSite(siteId, updatedSite);
                    // id 以本地这份为准，避免个别后端实现回显的 id 不准确
                    if (saved) {
                        upsertSiteLocally({ ...updatedSite, ...saved, id: updatedSite.id });
                    }

                    // 改卡片也能撤销：Ctrl+Z 或提示条上的「撤销」把它改回原样。
                    // 顺带记一份持久化描述 —— 这是少数「靠数据就能倒回去」的操作，
                    // 刷新之后照样能撤（删除不走这条，回收站已经兜住了）。
                    if (snapshot && snapshot.id !== undefined) {
                        const label = `修改「${snapshot.name || updatedSite.name || "该网站"}」`;
                        const writeBack = async (site: Site) => {
                            await api.updateSite(siteId, { ...site, id: siteId });
                            upsertSiteLocally({ ...site, id: siteId });
                        };
                        pushHistory({
                            label,
                            undo: () => writeBack(snapshot),
                            redo: () => writeBack(updatedSite),
                            persist: {
                                kind: "site-edit",
                                label,
                                at: Date.now(),
                                siteId,
                                before: snapshot,
                                after: updatedSite,
                            },
                        });
                    }
                } catch (error) {
                    console.error("更新站点失败:", error);
                    reportError(error, { source: "site-update" });
                    if (snapshot) upsertSiteLocally(snapshot);
                    handleError("更新站点失败: " + (error as Error).message);
                }
            };

            // 改完链接后跟别张卡片撞了，也先确认一次再写库
            guardDuplicate(updatedSite.url, updatedSite.id, doUpdate);
        },
        [upsertSiteLocally, handleError, notify, guardDuplicate, pushHistory]
    );

    // 删除站点：删完给一条带「撤销」的提示，8 秒内点一下就能把卡片原样建回来。
    // 删除是软删除（先进回收站），撤销优先「从回收站精确还原」原 id；
    // 拿不到回收站 id（如本地 mock 模式）时退回「按快照重建」。
    const handleSiteDelete = useCallback(
        async (siteId: number) => {
            const snapshot = groupsRef.current
                .flatMap(group => group.sites)
                .find(site => site.id === siteId);
            // 本机标签/星标先留一份快照：删除时要清掉它们，撤销时再挂到新卡片上
            const snapshotTags = tags[String(siteId)] ?? [];
            const wasStarred = starred.includes(siteId);
            try {
                const del = await api.deleteSite(siteId);
                const recycleId = del.recycleId;
                removeSiteLocally(siteId);
                // 卡片没了，它的标签/星标也就没有宿主，一并清掉，避免标签栏残留点不出来的标签
                forgetSites([siteId]);
                if (!snapshot) return;

                // 恢复：优先从回收站精确还原（保留原 id，标签/星标按 id 自动归位）；
                // 没有回收站 id 时退回「按快照重建」老路径。
                const restored: { id?: number } = {};
                const restore = async () => {
                    if (recycleId !== undefined) {
                        const ok = await api.restoreRecycleItem(recycleId);
                        if (ok) {
                            // 重新拉一份数据，被还原的卡片即刻回到原位置
                            await fetchData({ silent: true });
                            restored.id = snapshot.id;
                            return;
                        }
                        // 还原失败（已被清掉）则继续走重建
                    }
                    const created = await api.createSite({
                        ...snapshot,
                        id: undefined,
                    } as Site);
                    if (!created || created.id === undefined) throw new Error("重建站点失败");
                    upsertSiteLocally(created);
                    // 撤销是「原样恢复」，把标签与星标也挂回新 id 上
                    if (snapshotTags.length > 0) setSiteTags(created.id, snapshotTags);
                    if (wasStarred) setStarredMany([created.id], true);
                    restored.id = created.id;
                };
                const removeAgain = async () => {
                    if (recycleId !== undefined) {
                        // 撤销后「再删一次」= 把回收站里那一条彻底删除（不可恢复）
                        await api.purgeRecycleItem(recycleId);
                        return;
                    }
                    if (restored.id === undefined) return;
                    const id = restored.id;
                    restored.id = undefined;
                    await api.deleteSite(id);
                    removeSiteLocally(id);
                    forgetSites([id]);
                };

                const label = `删除「${snapshot.name || "该网站"}」`;
                // 压进操作栈后，即使提示条已经消失，Ctrl+Z 还能把卡片找回来
                pushHistory({ label, undo: restore, redo: removeAgain });
                notify(`已删除「${snapshot.name || "该网站"}」（可在回收站恢复）`, "info", 8000, {
                    label: "撤销",
                    onClick: () => void runUndo(),
                });
            } catch (error) {
                console.error("删除站点失败:", error);
                reportError(error, { source: "site-delete" });
                handleError("删除站点失败: " + (error as Error).message);
            }
        },
        [
            removeSiteLocally,
            upsertSiteLocally,
            handleError,
            notify,
            tags,
            starred,
            forgetSites,
            setSiteTags,
            setStarredMany,
            pushHistory,
            runUndo,
            fetchData,
        ]
    );

    // 批量删除站点（多选模式）：确认弹窗在底部操作条上（OverlayHost），确认后直接进这里。
    // 删除是软删除（先进回收站），撤销时优先从回收站精确还原。

    // 真正执行批量删除（确认后调用）
    const doSitesDelete = useCallback(
        async (siteIds: number[]) => {
            if (siteIds.length === 0) return;
            const snapshots = groupsRef.current
                .flatMap(group => group.sites)
                .filter(site => site.id !== undefined && siteIds.includes(site.id));

            if (snapshots.length === 0) return;

            // 本机标签/星标快照（按站点 id），删除时清掉、撤销时挂回新 id
            const prefsMap = new Map<number, { tags: string[]; starred: boolean }>();
            snapshots.forEach(site => {
                const id = site.id as number;
                prefsMap.set(id, {
                    tags: tags[String(id)] ?? [],
                    starred: starred.includes(id),
                });
            });

            try {
                const results = await Promise.all(
                    snapshots.map(site => api.deleteSite(site.id as number))
                );
                const recycleIds = results.map(r => r.recycleId).filter((x): x is number => x !== undefined);
                removeSitesLocally(snapshots.map(site => site.id as number));
                forgetSites(snapshots.map(site => site.id as number));

                const restoredIds: number[] = [];
                const restore = async () => {
                    if (recycleIds.length > 0) {
                        await Promise.all(recycleIds.map(id => api.restoreRecycleItem(id)));
                        await fetchData({ silent: true });
                        return;
                    }
                    // 没有回收站 id（如本地 mock）时退回按快照重建
                    const ordered = [...snapshots].sort(
                        (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                    );
                    restoredIds.length = 0;
                    for (const site of ordered) {
                        const created = await api.createSite({
                            ...site,
                            id: undefined,
                        } as Site);
                        if (created && created.id !== undefined) {
                            upsertSiteLocally(created);
                            restoredIds.push(created.id);
                            const prefs = prefsMap.get(site.id as number);
                            if (prefs) {
                                if (prefs.tags.length > 0) setSiteTags(created.id, prefs.tags);
                                if (prefs.starred) setStarredMany([created.id], true);
                            }
                        }
                    }
                };
                const removeAgain = async () => {
                    if (recycleIds.length > 0) {
                        await Promise.all(recycleIds.map(id => api.purgeRecycleItem(id)));
                        return;
                    }
                    const ids = [...restoredIds];
                    restoredIds.length = 0;
                    if (ids.length === 0) return;
                    await Promise.all(ids.map(id => api.deleteSite(id)));
                    removeSitesLocally(ids);
                    forgetSites(ids);
                };

                const label = `删除 ${snapshots.length} 个网站`;
                pushHistory({ label, undo: restore, redo: removeAgain });
                notify(`已删除 ${snapshots.length} 个网站（可在回收站恢复）`, "info", 8000, {
                    label: "撤销",
                    onClick: () => void runUndo(),
                });
            } catch (error) {
                console.error("批量删除站点失败:", error);
                reportError(error, { source: "site-bulk-delete" });
                handleError("批量删除站点失败: " + (error as Error).message);
            }
        },
        [
            removeSitesLocally,
            upsertSiteLocally,
            handleError,
            notify,
            tags,
            starred,
            forgetSites,
            setSiteTags,
            setStarredMany,
            pushHistory,
            runUndo,
            fetchData,
        ]
    );

    // ---- 批量操作（多选模式） ----
    // 加星 / 打标签 / 删标签 / 移动 / 删除：整组搬进了 useBulkActions，
    // App 这里只负责把依赖喂进去（纯搬迁，行为不变）。
    const { bulkStar, bulkTag, deleteTagWithUndo, bulkMove, bulkDelete } = useBulkActions({
        selectedIds,
        clearSelection,
        groupsRef,
        tags,
        api,
        setGroups,
        setActiveTags,
        setStarredMany,
        addTagsToMany,
        removeTagFromAll,
        setBulkDeleteOpen,
        doSitesDelete,
        notify,
        handleError,
    });

    // 更新分组（引用稳定，配合 GroupCard 的 memo 减少重渲染）
    const handleGroupUpdate = useCallback(
        async (updatedGroup: Group) => {
            try {
                if (updatedGroup.id) {
                    const saved = await api.updateGroup(updatedGroup.id, updatedGroup);
                    const nextGroup = saved && saved.id !== undefined ? saved : updatedGroup;
                    setGroups(prev => {
                        const idx = prev.findIndex(group => group.id === updatedGroup.id);
                        if (idx === -1) return prev;
                        const next = [...prev];
                        next[idx] = { ...prev[idx], ...nextGroup };
                        return next;
                    });
                }
            } catch (error) {
                console.error("更新分组失败:", error);
                reportError(error, { source: "group-update" });
                handleError("更新分组失败: " + (error as Error).message);
            }
        },
        [handleError]
    );

    // 删除分组：连同组内卡片一起删，所以撤销要把「分组 + 卡片」整组重建回来
    // 分组删除：先弹二次确认（含导出提示），确认后才真删。
    // 删除是软删除（先进回收站），撤销时优先从回收站精确还原。
    const [pendingGroupDelete, setPendingGroupDelete] = useState<number | null>(null);

    // 真正执行分组删除（确认后调用）
    const doGroupDelete = useCallback(
        async (groupId: number) => {
            const snapshot = groupsRef.current.find(group => group.id === groupId);
            // 分组里的卡片会跟着一起删，它们的本机标签/星标也先留一份快照
            const sitePrefs = new Map<number, { tags: string[]; starred: boolean }>();
            if (snapshot) {
                snapshot.sites.forEach(site => {
                    const id = site.id as number;
                    sitePrefs.set(id, {
                        tags: tags[String(id)] ?? [],
                        starred: starred.includes(id),
                    });
                });
            }
            try {
                const del = await api.deleteGroup(groupId);
                const recycleId = del.recycleId;
                setGroups(prev => {
                    const next = prev.filter(group => group.id !== groupId);
                    return next.length === prev.length ? prev : next;
                });
                // 组内卡片的标签/星标随卡片一起清掉，避免孤儿标签残留在标签栏
                if (snapshot) forgetSites(snapshot.sites.map(site => site.id as number));
                if (!snapshot) return;

                const restoredGroupId: { id?: number } = {};
                const restoredSiteIds: number[] = [];
                const restore = async () => {
                    if (recycleId !== undefined) {
                        const ok = await api.restoreRecycleItem(recycleId);
                        if (ok) {
                            await fetchData({ silent: true });
                            restoredGroupId.id = snapshot.id;
                            return;
                        }
                    }
                    const created = await api.createGroup({
                        name: snapshot.name,
                        order_num: snapshot.order_num ?? 0,
                    } as Group);
                    const newId = created?.id;
                    if (newId === undefined) throw new Error("重建分组失败");
                    restoredGroupId.id = newId;

                    // 卡片按原顺序重建，分组位置也按 order_num 插回原处
                    const restored: Site[] = [];
                    const ordered = [...snapshot.sites].sort(
                        (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                    );
                    restoredSiteIds.length = 0;
                    for (const site of ordered) {
                        const createdSite = await api.createSite({
                            ...site,
                            id: undefined,
                            group_id: newId,
                        } as Site);
                        if (createdSite && createdSite.id !== undefined) {
                            restored.push(createdSite);
                            restoredSiteIds.push(createdSite.id);
                            const prefs = sitePrefs.get(site.id as number);
                            if (prefs) {
                                if (prefs.tags.length > 0) setSiteTags(createdSite.id, prefs.tags);
                                if (prefs.starred) setStarredMany([createdSite.id], true);
                            }
                        }
                    }

                    setGroups(prev =>
                        [...prev, { ...created, id: newId, sites: restored }].sort(
                            (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                        )
                    );
                };
                const removeAgain = async () => {
                    if (recycleId !== undefined) {
                        await api.purgeRecycleItem(recycleId);
                        return;
                    }
                    const groupIdToRemove = restoredGroupId.id;
                    restoredGroupId.id = undefined;
                    if (groupIdToRemove === undefined) return;
                    await api.deleteGroup(groupIdToRemove);
                    setGroups(prev => prev.filter(g => g.id !== groupIdToRemove));
                    if (restoredSiteIds.length) {
                        forgetSites([...restoredSiteIds]);
                        restoredSiteIds.length = 0;
                    }
                };

                const label = `删除分组「${snapshot.name}」`;
                pushHistory({ label, undo: restore, redo: removeAgain });
                notify(
                    `已删除分组「${snapshot.name}」${snapshot.sites.length ? `及 ${snapshot.sites.length} 张卡片（可在回收站恢复）` : ""}`,
                    "info",
                    8000,
                    {
                        label: "撤销",
                        onClick: () => void runUndo(),
                    }
                );
            } catch (error) {
                console.error("删除分组失败:", error);
                reportError(error, { source: "group-delete" });
                handleError("删除分组失败: " + (error as Error).message);
            }
        },
        [
            handleError,
            notify,
            tags,
            starred,
            forgetSites,
            setSiteTags,
            setStarredMany,
            pushHistory,
            runUndo,
            fetchData,
        ]
    );

    // 入口：先确认再删（分组删除会连带清空其下所有卡片，误删代价大）
    const handleGroupDelete = useCallback((groupId: number) => {
        setPendingGroupDelete(groupId);
    }, []);

    // 保存分组排序
    const handleSaveGroupOrder = async () => {
        try {
            // 构造需要更新的分组顺序数据
            const groupOrders = groupsRef.current.map((group, index) => ({
                id: group.id as number,
                order_num: index,
            }));

            // 一次批量请求写入全部顺序
            const result = await api.updateGroupOrder(groupOrders);

            if (!result) {
                throw new Error("分组排序更新失败");
            }

            // 本地顺序就是拖拽后的结果，补一下 order_num 即可，不再多发一次全量刷新请求
            setGroups(prev => prev.map((group, index) => ({ ...group, order_num: index })));

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("更新分组排序失败:", error);
            reportError(error, { source: "group-reorder" });
            handleError("更新分组排序失败: " + (error as Error).message);
        }
    };

    // 保存站点排序（单组保存）
    const handleSaveSiteOrder = useCallback(
        async (groupId: number, sites: Site[]) => {
            try {
                // 构造需要更新的站点顺序数据
                const siteOrders = sites.map((site, index) => ({
                    id: site.id as number,
                    order_num: index,
                }));

                // 一次批量请求写入全部顺序
                const result = await api.updateSiteOrder(siteOrders);

                if (!result.success) {
                    throw new Error(
                        result.failed.length > 0
                            ? `站点排序更新失败（${result.failed.length} 个未生效，刷新后重试）`
                            : "站点排序更新失败"
                    );
                }

                // 本地即服务端结果，补齐 order_num；只重建这一个分组，其它分组保持原引用
                const orderMap = new Map(siteOrders.map(item => [item.id, item.order_num]));
                setGroups(prev => {
                    const idx = prev.findIndex(g => g.id === groupId);
                    if (idx === -1) return prev;
                    const next = [...prev];
                    next[idx] = {
                        ...prev[idx],
                        sites: prev[idx].sites
                            .map(site => {
                                const order = orderMap.get(site.id as number);
                                return order === undefined ? site : { ...site, order_num: order };
                            })
                            .sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)),
                    };
                    return next;
                });

                setSortMode(SortMode.None);
                setCurrentSortingGroupId(null);
            } catch (error) {
                console.error("更新站点排序失败:", error);
                reportError(error, { source: "site-reorder" });
                handleError("更新站点排序失败: " + (error as Error).message);
            }
        },
        [handleError]
    );

    // 启动分组排序
    const startGroupSort = useCallback(() => {
        // 必须先关掉「更多选项」菜单：进入排序模式后该按钮会被卸载，
        // 菜单失去 anchor 元素就会跑到页面左上角
        handleMenuClose();
        setSortMode(SortMode.GroupSort);
        setCurrentSortingGroupId(null);
    }, []);

    // 启动站点排序
    const startSiteSort = useCallback((groupId: number) => {
        setSortMode(SortMode.SiteSort);
        setCurrentSortingGroupId(groupId);
        // 记录每个站点当前的原始分组，用于保存时识别跨组移动
        const map = new Map<number, number>();
        groupsRef.current.forEach(g => {
            g.sites.forEach(s => {
                if (s.id !== undefined) map.set(s.id, g.id as number);
            });
        });
        siteOriginalGroupRef.current = map;
    }, []);

    // 取消排序
    const cancelSort = useCallback(() => {
        setSortMode(SortMode.None);
        setCurrentSortingGroupId(null);
    }, []);

    // 处理拖拽结束事件
    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;

        if (!over || active.id === over.id) return;

        setGroups(prev => {
            const oldIndex = prev.findIndex(group => group.id.toString() === active.id);
            const newIndex = prev.findIndex(group => group.id.toString() === over.id);

            if (oldIndex === -1 || newIndex === -1) return prev;
            return arrayMove(prev, oldIndex, newIndex);
        });
    }, []);

    // 站点跨分组拖拽：同一分组内重排，跨分组则把卡片移动到目标分组
    // 注意：只重建受影响的分组对象，其它分组保持原引用，避免拖拽时全量卡片重渲染
    const moveSiteAcrossGroups = useCallback((activeId: string, overId: string) => {
        if (!overId || activeId === overId) return;
        if (!activeId.startsWith("site-")) return;

        const activeSiteId = Number(activeId.slice("site-".length));
        const overSiteId = overId.startsWith("site-") ? Number(overId.slice("site-".length)) : undefined;
        const overGroupId = overId.startsWith("group-") ? Number(overId.slice("group-".length)) : undefined;

        setGroups(prev => {
            const activeContainerIdx = prev.findIndex(g => g.sites.some(s => s.id === activeSiteId));
            if (activeContainerIdx === -1) return prev;

            let overContainerIdx: number;
            let overIndex: number;
            if (overSiteId !== undefined) {
                overContainerIdx = prev.findIndex(g => g.sites.some(s => s.id === overSiteId));
                if (overContainerIdx === -1) return prev;
                overIndex = prev[overContainerIdx].sites.findIndex(s => s.id === overSiteId);
                if (overIndex === -1) return prev;
            } else if (overGroupId !== undefined) {
                overContainerIdx = prev.findIndex(g => g.id === overGroupId);
                if (overContainerIdx === -1) return prev;
                overIndex = prev[overContainerIdx].sites.length;
            } else {
                return prev;
            }

            const moved = prev[activeContainerIdx].sites.find(s => s.id === activeSiteId);
            if (!moved) return prev;

            // 同一分组内重排：只克隆这一个分组
            if (activeContainerIdx === overContainerIdx) {
                const c = activeContainerIdx;
                const siteList = prev[c].sites;
                const oldIndex = siteList.findIndex(s => s.id === activeSiteId);
                const newIndex = Math.min(overIndex, siteList.length - 1);
                // 位置没变化就直接返回原状态：拖拽时的 dragOver 会高频触发
                if (oldIndex === -1 || oldIndex === newIndex) return prev;

                const next = [...prev];
                next[c] = { ...prev[c], sites: arrayMove(siteList, oldIndex, newIndex) };
                return next;
            }

            // 跨分组移动：只改来源分组和目标分组两个对象
            const next = [...prev];
            const movedSite = { ...moved, group_id: prev[overContainerIdx].id as number };
            next[activeContainerIdx] = {
                ...prev[activeContainerIdx],
                sites: prev[activeContainerIdx].sites.filter(s => s.id !== activeSiteId),
            };
            const target = prev[overContainerIdx].sites;
            const insertIdx = Math.min(overIndex, target.length);
            next[overContainerIdx] = {
                ...prev[overContainerIdx],
                sites: [...target.slice(0, insertIdx), movedSite, ...target.slice(insertIdx)],
            };
            return next;
        });
    }, []);

    const handleSiteSortDragOver = useCallback(
        (event: DragOverEvent) => {
            const { active, over } = event;
            if (!over) return;
            moveSiteAcrossGroups(String(active.id), String(over.id));
        },
        [moveSiteAcrossGroups]
    );

    const handleSiteSortDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over) return;
            moveSiteAcrossGroups(String(active.id), String(over.id));
        },
        [moveSiteAcrossGroups]
    );

    // 拖拽视觉反馈：被拖起的卡片用浮层跟着指针走，原位留半透明占位
    const [draggingSite, setDraggingSite] = useState<Site | null>(null);
    const handleSiteDragStart = useCallback((event: DragStartEvent) => {
        const id = String(event.active.id);
        if (!id.startsWith("site-")) return;
        const siteId = Number(id.slice(5));
        const found = groupsRef.current.flatMap(g => g.sites).find(s => s.id === siteId);
        setDraggingSite(found ?? null);
    }, []);
    const handleSiteDragCancel = useCallback(() => setDraggingSite(null), []);

    // 保存站点排序（支持跨分组移动）
    // 顺序调整 + 跨组移动合并成「一次」批量请求：
    // 原来是「1 次排序 + 每移动一张卡片一次串行更新请求」，卡片多时保存会明显变慢。
    const handleSaveSiteSort = useCallback(async () => {
        try {
            const orders: { id: number; order_num: number; group_id?: number }[] = [];
            const original = siteOriginalGroupRef.current;

            groupsRef.current.forEach(g => {
                g.sites.forEach((site, idx) => {
                    const id = site.id as number;
                    const fromGroup = original.get(id);
                    const moved = fromGroup !== undefined && fromGroup !== g.id;
                    orders.push(
                        moved ? { id, order_num: idx, group_id: g.id as number } : { id, order_num: idx }
                    );
                });
            });

            if (orders.length > 0) {
                const result = await api.updateSiteOrder(orders);
                if (!result.success) {
                    throw new Error(
                        result.failed.length > 0
                            ? `更新排序失败（${result.failed.length} 个未生效，刷新后重试）`
                            : "更新排序失败"
                    );
                }
            }

            // 本地补齐 order_num / group_id，与服务端保持一致，无需再拉一次全量数据
            const orderMap = new Map(orders.map(item => [item.id, item]));
            setGroups(prev =>
                prev.map(g => ({
                    ...g,
                    sites: g.sites.map(site => {
                        const item = orderMap.get(site.id as number);
                        if (!item) return site;
                        return { ...site, order_num: item.order_num, group_id: g.id as number };
                    }),
                }))
            );

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("保存站点排序失败:", error);
            reportError(error, { source: "site-order-save" });
            handleError("保存站点排序失败: " + (error as Error).message);
        }
    }, [handleError]);

    // 新增分组相关函数
    const handleOpenAddGroup = () => {
        handleMenuClose();
        setOpenAddGroup(true);
    };

    const handleCloseAddGroup = () => {
        setOpenAddGroup(false);
    };

    const handleCreateGroup = async (name: string) => {
        try {
            const groupName = (name || "").trim();
            if (!groupName) {
                handleError("分组名称不能为空");
                return;
            }

            const created = await api.createGroup({
                name: groupName,
                order_num: groupsRef.current.length,
            } as Group);
            // 服务端返回新建分组，直接追加到本地列表，无需重新加载
            if (created && created.id !== undefined) {
                setGroups(prev => [...prev, { ...created, id: created.id as number, sites: [] }]);
            }
            handleCloseAddGroup();
        } catch (error) {
            console.error("创建分组失败:", error);
            reportError(error, { source: "group-create" });
            handleError("创建分组失败: " + (error as Error).message);
        }
    };

    // 新增站点相关函数
    const handleOpenAddSite = useCallback((groupId: number) => {
        const group = groupsRef.current.find(g => g.id === groupId);
        const maxOrderNum = group?.sites.length
            ? Math.max(...group.sites.map(s => s.order_num)) + 1
            : 0;

        setNewSite({
            name: "",
            url: "",
            icon: "",
            description: "",
            notes: "",
            username: "",
            password: "",
            group_id: groupId,
            order_num: maxOrderNum,
        });

        // 每次打开都从「密码隐藏」状态开始，并清掉上一次的提交锁
        setShowNewSitePassword(false);
        creatingSiteRef.current = false;
        setCreatingSite(false);
        setOpenAddSite(true);
    }, []);

    const handleCloseAddSite = () => {
        setOpenAddSite(false);
    };

    const handleSiteInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        // 账号/密码框的 name 为避浏览器识别改叫 site-account / site-secret，
        // 状态里的键仍是 username / password（见 utils/secretInput.ts）
        const key = formDataKey(name);

        setNewSite(prev => {
            const next: Partial<Site> = { ...prev, [key]: value };

            // 填「站点URL」时自动按「获取图标API」生成图标URL。
            // 只有图标为空、或图标仍是自动生成的值时才覆盖，用户手填过的图标不会被冲掉。
            if (name === "url") {
                const autoIcon = resolveIconApiUrl(configs["site.iconApi"], value);
                const prevAutoIcon = resolveIconApiUrl(configs["site.iconApi"], prev.url || "");
                if (!prev.icon || prev.icon === prevAutoIcon) {
                    next.icon = autoIcon;
                }
            }

            return next;
        });
    };

    // 新增站点时：让服务端去抓目标页面的标题 / 描述，一键补全
    // （浏览器直接 fetch 第三方页面会被 CORS 挡住，所以走 worker 的 /api/meta）
    const handleFetchNewSiteMeta = async () => {
        if (fetchingMetaRef.current) return;

        const target = normalizeUrl(newSite.url || "");
        if (!target.ok) {
            handleError(normalizeFailureText(target.reason));
            return;
        }

        fetchingMetaRef.current = true;
        setFetchingMeta(true);
        try {
            const meta = await api.getSiteMeta(target.url);
            setNewSite(prev => ({
                ...prev,
                // 顺手把规范化后的网址写回输入框，用户填的 baidu.com 会立刻变成 https://baidu.com
                url: target.url,
                name: prev.name || meta.title || "",
                description: prev.description || meta.description || "",
                icon:
                    prev.icon ||
                    meta.icon ||
                    resolveIconApiUrl(configs["site.iconApi"], target.url),
            }));
            notify(
                meta.title ? "已抓取站点名称与描述" : "这个站点没给标题，手动填一下吧",
                meta.title ? "success" : "info"
            );
        } catch (error) {
            handleError("抓取站点信息失败：" + (error as Error).message);
        } finally {
            fetchingMetaRef.current = false;
            setFetchingMeta(false);
        }
    };

    // 新增站点时：按配置的图标 API 一键生成图标 URL
    const handleFetchNewSiteIcon = () => {
        const resolved = resolveIconApiUrl(configs["site.iconApi"], newSite.url || "");
        if (!resolved) {
            handleError("请先填写有效的站点URL，再获取图标");
            return;
        }
        setNewSite(prev => ({ ...prev, icon: resolved }));
        notify("已根据站点链接生成图标URL", "success");
    };

    const handleCreateSite = async () => {
        // 连点「创建」只提交一次，避免创建出多张重复卡片
        if (creatingSiteRef.current) return;
        creatingSiteRef.current = true;
        setCreatingSite(true);

        const release = () => {
            creatingSiteRef.current = false;
            setCreatingSite(false);
        };

        if (!newSite.name || !newSite.url) {
            handleError("站点名称和URL不能为空");
            release();
            return;
        }

        // 网址规范化：补上 https://、挡掉 javascript: 这类危险协议。
        // <input type="url"> 拦得住 baidu.com 却放行 javascript:alert(1)（实测 Chrome 行为），
        // 而卡片是 href={site.url} 直出的，所以入库前必须自己过一道。
        const urlCheck = normalizeUrl(newSite.url || "");
        if (!urlCheck.ok) {
            handleError(normalizeFailureText(urlCheck.reason));
            release();
            return;
        }
        const siteToCreate = { ...newSite, url: urlCheck.url } as Site;

        const doCreate = async () => {
            try {
                const created = await api.createSite(siteToCreate);
                // 服务端返回新建站点，直接插入本地列表，界面立即出现新卡片（无需刷新页面）
                if (created && created.id !== undefined) {
                    upsertSiteLocally(created);
                }
                handleCloseAddSite();
                notify("卡片已添加", "success");
            } catch (error) {
                console.error("创建站点失败:", error);
                handleError("创建站点失败: " + (error as Error).message);
            } finally {
                release();
            }
        };

        // 同一条链接已经加过就先问一句，用户确认「仍然添加」才真的写库
        if (!guardDuplicate(siteToCreate.url, undefined, doCreate)) release();
    };

    // 配置相关函数
    const handleOpenConfig = () => {
        handleMenuClose();
        setTempConfigs({ ...configs });
        // 管理员凭据每次打开都重新填，避免误存上一次的输入
        setAuthUsername("");
        setAuthCurrentPassword("");
        setAuthNewPassword("");
        setOpenConfig(true);
    };

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
            handleLogout();
            setError("账号或密码已更新，请使用新凭据重新登录");
        } catch (error) {
            console.error("保存账号密码失败:", error);
            handleError("保存账号密码失败: " + (error as Error).message);
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

    // 毛玻璃强度：临时值为空/非法时按默认 14 显示
    const tempGlassBlur = (() => {
        const raw = tempConfigs["site.glassBlur"];
        const n = Number(raw);
        if (raw === undefined || raw === "" || !Number.isFinite(n)) return 14;
        return Math.min(24, Math.max(0, n));
    })();

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
            console.error("保存配置失败:", error);
            handleError("保存配置失败: " + (error as Error).message);
        } finally {
            savingConfigRef.current = false;
            setSavingConfig(false);
        }
    };

    // 打开备份对话框（0=备份，1=恢复）
    const handleOpenBackup = (tab = 0) => {
        setBackupTab(tab);
        setOpenBackup(true);
        handleMenuClose();
    };

    const handleCloseBackup = () => {
        setOpenBackup(false);
    };

    // 最近一次定时任务（每周自动备份 / 死链巡检）的失败留痕，没有就是 null。
    // 定时任务跑在 Worker 里，失败了页面上毫无动静，只能靠启动时提示一句 +
    // 备份弹窗里常驻一条 —— 否则「自动备份其实早就不工作了」要等到真要恢复那天才发现。
    const cronError = useMemo(() => {
        for (const task of ["backup", "linkSweep"]) {
            const raw = configs[`${CRON_LAST_ERROR_KEY}.${task}`];
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as {
                    task?: string;
                    message?: string;
                    at?: string;
                };
                if (parsed && typeof parsed.message === "string" && parsed.message) {
                    return { task: parsed.task || task, message: parsed.message, at: parsed.at };
                }
            } catch {
                // 留痕本身坏了就当没留过，别因为一行坏数据把弹窗搞崩
            }
        }
        return null;
    }, [configs]);

    // 启动后提示一次（同一条不重复弹）：定时任务失败不是用户当下的操作引起的，
    // 不提示的话他根本不会知道要去看一眼备份设置
    const cronErrorNotifiedRef = useRef<string>("");
    useEffect(() => {
        if (!cronError) return;
        if (cronErrorNotifiedRef.current === cronError.message) return;
        cronErrorNotifiedRef.current = cronError.message;
        notify(
            `${cronError.task === "backup" ? "每周自动备份" : "死链巡检"}未成功：${
                cronError.message
            }`,
            "error",
            8000
        );
    }, [cronError, notify]);

    // 构造完整备份数据（分组 + 站点（含账号密码）+ 网站配置 + 本机星标/标签）
    const buildExportData = (): ExportData => {
        // 全站设置（标题 / 主题 / 背景…）是所有账号共用的，只有站点所有者（或未启用
        // 登录的单账号部署）才写进备份文件：否则这份备份被别的账号恢复时，会把整站
        // 外观一起改掉。按账号隔离的那批（webdav.*）属敏感配置，一律不进备份。
        const mayExportShared = !currentUser || currentUser.role === "owner";
        const sharedConfigs: Record<string, string> = {};
        Object.entries(configs).forEach(([key, value]) => {
            // 敏感配置（WebDAV 凭据）和「服务端镜像」类的大块数据（失效记录、星标标签）
            // 都不写进备份文件，规则统一在 isSecretConfigKey 里维护
            if (!isSecretConfigKey(key)) {
                sharedConfigs[key] = value;
            }
        });

        // 普通账号：外观（标题 / 背景 / 主题色…）是自己那份，也要跟着备份走。
        // 所有者那份本来就是全站 configs，已经进了 sharedConfigs，不重复写。
        const ownConfigs: Record<string, string> = {};
        if (!mayExportShared) {
            Object.entries(configs).forEach(([key, value]) => {
                if (!isSecretConfigKey(key) && isPerUserAppearanceKey(key)) {
                    ownConfigs[key] = value;
                }
            });
        }

        return {
            groups: groups.map(group => ({
                id: group.id,
                name: group.name,
                order_num: group.order_num,
            })),
            sites: groups.flatMap(group =>
                group.sites.map(site => ({
                    ...site,
                    // 与后端 /api/export、每周定时备份用同一个开关：
                    // 关掉之后导出文件里不带网站账号密码
                    ...(configs[BACKUP_CREDENTIALS_CONFIG] === "true"
                        ? {}
                        : { username: "", password: "" }),
                }))
            ),
            // 全站设置（标题 / 主题 / 背景…）：所有者写进 sharedConfigs（恢复时会覆盖全站），
            // 普通账号只带自己那份外观，不会把整站长什么样改掉。
            configs: ownConfigs,
            ...(mayExportShared ? { sharedConfigs } : {}),
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            // 星标 / 标签只存在本机，数据库里没有对应字段，所以由前端附带进备份文件
            localPrefs: {
                starred: [...starred],
                tags: { ...tags },
            },
        };
    };

    // 备份到本地：下载备份文件。传了口令就用它加密后再落盘（明文 JSON 会带着站点
    // 密码直接躺在磁盘 / 网盘同步目录里），不传则维持原来的明文 JSON（兼容老备份）。
    const handleDownloadLocal = async (password?: string) => {
        try {
            // 摘要在「写文件前的最后一刻」才算：这份数据里带着本机星标 / 标签（localPrefs），
            // 服务端那份 exportData 不知道它，早算一步就会对不上
            const dataStr = JSON.stringify(await withBackupIntegrity(buildExportData()), null, 2);
            const stamp = new Date().toISOString().slice(0, 10);

            let blob: Blob;
            let exportFileName: string;
            if (password) {
                const bytes = await encryptBackup(new TextEncoder().encode(dataStr), password);
                blob = new Blob([bytes], { type: "application/octet-stream" });
                // 换后缀：加密文件已经不是 JSON 了，用 .navihive 免得被当文本打开
                exportFileName = `导航站备份_${stamp}.navihive`;
            } else {
                blob = new Blob([dataStr], { type: "application/json;charset=utf-8" });
                exportFileName = `导航站备份_${stamp}.json`;
            }

            const url = URL.createObjectURL(blob);

            const linkElement = document.createElement("a");
            linkElement.setAttribute("href", url);
            linkElement.setAttribute("download", exportFileName);
            document.body.appendChild(linkElement);
            linkElement.click();
            document.body.removeChild(linkElement);
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            console.error("导出数据失败:", error);
            handleError("导出数据失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    };

    // 保存 WebDAV 配置到服务端
    const handleSaveWebdavConfig = async (config: WebDavConfig) => {
        try {
            // 原来 5 个 setConfig 串行 = 5 次网络往返，网络慢时能把「连接成功」的反馈一起拖住。
            // 两个口令必须单独写（setConfig 会用 AUTH_SECRET 加密落库，批量接口不会），
            // 其余 4 项一次写完。
            await api.setConfigs({
                [`${WEBDAV_CONFIG_PREFIX}url`]: config.url,
                [`${WEBDAV_CONFIG_PREFIX}username`]: config.username,
                [`${WEBDAV_CONFIG_PREFIX}path`]: config.path || DEFAULT_WEBDAV_CONFIG.path,
                [`${WEBDAV_CONFIG_PREFIX}allowPrivateNetwork`]: config.allowPrivateNetwork ? "1" : "0",
            });
            // 两个口令都「写了才存、清空就删」：
            // worker 的 configs/{key} PUT 会拒绝空值（validateConfig 要求 value 非空），
            // 写空串会直接 400 —— 而备份口令是可选的，留空才是常态，所以清空必须走 DELETE。
            if (config.password) {
                await api.setConfig(`${WEBDAV_CONFIG_PREFIX}password`, config.password);
            } else {
                await api.deleteConfig(`${WEBDAV_CONFIG_PREFIX}password`);
            }
            // 备份口令单独存（落库加密），定时备份与恢复都靠它，与 AUTH_SECRET 无关
            if (config.backupPassword) {
                await api.setConfig(
                    `${WEBDAV_CONFIG_PREFIX}backupPassword`,
                    config.backupPassword
                );
            } else {
                await api.deleteConfig(`${WEBDAV_CONFIG_PREFIX}backupPassword`);
            }
            setWebdavConfig(config);
        } catch (error) {
            console.error("保存 WebDAV 配置失败:", error);
            handleError("保存 WebDAV 配置失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    // 每周自动备份开关（存在服务器，定时备份由 Worker 的 Cron 触发）
    // 注意顺序：先翻转本地状态，再发请求。Switch 是受控组件，如果等 await 回来才
    // setConfigs，从点下去到界面响应之间整整隔一个网络往返 —— 那就是「点一下卡一下」的来源。
    // 请求失败再回滚成原值。
    const handleToggleAutoBackup = async (enabled: boolean) => {
        const key = `${WEBDAV_CONFIG_PREFIX}autoBackup`;
        const previous = configs[key] ?? "true";
        const next = enabled ? "true" : "false";
        setConfigs(prev => ({ ...prev, [key]: next }));
        try {
            await api.setConfig(key, next);
        } catch (error) {
            setConfigs(prev => ({ ...prev, [key]: previous }));
            console.error("保存自动备份设置失败:", error);
            handleError("保存自动备份设置失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    };

    /**
     * 开/关「备份文件带上网站登录凭据」。
     * 存服务端配置（不是本机偏好），这样 Worker 里的每周定时备份也读得到同一个开关。
     * 同样是乐观更新：开关先动、提示先弹，写库失败再回滚。
     */
    const handleToggleIncludeCredentials = async (enabled: boolean) => {
        const previous = configs[BACKUP_CREDENTIALS_CONFIG] ?? "false";
        const next = enabled ? "true" : "false";
        setConfigs(prev => ({ ...prev, [BACKUP_CREDENTIALS_CONFIG]: next }));
        notify(
            enabled ? "以后的备份会带上网站账号密码" : "以后的备份不再包含网站账号密码",
            "info"
        );
        try {
            await api.setConfig(BACKUP_CREDENTIALS_CONFIG, next);
        } catch (error) {
            setConfigs(prev => ({ ...prev, [BACKUP_CREDENTIALS_CONFIG]: previous }));
            console.error("保存备份设置失败:", error);
            handleError(
                "保存备份设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    /**
     * 开/关「失效检测结果同步到服务端」。
     * 打开时顺手把本机这份推一次，否则要等到下次探测才有内容上去。
     * 关掉不动服务端已经存的那份：下次再打开还能接着用（也方便误关后恢复）。
     */
    const handleToggleLinkHealthSync = async (enabled: boolean) => {
        const next = enabled ? "true" : "false";
        const rollback = configs[LINK_HEALTH_SYNC_CONFIG] ?? "";
        // 乐观更新：先拨开关再发请求。原来是 await 完才改状态，等于让用户盯着一个没反应的
        // 开关等一次网络往返（实测 150ms RTT 下要 188ms 才翻转）。
        setConfigs(prev => ({ ...prev, [LINK_HEALTH_SYNC_CONFIG]: next }));
        try {
            await api.setConfig(LINK_HEALTH_SYNC_CONFIG, next);
            if (enabled) {
                const payload = JSON.stringify(exportLinkHealth());
                await api.setConfig(LINK_HEALTH_CONFIG, payload);
                lastHealthPushRef.current = payload;
                notify("失效检测结果已同步到服务端", "success");
            } else {
                notify("已停止同步失效检测结果（服务端那份先留着）", "info");
            }
        } catch (error) {
            // 没写进去就把开关拨回去，别让界面显示一个不存在的状态
            setConfigs(prev => ({ ...prev, [LINK_HEALTH_SYNC_CONFIG]: rollback }));
            console.error("保存同步设置失败:", error);
            handleError(
                "保存同步设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    /**
     * 开/关「星标与标签同步到服务端」。
     * 这两样本机是唯一来源，所以打开时先推一份上去，避免另一台设备看到的还是空的。
     */
    const handleTogglePrefSync = async (enabled: boolean) => {
        if (!enabled) {
            setPrefSync(false);
            try {
                await api.setConfig(PREF_SYNC_CONFIG, "false");
            } catch {
                // 关同步失败不用打扰用户，本机已经不再上传了
            }
            notify("已停止同步星标与标签", "info");
            return;
        }

        // 乐观更新：打开时本来要连发 3 次配置写入，串行 await 完才拨开关，
        // 实测 150ms RTT 下要 374ms 才有反馈。先拨开关，三次写入并发发出去。
        setPrefSync(true);
        const payload = JSON.stringify({ starred, tags });
        try {
            await Promise.all([
                api.setConfig(PREF_SYNC_CONFIG, "true"),
                api.setConfig(PREF_STARRED_CONFIG, JSON.stringify(starred)),
                api.setConfig(PREF_TAGS_CONFIG, JSON.stringify(tags)),
            ]);
            // 记一下刚推的内容，免得开关打开后立刻又原样推一次
            lastPrefPushRef.current = payload;
            notify("星标与标签已同步到服务端", "success");
        } catch (error) {
            setPrefSync(false);
            console.error("保存同步设置失败:", error);
            handleError(
                "保存同步设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    // 导入前的差异预览：弹出预览框，等用户确认（返回裁剪后的数据）或取消（返回 null）
    const requestImportPreview = useCallback(
        (data: ExportData, overwrite: boolean) => {
            setImportPreview({ data, overwrite });
            return new Promise<ExportData | null>(resolve => {
                importPreviewResolve.current = resolve;
            });
        },
        []
    );

    const closeImportPreview = useCallback((result: ExportData | null) => {
        setImportPreview(null);
        const resolve = importPreviewResolve.current;
        importPreviewResolve.current = null;
        resolve?.(result);
    }, []);

    // 导入/恢复数据：overwrite=true 覆盖恢复（服务端整体导入），false 合并追加
    const handleImportBackup = async (data: ExportData, overwrite: boolean) => {
        try {
            // 恢复前先验文件有没有损坏。必须拿**原始**数据验：normalizeImportData 会补默认值、
            // 重排字段，归一化之后再算摘要必然对不上，好文件也会被拦下来。
            const integrityCheck = await verifyBackupIntegrity(data);
            if (!integrityCheck.ok) {
                throw new Error(integrityCheck.reason || "备份文件校验失败");
            }

            const normalized = normalizeImportData(data);
            // 站点 id 映射：覆盖恢复由服务端重新发号并回传映射，合并导入在下面自己建，
            // 两种模式都要它来把备份里的星标 / 标签翻译到新 id 上
            const siteIdMap = new Map<number, number>();
            // 全站共享配置只有所有者（或未启用登录的单账号部署）能改，
            // 免得普通账号拿别人的备份恢复时把整站外观改掉
            const mayWriteShared = !currentUser || currentUser.role === "owner";

            // 空备份当成失败处理：覆盖恢复的语义是「以这份备份为准」，拿一份没有分组
            // 也没有卡片的备份去覆盖，等于把账号清空 —— 多半是文件选错了 / 解析没成功。
            // 宁可报错让人重选，也不要「恢复成功」后一片空白。
            if (normalized.groups.length === 0 && normalized.sites.length === 0) {
                throw new Error("这份备份里没有任何分组或卡片，已取消导入（现有数据未改动）");
            }

            if (overwrite) {
                // 传原始 data（不是 normalized）：服务端会自己归一化，
                // 而完整性校验必须在归一化之前做，否则摘要永远对不上。
                const result = await api.importData(data);
                if (!result.success) {
                    throw new Error(result.message || "服务端导入失败");
                }
                for (const [oldId, newId] of Object.entries(result.siteIdMap || {})) {
                    siteIdMap.set(Number(oldId), newId);
                }
            } else {
                // 合并导入：新建分组并记录新旧ID映射，再追加站点
                const groupIdMap = new Map<number, number>();

                for (const group of normalized.groups) {
                    const created = await api.createGroup({
                        name: group.name,
                        order_num: group.order_num ?? 0,
                    } as Group);

                    if (group.id !== undefined && created && created.id !== undefined) {
                        groupIdMap.set(group.id, created.id);
                    }
                }

                for (const site of normalized.sites) {
                    const created = await api.createSite({
                        ...site,
                        id: undefined,
                        group_id: groupIdMap.get(site.group_id) ?? site.group_id,
                    } as Site);

                    if (site.id !== undefined && created && created.id !== undefined) {
                        siteIdMap.set(site.id, created.id);
                    }
                }

                // 老备份的全站设置混在 configs 里，新备份放在 sharedConfigs，
                // 两边都按「共享键只有所有者能写」过滤一遍
                const configEntries: [string, string][] = [
                    ...Object.entries(normalized.configs || {}),
                    ...Object.entries(normalized.sharedConfigs || {}),
                ];
                for (const [key, value] of configEntries) {
                    if (key === "DB_INITIALIZED") continue;
                    if (isSecretConfigKey(key)) continue;
                    if (!isUserScopedConfigKey(key) && !mayWriteShared) continue;
                    await api.setConfig(key, value);
                }
            }

            // 把备份里的星标 / 标签写回本机 localStorage：
            // 服务端现在会重新发号（不再保留备份里的 id），所以两种模式都按映射翻译一遍。
            // 老备份/无 id 的备份拿不到映射，就只能照原样写回。
            const prefs = normalized.localPrefs;
            if (prefs) {
                const remapped =
                    siteIdMap.size > 0
                        ? {
                              starred: (prefs.starred ?? []).map(id => siteIdMap.get(id)).filter(
                                  (id): id is number => typeof id === "number"
                              ),
                              tags: Object.entries(prefs.tags ?? {}).reduce<
                                  Record<string, string[]>
                              >((acc, [siteId, list]) => {
                                  const mapped = siteIdMap.get(Number(siteId));
                                  if (typeof mapped === "number") acc[String(mapped)] = list;
                                  return acc;
                              }, {}),
                          }
                        : prefs;

                restoreLocalPrefs(remapped, overwrite ? "replace" : "merge");
            }

            // 恢复/导入是低频重操作，这里同步刷新一次（一次 bootstrap 请求）
            await fetchData();
        } catch (error) {
            console.error("导入数据失败:", error);
            handleError("导入数据失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    // 按关键词筛选：命中「网站名称 / 网站链接 / 网站描述」的卡片会被保留，分组名命中则整组保留。
    // 用 useDeferredValue 把过滤推迟到空闲帧：输入框始终跟手，卡片多的时候也不会边打边卡。
    const query = useDeferredValue(searchQuery.trim().toLowerCase());
    const filteredGroups = useMemo(() => {
        if (!query) return groups;

        return groups
            .map(group => {
                if (matchesGroupQuery(group.name, query, usePinyin)) return group;
                const sites = group.sites.filter(site => matchesSiteQuery(site, query, usePinyin));
                return { ...group, sites };
            })
            .filter(group => group.sites.length > 0);
    }, [groups, query, usePinyin]);

    // 星标 / 标签筛选：在搜索结果之上再叠一层。
    // 标签取交集（同时带「工具」「AI」两个标签才命中），星标是独立的开关。
    const matchFilters = useCallback(
        (site: Site) => {
            if (starFilter && !starred.includes(site.id as number)) return false;
            // 「只看失效」：只留检测出问题的那些链接
            if (deadOnly && !deadLinks[site.url ?? ""]) return false;
            if (activeTags.length === 0) return true;
            const own = tags[String(site.id)] ?? [];
            return activeTags.every(tag => own.includes(tag));
        },
        [starFilter, starred, deadOnly, deadLinks, activeTags, tags]
    );

    const visibleGroups = useMemo(() => {
        if (!starFilter && !deadOnly && activeTags.length === 0) return filteredGroups;
        return filteredGroups
            .map(group => ({ ...group, sites: group.sites.filter(matchFilters) }))
            .filter(group => group.sites.length > 0);
    }, [filteredGroups, starFilter, deadOnly, activeTags, matchFilters]);

    // 一次性清掉星标 / 失效 / 标签三档筛选（空状态里的「清除筛选」用）
    const clearAllFilters = useCallback(() => {
        setStarFilter(false);
        setDeadOnly(false);
        setActiveTags([]);
    }, []);

    // 点标签：多选取交集，再点一次取消
    const toggleActiveTag = useCallback((tag: string) => {
        setActiveTags(prev =>
            prev.includes(tag) ? prev.filter(item => item !== tag) : [...prev, tag]
        );
    }, []);

    // 检出失效的链接条数：决定是否显示「只看失效」入口
    const deadCount = Object.keys(deadLinks).length;

    // 筛选生效时页面里还剩多少张卡片（搜索结果计数要用）
    const matchedCount = useMemo(
        () => visibleGroups.reduce((sum, group) => sum + group.sites.length, 0),
        [visibleGroups]
    );

    // 命中太多时先只渲染一部分：几百张卡片一次性铺开会卡住输入（实测一次过滤 ~116ms），
    // 计数照常按真实命中数显示，只是不把它们全部挂到 DOM 上。
    const SEARCH_PER_GROUP_LIMIT = 24;
    const SEARCH_TOTAL_LIMIT = 60;
    const searchTruncated = query ? matchedCount > SEARCH_TOTAL_LIMIT : false;
    const renderGroups = useMemo(
        () =>
            searchTruncated
                ? visibleGroups.map(group =>
                      group.sites.length > SEARCH_PER_GROUP_LIMIT
                          ? { ...group, sites: group.sites.slice(0, SEARCH_PER_GROUP_LIMIT) }
                          : group
                  )
                : visibleGroups,
        [visibleGroups, searchTruncated]
    );
    // 「当前分组」：左侧栏选中的那个；没选中就取第一个可见分组。
    // 数字键 1~9 打开的就是这个分组里的第 N 张卡片。
    const currentGroupSites = useMemo(() => {
        if (renderGroups.length === 0) return [] as Site[];
        const picked =
            activeGroupId != null ? renderGroups.find(g => g.id === activeGroupId) : undefined;
        return (picked ?? renderGroups[0]).sites;
    }, [renderGroups, activeGroupId]);

    // 卡片很多时整体关掉入场动画：几百张同时跑 transform 动画，
    // 合成开销比动画本身还贵，视觉上也看不出「依次浮现」了
    const ENTRY_ANIMATION_LIMIT = 60;
    const reduceEntryAnimation = matchedCount > ENTRY_ANIMATION_LIMIT;

    const renderedCount = useMemo(
        () => (searchTruncated ? renderGroups.reduce((sum, g) => sum + g.sites.length, 0) : matchedCount),
        [searchTruncated, renderGroups, matchedCount]
    );

    // 下拉面板的扁平结果：跨分组取前 8 条，够用又不至于太长
    const flatResults = useMemo(() => {
        if (!query) return [];
        const items: { site: Site; groupName: string }[] = [];
        for (const group of filteredGroups) {
            for (const site of group.sites) {
                items.push({ site, groupName: group.name });
                if (items.length >= 8) break;
            }
            if (items.length >= 8) break;
        }
        return items;
    }, [filteredGroups, query]);

    const dropdownOpen = query.length > 0 && searchFocused && flatResults.length > 0;
    // 没有输入但曾经搜过：把历史关键词亮出来，点一下就能接着搜
    const historyOpen = searchFocused && query.length === 0 && searchHistory.length > 0;

    // 打开下拉面板里的某一项（用户主动选择，直接前台打开）
    const openResult = (site: Site) => {
        setSearchFocused(false);
        // 从搜索面板打开的，把这次关键词记进搜索历史
        if (searchQuery.trim()) pushSearchHistory(searchQuery);
        if (site.url) {
            window.open(site.url, "_blank", "noopener,noreferrer");
        }
    };

    // 点历史关键词：回填到搜索框并保持聚焦，方便直接回车打开
    const applyHistoryTerm = (term: string) => {
        setSearchQuery(term);
        setActiveResult(0);
        setSearchFocused(true);
        searchInputRef.current?.focus();
    };

    // 「最近访问」虚拟分组：7 天内点开过、且点开次数最多的前 10 个网站
    // （纯派生逻辑抽到 utils/siteView.ts，便于单测，不再和 App 绑死）
    const favoritesGroup = useMemo(
        () => buildFavoritesGroup(groups, visits),
        [groups, visits]
    );

    // 真正渲染的分组列表：常用置前（排序模式与关闭时不插）
    const displayedGroups = useMemo(
        () =>
            deriveDisplayedGroups(
                renderGroups,
                favoritesEnabled,
                favoritesGroup,
                query,
                matchFilters,
                usePinyin
            ),
        [visibleGroups, favoritesGroup, favoritesEnabled, query, matchFilters, usePinyin]
    );

    // 分组面板滚进视口时播一次「渐显上浮」（只播一次，来回滚动不会反复闪）。
    // 元素默认就是正常显示，动画靠 JS 加 class 触发，IntersectionObserver 不可用时完全不受影响。
    useEffect(() => {
        if (loading || sortMode !== SortMode.None) return;
        if (typeof IntersectionObserver === "undefined") return;

        const io = new IntersectionObserver(
            entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const target = entry.target as HTMLElement;
                    target.classList.add("nav-reveal-in");
                    // 播完就把 class 摘掉：面板带毛玻璃，只要还挂着动画，浏览器就会
                    // 一直把它当独立合成层处理（边缘容易渗出暗边），也会压住 :hover。
                    target.addEventListener(
                        "animationend",
                        () => target.classList.remove("nav-reveal-in"),
                        { once: true }
                    );
                    io.unobserve(target);
                });
            },
            { rootMargin: "0px 0px -32px 0px" }
        );

        document
            .querySelectorAll<HTMLElement>(".nav-group-panel")
            .forEach(node => io.observe(node));

        return () => io.disconnect();
    }, [loading, sortMode, displayedGroups.length]);

    // 分组锚点跳转：左侧导航条与移动端「分组」菜单共用
    const jumpToGroup = useCallback((groupId: number) => {
        setMobileGroupsAnchor(null);
        const node = document.getElementById(`group-anchor-${groupId}`);
        if (!node) return;
        const top = node.getBoundingClientRect().top + window.scrollY - 96;
        window.scrollTo({ top, behavior: "smooth" });
    }, []);

    // 分组强调色：存成 group.color.<id> 配置，不动数据表结构
    const handleGroupAccentChange = useCallback(
        async (groupId: number, color: string) => {
            const key = `group.color.${groupId}`;
            setConfigs(prev => ({ ...prev, [key]: color }));
            try {
                await api.setConfig(key, color);
                notify(color ? "分组颜色已更新" : "已恢复为全局主色", "success");
            } catch {
                notify("分组颜色保存失败", "error");
            }
        },
        [notify]
    );

    // 失效链接检测：结果存本机，卡片上标灰点
    const runLinkCheck = useCallback(async () => {
        const urls = Array.from(
            new Set(
                groups
                    .flatMap(g => g.sites.map(s => (s.url || "").trim()))
                    .filter(Boolean)
            )
        );
        if (urls.length === 0) {
            notify("还没有可以检测的链接", "info");
            return;
        }
        notify(`开始检测 ${urls.length} 个链接…`, "info");
        // 增量检测：7 天内探测过、或用户手动标记过「能访问」的链接直接跳过，
        // 同一域名也只探一次，避免每次都得等上几分钟
        const result = await probeLinks(urls, { concurrency: 5, skipFreshMs: FRESH_WINDOW_MS });
        setDeadLinks(result.dead);
        const dead = Object.keys(result.dead).length;
        const skipNote = result.skipped
            ? `（${result.skipped} 个近期检测过，已跳过）`
            : "";
        notify(
            dead
                ? `检测完成，${dead} 个链接疑似失效${skipNote}`
                : `检测完成，所有链接都能访问${skipNote}`,
            dead ? "info" : "success",
            undefined,
            // 有可疑链接时给个快捷入口，省得自己一张张翻
            dead
                ? { label: "只看失效", onClick: () => setDeadOnly(true) }
                : undefined
        );
    }, [groups, notify, setDeadLinks]);

    // 书签导入：同名文件夹复用已有分组，其余新建
    const importBookmarks = useCallback(
        async (parsed: ParsedBookmarkGroup[]) => {
            let created = 0;
            const iconTemplate = (configs["site.iconApi"] || "").trim();

            for (const folder of parsed) {
                let target = groups.find(g => g.name === folder.folder);
                if (!target) {
                    const saved = await api.createGroup({
                        name: folder.folder,
                        order_num: groups.length + created,
                    } as Group);
                    target = { ...saved, sites: [] } as GroupWithSites;
                }
                const baseOrder = target.sites?.length ?? 0;
                for (const [idx, item] of folder.items.entries()) {
                    await api.createSite({
                        name: item.title.slice(0, 60),
                        url: item.url,
                        icon: resolveIconApiUrl(iconTemplate, item.url),
                        description: "",
                        group_id: target.id,
                        order_num: baseOrder + idx,
                    } as Site);
                    created += 1;
                }
            }

            await fetchData({ silent: true });
            notify(`已导入 ${created} 个网站`, "success");
            return created;
        },
        [groups, configs, notify, fetchData]
    );

    // ---- 一键全部折叠 / 展开 ----
    // 收起状态存在 localStorage（和 GroupCard 共用），这里再跟一份 state：
    // 左侧分组栏的开关要能立刻换成「展开全部」，所以必须随事件同步，不能只现算
    const realGroups = useMemo(
        () => groups.filter(g => typeof g.id === "number" && g.id > 0),
        [groups]
    );
    const [collapsedIds, setCollapsedIds] = useState<string[]>(() => readCollapsedGroupIds());

    useEffect(() => {
        const sync = () => setCollapsedIds(readCollapsedGroupIds());
        // 本页写入走自定义事件，其他标签页写入走 storage
        window.addEventListener(COLLAPSED_EVENT, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(COLLAPSED_EVENT, sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    const allGroupsCollapsed =
        realGroups.length > 0 && realGroups.every(g => collapsedIds.includes(String(g.id)));

    const toggleCollapseAll = useCallback(() => {
        const next = !allGroupsCollapsed; // true = 折叠全部
        setAllCollapsed(
            realGroups.map(g => g.id),
            next
        );
        // 折叠 / 展开是即时可见的操作，不再弹提示打扰
    }, [allGroupsCollapsed, realGroups]);

    // 命令面板：站点跳转 + 常用操作，键盘党不用摸鼠标
    const commands = useMemo<CommandItem[]>(() => {
        const siteCommands: CommandItem[] = groups
            .flatMap(group =>
                group.sites.map(site => ({
                    id: `cmd-site-${group.id}-${site.id}`,
                    label: site.name || site.url || "未命名",
                    hint: group.name,
                    section: "打开网站",
                    keywords: `${site.url || ""} ${site.description || ""}`,
                    iconUrl: site.icon,
                    run: () => {
                        recordVisit(site.id);
                        if (site.url) window.open(site.url, "_blank", "noopener");
                    },
                }))
            )
            .slice(0, 120);

        const actionCommands: CommandItem[] = [
            // 撤销 / 重做放在最前面：删完卡片想反悔时，Ctrl+K 之后一眼就能看到
            {
                id: "cmd-undo",
                label: canUndo ? "撤销上一步" : "撤销上一步（暂无可撤销）",
                section: "撤销",
                run: () => void runUndo(),
            },
            {
                id: "cmd-redo",
                label: canRedo ? "重做" : "重做（暂无可重做）",
                section: "撤销",
                run: () => void runRedo(),
            },
            {
                id: "cmd-view-card",
                label: "切换到卡片视图",
                section: "显示",
                run: () => setViewMode("card"),
            },
            {
                id: "cmd-view-list",
                label: "切换到列表视图",
                section: "显示",
                run: () => setViewMode("list"),
            },
            {
                id: "cmd-view-wall",
                label: "切换到图标墙视图",
                section: "显示",
                run: () => setViewMode("wall"),
            },
            {
                id: "cmd-density",
                label: density === "compact" ? "切换到舒适密度" : "切换到紧凑密度",
                section: "显示",
                run: () => setDensity(density === "compact" ? "comfortable" : "compact"),
            },
            {
                id: "cmd-theme",
                label: "切换主题（浅色 / 深色 / 跟随系统）",
                section: "显示",
                run: () => toggleTheme(),
            },
            {
                id: "cmd-favorites",
                label: favoritesEnabled ? "关闭最近访问置前" : "开启最近访问置前",
                section: "显示",
                run: () => setFavoritesEnabled(!favoritesEnabled),
            },
            {
                id: "cmd-glass",
                label: glassEffects ? "关闭毛玻璃特效" : "开启毛玻璃特效",
                section: "显示",
                run: () => setGlassEffects(!glassEffects),
            },
            {
                id: "cmd-shortcuts",
                label: "键盘快捷键",
                section: "帮助",
                run: () => setOpenShortcuts(true),
            },
            {
                id: "cmd-add-group",
                label: "新增分组",
                section: "操作",
                run: () => handleOpenAddGroup(),
            },
            {
                id: "cmd-group-sort",
                label: "进入编辑排序",
                section: "操作",
                run: () => startGroupSort(),
            },
            {
                id: "cmd-config",
                label: "打开网站设置",
                section: "操作",
                run: () => handleOpenConfig(),
            },
            {
                id: "cmd-account",
                label: "打开账号管理",
                section: "操作",
                run: () => {
                    setOpenAccount(true);
                    void fetchAccountList();
                },
            },
            {
                id: "cmd-backup",
                label: "数据备份",
                section: "操作",
                run: () => handleOpenBackup(0),
            },
            {
                id: "cmd-bookmarks",
                label: "导入浏览器书签",
                section: "操作",
                run: () => setBookmarkOpen(true),
            },
            {
                id: "cmd-link-check",
                label: "检测失效链接",
                section: "操作",
                run: () => void runLinkCheck(),
            },
            {
                id: "cmd-visits",
                label: "查看访问统计",
                section: "显示",
                run: () => setOpenVisits(true),
            },
            {
                id: "cmd-collapse-all",
                label: allGroupsCollapsed ? "展开全部分组" : "折叠全部分组",
                section: "显示",
                run: () => toggleCollapseAll(),
            },
            {
                id: "cmd-multiselect",
                label: multiSelect ? "退出批量多选" : "批量多选",
                section: "操作",
                run: () => (multiSelect ? exitMultiSelect() : setMultiSelect(true)),
            },
            {
                id: "cmd-star-filter",
                label: starFilter ? "取消只看星标" : "只看星标",
                section: "显示",
                run: () => setStarFilter(!starFilter),
            },
            {
                id: "cmd-rail",
                label: railCollapsed ? "展开左侧分组栏" : "收起左侧分组栏",
                section: "显示",
                run: () => setRailCollapsed(!railCollapsed),
            },
            {
                id: "cmd-clear-visits",
                label: "清除访问记录",
                section: "操作",
                run: () => {
                    clearVisits();
                    // 清除访问记录不弹提示：「最近访问」分组会当场消失，本身就是反馈
                },
            },
        ];

        return [...siteCommands, ...actionCommands];
    }, [
        groups,
        viewMode,
        density,
        favoritesEnabled,
        toggleTheme,
        setViewMode,
        setDensity,
        setFavoritesEnabled,
        glassEffects,
        setGlassEffects,
        canUndo,
        canRedo,
        runUndo,
        runRedo,
        handleOpenAddGroup,
        startGroupSort,
        handleOpenConfig,
        handleOpenBackup,
        runLinkCheck,
        clearVisits,
        notify,
        recordVisit,
        allGroupsCollapsed,
        toggleCollapseAll,
        multiSelect,
        exitMultiSelect,
        starFilter,
        railCollapsed,
        setRailCollapsed,
    ]);

    // 方向键在卡片之间移动焦点（按几何位置找同行/同列的邻居）
    const focusCardByDirection = (dir: "left" | "right" | "up" | "down") => {
        const cards = Array.from(
            document.querySelectorAll<HTMLElement>('[data-nav-card="true"]')
        );
        if (cards.length === 0) return;

        const active = document.activeElement as HTMLElement | null;
        const current =
            active && active.getAttribute("data-nav-card") === "true" ? active : null;

        if (!current) {
            cards[0].focus();
            return;
        }

        const rect = current.getBoundingClientRect();
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;

        if (dir === "left" || dir === "right") {
            const sameRow = cards.filter(card => {
                if (card === current) return false;
                const r = card.getBoundingClientRect();
                return Math.abs((r.top + r.bottom) / 2 - cy) < 16;
            });
            if (sameRow.length === 0) return;
            const target =
                dir === "right"
                    ? sameRow
                          .filter(card => card.getBoundingClientRect().left > cx)
                          .sort(
                              (a, b) =>
                                  a.getBoundingClientRect().left -
                                  b.getBoundingClientRect().left
                          )[0]
                    : sameRow
                          .filter(card => card.getBoundingClientRect().right < cx)
                          .sort(
                              (a, b) =>
                                  b.getBoundingClientRect().right -
                                  a.getBoundingClientRect().right
                          )[0];
            (target || current).focus();
            return;
        }

        const sameColumn = cards.filter(card => {
            if (card === current) return false;
            const r = card.getBoundingClientRect();
            return Math.abs((r.left + r.right) / 2 - cx) < 24;
        });
        if (sameColumn.length === 0) return;
        const target =
            dir === "down"
                ? sameColumn
                      .filter(card => card.getBoundingClientRect().top > cy)
                      .sort(
                          (a, b) =>
                              a.getBoundingClientRect().top - b.getBoundingClientRect().top
                      )[0]
                : sameColumn
                      .filter(card => card.getBoundingClientRect().bottom < cy)
                      .sort(
                          (a, b) =>
                              b.getBoundingClientRect().bottom -
                              a.getBoundingClientRect().bottom
                      )[0];
        (target || current).focus();
    };

    // 点击搜索框与结果面板以外的地方才收起面板。
    // （不用 onBlur：点结果项时 mousedown 会先让输入框失焦，面板还没等到 click 就卸载了）
    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (searchAnchor && searchAnchor.contains(target)) return;
            if (searchPanelRef.current && searchPanelRef.current.contains(target)) return;
            setSearchFocused(false);
        };

        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
    }, [searchAnchor]);

    // 「/」快速聚焦搜索框、方向键导航、搜索框内的上下键与回车
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isTyping =
                !!target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable);

            if (e.key === "/" && !isTyping) {
                e.preventDefault();
                searchInputRef.current?.focus();
                return;
            }

            // Ctrl / Cmd + Z 撤销、Ctrl+Shift+Z（或 Ctrl+Y）重做。
            // 正在输入时不能拦：输入框里的 Ctrl+Z 是「撤销我刚打的字」，那是浏览器自己的事。
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isTyping) {
                e.preventDefault();
                if (e.shiftKey) void runRedo();
                else void runUndo();
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !isTyping) {
                e.preventDefault();
                void runRedo();
                return;
            }

            // 搜索框内：↑↓ 选结果，Enter 打开，Esc 清空
            if (target === searchInputRef.current) {
                if (e.key === "ArrowDown" && flatResults.length > 0) {
                    e.preventDefault();
                    setActiveResult(prev => (prev + 1) % flatResults.length);
                    return;
                }
                if (e.key === "ArrowUp" && flatResults.length > 0) {
                    e.preventDefault();
                    setActiveResult(prev =>
                        prev <= 0 ? flatResults.length - 1 : prev - 1
                    );
                    return;
                }
                if (e.key === "Enter" && flatResults.length > 0) {
                    e.preventDefault();
                    const picked = flatResults[activeResult] || flatResults[0];
                    if (picked) openResult(picked.site);
                    return;
                }
                if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchFocused(false);
                    searchInputRef.current?.blur();
                    return;
                }
                return;
            }

            // 其它位置：方向键在卡片之间移动焦点
            if (isTyping) return;

            // 有弹窗 / 菜单开着的时候，下面这些「直接动手」的快捷键一律不响应，
            // 免得在设置弹窗里按个 1 就把某个网站打开了
            const overlayOpen = !!document.querySelector(
                ".MuiModal-root, .MuiMenu-root, .MuiPopover-root"
            );

            // ? 打开快捷键说明表（Shift + /）
            if (e.key === "?" && !overlayOpen && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                setOpenShortcuts(true);
                return;
            }

            // 1~9：搜索状态下打开第 N 条结果，否则打开当前分组第 N 张卡片。
            // 这是最省事的一条路 —— 不用先把鼠标挪过去，敲个数字就跳走了
            if (!overlayOpen && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
                const index = Number(e.key) - 1;
                if (searchQuery.trim() && flatResults.length > 0) {
                    const picked = flatResults[index];
                    if (picked) {
                        e.preventDefault();
                        openResult(picked.site);
                    }
                    return;
                }
                const target = currentGroupSites[index];
                if (target) {
                    e.preventDefault();
                    openResult(target);
                }
                return;
            }

            if (e.key === "ArrowRight") {
                focusCardByDirection("right");
                e.preventDefault();
            } else if (e.key === "ArrowLeft") {
                focusCardByDirection("left");
                e.preventDefault();
            } else if (e.key === "ArrowDown") {
                focusCardByDirection("down");
                e.preventDefault();
            } else if (e.key === "ArrowUp") {
                focusCardByDirection("up");
                e.preventDefault();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [flatResults, activeResult, runUndo, runRedo, searchQuery, currentGroupSites]);

    // context value 记忆化：只有相关配置真正变化时才通知消费方，避免无谓重渲染
    const appConfigValue = useMemo(
        () => ({
            iconApi: configs["site.iconApi"] || "",
            thumbApi: (configs["site.thumbApi"] || "").trim(),
            backgroundImage: (configs["site.backgroundImage"] || "").trim(),
            backgroundMaskOpacity: configs["site.backgroundMaskOpacity"] || "0.15",
        }),
        [configs]
    );

    // 渲染登录页面
    const renderLoginForm = () => {
        return (
            <Box
                sx={{
                    minHeight: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "background.default",
                }}
            >
                <LoginForm
                    onLogin={handleLogin}
                    loading={loginLoading}
                    error={loginError}
                    onRecover={handleRecover}
                    recoverConfigured={recoveryConfigured}
                    onRegister={handleRegister}
                />
            </Box>
        );
    };

    // 如果正在检查认证状态，显示加载界面
    if (isAuthChecking) {
        return (
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Box
                    sx={{
                        minHeight: "100vh",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: "background.default",
                    }}
                >
                    <CircularProgress size={60} thickness={4} />
                </Box>
            </ThemeProvider>
        );
    }

    // 如果需要认证但未认证，显示登录界面
    if (isAuthRequired && !isAuthenticated) {
        return (
            <ThemeProvider theme={theme}>
                <CssBaseline />
                {renderLoginForm()}
            </ThemeProvider>
        );
    }

    // ---- 背景图片相关（来自「网站设置」） ----
    const backgroundImageUrl = (configs["site.backgroundImage"] || "").trim();
    const hasBackgroundImage = backgroundImageUrl.length > 0;
    // 滑块值越大 → 图片越清晰 → 蒙版越淡，所以蒙版不透明度取 1 - 滑块值
    const backgroundSliderValue = Math.min(
        1,
        Math.max(0, Number(configs["site.backgroundMaskOpacity"]) || 0)
    );
    const backgroundMaskOpacity = 1 - backgroundSliderValue;

    return (
        <AppConfigProvider value={appConfigValue}>
         <NotifyContext.Provider value={notify}>
            <ThemeProvider theme={theme}>
            <CssBaseline />

            {/* 顶部滚动进度条：固定贴在最上方，纯装饰 */}
            <ScrollProgress />
            {/* 断网 / 恢复的浮动提示 */}
            <OfflineBanner />

            {/* 回到顶部：滚过一屏才出现 */}
            <BackToTop />

            <SnackbarHost
                open={snackbarOpen}
                message={snackbarMessage}
                severity={snackbarSeverity}
                duration={snackbarDuration}
                action={snackbarAction}
                liveMessage={liveMessage}
                onClose={handleCloseSnackbar}
            />

            <BackgroundLayers
                imageUrl={backgroundImageUrl}
                maskOpacity={backgroundMaskOpacity}
                darkMode={darkMode}
            />

            <Box
                className='nav-root'
                data-font-scale={fontScale}
                style={{ ["--card-radius" as string]: RADIUS_PX[radius] }}
                sx={{
                    minHeight: "100vh",
                    bgcolor: hasBackgroundImage ? "transparent" : "background.default",
                    color: "text.primary",
                    transition: "all 0.3s ease-in-out",
                    position: "relative",
                    zIndex: 1,
                }}
            >
                {/* 键盘 / 读屏用户的第一站：一次 Tab 就能跳过分组导航与顶栏直达网站列表。
                    平时视觉隐藏，只有被键盘聚焦时才浮到左上角。 */}
                <Box component='a' href='#main-content' className='nav-skip-link'>
                    跳到网站列表
                </Box>

                <Container
                    component='main'
                    id='main-content'
                    tabIndex={-1}
                    aria-label='网站列表'
                    maxWidth='lg'
                    sx={{
                        py: 4,
                        px: { xs: 2, sm: 3, md: 4 },
                        // 手机端给底部导航条留出空间
                        pb: { xs: 11, md: 4 },
                        // 跳转链接把焦点送到这里时别画一圈突兀的框
                        "&:focus": { outline: "none" },
                    }}
                >
                    {/* 分组锚点导航：分组多了直接跳，不用一路滚 */}
                    {!loading && sortMode === SortMode.None && (
                        <GroupNavRail
                            groups={displayedGroups.map(g => ({
                                id: g.id,
                                name: g.name,
                                count: g.sites.length,
                            }))}
                            activeId={activeGroupId}
                            onJump={jumpToGroup}
                            allCollapsed={allGroupsCollapsed}
                            onToggleCollapseAll={toggleCollapseAll}
                        />
                    )}
                    <SiteListHeader
                        siteName={configs["site.name"]}
                        headerCompact={headerCompact}
                        actions={
                            <>
                                {sortMode === SortMode.None && (
                                    <HeaderSearchBox
                                        searchInputRef={searchInputRef}
                                        searchPanelRef={searchPanelRef}
                                        searchQuery={searchQuery}
                                        setSearchQuery={setSearchQuery}
                                        setActiveResult={setActiveResult}
                                        setSearchFocused={setSearchFocused}
                                        searchAnchor={searchAnchor}
                                        setSearchAnchor={setSearchAnchor}
                                        dropdownOpen={dropdownOpen}
                                        historyOpen={historyOpen}
                                        query={query}
                                        results={flatResults}
                                        activeResult={activeResult}
                                        openResult={openResult}
                                        searchHistory={searchHistory}
                                        applyHistoryTerm={applyHistoryTerm}
                                        clearSearchHistory={clearSearchHistory}
                                        headerCompact={headerCompact}
                                    />
                                )}
                                {/* 搜索是「找东西」，右侧是「改数据 / 改显示」，中间用竖线分开 */}
                                {sortMode === SortMode.None && (
                                    <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                                )}
                                <HeaderActions
                                    sortMode={sortMode}
                                    onSaveGroupOrder={handleSaveGroupOrder}
                                    onSaveSiteSort={handleSaveSiteSort}
                                    onCancelSort={cancelSort}
                                    onOpenAddGroup={handleOpenAddGroup}
                                    onMenuOpen={handleMenuOpen}
                                    menuOpen={openMenu}
                                    menu={
                                        <MoreMenu
                                            anchorEl={menuAnchorEl}
                                            open={openMenu && sortMode === SortMode.None}
                                            onClose={handleMenuClose}
                                            onOpenConfig={handleOpenConfig}
                                            onOpenAccount={() => {
                                                handleMenuClose();
                                                setOpenAccount(true);
                                                void fetchAccountList();
                                            }}
                                            onStartGroupSort={startGroupSort}
                                            canInstall={canInstall}
                                            onInstallApp={() => void handleInstallApp()}
                                            favoritesEnabled={favoritesEnabled}
                                            onFavoritesEnabledChange={setFavoritesEnabled}
                                            onOpenVisits={() => setOpenVisits(true)}
                                            onOpenBackup={handleOpenBackup}
                                            onOpenRecycle={() => {
                                                handleMenuClose();
                                                setOpenRecycle(true);
                                            }}
                                            onOpenAudit={() => {
                                                handleMenuClose();
                                                setOpenAudit(true);
                                            }}
                                            isAuthenticated={isAuthenticated}
                                            onLogout={handleLogout}
                                            isSiteOwner={currentUser?.role === "owner"}
                                        />
                                    }
                                />
                                {/* 操作按钮与显示控制之间再分一次组 */}
                                {sortMode === SortMode.None && (
                                    <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                                )}
                                {/* 显示控制：视图版式 + 显示密度合成一块玻璃胶囊，中间一条细线分开 */}
                                {sortMode === SortMode.None && (
                                    <DisplayControls
                                        viewMode={viewMode}
                                        setViewMode={setViewMode}
                                        density={density}
                                        setDensity={setDensity}
                                        multiSelect={multiSelect}
                                        setMultiSelect={setMultiSelect}
                                        exitMultiSelect={exitMultiSelect}
                                        starFilter={starFilter}
                                        setStarFilter={setStarFilter}
                                        themeMode={themeMode}
                                        onToggleTheme={toggleTheme}
                                    />
                                )}
                                {/* 时钟自己归成「状态区」，和左侧操作按钮用竖线隔开。 */}
                                <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                                <HeaderClock />
                            </>
                        }
                    />

                    {/* 标签筛选栏：有用过的标签、或检出失效链接时才出现 */}
                    {sortMode === SortMode.None &&
                        !loading &&
                        (allTags.length > 0 || deadCount > 0 || starFilter) && (
                            <TagBar
                                tags={allTags}
                                activeTags={activeTags}
                                onToggleTag={toggleActiveTag}
                                onClearTags={() => setActiveTags([])}
                                starFilter={starFilter}
                                onToggleStarFilter={() => setStarFilter(prev => !prev)}
                                deadCount={deadCount}
                                deadOnly={deadOnly}
                                onToggleDeadOnly={() => setDeadOnly(prev => !prev)}
                                onManageTags={() => setTagManagerOpen(true)}
                            />
                        )}

                    {/* 结果计数：搜索框在上方标题栏里，这里只保留一行轻提示 */}
                    {sortMode === SortMode.None &&
                        (query || starFilter || deadOnly || activeTags.length > 0) && (
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ display: "block", mt: -2, mb: 3 }}
                            >
                                找到 {matchedCount} 个匹配的网站
                                {searchTruncated
                                    ? `，先显示前 ${renderedCount} 个，继续输入可以缩小范围`
                                    : ""}
                            </Typography>
                        )}

                    {loading && <SiteListSkeleton />}

                    {!loading && !error && (
                        <Box
                            sx={{
                                "& > *": { mb: 5 },
                                minHeight: "100px",
                            }}
                        >
                            {sortMode === SortMode.GroupSort ? (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handleDragEnd}
                                >
                                    <SortableContext
                                        items={groups.map(group => group.id.toString())}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <Stack
                                            spacing={2}
                                            sx={{
                                                "& > *": {
                                                    transition: "none",
                                                },
                                            }}
                                        >
                                            {groups.map(group => (
                                                <SortableGroupItem
                                                    key={group.id}
                                                    id={group.id.toString()}
                                                    group={group}
                                                />
                                            ))}
                                        </Stack>
                                    </SortableContext>
                                </DndContext>
                            ) : sortMode === SortMode.SiteSort ? (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragStart={handleSiteDragStart}
                                    onDragOver={handleSiteSortDragOver}
                                    onDragEnd={handleSiteSortDragEnd}
                                    onDragCancel={handleSiteDragCancel}
                                >
                                    <Stack spacing={5}>
                                        {groups.map(group => (
                                            <GroupCard
                                                key={`group-${group.id}`}
                                                group={group}
                                                accentColor={groupAccent(group.id, darkMode ? "dark" : "light")}
                                                sortMode="SiteSort"
                                                currentSortingGroupId={null}
                                                globalSiteSort
                                                onUpdate={handleSiteUpdate}
                                                onDelete={handleSiteDelete}
                                                onSaveSiteOrder={handleSaveSiteOrder}
                                                onStartSiteSort={startSiteSort}
                                                onAddSite={handleOpenAddSite}
                                                onUpdateGroup={handleGroupUpdate}
                                                onDeleteGroup={handleGroupDelete}
                                            />
                                        ))}
                                    </Stack>

                                    {/* 跟随指针的拖拽浮层：比原位卡片略大、略微倾斜 */}
                                    <DragOverlay dropAnimation={null}>
                                        {draggingSite && (
                                            <Box
                                                className='nav-drag-overlay'
                                                sx={{ width: 200, pointerEvents: "none" }}
                                            >
                                                <SiteCard
                                                    site={draggingSite}
                                                    onUpdate={handleSiteUpdate}
                                                    onDelete={handleSiteDelete}
                                                    isEditMode
                                                />
                                            </Box>
                                        )}
                                    </DragOverlay>
                                </DndContext>
                            ) : displayedGroups.length > 0 ? (
                                <Stack
                                    spacing={density === "compact" ? 3 : 5}
                                    className={reduceEntryAnimation ? "nav-static-entry" : undefined}
                                >
                                    {displayedGroups.map(group => (
                                        <GroupCard
                                            key={`group-${group.id}`}
                                            group={group}
                                            sortMode={
                                                sortMode === SortMode.None ? "None" : "SiteSort"
                                            }
                                            currentSortingGroupId={currentSortingGroupId}
                                            onUpdate={handleSiteUpdate}
                                            onDelete={handleSiteDelete}
                                            onSaveSiteOrder={handleSaveSiteOrder}
                                            onStartSiteSort={startSiteSort}
                                            onAddSite={handleOpenAddSite}
                                            onUpdateGroup={handleGroupUpdate}
                                            onDeleteGroup={handleGroupDelete}
                                            searchQuery={query}
                                            accentColor={
                                                configs[`group.color.${group.id}`] ||
                                                groupAccent(group.id, darkMode ? "dark" : "light")
                                            }
                                            onAccentChange={handleGroupAccentChange}
                                            selectMode={multiSelect}
                                            selectedIds={selectedIds}
                                            onToggleSelect={toggleSelect}
                                        />
                                    ))}
                                </Stack>
                            ) : (
                                <SiteListEmptyState
                                    query={query}
                                    hasTagFilter={activeTags.length > 0}
                                    starFilter={starFilter}
                                    deadOnly={deadOnly}
                                    onClearSearch={() => setSearchQuery("")}
                                    onClearFilters={clearAllFilters}
                                />
                            )}
                        </Box>
                    )}

                    {/* 新增分组对话框（与「编辑分组」共用同一套样式与尺寸） */}
                    <EditGroupDialog
                        open={openAddGroup}
                        group={null}
                        mode='create'
                        onClose={handleCloseAddGroup}
                        onSave={group => handleCreateGroup(group.name)}
                    />

                    {/* 新增站点对话框：字段顺序与「网站设置」对齐
                        （名称 → 链接 → 图标 → 描述 → 备注 → 分隔线 → 登录凭据），宽度也统一成 600px */}
                    <Dialog open={openAddSite} onClose={handleCloseAddSite} maxWidth='sm' fullWidth>
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
                                onClick={handleCloseAddSite}
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
                                            value={newSite.name}
                                            onChange={handleSiteInputChange}
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
                                            value={newSite.url}
                                            onChange={handleSiteInputChange}
                                            InputProps={{
                                                endAdornment: (
                                                    <InputAdornment position='end'>
                                                        <Tooltip title='抓取这个网站的标题和描述'>
                                                            <span>
                                                                <IconButton
                                                                    size='small'
                                                                    edge='end'
                                                                    onClick={
                                                                        handleFetchNewSiteMeta
                                                                    }
                                                                    disabled={
                                                                        !newSite.url ||
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
                                                    </InputAdornment>
                                                ),
                                            }}
                                        />
                                    </Box>
                                </Box>

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
                                    value={newSite.icon}
                                    onChange={handleSiteInputChange}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position='end'>
                                                <Tooltip title='根据网站链接一键获取图标URL'>
                                                    <span>
                                                        <IconButton
                                                            size='small'
                                                            edge='end'
                                                            onClick={handleFetchNewSiteIcon}
                                                            disabled={!newSite.url}
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
                                    value={newSite.description}
                                    onChange={handleSiteInputChange}
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
                                    value={newSite.notes}
                                    onChange={handleSiteInputChange}
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
                                                value={newSite.username || ""}
                                                onChange={handleSiteInputChange}
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
                                                type={secretInputType(showNewSitePassword)}
                                                sx={secretInputSx(showNewSitePassword)}
                                                variant='outlined'
                                                placeholder='登录密码（可留空）'
                                                value={newSite.password || ""}
                                                onChange={handleSiteInputChange}
                                                autoComplete='off'
                                                inputProps={{ ...SECRET_IGNORE_ATTRS }}
                                                InputProps={{
                                                    endAdornment: (
                                                        <InputAdornment position='end'>
                                                            <IconButton
                                                                size='small'
                                                                edge='end'
                                                                onClick={() =>
                                                                    setShowNewSitePassword(prev => !prev)
                                                                }
                                                                aria-label={
                                                                    showNewSitePassword
                                                                        ? "隐藏密码"
                                                                        : "显示密码"
                                                                }
                                                            >
                                                                {showNewSitePassword ? (
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
                            <Button onClick={handleCloseAddSite} variant='outlined'>
                                取消
                            </Button>
                            <Button
                                onClick={handleCreateSite}
                                variant='contained'
                                color='primary'
                                disabled={creatingSite}
                            >
                                {creatingSite ? "创建中…" : "创建"}
                            </Button>
                        </DialogActions>
                    </Dialog>

                    {/* 网站配置对话框 */}
                    {/* 全站设置：这一块原来内联在 App 里，抽成 SettingsDialog 单独维护 */}
                    <Suspense fallback={null}>
                    <SettingsDialog
                        open={openConfig}
                        onClose={handleCloseConfig}
                        onSave={handleSaveConfig}
                        tempConfigs={tempConfigs}
                        setTempConfigs={setTempConfigs}
                        onConfigInputChange={handleConfigInputChange}
                        onMaskOpacityChange={handleConfigSliderChange}
                        onPickAccent={pickAccent}
                        radius={radius}
                        onRadiusChange={setRadius}
                        fontScale={fontScale}
                        onFontScaleChange={setFontScale}
                        glassBlur={tempGlassBlur}
                        onGlassBlurChange={handleGlassBlurChange}
                        glassEffects={glassEffects}
                        onGlassEffectsChange={setGlassEffects}
                        saving={savingConfig}
                        pinyinSearch={pinyinSearch}
                        onPinyinSearchChange={setPinyinSearch}
                        syncHealth={configs[LINK_HEALTH_SYNC_CONFIG] === "true"}
                        onSyncHealthChange={handleToggleLinkHealthSync}
                        syncPrefs={prefSync}
                        onSyncPrefsChange={handleTogglePrefSync}
                        // 检测失效链接：从「更多选项」挪进「数据同步」这一节，挨着失效检测结果开关
                        onRunLinkCheck={() => void runLinkCheck()}
                        // 全站外观是所有人共用的，只有站点所有者能改（服务端同规则）
                        isSiteOwner={!currentUser || currentUser.role === "owner"}
                    />
                    </Suspense>

                    {/* 账号管理：改账号密码 / 恢复密钥 / 邀请码 / 注销账号。
                        原先「账户安全」混在网站设置里、注销账号又孤零零挂在更多菜单，
                        现在都收在这里 —— 网站设置只管「站点长什么样」。 */}
                    <Suspense fallback={null}>
                    <AccountDialog
                        open={openAccount}
                        onClose={() => setOpenAccount(false)}
                        auth={{
                            username: authUsername,
                            currentPassword: authCurrentPassword,
                            newPassword: authNewPassword,
                        }}
                        onAuthChange={(field, value) => {
                            if (field === "username") setAuthUsername(value);
                            else if (field === "currentPassword") setAuthCurrentPassword(value);
                            else setAuthNewPassword(value);
                        }}
                        onSaveAuth={() => void handleSaveAuthCredentials()}
                        saving={savingAuth}
                        currentUser={currentUser}
                        recoveryKeyConfigured={recoveryConfigured}
                        onGenerateRecoveryKey={handleGenerateRecoveryKey}
                        invite={invite}
                        onCreateInvite={handleCreateInvite}
                        accounts={accountList}
                        onExemptUser={uid => void handleExemptUser(uid)}
                        inactivePolicy={inactivePolicy ?? undefined}
                        onSaveInactivePolicy={handleSaveInactivePolicy}
                        onDeleteAccount={() => {
                            handleMenuClose();
                            setOpenAccount(false);
                            setDeleteAccountOpen(true);
                        }}
                    />
                    </Suspense>

                    {/* 注销账号：二次确认 + 当前密码（入口在「更多选项」） */}
                    <DeleteAccountDialog
                        open={deleteAccountOpen}
                        username={currentUser?.username}
                        busy={deleteAccountBusy}
                        password={deleteAccountPassword}
                        onPasswordChange={setDeleteAccountPassword}
                        onConfirm={() => void handleDeleteAccount()}
                        onClose={() => {
                            if (deleteAccountBusy) return;
                            setDeleteAccountOpen(false);
                            setDeleteAccountPassword("");
                        }}
                    />

                    {/* 访问统计：本机热力图 + Top5 */}
                    <Suspense fallback={null}>
                    <VisitsDialog
                        open={openVisits}
                        onClose={() => setOpenVisits(false)}
                        nameOf={id => {
                            for (const group of groups) {
                                const hit = group.sites.find(s => String(s.id) === id);
                                if (hit) return hit.name || hit.url || `#${id}`;
                            }
                            return `已删除的网站 #${id}`;
                        }}
                        onClear={() => {
                            clearVisits();
                            // 清除访问记录不弹提示：「最近访问」分组会当场消失，本身就是反馈
                        }}
                    />
                    </Suspense>

                    {/* 数据备份与恢复对话框 */}
                    <Suspense fallback={null}>
                    <BackupDialog
                        open={openBackup}
                        initialTab={backupTab}
                        client={api}
                        webdavConfig={webdavConfig}
                        onSaveWebdavConfig={handleSaveWebdavConfig}
                        autoBackup={configs[`${WEBDAV_CONFIG_PREFIX}autoBackup`] !== "false"}
                        lastBackupAt={configs[`${WEBDAV_CONFIG_PREFIX}lastBackupAt`] || ""}
                        onToggleAutoBackup={handleToggleAutoBackup}
                        onBuildExportData={buildExportData}
                        onDownloadLocal={handleDownloadLocal}
                        onImportData={handleImportBackup}
                        onRequestImportPreview={requestImportPreview}
                        onNotify={notify}
                        onClose={handleCloseBackup}
                        includeCredentials={configs[BACKUP_CREDENTIALS_CONFIG] === "true"}
                        onIncludeCredentialsChange={handleToggleIncludeCredentials}
                        // 导入浏览器书签：从「更多选项」挪进「恢复 / 导入」页，和从文件恢复同类
                        onOpenBookmark={() => {
                            setOpenBackup(false);
                            setBookmarkOpen(true);
                        }}
                        cronError={cronError}
                    />
                    </Suspense>

                {/* 快捷键说明表：按 ? 打开，命令面板里也有入口（已不在「更多选项」里占位置） */}
                <Suspense fallback={null}>
                <ShortcutsDialog
                    open={openShortcuts}
                    onClose={() => setOpenShortcuts(false)}
                />
                </Suspense>

                {/* 导入预览：恢复前先给用户看差异，勾选后才会真的写库 */}
                <Suspense fallback={null}>
                <ImportPreviewDialog
                    open={importPreview !== null}
                    data={importPreview?.data ?? null}
                    overwrite={importPreview?.overwrite ?? false}
                    current={groups}
                    onCancel={() => closeImportPreview(null)}
                    onConfirm={data => closeImportPreview(data)}
                />
                </Suspense>

                {/* 审计日志：仅站点所有者可读，事后溯源谁在何时做了什么 */}
                <Suspense fallback={null}>
                <AuditDialog
                    open={openAudit}
                    onClose={() => setOpenAudit(false)}
                    client={api as unknown as NavigationClient}
                />
                </Suspense>

                {/* 回收站：还原 / 彻底删除被软删除的站点、分组 */}
                <Suspense fallback={null}>
                <RecycleBinDialog
                    open={openRecycle}
                    onClose={() => setOpenRecycle(false)}
                    client={api as unknown as NavigationClient}
                    onChanged={() => void fetchData({ silent: true })}
                    onNotify={(msg, severity) => notify(msg, severity || "info")}
                />
                </Suspense>

                {/* 删除分组：二次确认 + 导出提示 */}
                <ConfirmDialog
                    open={pendingGroupDelete !== null}
                    title='删除分组'
                    danger
                    description={
                        <span>
                            将删除该分组及其下所有网站（先进入回收站，可在回收站恢复）。建议先导出备份。
                        </span>
                    }
                    confirmText='删除'
                    onClose={() => setPendingGroupDelete(null)}
                    onConfirm={() => {
                        const id = pendingGroupDelete;
                        setPendingGroupDelete(null);
                        if (id !== null) void doGroupDelete(id);
                    }}
                />

                </Container>

                {/* 手机端底部导航：搜索 / 分组 / 新增 / 更多 */}
                <OverlayHost
                    mobile={{
                        onSearch: () => {
                            searchInputRef.current?.focus();
                            window.scrollTo({ top: 0, behavior: "smooth" });
                        },
                        onGroups: event => setMobileGroupsAnchor(event.currentTarget),
                        onAdd: handleOpenAddGroup,
                        onMore: event =>
                            handleMenuOpen(event as React.MouseEvent<HTMLButtonElement>),
                        onExitViewport: handleExitMobileViewport,
                        onToggleStar: () => setStarFilter(!starFilter),
                        starActive: starFilter,
                        badge: displayedGroups.length,
                        groupsAnchor: mobileGroupsAnchor,
                        onCloseGroups: () => setMobileGroupsAnchor(null),
                        groups: displayedGroups,
                        onJumpGroup: jumpToGroup,
                        activeGroupId: activeGroupId,
                    }}
                    commandPalette={{
                        open: commandOpen,
                        onClose: () => setCommandOpen(false),
                        commands: commands,
                    }}
                    bookmarkImport={{
                        open: bookmarkOpen,
                        onClose: () => setBookmarkOpen(false),
                        onImport: importBookmarks,
                    }}
                    bulkBar={{
                        visible: multiSelect && sortMode === SortMode.None,
                        count: selectedIds.length,
                        groups: groups,
                        allTags: allTags,
                        onStar: bulkStar,
                        onTag: bulkTag,
                        onMove: bulkMove,
                        onDelete: () => {
                            if (selectedIds.length === 0) return;
                            setBulkDeleteOpen(true);
                        },
                        onFinish: exitMultiSelect,
                        onExit: exitMultiSelect,
                    }}
                    dupPrompt={dupPrompt}
                    onDupConfirm={() => {
                        const run = dupPrompt?.run;
                        setDupPrompt(null);
                        if (run) void run();
                    }}
                    onDupCancel={() => setDupPrompt(null)}
                    onJumpToSite={jumpToSite}
                    bulkDelete={{
                        open: bulkDeleteOpen,
                        count: selectedIds.length,
                        onConfirm: bulkDelete,
                        onClose: () => setBulkDeleteOpen(false),
                    }}
                    tagManager={{
                        open: tagManagerOpen,
                        tags: allTags,
                        counts: tagCounts,
                        onDeleteTag: deleteTagWithUndo,
                        onClose: () => setTagManagerOpen(false),
                    }}
                />
            </Box>
        </ThemeProvider>
         </NotifyContext.Provider>
        </AppConfigProvider>
    );
}

export default App;
