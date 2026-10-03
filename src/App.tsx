import { reportError } from "./utils/errorReporter";
import {
    useState,
    useEffect,
    useMemo,
    useRef,
    useCallback,
    lazy,
    Suspense,
    type SetStateAction,
} from "react";
import { NavigationClient } from "./API/client";
import { MockNavigationClient } from "./API/mock";
import {
    Site,
    Group,
    BootstrapData,
    WebDavConfig,
    BACKUP_CREDENTIALS_CONFIG,
} from "./API/http";
import { mapWithConcurrency } from "./API/methods/transfer";
import { RETENTION_DAYS_KEY } from "./API/configKeys";
import { GroupWithSites } from "./types";
import { AppConfigProvider } from "./context/AppConfigContext";
import { NotifyContext } from "./context/NotifyContext";
import { useUIPrefs, RADIUS_PX } from "./context/uiPrefsStore";
import GroupNavRail from "./components/GroupNavRail";
// 弹窗/面板类组件按需加载：首屏用不到它们，拆出去能让主包小一大截
// （命令面板与书签导入已随 OverlayHost 一起搬走；命令条目的类型跟着
//  useAppCommands 走，App 这边连类型都不必留）
import ScrollProgress from "./components/ScrollProgress";
import BackToTop from "./components/BackToTop";
import OfflineBanner from "./components/OfflineBanner";
import ConfirmDialog from "./components/ConfirmDialog";
// 提示条 / 背景装饰 / 浮层挂载点：三段纯渲染的 JSX，从 App 的渲染树里抽出来
import SnackbarHost from "./components/SnackbarHost";
import BackgroundLayers from "./components/BackgroundLayers";
import OverlayHost from "./components/OverlayHost";
import { useDocumentEffects } from "./hooks/useDocumentEffects";
import { useSiteSettings } from "./hooks/useSiteSettings";
import { useSiteSearch } from "./hooks/useSiteSearch";
import { useAccountSession } from "./hooks/useAccountSession";
import { usePwaInstall } from "./hooks/usePwaInstall";
import { useHistoryStack } from "./hooks/useHistoryStack";
import { useNotify } from "./hooks/useNotify";
import { useSites } from "./hooks/useSites";
import { useMultiSelect } from "./hooks/useMultiSelect";
import { useBulkActions } from "./hooks/useBulkActions";
import { useTagOpsActions } from "./hooks/useTagOpsActions";
import { useAiAssistant, useSiteAiMeta } from "./hooks/useAiAssistant";
import { AiContext } from "./context/AiContext";
import { useAppDialogs } from "./hooks/useAppDialogs";
import { useThemeController } from "./hooks/useThemeController";
import { useSortController } from "./hooks/useSortController";
import { useSiteCreator } from "./hooks/useSiteCreator";
import { useSemanticSearch } from "./hooks/useSemanticSearch";
import { useSiteActions } from "./hooks/useSiteActions";
import { useGroupActions } from "./hooks/useGroupActions";
import { useUndoRedo } from "./hooks/useUndoRedo";
import { useBackupController } from "./hooks/useBackupController";
import { useAppCommands } from "./hooks/useAppCommands";
import { usePrefSync } from "./hooks/usePrefSync";
import {
    wrapMutations,
    installOnlineListener,
    flushOfflineQueue,
    pendingCount,
    setAccountUid,
    type MutationApi,
} from "./API/offlineQueue";
import { advancedHint } from "./utils/advancedSearch";
import { backgroundMaskOpacity as backgroundMaskOpacityFromSlider } from "./utils/backgroundMask";
import { brandTitle } from "./brand";
import {
    SortMode,
    headerSearchSlotSx,
} from "./constants";
import HeaderSearchBox from "./components/HeaderSearchBox";
import HeaderActionsSlot from "./components/HeaderActionsSlot";
import LoginScreen from "./components/LoginScreen";
import SearchStatusLine from "./components/SearchStatusLine";
import DisplayControls from "./components/DisplayControls";
import HeaderGroupsButton from "./components/HeaderGroupsButton";
// 新增卡片 / 新建分组：点「新增」才用得到，懒加载。
// ⚠️ 注意 OverlayHost 里那五个（命令面板 / 书签导入 / 标签管理 / 两个 AI 弹窗）也走 lazy，
//    但它们写在 OverlayHost 里 —— 别只在这里数 lazy( 的个数，得看每个组件的 import 语句本身。
const AddSiteDialog = lazy(() => import("./components/AddSiteDialog"));
const EditGroupDialog = lazy(() => import("./components/EditGroupDialog"));
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
const VisitsDialog = lazy(() => import("./components/VisitsDialog"));
import {
    COLLAPSED_EVENT,
    isAllCollapsed,
    readCollapsedGroupIds,
    setAllCollapsed,
    writeCollapsedGroupIds,
} from "./utils/collapse";
import { splitIncomingConfigs } from "./utils/configMerge";
import { loadPinyinMatcher } from "./utils/pinyin";
import {
    collectCheckUrls,
    describeLinkCheck,
    FRESH_WINDOW_MS,
    mergeLinkHealth,
    probeLinks,
    readDeadLinks,
} from "./utils/linkHealth";
import { readBootstrapCache } from "./utils/firstPaintCache";
import {
    resetCollapsedState,
    switchAccountBoundary,
} from "./utils/sessionBoundary";
import { domCardEnv, focusCardByDirection as focusCardByDirectionImpl } from "./utils/cardFocus";
import { ParsedBookmarkGroup } from "./utils/bookmarks";
import { resolveIconApiUrl } from "./utils/iconApi";
import {
    DEFAULT_CONFIGS,
    DEFAULT_WEBDAV_CONFIG,
    WEBDAV_CONFIG_PREFIX,
    LINK_HEALTH_CONFIG,
    LINK_HEALTH_SYNC_CONFIG,
    PREF_SYNC_CONFIG,
    PREF_STARRED_CONFIG,
    PREF_TAGS_CONFIG,
    PREF_VISITS_CONFIG,
    PREF_COLLAPSED_CONFIG,
} from "./appDefaults";
import { setUndoAccountUid } from "./utils/undoPersist";
import SiteListBody from "./components/SiteListBody";
// 登录页是 lazy chunk（见 components/LoginScreen.tsx）：它不进首屏包，但登录页本身
// 是首屏 —— 所以配合下面的「预热」，让它的 chunk 与认证检查那次请求并行下载：
// 等 chunk 到位时正好渲染，用户感觉不到多等一次。
const BackupDialog = lazy(() => import("./components/BackupDialog"));
import "./App.css";
import {
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
// Material UI 导入
import {
    Container,
    Typography,
    Box,
    Button,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import TagBar from "./components/TagBar";
const ShortcutsDialog = lazy(() => import("./components/ShortcutsDialog"));

// 根据环境选择使用真实API还是模拟API
const isDevEnvironment = import.meta.env.DEV;
const useRealApi = import.meta.env.VITE_USE_REAL_API === "true";

/** 书签导入时同时最多建几张卡片：太高会把 D1 打满，太低一份大书签要等很久 */
const BOOKMARK_IMPORT_CONCURRENCY = 6;

const api =
    isDevEnvironment && !useRealApi
        ? new MockNavigationClient()
        : new NavigationClient(isDevEnvironment ? "http://localhost:8788/api" : "/api");

// 离线写入队列：给所有 mutation 方法包一层。离线 / 网络失败时把操作存本地，
// 恢复连接后由下面的 online 监听自动重放。模块级只跑一次。
wrapMutations(api as unknown as MutationApi);

// 默认值与配置键名都搬到了 ./appDefaults，这里只 import —— 见那个文件的注释。

// ---- 顶部工具栏的统一尺寸 ----
// 之前搜索框（40px）比按钮（32px）高一截，一行里高矮不齐；现在统一成一个高度、一个圆角。
// 主题模式（ThemeMode）定义在 ThemeToggle 里，这里直接引用，避免两处联合类型各写一份。
function App() {

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
        upsertSitesLocally,
        removeSiteLocally,
        removeSitesLocally,
    } = useSites({
        api,
        onRemoteExtras: applyRemoteExtras,
        onError: (msg) => handleError(msg),
        onAuthFail: () => {
            // 只有登录过的人才需要吊销会话；没登录过的那次 401 本来就是正常答复
            if (hadSessionRef.current) api.logout();
            setIsAuthRequired(true);
            setIsAuthenticatedTracked(false);
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

            // 访问统计：换台设备登录，点过的热度不该从零开始重攒
            try {
                mergeRemoteVisits(JSON.parse(incoming[PREF_VISITS_CONFIG] || "{}"));
            } catch {
                // 同上
            }

            // 分组折叠是「当前状态」而非累计量，所以直接以服务端那份为准
            // （本机刚改过的话，下面的上传会立刻把新状态推回去，不会来回打架）
            try {
                const remote = JSON.parse(incoming[PREF_COLLAPSED_CONFIG] || "null");
                if (Array.isArray(remote)) {
                    writeCollapsedGroupIds(
                        remote.filter((id: unknown) => typeof id === "string")
                    );
                }
            } catch {
                // 同上
            }
        }
    }

    // 用 ref 镜像最新的 groups：事件回调可以保持稳定引用（配合 memo 减少无谓重渲染）
    const groupsRef = useRef<GroupWithSites[]>([]);
    // 「折叠状态复位」的入口：折叠表声明在文件很后面（要读 collapsedIds 的初值），
    // 而退出 / 换账号的逻辑在前面 —— 用 ref 传一个稳定的调用入口，避免提前引用
    const resetCollapsedRef = useRef<() => void>(() => {});

    useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);

    // 新增认证状态（这两个开关留在 App：useSites 的鉴权失败回调比账号 hook 更早用到它们的 setter）
    const [isAuthRequired, setIsAuthRequired] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    // 「这一轮会话里到底有没有登录过」。
    // 鉴权失败时（bootstrap 401）要调 logout 把服务端会话吊销 —— 但从未登录过的访客
    // 打开页面同样是 401，这时候去 logout 只会给我们自己再制造一条 401：
    // 浏览器控制台上三条红色报错里有两条就是这么来的，看起来像崩了，其实只是没登录。
    const hadSessionRef = useRef(false);
    const setIsAuthenticatedTracked = (value: SetStateAction<boolean>) => {
        // 没法从 updater 里判断登录态，但函数式更新必然发生在「当前已登录」的前提下
        if (value !== false) hadSessionRef.current = true;
        setIsAuthenticated(value);
    };


    // 配置状态
    const [configs, setConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    const [openConfig, setOpenConfig] = useState(false);
    const [tempConfigs, setTempConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    // 账号管理弹窗（账号密码 / 恢复密钥 / 邀请码 / 注销）
    const [openAccount, setOpenAccount] = useState(false);
    const [savingAuth, setSavingAuth] = useState(false);

    // 设置弹窗里选色时的即时预览值（不落库，关闭弹窗即回滚）
    const [accentPreview, setAccentPreview] = useState<string | null>(null);
    // 保存网站设置的防连点守卫（同步 ref 拦同一轮连点，state 用于按钮禁用）
    const [savingConfig, setSavingConfig] = useState(false);

    // 自定义主色：只有合法的 #rgb / #rrggbb 才采用，避免脏数据把主题搞坏
    const accentRaw = (accentPreview ?? (configs["site.primaryColor"] || "")).trim();
    const accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentRaw) ? accentRaw : "";

    // 创建Material UI主题（放在 configs 之后，才能读到自定义主色）
    const { themeMode, setThemeMode, darkMode, toggleTheme, theme } = useThemeController(accent);

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

    // 新增菜单状态
    const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
    const openMenu = Boolean(menuAnchorEl);


    // 审计日志 / 回收站对话框状态
    const [openAudit, setOpenAudit] = useState(false);
    const [openRecycle, setOpenRecycle] = useState(false);



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
    liteMode,
    setLiteMode,
    offlineFull,
    setOfflineFull,
    iconPrivacy,
    setIconPrivacy,
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
        applyTagOps,
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
        mergeRemoteVisits,
        markVisitsSynced,
        setPrefsAccountUid,
    } = useUIPrefs();


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
    // 「分组」菜单的锚点（底栏与窄桌面顶栏共用同一个菜单）
    const [mobileGroupsAnchor, setMobileGroupsAnchor] = useState<HTMLElement | null>(
        null
    );
    // 锚点来自顶栏还是底栏：顶栏按钮在页面上方，菜单要往下展开；
    // 底栏按钮贴着屏幕下边缘，只能往上翻。两者共用菜单，方向得按锚点位置定。
    const [groupsAnchorFromTop, setGroupsAnchorFromTop] = useState(false);

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
        // setCommandOpen 来自 useAppDialogs，是 React 的 useState setter，引用恒定
    }, [setCommandOpen]);

    // 菜单打开关闭
    const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
        setMenuAnchorEl(event.currentTarget);
    };

    // 包成 useCallback：它进了很多 useMemo / useCallback 的依赖，
    // 每次渲染换一个引用会让那些记忆化全部失效
    const handleMenuClose = useCallback(() => {
        setMenuAnchorEl(null);
    }, []);

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

    // 底栏退场（视口宽过 899.98px）：只收掉挂在底栏按钮上的弹层，顶栏自己的别误伤
    const handleExitMobileViewport = useCallback(() => {
        setMenuAnchorEl(prev =>
            prev && prev.closest(".nav-mobile-tabbar") ? null : prev
        );
        setMobileGroupsAnchor(prev =>
            prev && prev.closest(".nav-mobile-tabbar") ? null : prev
        );
    }, []);

    // 顶栏「分组」按钮退场（视口离开 900~1343.98px）：这颗按钮只在那一档渲染，
    // 菜单挂在它上面，按钮一卸载 anchor 就失效（MUI 会让菜单飘到左上角），
    // 所以这里只收挂在这颗按钮上的那份，底栏那份归 handleExitMobileViewport 管。
    const handleExitGroupsButtonViewport = useCallback(() => {
        setMobileGroupsAnchor(prev =>
            prev && !prev.closest(".nav-mobile-tabbar") ? null : prev
        );
    }, []);

    // ---- 撤销 / 重做 ----
    // 每个破坏性操作做完就往栈里压一条「怎么把自己倒回去」的记录，
    // 提示条上的「撤销」按钮和 Ctrl+Z 走同一份逻辑，所以能连续撤好几步。
    const {
        push: pushHistory,
        undo: undoHistory,
        redo: redoHistory,
        hydrate: hydrateHistory,
        clear: clearHistory,
        canUndo,
        canRedo,
    } = useHistoryStack();

    /**
     * 切换账号时统一收拾本地状态（D03）。
     *
     * 换人登录最危险的不是界面没刷新，而是**上一个账号的本地数据继续生效**：
     * 离线队列里排着的操作会被补发到新账号名下，撤销快照能一键把别人的卡片改回来，
     * 撤销栈按钮还亮着。所以账号一变，这些都跟着换一份 / 清掉。
     */
    const switchAccount = useCallback(
        (uid: number | null) => {
            // 账号边界上要清哪几样、按什么顺序，集中在 utils/sessionBoundary.ts
            switchAccountBoundary(uid, {
                setQueueAccount: setAccountUid,
                setUndoAccount: setUndoAccountUid,
                setPrefsAccount: setPrefsAccountUid,
                clearHistory,
                resetCollapsed: () => resetCollapsedRef.current(),
            });
        },
        [clearHistory, setPrefsAccountUid]
    );

    // 统一提示函数（引用稳定，便于被 memo 的子组件复用）
    // duration 可选：成功/信息类默认短暂停留 2.2s，错误类默认 6s（便于阅读），传入则覆盖
    // action 可选：在提示条上挂一个操作按钮（删除后的「撤销」就靠它）
    // 处理错误的函数
    const handleError = useCallback(
        (errorMessage: string) => {
            // 离线队列已接住的操作：温和不报错，告诉用户会在联网后自动同步即可
            const isOfflineQueued = errorMessage.includes("离线保存") || errorMessage.includes("OfflineQueued");
            notify(errorMessage, isOfflineQueued ? "info" : "error");
            if (!isOfflineQueued) reportError(errorMessage, { source: "save-error" });
        },
        [notify]
    );

    // 认证与账号治理：整段搬到 hooks/useAccountSession.ts
    // （注册 / 登录 / 登出 / 恢复密钥 / 邀请码 / 会话 / 沉睡治理 / 注销）
    const {
        isAuthChecking,
        loginError,
        loginLoading,
        recoveryConfigured,
        currentUser,
        invite,
        deleteAccountOpen,
        setDeleteAccountOpen,
        deleteAccountPassword,
        setDeleteAccountPassword,
        deleteAccountBusy,
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
        checkAuthStatus,
        handleLogin,
        handleRecover,
        handleGenerateRecoveryKey,
        handleLogout,
    } = useAccountSession({
        api,
        notify,
        onError: handleError,
        onMenuClose: handleMenuClose,
        onDataError: setError,
        fetchData,
        onCloseSnackbar: handleCloseSnackbar,
        onSwitchAccount: switchAccount,
        onExitMultiSelect: exitMultiSelect,
        clearHistory,
        onResetCollapsed: () => resetCollapsedRef.current(),
        setGroups,
        setPrefsAccountUid,
        isAuthenticated,
        setIsAuthenticated: setIsAuthenticatedTracked,
        setIsAuthRequired,
    });

    // 加载配置（WebDAV 配置单独存放，避免被写进备份文件）
    const applyConfigs = (configsData: Record<string, string> | null | undefined) => {
        // WebDAV 配置单独存放，避免被写进备份文件（拆分规则见 utils/configMerge）
        const { configs: nextConfigs, webdav: nextWebdav } = splitIncomingConfigs(configsData);
        setConfigs(nextConfigs);
        setTempConfigs({ ...nextConfigs });
        setWebdavConfig(nextWebdav);
    };

    // 把一次 bootstrap 拉回的数据合并进本地状态
    // ---- 云端同步：上传（防抖 + 内容没变就不发）----
    // 只负责「本机 → 服务端」这一半；合并在 useSites 的 applyRemoteData（分组）与
    // 本文件的 applyRemoteExtras（配置 / 偏好 / 链接健康）里做。
    // 四段上传逻辑都在 hooks/usePrefSync.ts 里（失效检测 / 星标标签 / 访问统计 / 折叠态），
    // 调用点在 collapsedIds 声明之后 —— 上传要用到它，而 hook 调用顺序只要每渲染一致即可。

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
        // 当初这里顺手重置过排序状态（setSortMode(None) / setCurrentSortingGroupId(null)）。
        // 排序域搬到 useSortController 后，这两个状态本来就以 None 初始化，
        // 挂载时再设一遍是空操作；而 hook 的调用点在 handleError 之后，
        // 这里引用不到它的 setter，所以直接去掉这一段。
        // 故意只在挂载时跑一次：checkAuthStatus / applyRemoteData 每次渲染都是新函数，
        // 进 deps 会让这段每渲染重来一遍（重新读缓存、重发认证请求）。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 文档标题 / 自定义 CSS / 根节点 class / 主色与毛玻璃变量：
    // 一串纯 DOM 副作用（不改 React 树），搬到 hooks/useDocumentEffects.ts
    useDocumentEffects({ configs, darkMode, accent, glassEffects, liteMode });

    // 系统开了「减少动效」时，主动说一句清爽模式的存在。
    //
    // 只在「系统要求减动效 + 自己还没开清爽模式 + 从没提醒过」时说一次：
    // 这块-reactive CSS 已经帮他们把动画降下来了，但毛玻璃、头像模糊这些合成开销
    // 还得靠清爽模式才能省掉 —— 而那个开关埋在设置深处，不提一句多数人永远不会发现。
    useEffect(() => {
        try {
            if (typeof window.matchMedia !== "function") return;
            if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            if (liteMode) return;
            if (localStorage.getItem("navihive:hintedLiteMode") === "1") return;
            localStorage.setItem("navihive:hintedLiteMode", "1");
            notify("检测到系统偏好「减少动效」，可在设置里开启清爽模式省电", "info", 8000);
        } catch {
            // 隐私模式下 localStorage 写不进去，提示没出现也不影响使用
        }
    }, [liteMode, notify]);

    // PWA：把浏览器给的安装机会存下来，用户点「安装到桌面」时才弹原生安装框
    const { canInstall, promptInstall } = usePwaInstall();
    const handleInstallApp = useCallback(async () => {
        const accepted = await promptInstall();
        notify(accepted ? "已装到桌面，下次从桌面图标打开就行" : "已取消安装", accepted ? "success" : "info");
    }, [promptInstall, notify]);

    // ---- 撤销 / 重做的执行层 ----
    // 按下之后发生什么、以及刷新后把落盘的「可重放」记录捞回来，都在
    // hooks/useUndoRedo.ts（栈本身在 useHistoryStack）。引用点名字保持原样。
    const { runUndo, runRedo } = useUndoRedo({
        api,
        groupsRef,
        upsertSiteLocally,
        notify,
        undoHistory,
        redoHistory,
        hydrateHistory,
        groupsReady: groups.length > 0,
    });

    // 拉取全量数据：一次 bootstrap 请求搞定（原来要 1 次分组 + 每个分组一次站点 + 1 次配置）
    // silent=true 时不显示全屏 loading、不弹错误提示，用于修改后的后台同步
    // fetchData 每次渲染都是新函数（useSites 里没包 useCallback），直接进 deps 会让下面两个
    // effect 每渲染重跑一遍 —— 反复重装 online 监听、反复重放队列。用 ref 拿最新的一份，
    // 既不留过期闭包，也不重复注册。
    const fetchDataRef = useRef(fetchData);
    useEffect(() => {
        fetchDataRef.current = fetchData;
    });

    // 离线期间入队的写入，恢复连接后自动重放；重放完顺手后台刷新一次本地数据
    useEffect(() => {
        installOnlineListener(api as unknown as MutationApi, (done) => {
            notify(`已恢复连接，自动同步了 ${done} 项离线改动`, "success");
            void fetchDataRef.current({ silent: true });
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
                void fetchDataRef.current({ silent: true });
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

    // ---- 卡片的改 / 删 / 批量删 + 重复网址守卫 ----
    // 四条路径（改链接前查重、更新、单张删除、批量删除）连同各自的快照与撤销
    // 全在 hooks/useSiteActions.ts；快照与回执的纯计算在 utils/siteMutations.ts
    // （有单测）。引用点名字与抽走前一致，下面的 JSX 一行都不用改。
    const { guardDuplicate, handleSiteUpdate, handleSiteDelete, doSitesDelete } = useSiteActions({
        api,
        groupsRef,
        setDupPrompt,
        upsertSiteLocally,
        upsertSitesLocally,
        removeSiteLocally,
        removeSitesLocally,
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
    });

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

    // ---- 标签重命名 / 合并 ----
    // 改一个标签会同时动几十张卡片，所以走「整份写回 + 提示条上给一次撤销」，
    // 不做逐条修改（逐条改到一半失败就是半改名状态，没法收拾）。
    const { renameTagWithUndo, mergeTagsWithUndo } = useTagOpsActions({
        tags,
        applyTagOps,
        setActiveTags,
        notify,
    });

    // ---- AI 助手 ----
    // 默认关、配置不全时 ready 为 false，界面上所有 AI 入口都只是置灰并在旁边写清原因。
    const ai = useAiAssistant({ api });
    const aiStatusText = useMemo(() => {
        const st = ai.status;
        if (!st) return "";
        if (!st.enabled) return "未启用";
        if (st.problem) return st.problem;
        const provider = st.provider === "workers-ai" ? "Workers AI" : "OpenAI 兼容接口";
        return `已就绪（${provider} · ${st.textModel}）· 已建语义索引 ${st.embedded} 条`;
    }, [ai.status]);

    // 语义搜索用原始输入（不小写、不拆词）：模型见到的是用户真正打的那句话
    const aiQuery = searchQuery.trim();

    // 往下传给卡片的那份：只含「能不能补全」三个字段，引用稳定
    const siteAi = useSiteAiMeta(ai);

    const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
    // ---- AI 语义搜索 / 标签建议域 ----
    // 开关、命中、提示、忙碌四个状态 + 两个 effect（关掉清空 / 防抖重搜）
    // + 两个回调（建索引 / 应用标签建议）全在 useSemanticSearch 里；
    // 合并标签的纯计算在 utils/tagOps.ts 的 applyTagSuggestions（有单测）。
    // 返回值沿用原来的变量名与回调名，下面的 JSX 一行都不用改。
    const {
        openAiAssistant,
        setOpenAiAssistant,
        aiSuggestSites,
        semanticSearch,
        setSemanticSearch,
        semanticHits,
        semanticNote,
        semanticBusy,
        buildSemanticIndex,
        applyAiTagSuggestions,
    } = useSemanticSearch({
        ai,
        query: aiQuery,
        groups,
        tags,
        applyTagOps,
        notify,
    });

    // ---- 分组的改 / 删（删分组会连组内卡片一起删）----
    // 分组更新、删除确认、软删与整组重建（含卡片的本机标签 / 星标）全在
    // hooks/useGroupActions.ts；偏好快照复用 utils/siteMutations.ts 的
    // snapshotSitePrefs。引用点名字与抽走前一致，下面的 JSX 一行都不用改。
    const {
        handleGroupUpdate,
        pendingGroupDelete,
        setPendingGroupDelete,
        doGroupDelete,
        handleGroupDelete,
    } = useGroupActions({
        api,
        groupsRef,
        setGroups,
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
    });

    // ---- 排序 / 拖拽域 ----
    // 状态（sortMode / currentSortingGroupId / draggingSite）+ 六个事件回调 + 三个保存函数
    // 全在 useSortController 里；排列计算本身在 utils/sortable.ts（纯函数，有单测）。
    // 引用点名字与抽走前保持一致，下面的 JSX 一行都不用改。
    const {
        sortMode,
        currentSortingGroupId,
        draggingSite,
        startGroupSort,
        startSiteSort,
        cancelSort,
        handleDragEnd,
        nudgeGroup,
        handleSiteSortDragOver,
        handleSiteSortDragEnd,
        handleSiteDragStart,
        handleSiteDragCancel,
        handleSaveGroupOrder,
        handleSaveSiteOrder,
        handleSaveSiteSort,
    } = useSortController({
        api,
        groupsRef,
        setGroups,
        onError: handleError,
        onMenuClose: handleMenuClose,
    });
    // ---- 新建分组 / 新建卡片域 ----
    // 表单状态 + 九个回调全在 useSiteCreator 里；字段变更与图标跟随的计算在
    // utils/siteForm.ts（纯函数，有单测）。引用点名字保持原样，JSX 一行没改。
    const {
        openAddGroup,
        openAddSite,
        newSite,
        setNewSite,
        showNewSitePassword,
        setShowNewSitePassword,
        creatingSite,
        handleOpenAddGroup,
        handleCloseAddGroup,
        handleCreateGroup,
        handleOpenAddSite,
        handleCloseAddSite,
        handleSiteInputChange,
        handleFetchNewSiteIcon,
        handleCreateSite,
    } = useSiteCreator({
        api,
        groupsRef,
        setGroups,
        upsertSiteLocally,
        guardDuplicate,
        iconApi: configs["site.iconApi"],
        onError: handleError,
        onNotify: notify,
        onMenuClose: handleMenuClose,
    });

    // 新增站点弹窗的 AI 补全：只填名称与描述，成功不说话，失败才提示（与编辑站点同款）
    const [aiBusyNew, setAiBusyNew] = useState(false);
    const [aiMessageNew, setAiMessageNew] = useState("");
    const [aiMessageErrorNew, setAiMessageErrorNew] = useState(false);

    const handleAiCompleteNew = async () => {
        if (!siteAi?.enabled || !newSite.url) return;
        setAiBusyNew(true);
        setAiMessageNew("");
        setAiMessageErrorNew(false);
        const groupNames = groups.map(g => g.name);
        const res = await siteAi.siteMeta(newSite.url, {
            name: newSite.name || undefined,
            groups: groupNames,
            tags: allTags,
        });
        setAiBusyNew(false);
        if (!res.ok) {
            setAiMessageNew(res.message);
            setAiMessageErrorNew(true);
            return;
        }
        const { name, description } = res.data;
        setNewSite(prev => ({
            ...prev,
            name: name || prev.name,
            description: description || prev.description,
        }));
    };

    // 「网站设置」与管理员凭据的写逻辑：整段搬到 hooks/useSiteSettings.ts
    // （打开弹窗的初始化、临时配置编辑、凭据提交、整批保存）
    const {
        handleOpenConfig,
        handleSaveAuthCredentials,
        handleCloseConfig,
        pickAccent,
        handleConfigInputChange,
        handleConfigSliderChange,
        tempGlassBlur,
        handleGlassBlurChange,
        handleSaveConfig,
    } = useSiteSettings({
        api,
        notify,
        onError: handleError,
        onMenuClose: handleMenuClose,
        onLogout: handleLogout,
        onDataError: setError,
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
    });

    /**
     * 「上次推到服务端的内容」缓存，usePrefSync 与 useBackupController 共用：
     * 打开同步开关时后者会立刻推一次并记下内容，前者才不会转头又原样推一遍。
     */
    const lastHealthPushRef = useRef("");
    const lastPrefPushRef = useRef("");

    // 打开备份对话框（0=备份，1=恢复）
    const {
        openBackup,
        setOpenBackup,
        backupTab,
        importPreview,
        cronError,
        handleOpenBackup,
        handleCloseBackup,
        buildExportData,
        handleDownloadLocal,
        handleSaveWebdavConfig,
        handleToggleAutoBackup,
        handleToggleIncludeCredentials,
        handleToggleLinkHealthSync,
        handleTogglePrefSync,
        requestImportPreview,
        closeImportPreview,
        handleImportBackup,
    } = useBackupController({
        api,
        configs,
        groups,
        starred,
        tags,
        currentUser,
        notify,
        handleError,
        handleMenuClose,
        fetchData,
        restoreLocalPrefs,
        setConfigs,
        setWebdavConfig,
        setPrefSync,
        lastHealthPushRef,
        lastPrefPushRef,
    });

    // 搜索与筛选的派生链：整段搬到 hooks/useSiteSearch.ts
    // （关键词 → 检索索引 → 高级语法 → 语义叠加 → 星标/标签/失效 → 渲染上限 → 常用置前）
    const {
        query,
        advancedQuery,
        clearAllFilters,
        toggleActiveTag,
        deadCount,
        matchedCount,
        searchTruncated,
        searchExpanded,
        expandAllResults,
        collapseAllResults,
        currentGroupSites,
        reduceEntryAnimation,
        renderedCount,
        flatResults,
        dropdownOpen,
        historyOpen,
        openResult,
        applyHistoryTerm,
        displayedGroups,
    } = useSiteSearch({
        groups,
        searchQuery,
        usePinyin,
        semanticSearch,
        semanticHits,
        starred,
        tags,
        deadLinks,
        starFilter,
        deadOnly,
        activeTags,
        setStarFilter,
        setDeadOnly,
        setActiveTags,
        searchFocused,
        searchHistory,
        pushSearchHistory,
        setSearchFocused,
        setActiveResult,
        setSearchQuery,
        searchInputRef,
        visits,
        favoritesEnabled,
        activeGroupId,
    });

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
        const urls = collectCheckUrls(groups);
        if (urls.length === 0) {
            notify("还没有可以检测的链接", "info");
            return;
        }
        notify(`开始检测 ${urls.length} 个链接…`, "info");
        // 增量检测：7 天内探测过、或用户手动标记过「能访问」的链接直接跳过，
        // 同一域名也只探一次，避免每次都得等上几分钟
        const result = await probeLinks(urls, { concurrency: 5, skipFreshMs: FRESH_WINDOW_MS });
        setDeadLinks(result.dead);
        const { text, severity, offerFilter } = describeLinkCheck(
            Object.keys(result.dead).length,
            result.skipped
        );
        notify(
            text,
            severity,
            undefined,
            // 有可疑链接时给个快捷入口，省得自己一张张翻
            offerFilter ? { label: "只看失效", onClick: () => setDeadOnly(true) } : undefined
        );
    }, [groups, notify, setDeadLinks]);

    // 书签导入：同名文件夹复用已有分组，其余新建。
    // 重复与无效的链接在弹窗里已经筛掉了，这里只管建 —— 建卡片限并发，
    // 一份几百条的书签逐个 await 会慢到以为卡住了。
    const importBookmarks = useCallback(
        async (parsed: ParsedBookmarkGroup[]) => {
            let created = 0;
            let groupSeq = 0;
            const iconTemplate = (configs["site.iconApi"] || "").trim();

            for (const folder of parsed) {
                if (folder.items.length === 0) continue;
                let target = groups.find(g => g.name === folder.folder);
                if (!target) {
                    const saved = await api.createGroup({
                        name: folder.folder,
                        order_num: groups.length + groupSeq,
                    } as Group);
                    groupSeq += 1;
                    target = { ...saved, sites: [] } as GroupWithSites;
                }
                const baseOrder = target.sites?.length ?? 0;
                const groupId = target.id;
                const done = await mapWithConcurrency(
                    folder.items,
                    BOOKMARK_IMPORT_CONCURRENCY,
                    async (item, idx) => {
                        await api.createSite({
                            name: item.title.slice(0, 60),
                            url: item.url,
                            icon: resolveIconApiUrl(iconTemplate, item.url),
                            description: "",
                            group_id: groupId,
                            order_num: baseOrder + idx,
                        } as Site);
                        return 1;
                    }
                );
                created += done.length;
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
    resetCollapsedRef.current = resetCollapsedState(setCollapsedIds);

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

    // 四份本机偏好的上传（失效检测 / 星标标签 / 访问统计 / 折叠态）统一在这里接上，
    // 具体实现见 hooks/usePrefSync.ts
    usePrefSync({
        api,
        lastHealthPushRef,
        lastPrefPushRef,
        linkHealthSync: configs[LINK_HEALTH_SYNC_CONFIG] === "true",
        prefSync,
        starred,
        tags,
        visits,
        onVisitsSynced: markVisitsSynced,
        collapsedIds,
    });

    const allGroupsCollapsed = isAllCollapsed(realGroups, collapsedIds);

    const toggleCollapseAll = useCallback(() => {
        const next = !allGroupsCollapsed; // true = 折叠全部
        setAllCollapsed(
            realGroups.map(g => g.id),
            next
        );
        // 折叠 / 展开是即时可见的操作，不再弹提示打扰
    }, [allGroupsCollapsed, realGroups]);

    // 命令面板：站点跳转 + 常用操作，键盘党不用摸鼠标。
    // 条目本身搬到 hooks/useAppCommands.ts —— App 只把动作传进去，
    // 「哪条命令叫什么、按下去跑什么」由那边统一维护。
    const commands = useAppCommands({
        groups,
        canUndo,
        canRedo,
        density,
        favoritesEnabled,
        glassEffects,
        allGroupsCollapsed,
        multiSelect,
        starFilter,
        railCollapsed,
        recordVisit,
        runUndo,
        runRedo,
        setViewMode,
        setDensity,
        toggleTheme,
        setFavoritesEnabled,
        setGlassEffects,
        setOpenShortcuts,
        handleOpenAddGroup,
        startGroupSort,
        handleOpenConfig,
        setOpenAccount,
        fetchAccountList,
        handleOpenBackup,
        setBookmarkOpen,
        runLinkCheck,
        setOpenVisits,
        toggleCollapseAll,
        exitMultiSelect,
        setMultiSelect,
        setStarFilter,
        setRailCollapsed,
        clearVisits,
    });

    // 顶栏 / 底栏的「新增」主按钮：默认开「新增网站」。
    // 落到哪个分组按「当前正在看的那个」算 —— 以前固定挂到第一个分组，
    // 用户滚到第三个分组点新增，卡片却出现在列表最上面，等于白找一趟。
    // 没有正在看的分组（刚打开、或者左栏没启用）就退回第一个；
    // 一个分组都还没有时，退回到「新增分组」——不然点了没反应。
    const handleQuickAdd = useCallback(() => {
        const current =
            activeGroupId === null
                ? undefined
                : groups.find(g => g.id === activeGroupId && g.id !== undefined);
        const target = current ?? groups.find(g => g.id !== undefined);
        if (target) {
            handleOpenAddSite(target.id as number);
            return;
        }
        handleOpenAddGroup();
    }, [groups, activeGroupId, handleOpenAddSite, handleOpenAddGroup]);

    // 「新增」按钮上的目标分组名：让用户点之前就知道卡片会落到哪
    const quickAddTargetName = useMemo(() => {
        const current =
            activeGroupId === null
                ? undefined
                : groups.find(g => g.id === activeGroupId && g.id !== undefined);
        const target = current ?? groups.find(g => g.id !== undefined);
        return target?.name ?? "";
    }, [groups, activeGroupId]);

    // 方向键在卡片之间移动焦点（按几何位置找同行/同列的邻居）
    const focusCardByDirection = (dir: "left" | "right" | "up" | "down") =>
        focusCardByDirectionImpl(dir, domCardEnv());

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

    // openResult 每次渲染都是新函数，进 deps 会让键盘监听每渲染拆装一次；
    // 用 ref 拿最新的一份（和上面的 fetchDataRef 同一个套路）。
    const openResultRef = useRef(openResult);
    useEffect(() => {
        openResultRef.current = openResult;
    });

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
                    if (picked) openResultRef.current(picked.site);
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
                        openResultRef.current(picked.site);
                    }
                    return;
                }
                const target = currentGroupSites[index];
                if (target) {
                    e.preventDefault();
                    openResultRef.current(target);
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
    }, [flatResults, activeResult, runUndo, runRedo, searchQuery, currentGroupSites, setOpenShortcuts]);

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
    // 预热登录页：本地没有可用令牌时，这次启动大概率要走到登录页。
    // 趁认证检查那次请求还在飞就把 chunk 拉下来，两边并行，登录页就不多等一次。
    // 有令牌（已登录 / 记住我）时完全不拉 —— 不能让常用路径为一个用不上的组件付流量。
    useEffect(() => {
        if (!api.isLoggedIn()) void import("./components/LoginForm");
        // 只在挂载时判断一次：这是「本次启动要不要预热」的问题，不是跟着状态变的
    }, []);

    // 如果正在检查认证状态，显示加载界面
    if (isAuthChecking) {
        return <LoginScreen theme={theme} checking />;
    }

    // 如果需要认证但未认证，显示登录界面
    if (isAuthRequired && !isAuthenticated) {
        return (
            <LoginScreen
                theme={theme}
                brandName={brandTitle(configs["site.title"])}
                onLogin={handleLogin}
                loading={loginLoading}
                error={loginError}
                onRecover={handleRecover}
                recoverConfigured={recoveryConfigured}
                onRegister={handleRegister}
            />
        );
    }

    // ---- 背景图片相关（来自「网站设置」） ----
    const backgroundImageUrl = (configs["site.backgroundImage"] || "").trim();
    const hasBackgroundImage = backgroundImageUrl.length > 0;
    // 滑块值越大 → 图片越清晰 → 蒙版越淡（换算与下限都在 utils/backgroundMask 里：
    // 拉到最右也保留一层最小蒙版，保证自定义背景上的文字始终读得清）
    const backgroundMaskOpacity = backgroundMaskOpacityFromSlider(
        Number(configs["site.backgroundMaskOpacity"])
    );

    return (
        <AppConfigProvider value={appConfigValue}>
         <NotifyContext.Provider value={notify}>
            <AiContext.Provider value={siteAi}>
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
                        clock={<HeaderClock />}
                        actions={
                            <>
                                {sortMode === SortMode.None && (
                                    <Box className='nav-header-search' sx={headerSearchSlotSx}>
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
                                        semantic={{
                                            enabled: semanticSearch,
                                            onToggle: setSemanticSearch,
                                            ready: ai.ready,
                                            reason: ai.reason,
                                            busy: semanticBusy,
                                        }}
                                    />
                                    </Box>
                                )}
                                {/* 窄桌面（900~1343px）的分组入口：这一段左栏没有、底栏也没有 */}
                                {sortMode === SortMode.None && (
                                    <HeaderGroupsButton
                                        onOpen={event => {
                                            setMobileGroupsAnchor(event.currentTarget);
                                            setGroupsAnchorFromTop(true);
                                        }}
                                        open={Boolean(mobileGroupsAnchor)}
                                        count={displayedGroups.length}
                                        onExitViewport={handleExitGroupsButtonViewport}
                                    />
                                )}
                                {/* 显示控制：星标 / 当前视图（点开是密度与主题）/ 多选。
                                    紧跟搜索：这几项都属于「当下怎么看这个列表」 */}
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
                                        setThemeMode={setThemeMode}
                                        favoritesEnabled={favoritesEnabled}
                                        onFavoritesEnabledChange={setFavoritesEnabled}
                                    />
                                )}
                                <HeaderActionsSlot
                                    sortMode={sortMode}
                                    onSaveGroupOrder={handleSaveGroupOrder}
                                    onSaveSiteSort={handleSaveSiteSort}
                                    onCancelSort={cancelSort}
                                    onQuickAdd={handleQuickAdd}
                                    addTargetName={quickAddTargetName}
                                    onOpenAddGroup={handleOpenAddGroup}
                                    onMenuOpen={handleMenuOpen}
                                    menuOpen={openMenu}
                                    menuAnchorEl={menuAnchorEl}
                                    onMenuClose={handleMenuClose}
                                    onOpenConfig={handleOpenConfig}
                                    onOpenAccount={() => {
                                        handleMenuClose();
                                        setOpenAccount(true);
                                        void fetchAccountList();
                                        void fetchSessions();
                                    }}
                                    onStartGroupSort={startGroupSort}
                                    canInstall={canInstall}
                                    onInstallApp={() => void handleInstallApp()}
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
                                    onOpenAiAssistant={() => {
                                        handleMenuClose();
                                        setOpenAiAssistant(true);
                                    }}
                                    onOpenShortcuts={() => setOpenShortcuts(true)}
                                    isSiteOwner={currentUser?.role === "owner"}
                                />
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
                    <SearchStatusLine
                        filtering={
                            sortMode === SortMode.None &&
                            Boolean(query || starFilter || deadOnly || activeTags.length > 0)
                        }
                        matchedCount={matchedCount}
                        renderedCount={renderedCount}
                        searchTruncated={searchTruncated}
                        searchExpanded={searchExpanded}
                        onExpand={expandAllResults}
                        onCollapse={collapseAllResults}
                        hint={sortMode === SortMode.None ? advancedHint(advancedQuery) : ""}
                        semanticEnabled={sortMode === SortMode.None && semanticSearch}
                        semanticNote={semanticNote}
                        aiReady={ai.ready}
                        embeddedCount={ai.status?.embedded ?? 0}
                        semanticBusy={semanticBusy}
                        onBuildSemanticIndex={() => void buildSemanticIndex(true)}
                    />

                    {/* 语义搜索的两句话：没索引就教他建一个，搜不到就说清楚下面的是关键词结果 */}
                    {semanticSearch && (
                        <Typography
                            variant='caption'
                            color='text.secondary'
                            sx={{ display: "block", mt: -2, mb: 2 }}
                        >
                            {semanticNote ? `${semanticNote}。` : null}
                            {ai.ready && (ai.status?.embedded ?? 0) === 0 ? (
                                <>
                                    {" "}
                                    语义搜索要先给站点建一次索引。
                                    <Button
                                        size='small'
                                        disabled={semanticBusy}
                                        onClick={() => void buildSemanticIndex(true)}
                                        sx={{ minWidth: 0, px: 0.5, fontSize: 12 }}
                                    >
                                        {semanticBusy ? "正在生成…" : "现在生成"}
                                    </Button>
                                </>
                            ) : null}
                        </Typography>
                    )}

                    {loading && <SiteListSkeleton />}

                    {!loading && !error && (
                        <SiteListBody
                            sortMode={sortMode}
                            sensors={sensors}
                            onGroupDragEnd={handleDragEnd}
                            groups={groups}
                            onNudgeGroup={nudgeGroup}
                            onSiteDragStart={handleSiteDragStart}
                            onSiteDragOver={handleSiteSortDragOver}
                            onSiteDragEnd={handleSiteSortDragEnd}
                            onSiteDragCancel={handleSiteDragCancel}
                            draggingSite={draggingSite}
                            darkMode={darkMode}
                            onSiteUpdate={handleSiteUpdate}
                            onSiteDelete={handleSiteDelete}
                            onSaveSiteOrder={handleSaveSiteOrder}
                            onStartSiteSort={startSiteSort}
                            onAddSite={handleOpenAddSite}
                            onGroupUpdate={handleGroupUpdate}
                            onGroupDelete={handleGroupDelete}
                            displayedGroups={displayedGroups}
                            density={density}
                            reduceEntryAnimation={reduceEntryAnimation}
                            currentSortingGroupId={currentSortingGroupId}
                            configs={configs}
                            onGroupAccentChange={handleGroupAccentChange}
                            selectMode={multiSelect}
                            selectedIds={selectedIds}
                            onToggleSelect={toggleSelect}
                            query={query}
                            activeTags={activeTags}
                            starFilter={starFilter}
                            deadOnly={deadOnly}
                            onClearSearch={() => setSearchQuery("")}
                            onClearFilters={clearAllFilters}
                        />
                    )}

                    {/* 新增分组对话框（与「编辑分组」共用同一套样式与尺寸）
                        两个都是 lazy chunk，套一层 Suspense 兜住首次打开时的加载间隙 */}
                    <Suspense fallback={null}>
                        <EditGroupDialog
                            open={openAddGroup}
                            group={null}
                            mode='create'
                            onClose={handleCloseAddGroup}
                            onSave={group => handleCreateGroup(group.name)}
                        />

                        <AddSiteDialog
                            open={openAddSite}
                            onClose={handleCloseAddSite}
                            site={newSite}
                            onInputChange={handleSiteInputChange}
                            showPassword={showNewSitePassword}
                            onTogglePassword={setShowNewSitePassword}
                            creating={creatingSite}
                            onFetchIcon={handleFetchNewSiteIcon}
                            onCreate={handleCreateSite}
                            ai={siteAi}
                            aiBusy={aiBusyNew}
                            aiMessage={aiMessageNew}
                            aiMessageError={aiMessageErrorNew}
                            onAiComplete={handleAiCompleteNew}
                        />
                    </Suspense>
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
                        offlineFull={offlineFull}
                        onOfflineFullChange={setOfflineFull}
                        iconPrivacy={iconPrivacy}
                        onIconPrivacyChange={setIconPrivacy}
                        liteMode={liteMode}
                        onLiteModeChange={setLiteMode}
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
                        onSweepInactive={handleSweepInactive}
                        sessions={sessions}
                        onRevokeSession={jti => void handleRevokeSession(jti)}
                        onRevokeOthers={() => void handleRevokeOthers()}
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
                        syncEnabled={configs[PREF_SYNC_CONFIG] === "true"}
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
                    retentionDays={Number(configs[RETENTION_DAYS_KEY]) || undefined}
                />
                </Suspense>

                {/* 回收站：还原 / 彻底删除被软删除的站点、分组 */}
                <Suspense fallback={null}>
                <RecycleBinDialog
                    open={openRecycle}
                    onClose={() => setOpenRecycle(false)}
                    client={api as unknown as NavigationClient}
                    retentionDays={Number(configs[RETENTION_DAYS_KEY]) || undefined}
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
                    // 影响面写实数：删的是哪一组、连带多少个网站，别让用户自己数
                    impact={{
                        object: "分组及组内网站",
                        count:
                            (groups.find(g => g.id === pendingGroupDelete)?.sites.length ?? 0) + 1,
                        undoable: true,
                    }}
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
                        onGroups: event => {
                            setMobileGroupsAnchor(event.currentTarget);
                            setGroupsAnchorFromTop(false);
                        },
                        // 和顶栏主按钮同一个动作：默认新增网站，没分组时才去建分组
                        onAdd: handleQuickAdd,
                        onMore: event =>
                            handleMenuOpen(event as React.MouseEvent<HTMLButtonElement>),
                        onExitViewport: handleExitMobileViewport,
                        onToggleStar: () => setStarFilter(!starFilter),
                        starActive: starFilter,
                        badge: displayedGroups.length,
                        groupsAnchor: mobileGroupsAnchor,
                        groupsPlacement: groupsAnchorFromTop ? "top" : "bottom",
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
                        groups: groups,
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
                    aiSuggest={{
                        open: aiSuggestOpen,
                        onClose: () => setAiSuggestOpen(false),
                        ai,
                        sites: aiSuggestSites,
                        groups: groups.map(g => g.name),
                        allTags,
                        onApply: applyAiTagSuggestions,
                    }}
                    aiAssistant={{
                        open: openAiAssistant,
                        onClose: () => setOpenAiAssistant(false),
                        // 只传读写配置那两个方法：AI 弹窗不该摸到别的 API
                        api: {
                            getConfigs: () => api.getConfigs(),
                            setConfigs: (configs: Record<string, string>) => api.setConfigs(configs),
                        },
                        ai,
                        onSaved: () => void ai.refresh(),
                        statusText: aiStatusText,
                    }}
                    tagManager={{
                        open: tagManagerOpen,
                        tags: allTags,
                        counts: tagCounts,
                        onDeleteTag: deleteTagWithUndo,
                        onRenameTag: renameTagWithUndo,
                        onMergeTags: (sources, target) => mergeTagsWithUndo(sources, target),
                        onAiSuggest: () => setAiSuggestOpen(true),
                        onClose: () => setTagManagerOpen(false),
                    }}
                />
            </Box>
        </ThemeProvider>
            </AiContext.Provider>
         </NotifyContext.Provider>
        </AppConfigProvider>
    );
}

export default App;
