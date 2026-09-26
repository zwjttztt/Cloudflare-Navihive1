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
import { Site, Group, ExportData, BootstrapData, WebDavConfig, normalizeImportData } from "./API/http";
import { GroupWithSites } from "./types";
import { AppConfigProvider } from "./context/AppConfigContext";
import { NotifyContext } from "./context/NotifyContext";
import type { NotifyAction } from "./context/NotifyContext";
import { useUIPrefs, RADIUS_PX } from "./context/UIPrefsContext";
import SiteCard from "./components/SiteCard";
import GroupNavRail from "./components/GroupNavRail";
import MobileTabBar from "./components/MobileTabBar";
// 弹窗/面板类组件按需加载：首屏用不到它们，拆出去能让主包小一大截
import type { CommandItem } from "./components/CommandPalette";
const CommandPalette = lazy(() => import("./components/CommandPalette"));
const BookmarkImportDialog = lazy(() => import("./components/BookmarkImportDialog"));
import ScrollProgress from "./components/ScrollProgress";
import BackToTop from "./components/BackToTop";
const SettingsDialog = lazy(() => import("./components/SettingsDialog"));
const ImportPreviewDialog = lazy(() => import("./components/ImportPreviewDialog"));
import HeaderClock from "./components/HeaderClock";
const VisitsDialog = lazy(() => import("./components/VisitsDialog"));
import EmptyArt from "./components/EmptyArt";
import { COLLAPSED_EVENT, readCollapsedGroupIds, setAllCollapsed } from "./utils/collapse";
import { DuplicateHit, findDuplicateSite } from "./utils/duplicate";
import { loadPinyinMatcher } from "./utils/pinyin";
import { FRESH_WINDOW_MS, probeLinks } from "./utils/linkHealth";
import { clearBootstrapCache, readBootstrapCache, writeBootstrapCache } from "./utils/firstPaintCache";
import { ParsedBookmarkGroup } from "./utils/bookmarks";
import { DEFAULT_ICON_API, resolveIconApiUrl } from "./utils/iconApi";
import { groupAccent } from "./utils/groupColor";
import { matchesGroupQuery, matchesSiteQuery } from "./utils/search";
import {
    RECENT_GROUP_SIZE,
    recentVisitCount,
} from "./utils/time";
import { saveRememberedLogin, clearRememberedLogin } from "./utils/rememberedLogin";
import ThemeToggle from "./components/ThemeToggle";
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
    Alert,
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
    Menu,
    MenuItem,
    Divider,
    ListItemIcon,
    ListItemText,
    Snackbar,
    Tooltip,
    InputAdornment,
    Skeleton,
    ToggleButton,
    ToggleButtonGroup,
    Popper,
    Paper,
    List,
    ListItemButton,
    Switch,
} from "@mui/material";
import SortIcon from "@mui/icons-material/Sort";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import SettingsIcon from "@mui/icons-material/Settings";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import SearchIcon from "@mui/icons-material/Search";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import ViewListIcon from "@mui/icons-material/ViewList";
import ViewCompactIcon from "@mui/icons-material/ViewCompact";
import DensityMediumIcon from "@mui/icons-material/DensityMedium";
import DensitySmallIcon from "@mui/icons-material/DensitySmall";
import StarIcon from "@mui/icons-material/Star";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import BookmarkAddedIcon from "@mui/icons-material/BookmarkAdded";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import InsightsIcon from "@mui/icons-material/Insights";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import BlurOnIcon from "@mui/icons-material/BlurOn";
import BlurOffIcon from "@mui/icons-material/BlurOff";
import InfoRoundedIcon from "@mui/icons-material/InfoRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import { alpha } from "@mui/material/styles";
import BulkActionBar from "./components/BulkActionBar";
import TagBar from "./components/TagBar";
const TagManagerDialog = lazy(() => import("./components/TagManagerDialog"));
import ConfirmDialog from "./components/ConfirmDialog";

// 根据环境选择使用真实API还是模拟API
const isDevEnvironment = import.meta.env.DEV;
const useRealApi = import.meta.env.VITE_USE_REAL_API === "true";

const api =
    isDevEnvironment && !useRealApi
        ? new MockNavigationClient()
        : new NavigationClient(isDevEnvironment ? "http://localhost:8788/api" : "/api");

// 排序模式枚举
enum SortMode {
    None, // 不排序
    GroupSort, // 分组排序
    SiteSort, // 站点排序
}

// 默认配置
const DEFAULT_CONFIGS = {
    "site.title": "MyHomepage",
    "site.name": "MyHomepage",
    "site.customCss": "",
    // 一键获取图标所用的 API 模板，{domain} 会被替换成站点域名
    "site.iconApi": DEFAULT_ICON_API,
    // 背景图片与蒙版透明度（0~1，越大背景图越清晰）
    "site.backgroundImage": "",
    "site.backgroundMaskOpacity": "0.15",
    // 站点缩略图 API 模板（{url} / {domain} / {origin} 会被替换），留空表示不启用缩略图
    "site.thumbApi": "",
    // 自定义主色（#rrggbb），留空表示跟随默认主题色
    "site.primaryColor": "",
    // 毛玻璃模糊强度（px，0~24），留空表示用默认 14
    "site.glassBlur": "",
};


// 判断一个背景值是不是 CSS 渐变（渐变可以直接当 background-image 用，图片要包 url()）
const isCssGradient = (value: string) => /^\s*(linear|radial|conic)-gradient\(/i.test(value);


// WebDAV 备份默认配置（保存在服务端 configs 表中，不会写入备份文件）
const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
    url: "",
    username: "",
    password: "",
    path: "navihive-backup",
};

// WebDAV 配置在 configs 表中的键名前缀
const WEBDAV_CONFIG_PREFIX = "webdav.";

// 主题模式：浅色 / 深色 / 跟随系统
type ThemeMode = "light" | "dark" | "system";

// ---- 顶部工具栏的统一尺寸 ----
// 之前搜索框（40px）比按钮（32px）高一截，一行里高矮不齐；现在统一成一个高度、一个圆角。
const HEADER_CONTROL_H = 36;
const HEADER_RADIUS = "14px";
// 搜索框 / 按钮 / 胶囊共用：高度对齐 + 圆角一致
const headerControlSx = {
    minWidth: "auto",
    height: HEADER_CONTROL_H,
    borderRadius: HEADER_RADIUS,
    fontSize: { xs: "0.75rem", sm: "0.875rem" },
};
// 逻辑分组之间的竖向分隔线（搜索 | 操作 | 显示 | 时钟）
const headerDividerSx = {
    width: "1px",
    alignSelf: "stretch",
    my: 0.75,
    bgcolor: "var(--glass-border)",
    flexShrink: 0,
};

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

    const [groups, setGroups] = useState<GroupWithSites[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
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
    // 找回密码：用应急重置码重设管理员密码
    const [resetLoading, setResetLoading] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);
    const [resetConfigured, setResetConfigured] = useState(true);
    const [loginLoading, setLoginLoading] = useState(false);

    // 配置状态
    const [configs, setConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    const [openConfig, setOpenConfig] = useState(false);
    const [tempConfigs, setTempConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);

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
                    // 所有弹窗默认走同一套毛玻璃面板：半透明底 + 模糊 + 细边框 + 柔和投影，
                    // 单个弹窗自己写了 paper sx 的话会覆盖这里（比如确认弹窗、命令面板）
                    MuiDialog: {
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
                            }),
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

    // 新增卡片时是否明文显示密码
    const [showNewSitePassword, setShowNewSitePassword] = useState(false);

    // 正在创建站点：按钮置灰 + 防止连点创建出多张卡片
    const [creatingSite, setCreatingSite] = useState(false);
    // setState 要等下一次渲染才生效，连点两下时用 ref 同步兜住
    const creatingSiteRef = useRef(false);

    // 错误提示框状态
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState("");
    const [snackbarSeverity, setSnackbarSeverity] = useState<"success" | "error" | "info">("error");
    const [snackbarDuration, setSnackbarDuration] = useState(6000);
    // 提示条上的操作按钮（删除后点「撤销」把卡片/分组恢复回来）
    const [snackbarAction, setSnackbarAction] = useState<NotifyAction | null>(null);
    // 读屏专用：提示条会自动消失，这里留一份纯文本供屏幕阅读器播报
    const [liveMessage, setLiveMessage] = useState("");
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
        void loadPinyinMatcher().then(() => {
            if (!cancelled) setPinyinReady(true);
        });
        return () => {
            cancelled = true;
        };
    }, [pinyinSearch]);
    const usePinyin = pinyinSearch && pinyinReady;

    // 批量多选：进入后点卡片是「勾选」而不是打开网页
    const [multiSelect, setMultiSelect] = useState(false);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    // 批量删除前的确认弹窗
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
    // 重复网址确认：撞车时先问一句，run 是用户确认后真正要执行的动作
    const [dupPrompt, setDupPrompt] = useState<{
        url: string;
        hit: DuplicateHit;
        run: () => void | Promise<void>;
    } | null>(null);
    // 筛选：只看星标 + 标签（可多选，取交集）
    const [starFilter, setStarFilter] = useState(false);
    const [activeTags, setActiveTags] = useState<string[]>([]);
    // 「标签管理」弹窗是否打开
    const [tagManagerOpen, setTagManagerOpen] = useState(false);
    // 「只看失效」：失效检测跑完后可以一键把可疑链接筛出来
    const [deadOnly, setDeadOnly] = useState(false);

    // 退出多选模式时顺手清掉勾选，避免下次进来还残留上一次的选择
    const exitMultiSelect = useCallback(() => {
        setMultiSelect(false);
        setSelectedIds([]);
    }, []);

    const toggleSelect = useCallback((siteId: number) => {
        setSelectedIds(prev =>
            prev.includes(siteId) ? prev.filter(id => id !== siteId) : [...prev, siteId]
        );
    }, []);

    // 命令面板（Ctrl / Cmd + K）
    const [commandOpen, setCommandOpen] = useState(false);
    // 访问统计弹窗（热力图 + Top5）
    const [openVisits, setOpenVisits] = useState(false);
    // 浏览器书签导入
    const [bookmarkOpen, setBookmarkOpen] = useState(false);
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

    // 检查认证状态
    // 优化点：不再单独发一次 checkAuthStatus 请求，直接拉 bootstrap
    // —— 拿得到数据即已登录，401 就是未登录/令牌失效，整个启动过程只花 1 次请求
    const checkAuthStatus = async () => {
        try {
            setIsAuthChecking(true);

            // 顺带确认是否配置了应急重置码（未登录也能查，失败就当作已配置，不影响登录）
            api
                .getResetCodeStatus()
                .then(status => setResetConfigured(status?.configured !== false))
                .catch(() => setResetConfigured(true));

            const ok = await fetchData();

            if (ok) {
                setIsAuthenticated(true);
                setIsAuthRequired(false);
            } else if (!api.isLoggedIn()) {
                // 本地没有可用令牌
                setIsAuthenticated(false);
                setIsAuthRequired(true);
            }
        } catch (error) {
            console.error("认证检查失败:", error);
            if (error instanceof Error && error.message.includes("认证")) {
                setIsAuthenticated(false);
                setIsAuthRequired(true);
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
                setSnackbarOpen(false);
                // 加载数据（一次 bootstrap 请求）
                await fetchData();
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
            handleError("登录失败: " + (error instanceof Error ? error.message : "未知错误"));
            setIsAuthenticated(false);
        } finally {
            setLoginLoading(false);
        }
    };

    // 用应急重置码重设管理员密码（登录页「忘记密码」入口）
    const handleResetPassword = async (code: string, newPassword: string) => {
        try {
            setResetLoading(true);
            setResetError(null);

            const result = await api.resetPasswordWithCode(code, newPassword);

            if (result?.success) {
                setResetError(null);
                setSnackbarOpen(false);
                notify(result.message || "密码已重置，请使用新密码登录", "success");
                // 回到登录页，并把刚设的新密码清掉旧的「记住账号密码」
                clearRememberedLogin();
            } else {
                setResetError(result?.message || "重置密码失败，请稍后再试");
            }
        } catch (error) {
            console.error("重置密码失败:", error);
            setResetError("重置密码失败: " + (error instanceof Error ? error.message : "未知错误"));
        } finally {
            setResetLoading(false);
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
                if (field === "url" || field === "username" || field === "password" || field === "path") {
                    nextWebdav[field] = value;
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
    const applyRemoteData = (data: BootstrapData) => {
        const sitesByGroup = new Map<number, Site[]>();
        for (const site of data.sites || []) {
            const list = sitesByGroup.get(site.group_id);
            if (list) {
                list.push(site);
            } else {
                sitesByGroup.set(site.group_id, [site]);
            }
        }

        const nextGroups: GroupWithSites[] = (data.groups || [])
            .filter(group => group.id !== undefined)
            .map(group => ({
                ...group,
                id: group.id as number,
                sites: (sitesByGroup.get(group.id as number) || []).sort(
                    (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                ),
            }));

        setGroups(nextGroups);
        applyConfigs(data.configs);
    };

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
    const notify = useCallback(
        (
            message: string,
            severity: "success" | "error" | "info" = "info",
            duration?: number,
            action?: NotifyAction
        ) => {
            setSnackbarMessage(message);
            setSnackbarSeverity(severity);
            setSnackbarDuration(duration ?? (severity === "error" ? 6000 : 2200));
            setSnackbarAction(action ?? null);
            setSnackbarOpen(true);
            // 读屏播报完就把文本清掉：这个区域视觉上不可见，但 innerText 里能捞到，
            // 留着会让「页面上还有没有某条提示」这类判断失真
            setLiveMessage(message);
            window.setTimeout(() => {
                setLiveMessage(prev => (prev === message ? "" : prev));
            }, 1500);
        },
        []
    );

    // 处理错误的函数
    const handleError = useCallback(
        (errorMessage: string) => {
            notify(errorMessage, "error");
            console.error(errorMessage);
        },
        [notify]
    );

    // 关闭错误提示框
    const handleCloseSnackbar = () => {
        setSnackbarOpen(false);
    };

    // 拉取全量数据：一次 bootstrap 请求搞定（原来要 1 次分组 + 每个分组一次站点 + 1 次配置）
    // silent=true 时不显示全屏 loading、不弹错误提示，用于修改后的后台同步
    const fetchData = async ({ silent = false }: { silent?: boolean } = {}): Promise<boolean> => {
        if (!silent) {
            setLoading(true);
            setError(null);
        }

        try {
            const data = await api.bootstrap();
            applyRemoteData(data);
            // 留一份快照，下次打开先用它渲染，不等这个请求回来
            writeBootstrapCache(data);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            console.error("加载数据失败:", message);

            if (!silent) {
                handleError("加载数据失败: " + message);
            }

            // 如果因为认证问题导致加载失败，处理认证状态
            if (message.includes("认证") || message.includes("401")) {
                api.logout();
                setIsAuthRequired(true);
                setIsAuthenticated(false);
            }
            return false;
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    };

    // ---- 本地状态更新（避免每次修改都整页重新加载） ----
    // 关键：只重建真正受影响的分组对象，其它分组保持原引用，
    // 这样被 memo 的 GroupCard / SiteCard 不会因为无关改动而重渲染。
    const upsertSiteLocally = useCallback((site: Site) => {
        setGroups(prev => {
            const targetIdx = prev.findIndex(g => g.id === site.group_id);
            const fromIdx = prev.findIndex(g => g.sites.some(item => item.id === site.id));
            // 跨分组移动：目标分组与来源分组不同
            const moved = fromIdx !== -1 && fromIdx !== targetIdx;

            let nextSite = site;
            if (moved && targetIdx !== -1) {
                // 移动过来的卡片排到目标分组末尾，避免沿用旧分组的 order_num 导致乱序
                const maxOrder = prev[targetIdx].sites.reduce(
                    (max, item) => Math.max(max, item.order_num ?? 0),
                    -1
                );
                nextSite = { ...site, order_num: maxOrder + 1 };
            }

            let changed = false;
            const next = prev.map((group, idx) => {
                if (idx === targetIdx) {
                    const exists = group.sites.some(item => item.id === nextSite.id);
                    const sites = exists
                        ? group.sites.map(item =>
                              item.id === nextSite.id ? { ...item, ...nextSite } : item
                          )
                        : [...group.sites, nextSite];
                    changed = true;
                    return {
                        ...group,
                        sites: [...sites].sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)),
                    };
                }

                // 站点被移动到了其他分组：从原分组移除
                if (moved && idx === fromIdx) {
                    changed = true;
                    return { ...group, sites: group.sites.filter(item => item.id !== site.id) };
                }

                return group;
            });

            return changed ? next : prev;
        });
    }, []);

    const removeSiteLocally = useCallback((siteId: number) => {
        setGroups(prev => {
            let changed = false;
            const next = prev.map(group => {
                if (!group.sites.some(item => item.id === siteId)) return group;
                changed = true;
                return { ...group, sites: group.sites.filter(item => item.id !== siteId) };
            });
            return changed ? next : prev;
        });
    }, []);

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
        async (updatedSite: Site) => {
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

                try {
                    const saved = await api.updateSite(updatedSite.id as number, updatedSite);
                    // id 以本地这份为准，避免个别后端实现回显的 id 不准确
                    if (saved) {
                        upsertSiteLocally({ ...updatedSite, ...saved, id: updatedSite.id });
                    }
                } catch (error) {
                    console.error("更新站点失败:", error);
                    if (snapshot) upsertSiteLocally(snapshot);
                    handleError("更新站点失败: " + (error as Error).message);
                }
            };

            // 改完链接后跟别张卡片撞了，也先确认一次再写库
            guardDuplicate(updatedSite.url, updatedSite.id, doUpdate);
        },
        [upsertSiteLocally, handleError, notify, guardDuplicate]
    );

    // 删除站点：删完给一条带「撤销」的提示，8 秒内点一下就能把卡片原样建回来
    // （服务端删掉的行拿不回原 id，所以撤销走「按快照重新创建」，name/url/图标/位置都还原）
    const handleSiteDelete = useCallback(
        async (siteId: number) => {
            const snapshot = groupsRef.current
                .flatMap(group => group.sites)
                .find(site => site.id === siteId);
            // 本机标签/星标先留一份快照：删除时要清掉它们，撤销时再挂到新卡片上
            const snapshotTags = tags[String(siteId)] ?? [];
            const wasStarred = starred.includes(siteId);
            try {
                await api.deleteSite(siteId);
                removeSiteLocally(siteId);
                // 卡片没了，它的标签/星标也就没有宿主，一并清掉，避免标签栏残留点不出来的标签
                forgetSites([siteId]);
                if (!snapshot) return;

                notify(`已删除「${snapshot.name || "该网站"}」`, "info", 8000, {
                    label: "撤销",
                    onClick: async () => {
                        try {
                            const created = await api.createSite({
                                ...snapshot,
                                id: undefined,
                            } as Site);
                            if (created && created.id !== undefined) {
                                upsertSiteLocally(created);
                                // 撤销是「原样恢复」，把标签与星标也挂回新 id 上
                                if (snapshotTags.length > 0) {
                                    setSiteTags(created.id, snapshotTags);
                                }
                                if (wasStarred) setStarredMany([created.id], true);
                            }
                            notify("已恢复", "success");
                        } catch (error) {
                            console.error("恢复站点失败:", error);
                            handleError("恢复站点失败: " + (error as Error).message);
                        }
                    },
                });
            } catch (error) {
                console.error("删除站点失败:", error);
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
        ]
    );

    // 批量删除站点（多选模式）：一次删完，同样给一次撤销机会
    const handleSitesDelete = useCallback(
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
                await Promise.all(snapshots.map(site => api.deleteSite(site.id as number)));
                snapshots.forEach(site => removeSiteLocally(site.id as number));
                forgetSites(snapshots.map(site => site.id as number));

                notify(`已删除 ${snapshots.length} 个网站`, "info", 8000, {
                    label: "撤销",
                    onClick: async () => {
                        try {
                            // 按原 order_num 从小到大重建，位置尽量还原
                            const ordered = [...snapshots].sort(
                                (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                            );
                            for (const site of ordered) {
                                const created = await api.createSite({
                                    ...site,
                                    id: undefined,
                                } as Site);
                                if (created && created.id !== undefined) {
                                    upsertSiteLocally(created);
                                    const prefs = prefsMap.get(site.id as number);
                                    if (prefs) {
                                        if (prefs.tags.length > 0) {
                                            setSiteTags(created.id, prefs.tags);
                                        }
                                        if (prefs.starred) setStarredMany([created.id], true);
                                    }
                                }
                            }
                            notify(`已恢复 ${ordered.length} 个网站`, "success");
                        } catch (error) {
                            console.error("批量恢复站点失败:", error);
                            handleError("恢复站点失败: " + (error as Error).message);
                        }
                    },
                });
            } catch (error) {
                console.error("批量删除站点失败:", error);
                handleError("批量删除站点失败: " + (error as Error).message);
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
        ]
    );

    // ---- 批量操作（多选模式） ----
    // 加星 / 取消加星：只改本机偏好，不碰数据库，改完立刻可见。
    // 批量操作后保留勾选，方便接着做下一个动作，收尾交给底部「完成」按钮。
    const bulkStar = useCallback(
        (next: boolean) => {
            if (selectedIds.length === 0) return;
            setStarredMany(selectedIds, next);
            notify(next ? `已给 ${selectedIds.length} 个网站加星标` : `已取消 ${selectedIds.length} 个网站的星标`, "success");
        },
        [selectedIds, setStarredMany, notify]
    );

    // 批量打标签：追加式，不会覆盖已有标签，同样保留勾选
    const bulkTag = useCallback(
        (next: string[]) => {
            if (selectedIds.length === 0) return;
            addTagsToMany(selectedIds, next);
            notify(`已给 ${selectedIds.length} 个网站加上标签：${next.join("、")}`, "success");
        },
        [selectedIds, addTagsToMany, notify]
    );

    // 标签管理：删除一个标签 = 从所有卡片上摘掉它，并给一次撤销机会
    const deleteTagWithUndo = useCallback(
        (tag: string) => {
            const affected = Object.entries(tags)
                .filter(([, list]) => list.includes(tag))
                .map(([siteId]) => Number(siteId))
                .filter(id => Number.isFinite(id));
            if (affected.length === 0) return;

            removeTagFromAll(tag);
            // 这个标签正在被筛选时，顺手把筛选条件也去掉，免得筛出一片空白
            setActiveTags(prev => prev.filter(t => t !== tag));

            notify(`已删除标签「${tag}」（${affected.length} 个网站）`, "info", 8000, {
                label: "撤销",
                onClick: () => {
                    addTagsToMany(affected, [tag]);
                    notify(`已恢复标签「${tag}」`, "success");
                },
            });
        },
        [tags, removeTagFromAll, addTagsToMany, notify]
    );

    // 批量移动到分组：一次批量请求改 group_id + order_num，本地同步搬运卡片
    const bulkMove = useCallback(
        async (groupId: number) => {
            if (selectedIds.length === 0) return;
            const target = groupsRef.current.find(group => group.id === groupId);
            if (!target) return;

            const maxOrder = target.sites.reduce(
                (max, site) => Math.max(max, site.order_num ?? 0),
                -1
            );
            const orders = selectedIds.map((id, idx) => ({
                id,
                order_num: maxOrder + 1 + idx,
                group_id: groupId,
            }));

            try {
                const ok = await api.updateSiteOrder(orders);
                if (!ok) throw new Error("服务端移动失败");

                setGroups(prev => {
                    const moving = prev
                        .flatMap(group => group.sites)
                        .filter(site => site.id !== undefined && selectedIds.includes(site.id))
                        .map((site, idx) => ({
                            ...site,
                            group_id: groupId,
                            order_num: maxOrder + 1 + idx,
                        }));

                    return prev.map(group => {
                        const kept = group.sites.filter(
                            site => !selectedIds.includes(site.id as number)
                        );
                        if (group.id === groupId) {
                            return {
                                ...group,
                                sites: [...kept, ...moving].sort(
                                    (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                                ),
                            };
                        }
                        return kept.length === group.sites.length ? group : { ...group, sites: kept };
                    });
                });

                // 移动后也保留勾选：卡片已经搬到新分组，选中态跟着走
                notify(`已移动 ${orders.length} 个网站到「${target.name}」`, "success");
            } catch (error) {
                console.error("批量移动站点失败:", error);
                handleError("批量移动站点失败: " + (error as Error).message);
            }
        },
        [selectedIds, handleError, notify]
    );

    // 批量删除：走和单张卡片同一套「删除后可撤销」流程
    const bulkDelete = useCallback(async () => {
        const ids = [...selectedIds];
        setBulkDeleteOpen(false);
        setSelectedIds([]);
        await handleSitesDelete(ids);
    }, [selectedIds, handleSitesDelete]);

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
                handleError("更新分组失败: " + (error as Error).message);
            }
        },
        [handleError]
    );

    // 删除分组：连同组内卡片一起删，所以撤销要把「分组 + 卡片」整组重建回来
    const handleGroupDelete = useCallback(
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
                await api.deleteGroup(groupId);
                setGroups(prev => {
                    const next = prev.filter(group => group.id !== groupId);
                    return next.length === prev.length ? prev : next;
                });
                // 组内卡片的标签/星标随卡片一起清掉，避免孤儿标签残留在标签栏
                if (snapshot) forgetSites(snapshot.sites.map(site => site.id as number));
                if (!snapshot) return;

                notify(
                    `已删除分组「${snapshot.name}」${snapshot.sites.length ? `及 ${snapshot.sites.length} 张卡片` : ""}`,
                    "info",
                    8000,
                    {
                        label: "撤销",
                        onClick: async () => {
                            try {
                                const created = await api.createGroup({
                                    name: snapshot.name,
                                    order_num: snapshot.order_num ?? 0,
                                } as Group);
                                const newId = created?.id;
                                if (newId === undefined) throw new Error("重建分组失败");

                                // 卡片按原顺序重建，分组位置也按 order_num 插回原处
                                const restored: Site[] = [];
                                const ordered = [...snapshot.sites].sort(
                                    (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                                );
                                for (const site of ordered) {
                                    const createdSite = await api.createSite({
                                        ...site,
                                        id: undefined,
                                        group_id: newId,
                                    } as Site);
                                    if (createdSite && createdSite.id !== undefined) {
                                        restored.push(createdSite);
                                        const prefs = sitePrefs.get(site.id as number);
                                        if (prefs) {
                                            if (prefs.tags.length > 0) {
                                                setSiteTags(createdSite.id, prefs.tags);
                                            }
                                            if (prefs.starred) {
                                                setStarredMany([createdSite.id], true);
                                            }
                                        }
                                    }
                                }

                                setGroups(prev =>
                                    [...prev, { ...created, id: newId, sites: restored }].sort(
                                        (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                                    )
                                );
                                notify(`已恢复分组「${snapshot.name}」`, "success");
                            } catch (error) {
                                console.error("恢复分组失败:", error);
                                handleError("恢复分组失败: " + (error as Error).message);
                            }
                        },
                    }
                );
            } catch (error) {
                console.error("删除分组失败:", error);
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
        ]
    );

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

                if (!result) {
                    throw new Error("站点排序更新失败");
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
                const ok = await api.updateSiteOrder(orders);
                if (!ok) throw new Error("更新排序失败");
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

        setNewSite(prev => {
            const next: Partial<Site> = { ...prev, [name]: value };

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

        const doCreate = async () => {
            try {
                const created = await api.createSite(newSite as Site);
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
        if (!guardDuplicate(newSite.url, undefined, doCreate)) release();
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
        if (!username && !authNewPassword && !authCurrentPassword) {
            return false; // 没填任何内容 → 不修改
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

            // 管理员凭据单独提交（失败会中断，不会把新密码悄悄丢掉）
            const authChanged = await submitAuthCredentials();

            // 更新配置状态：标题 / 背景图 / 自定义 CSS 都由 React 响应式生效，无需刷新页面
            setConfigs({ ...tempConfigs });
            // 正式保存后撤掉预览，改由已保存的配置驱动主题
            setAccentPreview(null);
            setAuthUsername("");
            setAuthCurrentPassword("");
            setAuthNewPassword("");
            handleCloseConfig();

            if (authChanged) {
                // 旧令牌仍然有效，当前会话不受影响，只是下次登录要用新账号密码
                notify("管理员凭据已更新，下次登录请使用新账号密码", "success", 4000);
            } else if (changed.length > 0) {
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

    // 构造完整备份数据（分组 + 站点（含账号密码）+ 网站配置 + 本机星标/标签）
    const buildExportData = (): ExportData => {
        const exportConfigs: Record<string, string> = {};
        Object.entries(configs).forEach(([key, value]) => {
            // WebDAV 凭据属于隐私信息，不写入备份文件
            if (!key.startsWith(WEBDAV_CONFIG_PREFIX)) {
                exportConfigs[key] = value;
            }
        });

        return {
            groups: groups.map(group => ({
                id: group.id,
                name: group.name,
                order_num: group.order_num,
            })),
            sites: groups.flatMap(group => group.sites.map(site => ({ ...site }))),
            configs: exportConfigs,
            version: "1.2",
            exportDate: new Date().toISOString(),
            // 星标 / 标签只存在本机，数据库里没有对应字段，所以由前端附带进备份文件
            localPrefs: {
                starred: [...starred],
                tags: { ...tags },
            },
        };
    };

    // 备份到本地：下载 JSON 文件
    const handleDownloadLocal = () => {
        try {
            const dataStr = JSON.stringify(buildExportData(), null, 2);
            const blob = new Blob([dataStr], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);

            const exportFileName = `导航站备份_${new Date().toISOString().slice(0, 10)}.json`;

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
            await api.setConfig(`${WEBDAV_CONFIG_PREFIX}url`, config.url);
            await api.setConfig(`${WEBDAV_CONFIG_PREFIX}username`, config.username);
            await api.setConfig(`${WEBDAV_CONFIG_PREFIX}password`, config.password);
            await api.setConfig(`${WEBDAV_CONFIG_PREFIX}path`, config.path || DEFAULT_WEBDAV_CONFIG.path);
            setWebdavConfig(config);
        } catch (error) {
            console.error("保存 WebDAV 配置失败:", error);
            handleError("保存 WebDAV 配置失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    // 每周自动备份开关（存在服务器，定时备份由 Worker 的 Cron 触发）
    const handleToggleAutoBackup = async (enabled: boolean) => {
        try {
            await api.setConfig(`${WEBDAV_CONFIG_PREFIX}autoBackup`, enabled ? "true" : "false");
            setConfigs(prev => ({
                ...prev,
                [`${WEBDAV_CONFIG_PREFIX}autoBackup`]: enabled ? "true" : "false",
            }));
        } catch (error) {
            console.error("保存自动备份设置失败:", error);
            handleError("保存自动备份设置失败: " + (error instanceof Error ? error.message : "未知错误"));
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
            const normalized = normalizeImportData(data);
            // 站点 id 映射：覆盖恢复保留原 id，合并导入会拿到新 id，恢复星标/标签时要用
            const siteIdMap = new Map<number, number>();

            if (overwrite) {
                const ok = await api.importData(normalized);
                if (!ok) {
                    throw new Error("服务端导入失败");
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

                for (const [key, value] of Object.entries(normalized.configs || {})) {
                    if (key !== "DB_INITIALIZED") {
                        await api.setConfig(key, value);
                    }
                }
            }

            // 把备份里的星标 / 标签写回本机 localStorage：
            // 覆盖恢复直接照搬（服务端保留了原 id），合并导入按新旧 id 映射翻译一遍
            const prefs = normalized.localPrefs;
            if (prefs && (overwrite || siteIdMap.size > 0)) {
                const remapped = overwrite
                    ? prefs
                    : {
                          starred: (prefs.starred ?? []).map(id => siteIdMap.get(id)).filter(
                              (id): id is number => typeof id === "number"
                          ),
                          tags: Object.entries(prefs.tags ?? {}).reduce<Record<string, string[]>>(
                              (acc, [siteId, list]) => {
                                  const mapped = siteIdMap.get(Number(siteId));
                                  if (typeof mapped === "number") acc[String(mapped)] = list;
                                  return acc;
                              },
                              {}
                          ),
                      };

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
    const favoritesGroup = useMemo(() => {
        const scored = groups
            .flatMap(group => group.sites)
            .map(site => {
                const stat = visits[String(site.id)];
                return { site, stat, count: recentVisitCount(stat) };
            })
            .filter(item => item.count > 0)
            .sort((a, b) => b.count - a.count || (b.stat?.last ?? 0) - (a.stat?.last ?? 0))
            .slice(0, RECENT_GROUP_SIZE)
            .map(item => item.site);

        return {
            id: -1,
            name: "最近访问",
            order_num: -1,
            sites: scored,
        } as GroupWithSites;
    }, [groups, visits]);

    // 真正渲染的分组列表：常用置前（排序模式与关闭时不插）
    const displayedGroups = useMemo(() => {
        if (!favoritesEnabled || favoritesGroup.sites.length === 0) return renderGroups;

        const favSites = favoritesGroup.sites.filter(
            site =>
                matchFilters(site) && (!query || matchesSiteQuery(site, query, usePinyin))
        );

        if (favSites.length === 0) return renderGroups;
        return [{ ...favoritesGroup, sites: favSites }, ...renderGroups];
    }, [visibleGroups, favoritesGroup, favoritesEnabled, query, matchFilters, usePinyin]);

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
                id: "cmd-export",
                label: "导出数据",
                section: "操作",
                run: () => handleOpenBackup(0),
            },
            {
                id: "cmd-import",
                label: "导入数据",
                section: "操作",
                run: () => handleOpenBackup(1),
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
    }, [flatResults, activeResult]);

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
                    onResetPassword={handleResetPassword}
                    resetLoading={resetLoading}
                    resetError={resetError}
                    resetConfigured={resetConfigured}
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

            {/* 回到顶部：滚过一屏才出现 */}
            <BackToTop />

            {/* 读屏播报区：视觉上不可见，但每次提示都会同步到这里（aria-live） */}
            <Box
                role='status'
                aria-live='polite'
                aria-atomic='true'
                sx={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    m: -1,
                    p: 0,
                    border: 0,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    clip: "rect(0 0 0 0)",
                }}
            >
                {liveMessage}
            </Box>

            {/* 错误/成功提示 Snackbar：顶部居中，成功类短暂停留、错误类停留更久 */}
            <Snackbar
                open={snackbarOpen}
                autoHideDuration={snackbarDuration}
                onClose={handleCloseSnackbar}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
                key={snackbarMessage + snackbarSeverity + snackbarDuration}
            >
                <Alert
                    onClose={handleCloseSnackbar}
                    severity={snackbarSeverity}
                    variant='filled'
                    className='nav-snackbar'
                    data-severity={snackbarSeverity}
                    iconMapping={{
                        success: <CheckCircleRoundedIcon fontSize='inherit' />,
                        info: <InfoRoundedIcon fontSize='inherit' />,
                        error: <ErrorOutlineRoundedIcon fontSize='inherit' />,
                    }}
                    sx={theme => {
                        // 按严重度取一个「有颜色但不刺眼」的强调色，用于图标与图标底色
                        const tone =
                            snackbarSeverity === "success"
                                ? theme.palette.success.main
                                : snackbarSeverity === "error"
                                  ? theme.palette.error.main
                                  : theme.palette.info.main;

                        return {
                            width: "100%",
                            alignItems: "center",
                            // 和卡片/确认弹窗同一套「毛玻璃 + 圆角 + 细边框 + 柔和投影」，
                            // 不再用 MUI 默认的实心饱和色块（和整站风格不搭）
                            minWidth: 260,
                            px: 1.5,
                            py: 0.75,
                            borderRadius: "var(--card-radius)",
                            color: "text.primary",
                            backgroundColor:
                                theme.palette.mode === "dark"
                                    ? "rgba(23,27,38,0.92)"
                                    : "rgba(255,255,255,0.92)",
                            backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                            WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
                            border: "1px solid var(--glass-panel-border)",
                            boxShadow: "var(--glass-shadow-hover)",
                            // 图标做成染色小方块，和确认弹窗标题前的图标同一种观感
                            "& .MuiAlert-icon": {
                                width: 28,
                                height: 28,
                                mr: 1.25,
                                p: 0,
                                borderRadius: "9px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 18,
                                opacity: 1,
                                color: tone,
                                backgroundColor: alpha(tone, theme.palette.mode === "dark" ? 0.22 : 0.13),
                            },
                            "& .MuiAlert-message": {
                                fontWeight: 500,
                                fontSize: 14,
                                lineHeight: 1.5,
                                py: 0.5,
                            },
                            "& .MuiAlert-action": { color: "text.secondary" },
                        };
                    }}
                    action={
                        snackbarAction ? (
                            <>
                                <Button
                                    className='nav-snackbar-action'
                                    color='inherit'
                                    size='small'
                                    onClick={() => {
                                        const run = snackbarAction.onClick;
                                        setSnackbarOpen(false);
                                        run();
                                    }}
                                    sx={{ fontWeight: 700, whiteSpace: "nowrap" }}
                                >
                                    {snackbarAction.label}
                                </Button>
                                <IconButton
                                    size='small'
                                    color='inherit'
                                    aria-label='关闭提示'
                                    onClick={handleCloseSnackbar}
                                >
                                    <CloseIcon fontSize='small' />
                                </IconButton>
                            </>
                        ) : undefined
                    }
                >
                    {snackbarMessage}
                </Alert>
            </Snackbar>

            {/* 背景图片层：固定铺满视口，用蒙版压暗以保证内容可读 */}
            {hasBackgroundImage && (
                <Box
                    aria-hidden
                    sx={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 0,
                        pointerEvents: "none",
                        // 预设壁纸存的是 CSS 渐变，可以直接当 background-image；普通图片才包 url()
                        backgroundImage: isCssGradient(backgroundImageUrl)
                            ? backgroundImageUrl
                            : `url("${backgroundImageUrl.replace(/"/g, '\\"')}")`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        backgroundRepeat: "no-repeat",
                        "&::after": {
                            content: '""',
                            position: "absolute",
                            inset: 0,
                            bgcolor: "background.default",
                            opacity: backgroundMaskOpacity,
                        },
                    }}
                />
            )}

            {/* 动态背景：缓慢漂移的柔光光晕，纯装饰、不拦截点击 */}
            <Box
                aria-hidden
                className='nav-aurora'
                sx={{
                    position: "fixed",
                    inset: "-12%",
                    zIndex: 0,
                    pointerEvents: "none",
                    filter: "blur(48px)",
                    opacity: hasBackgroundImage ? 0.35 : 0.55,
                    background: darkMode
                        ? "radial-gradient(38% 44% at 18% 22%, rgba(63,94,206,.45) 0%, transparent 62%), radial-gradient(34% 40% at 82% 28%, rgba(126,63,206,.38) 0%, transparent 60%), radial-gradient(40% 46% at 62% 86%, rgba(20,120,140,.34) 0%, transparent 62%)"
                        : "radial-gradient(38% 44% at 18% 22%, rgba(88,140,255,.24) 0%, transparent 62%), radial-gradient(34% 40% at 82% 28%, rgba(196,120,255,.20) 0%, transparent 60%), radial-gradient(40% 46% at 62% 86%, rgba(80,200,220,.18) 0%, transparent 62%)",
                    transition: "opacity .4s ease",
                }}
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
                <Container
                    maxWidth='lg'
                    sx={{
                        py: 4,
                        px: { xs: 2, sm: 3, md: 4 },
                        // 手机端给底部导航条留出空间
                        pb: { xs: 11, md: 4 },
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
                    <Box
                        className={headerCompact ? "nav-header-compact" : undefined}
                        sx={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            mb: headerCompact ? 2.5 : 5,
                            flexDirection: { xs: "column", sm: "row" },
                            gap: { xs: 2, sm: 0 },
                            // 向下滚动后收掉一点高度，内容区往上顶
                            pt: headerCompact ? 0 : 0.5,
                            transition: "margin .25s ease",
                        }}
                    >
                        <Typography
                            variant='h3'
                            component='h1'
                            fontWeight='bold'
                            color='text.primary'
                            sx={{ 
                                fontSize: headerCompact
                                    ? { xs: '1.25rem', sm: '1.5rem', md: '1.9rem' }
                                    : { xs: '1.75rem', sm: '2.125rem', md: '3rem' },
                                textAlign: { xs: 'center', sm: 'left' },
                                transition: 'font-size .25s ease',
                            }}
                        >
                            {configs["site.name"]}
                        </Typography>
                        <Stack 
                            direction={{ xs: 'row', sm: 'row' }} 
                            spacing={{ xs: 1, sm: 1.5 }} 
                            alignItems="center"
                            width={{ xs: '100%', sm: 'auto' }}
                            justifyContent={{ xs: 'center', sm: 'flex-end' }}
                            flexWrap="wrap"
                            useFlexGap
                            sx={{ rowGap: 1.5, py: { xs: 1, sm: 0 } }}
                        >
                            {/* 搜索框：位于操作按钮左侧，输入即时筛选并弹出结果面板 */}
                            {sortMode === SortMode.None && (
                                <Box ref={setSearchAnchor} sx={{ position: "relative" }}>
                                <TextField
                                    inputRef={searchInputRef}
                                    value={searchQuery}
                                    onChange={e => {
                                        setSearchQuery(e.target.value);
                                        setActiveResult(0);
                                        // 输入即展开面板（不只依赖 onFocus，避免程序化赋值时面板不出现）
                                        setSearchFocused(true);
                                    }}
                                    onFocus={() => setSearchFocused(true)}
                                    placeholder='搜索网站（按 /）'
                                    inputProps={{ "aria-label": "搜索网站" }}
                                    size='small'
                                    variant='outlined'
                                    InputProps={{
                                        startAdornment: (
                                            <InputAdornment position='start'>
                                                <SearchIcon fontSize='small' />
                                            </InputAdornment>
                                        ),
                                        endAdornment: searchQuery ? (
                                            <InputAdornment position='end'>
                                                <IconButton
                                                    size='small'
                                                    aria-label='清空搜索'
                                                    onClick={() => {
                                                        setSearchQuery("");
                                                        searchInputRef.current?.focus();
                                                    }}
                                                >
                                                    <CloseIcon fontSize='small' />
                                                </IconButton>
                                            </InputAdornment>
                                        ) : null,
                                    }}
                                    sx={{
                                        // 头部收紧时搜索框也收一档，和标题保持同步
                                        width: headerCompact
                                            ? { xs: "100%", sm: 150, md: 175 }
                                            : { xs: "100%", sm: 190, md: 230 },
                                        transition: "width .25s ease",
                                        // 毛玻璃底色必须和圆角一起挂在输入框本体上：
                                        // 放在外层 FormControl 上会在圆角外面露出一块直角白底
                                        "& .MuiOutlinedInput-root": {
                                            height: HEADER_CONTROL_H,
                                            borderRadius: "14px",
                                            bgcolor: headerCompact
                                                ? "var(--glass-bg-hover)"
                                                : "var(--glass-bg)",
                                            backdropFilter: "blur(10px)",
                                            WebkitBackdropFilter: "blur(10px)",
                                            transition: "background-color .25s ease",
                                        },
                                    }}
                                />

                                {/* 搜索结果下拉面板：↑↓ 选择，Enter 直接打开 */}
                                <Popper
                                    open={dropdownOpen || historyOpen}
                                    anchorEl={searchAnchor}
                                    placement='bottom-start'
                                    sx={{ zIndex: (t) => t.zIndex.modal, width: 320 }}
                                >
                                    <Paper
                                        ref={searchPanelRef}
                                        elevation={6}
                                        sx={{
                                            mt: 0.5,
                                            borderRadius: "16px",
                                            overflow: "hidden",
                                            border: "1px solid var(--glass-border)",
                                            bgcolor: "var(--glass-bg-hover)",
                                            backdropFilter: "blur(12px)",
                                            WebkitBackdropFilter: "blur(12px)",
                                        }}
                                    >
                                        {query.length > 0 ? (
                                        <List dense sx={{ py: 0.5 }}>
                                            {flatResults.map((item, idx) => (
                                                <ListItemButton
                                                    key={`${item.groupName}-${item.site.id ?? idx}`}
                                                    selected={idx === activeResult}
                                                    onMouseEnter={() => setActiveResult(idx)}
                                                    onClick={() => openResult(item.site)}
                                                    sx={{ borderRadius: "12px", mx: 0.5 }}
                                                >
                                                    <ListItemIcon sx={{ minWidth: 32 }}>
                                                        {item.site.icon ? (
                                                            <Box
                                                                component='img'
                                                                src={item.site.icon}
                                                                alt=''
                                                                sx={{ width: 18, height: 18, objectFit: "contain" }}
                                                            />
                                                        ) : (
                                                            <SearchIcon fontSize='small' />
                                                        )}
                                                    </ListItemIcon>
                                                    <ListItemText
                                                        primary={item.site.name}
                                                        secondary={item.groupName}
                                                        primaryTypographyProps={{ noWrap: true }}
                                                        secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
                                                    />
                                                </ListItemButton>
                                            ))}
                                        </List>
                                        ) : (
                                            <Box>
                                                <Box
                                                    sx={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        px: 1.5,
                                                        pt: 1.25,
                                                        pb: 0,
                                                    }}
                                                >
                                                    <Typography
                                                        variant='caption'
                                                        color='text.secondary'
                                                        sx={{ flex: 1, fontWeight: 600 }}
                                                    >
                                                        最近搜索
                                                    </Typography>
                                                    <Button
                                                        size='small'
                                                        color='inherit'
                                                        onClick={clearSearchHistory}
                                                        sx={{ minWidth: 0, fontSize: 11 }}
                                                    >
                                                        清空
                                                    </Button>
                                                </Box>
                                                <Box className='nav-search-history'>
                                                    {searchHistory.map(term => (
                                                        <button
                                                            key={term}
                                                            type='button'
                                                            className='nav-history-chip'
                                                            onClick={() => applyHistoryTerm(term)}
                                                        >
                                                            {term}
                                                        </button>
                                                    ))}
                                                </Box>
                                            </Box>
                                        )}
                                    </Paper>
                                </Popper>
                                </Box>
                            )}
                            {/* 搜索是「找东西」，右侧是「改数据 / 改显示」，中间用竖线分开 */}
                            {sortMode === SortMode.None && (
                                <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                            )}
                            {sortMode !== SortMode.None ? (
                                <>
                                    {sortMode === SortMode.GroupSort && (
                                        <Button
                                            variant='contained'
                                            color='primary'
                                            startIcon={<SaveIcon />}
                                            onClick={handleSaveGroupOrder}
                                            size="small"
                                            sx={headerControlSx}
                                        >
                                            保存分组顺序
                                        </Button>
                                    )}
                                    {sortMode === SortMode.SiteSort && (
                                        <Button
                                            variant='contained'
                                            color='primary'
                                            startIcon={<SaveIcon />}
                                            onClick={handleSaveSiteSort}
                                            size="small"
                                            sx={headerControlSx}
                                        >
                                            保存
                                        </Button>
                                    )}
                                    <Button
                                        variant='outlined'
                                        color='inherit'
                                        startIcon={<CancelIcon />}
                                        onClick={cancelSort}
                                        size="small"
                                        sx={headerControlSx}
                                    >
                                        取消编辑
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <Button
                                        variant='contained'
                                        color='primary'
                                        startIcon={<AddIcon />}
                                        onClick={handleOpenAddGroup}
                                        size="small"
                                        sx={headerControlSx}
                                    >
                                        新增分组
                                    </Button>

                                    <Button
                                        variant='outlined'
                                        color='primary'
                                        startIcon={<MenuIcon />}
                                        onClick={handleMenuOpen}
                                        aria-controls={openMenu ? "navigation-menu" : undefined}
                                        aria-haspopup='true'
                                        aria-expanded={openMenu ? "true" : undefined}
                                        size="small"
                                        sx={headerControlSx}
                                    >
                                        更多选项
                                    </Button>
                                    <Menu
                                        id='navigation-menu'
                                        anchorEl={menuAnchorEl}
                                        // 排序模式里「更多选项」按钮会被卸载，anchor 失效时菜单会飘到左上角，这里直接不渲染
                                        open={openMenu && sortMode === SortMode.None}
                                        onClose={handleMenuClose}
                                        MenuListProps={{
                                            "aria-labelledby": "navigation-button",
                                        }}
                                    >
                                        {/* 菜单顺序：常用配置 → 浏览偏好 → 数据管理 → 有破坏性的操作沉底，
                                            中间用分隔线分组，找东西不用整列扫一遍 */}
                                        <MenuItem onClick={handleOpenConfig}>
                                            <ListItemIcon>
                                                <SettingsIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>网站设置</ListItemText>
                                        </MenuItem>
                                        <MenuItem onClick={startGroupSort}>
                                            <ListItemIcon>
                                                <SortIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>编辑排序</ListItemText>
                                        </MenuItem>
                                        <Divider />
                                        {/* 毛玻璃特效：一个就地开关，点了马上生效。
                                            关掉时负责独有合成层 + 每帧背景采样的 backdrop-filter 会被整站摘掉，
                                            滚动更省，也不会再出现圆角边缘那一圈暗边。 */}
                                        <MenuItem
                                            onClick={() => setGlassEffects(!glassEffects)}
                                            aria-label='毛玻璃特效'
                                        >
                                            <ListItemIcon>
                                                {glassEffects ? (
                                                    <BlurOnIcon
                                                        fontSize='small'
                                                        color='primary'
                                                    />
                                                ) : (
                                                    <BlurOffIcon fontSize='small' />
                                                )}
                                            </ListItemIcon>
                                            <ListItemText>毛玻璃特效</ListItemText>
                                            <Switch
                                                checked={glassEffects}
                                                size='small'
                                                onChange={e => setGlassEffects(e.target.checked)}
                                                // 挡掉冒泡，否则点开关会同时触发菜单项的 onClick，切两下等于没切
                                                onClick={e => e.stopPropagation()}
                                                inputProps={{ "aria-label": "毛玻璃特效" }}
                                            />
                                        </MenuItem>
                                        <MenuItem
                                            onClick={() =>
                                                setFavoritesEnabled(!favoritesEnabled)
                                            }
                                        >
                                            <ListItemIcon>
                                                <StarIcon
                                                    fontSize='small'
                                                    color={
                                                        favoritesEnabled
                                                            ? "primary"
                                                            : "inherit"
                                                    }
                                                />
                                            </ListItemIcon>
                                            <ListItemText>
                                                {favoritesEnabled ? "取消最近访问置前" : "最近访问置前"}
                                            </ListItemText>
                                        </MenuItem>
                                        <MenuItem
                                            onClick={() => {
                                                handleMenuClose();
                                                setOpenVisits(true);
                                            }}
                                        >
                                            <ListItemIcon>
                                                <InsightsIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>访问统计</ListItemText>
                                        </MenuItem>
                                        <Divider />
                                        <MenuItem onClick={() => handleOpenBackup(0)}>
                                            <ListItemIcon>
                                                <FileDownloadIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>导出数据</ListItemText>
                                        </MenuItem>
                                        <MenuItem onClick={() => handleOpenBackup(1)}>
                                            <ListItemIcon>
                                                <FileUploadIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>导入数据</ListItemText>
                                        </MenuItem>
                                        <MenuItem
                                            onClick={() => {
                                                handleMenuClose();
                                                setBookmarkOpen(true);
                                            }}
                                        >
                                            <ListItemIcon>
                                                <BookmarkAddedIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>导入浏览器书签</ListItemText>
                                        </MenuItem>
                                        <MenuItem
                                            onClick={() => {
                                                handleMenuClose();
                                                void runLinkCheck();
                                            }}
                                        >
                                            <ListItemIcon>
                                                <LinkOffIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>检测失效链接</ListItemText>
                                        </MenuItem>
                                        <Divider />
                                        <MenuItem
                                            onClick={() => {
                                                clearVisits();
                                                // 清除访问记录不弹提示：「最近访问」分组会当场消失，本身就是反馈
                                            }}
                                            sx={{ color: "text.secondary" }}
                                        >
                                            <ListItemIcon sx={{ color: "text.secondary" }}>
                                                <DeleteOutlineIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>清除访问记录</ListItemText>
                                        </MenuItem>
                                        {isAuthenticated && (
                                            <MenuItem
                                                onClick={handleLogout}
                                                sx={{ color: "error.main" }}
                                            >
                                                <ListItemIcon sx={{ color: "error.main" }}>
                                                    <LogoutIcon fontSize='small' />
                                                </ListItemIcon>
                                                <ListItemText>退出登录</ListItemText>
                                            </MenuItem>
                                        )}
                                    </Menu>
                                </>
                            )}
                            {/* 操作按钮与显示控制之间再分一次组 */}
                            {sortMode === SortMode.None && (
                                <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                            )}
                            {/* 显示控制：视图版式 + 显示密度合成一块玻璃胶囊，中间一条细线分开
                                （原来是两块外形一模一样的独立胶囊，并排放着像重复按钮） */}
                            {sortMode === SortMode.None && (
                                <>
                                    <Box
                                        className='nav-display-pill'
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            height: HEADER_CONTROL_H,
                                            p: "2px",
                                            gap: "2px",
                                            borderRadius: HEADER_RADIUS,
                                            bgcolor: "var(--glass-bg)",
                                            border: "1px solid var(--glass-border)",
                                            backdropFilter: "blur(10px)",
                                            WebkitBackdropFilter: "blur(10px)",
                                            flexShrink: 0,
                                        }}
                                    >
                                        <ToggleButtonGroup
                                            size='small'
                                            exclusive
                                            value={viewMode}
                                            onChange={(_e, value) => value && setViewMode(value)}
                                            aria-label='视图切换'
                                            sx={{
                                                "& .MuiToggleButton-root": {
                                                    border: 0,
                                                    height: HEADER_CONTROL_H - 4,
                                                    px: 1,
                                                    borderRadius: "11px",
                                                },
                                            }}
                                        >
                                            <ToggleButton value='card' aria-label='卡片视图'>
                                                <Tooltip title='卡片视图'>
                                                    <ViewModuleIcon fontSize='small' />
                                                </Tooltip>
                                            </ToggleButton>
                                            <ToggleButton value='list' aria-label='列表视图'>
                                                <Tooltip title='紧凑列表'>
                                                    <ViewListIcon fontSize='small' />
                                                </Tooltip>
                                            </ToggleButton>
                                            <ToggleButton value='wall' aria-label='图标墙视图'>
                                                <Tooltip title='图标墙'>
                                                    <ViewCompactIcon fontSize='small' />
                                                </Tooltip>
                                            </ToggleButton>
                                        </ToggleButtonGroup>

                                        <Box
                                            aria-hidden
                                            sx={{
                                                width: "1px",
                                                height: 18,
                                                bgcolor: "var(--glass-border)",
                                                flexShrink: 0,
                                            }}
                                        />

                                        <ToggleButtonGroup
                                            size='small'
                                            exclusive
                                            value={density}
                                            onChange={(_e, value) => value && setDensity(value)}
                                            aria-label='显示密度'
                                            sx={{
                                                "& .MuiToggleButton-root": {
                                                    border: 0,
                                                    height: HEADER_CONTROL_H - 4,
                                                    px: 1,
                                                    borderRadius: "11px",
                                                },
                                            }}
                                        >
                                            <ToggleButton value='comfortable' aria-label='舒适密度'>
                                                <Tooltip title='舒适'>
                                                    <DensityMediumIcon fontSize='small' />
                                                </Tooltip>
                                            </ToggleButton>
                                            <ToggleButton value='compact' aria-label='紧凑密度'>
                                                <Tooltip title='紧凑'>
                                                    <DensitySmallIcon fontSize='small' />
                                                </Tooltip>
                                            </ToggleButton>
                                        </ToggleButtonGroup>

                                        <Box
                                            aria-hidden
                                            sx={{
                                                width: "1px",
                                                height: 18,
                                                bgcolor: "var(--glass-border)",
                                                flexShrink: 0,
                                            }}
                                        />

                                        {/* 批量多选：紧挨「只看星标」左边，和视图/密度同一条胶囊 */}
                                        <Tooltip title={multiSelect ? "退出多选" : "批量多选"}>
                                            <IconButton
                                                className='nav-multiselect-btn'
                                                data-active={multiSelect ? "true" : "false"}
                                                aria-label={
                                                    multiSelect ? "退出多选模式" : "进入多选模式"
                                                }
                                                aria-pressed={multiSelect}
                                                color={multiSelect ? "primary" : "default"}
                                                onClick={() =>
                                                    multiSelect
                                                        ? exitMultiSelect()
                                                        : setMultiSelect(true)
                                                }
                                                sx={{
                                                    width: HEADER_CONTROL_H - 4,
                                                    height: HEADER_CONTROL_H - 4,
                                                    borderRadius: "11px",
                                                    flexShrink: 0,
                                                    bgcolor: multiSelect
                                                        ? "var(--glass-bg-hover)"
                                                        : "transparent",
                                                }}
                                            >
                                                {multiSelect ? (
                                                    <CheckBoxIcon fontSize='small' />
                                                ) : (
                                                    <CheckBoxOutlineBlankIcon fontSize='small' />
                                                )}
                                            </IconButton>
                                        </Tooltip>

                                        {/* 「只看星标」：和视图/密度同一条胶囊，开着的星星是实心的 */}
                                        <ToggleButtonGroup
                                            size='small'
                                            exclusive
                                            value={starFilter ? "star" : ""}
                                            onChange={(_e, value) => setStarFilter(Boolean(value))}
                                            aria-label='只看星标'
                                            sx={{
                                                "& .MuiToggleButton-root": {
                                                    border: 0,
                                                    height: HEADER_CONTROL_H - 4,
                                                    px: 1,
                                                    borderRadius: "11px",
                                                },
                                            }}
                                        >
                                            <ToggleButton
                                                value='star'
                                                aria-label='只看星标'
                                                className='nav-star-filter'
                                                data-active={starFilter ? "true" : "false"}
                                                selected={starFilter}
                                            >
                                                <Tooltip title='只看星标'>
                                                    {starFilter ? (
                                                        <StarIcon fontSize='small' />
                                                    ) : (
                                                        <StarBorderIcon fontSize='small' />
                                                    )}
                                                </Tooltip>
                                            </ToggleButton>
                                        </ToggleButtonGroup>
                                    </Box>
                                </>
                            )}

                            {/* 时钟与主题切换归成「状态区」，和左侧操作按钮用竖线隔开 */}
                            <Box aria-hidden sx={headerDividerSx} className='nav-header-divider' />
                            <HeaderClock />
                            <ThemeToggle mode={themeMode} onToggle={toggleTheme} />
                        </Stack>
                    </Box>

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

                    {loading && (
                        <Stack spacing={5}>
                            {[0, 1].map(section => (
                                <Box key={section}>
                                    <Skeleton
                                        variant='rounded'
                                        width={180}
                                        height={32}
                                        sx={{ mb: 2.5 }}
                                    />
                                    <Box sx={{ display: "flex", flexWrap: "wrap", margin: -1 }}>
                                        {[0, 1, 2, 3, 4].map(i => (
                                            <Box
                                                key={i}
                                                sx={{
                                                    width: {
                                                        xs: "50%",
                                                        sm: "33.33%",
                                                        md: "25%",
                                                        lg: "25%",
                                                        xl: "20%",
                                                    },
                                                    padding: 1,
                                                    boxSizing: "border-box",
                                                }}
                                            >
                                                <Skeleton variant='rounded' height={104} />
                                            </Box>
                                        ))}
                                    </Box>
                                </Box>
                            ))}
                        </Stack>
                    )}

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
                                <Box
                                    sx={{
                                        py: 8,
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "center",
                                        gap: 1.5,
                                        textAlign: "center",
                                        borderRadius: "18px",
                                        border: "1.5px dashed",
                                        borderColor: "divider",
                                    }}
                                >
                                    <EmptyArt variant={query ? "search" : "empty"} size={132} />
                                    <Typography variant='subtitle1' fontWeight='600'>
                                        {query ? "没有找到匹配的网站" : "还没有任何分组"}
                                    </Typography>
                                    <Typography variant='body2' color='text.secondary'>
                                        {query
                                            ? `换个关键词试试，或清空搜索框查看全部网站`
                                            : "点击左上角「新增分组」开始搭建你的导航页"}
                                    </Typography>
                                    {/* 空状态也要有出路：能搜就给「清空搜索」，筛没了就给「清除筛选」 */}
                                    <Stack direction='row' spacing={1} sx={{ mt: 1 }}>
                                        {query && (
                                            <Button
                                                variant='outlined'
                                                size='small'
                                                onClick={() => setSearchQuery("")}
                                                className='nav-empty-clear-search'
                                            >
                                                清空搜索
                                            </Button>
                                        )}
                                        {(starFilter || deadOnly || activeTags.length > 0) && (
                                            <Button
                                                variant='outlined'
                                                size='small'
                                                onClick={clearAllFilters}
                                                className='nav-empty-clear-filter'
                                            >
                                                清除筛选
                                            </Button>
                                        )}
                                    </Stack>
                                </Box>
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
                                                name='username'
                                                label='网站账号'
                                                fullWidth
                                                size='small'
                                                type='text'
                                                variant='outlined'
                                                placeholder='登录用户名 / 邮箱（可留空）'
                                                value={newSite.username || ""}
                                                onChange={handleSiteInputChange}
                                                autoComplete='off'
                                            />
                                        </Box>
                                        <Box sx={{ flex: 1 }}>
                                            <TextField
                                                id='site-password'
                                                name='password'
                                                label='网站密码'
                                                fullWidth
                                                size='small'
                                                type={showNewSitePassword ? "text" : "password"}
                                                variant='outlined'
                                                placeholder='登录密码（可留空）'
                                                value={newSite.password || ""}
                                                onChange={handleSiteInputChange}
                                                autoComplete='new-password'
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
                        auth={{
                            username: authUsername,
                            currentPassword: authCurrentPassword,
                            newPassword: authNewPassword,
                        }}
                        pinyinSearch={pinyinSearch}
                        onPinyinSearchChange={setPinyinSearch}
                        onAuthChange={(field, value) => {
                            if (field === "username") setAuthUsername(value);
                            else if (field === "currentPassword") setAuthCurrentPassword(value);
                            else setAuthNewPassword(value);
                        }}
                    />
                    </Suspense>

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

                </Container>

                {/* 手机端底部导航：搜索 / 分组 / 新增 / 更多 */}
                <MobileTabBar
                    onSearch={() => {
                        searchInputRef.current?.focus();
                        window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    onGroups={event => setMobileGroupsAnchor(event.currentTarget)}
                    onAdd={handleOpenAddGroup}
                    onMore={event => handleMenuOpen(event as React.MouseEvent<HTMLButtonElement>)}
                    onToggleStar={() => setStarFilter(!starFilter)}
                    starActive={starFilter}
                    badge={displayedGroups.length}
                />

                {/* 移动端「分组」菜单：列出所有分组，点一下跳过去 */}
                <Menu
                    anchorEl={mobileGroupsAnchor}
                    open={Boolean(mobileGroupsAnchor)}
                    onClose={() => setMobileGroupsAnchor(null)}
                    anchorOrigin={{ vertical: "top", horizontal: "center" }}
                    transformOrigin={{ vertical: "bottom", horizontal: "center" }}
                    slotProps={{ paper: { sx: { minWidth: 180, borderRadius: "14px" } } }}
                >
                    {displayedGroups.map(group => (
                        <MenuItem
                            key={group.id}
                            onClick={() => jumpToGroup(group.id)}
                            selected={group.id === activeGroupId}
                        >
                            <ListItemText primary={group.name} secondary={`${group.sites.length} 个`} />
                        </MenuItem>
                    ))}
                </Menu>

                {/* 命令面板：Ctrl / Cmd + K */}
                <Suspense fallback={null}>
                <CommandPalette
                    open={commandOpen}
                    onClose={() => setCommandOpen(false)}
                    commands={commands}
                />
                </Suspense>

                {/* 浏览器书签批量导入 */}
                <Suspense fallback={null}>
                <BookmarkImportDialog
                    open={bookmarkOpen}
                    onClose={() => setBookmarkOpen(false)}
                    onImport={importBookmarks}
                />
                </Suspense>

                {/* 批量多选：底部操作条（删除 / 星标 / 标签 / 移动分组） */}
                {multiSelect && sortMode === SortMode.None && (
                    <BulkActionBar
                        count={selectedIds.length}
                        groups={groups.map(group => ({
                            id: group.id,
                            name: group.name,
                        }))}
                        allTags={allTags}
                        onStar={bulkStar}
                        onTag={bulkTag}
                        onMove={bulkMove}
                        onDelete={() => {
                            if (selectedIds.length === 0) return;
                            setBulkDeleteOpen(true);
                        }}
                        onFinish={exitMultiSelect}
                        onExit={exitMultiSelect}
                    />
                )}

                {/* 批量删除确认：删完同样可以在提示条上点「撤销」 */}
                {/* 重复网址确认：同一条链接已经加过，先确认再写库 */}
                <ConfirmDialog
                    open={dupPrompt !== null}
                    title='这个链接已经加过了'
                    description={
                        dupPrompt
                            ? `「${dupPrompt.hit.groupName}」里已有一张同链接的卡片：${dupPrompt.hit.site.name || dupPrompt.hit.site.url}。重复保存后，删的时候容易漏删。`
                            : ""
                    }
                    confirmText='仍然添加'
                    cancelText='取消'
                    extraAction={
                        dupPrompt?.hit.site.id != null
                            ? {
                                  label: "跳到那张",
                                  onClick: () => {
                                      const id = dupPrompt.hit.site.id as number;
                                      setDupPrompt(null);
                                      jumpToSite(id);
                                  },
                              }
                            : undefined
                    }
                    onConfirm={() => {
                        const run = dupPrompt?.run;
                        setDupPrompt(null);
                        if (run) void run();
                    }}
                    onClose={() => setDupPrompt(null)}
                />

                <ConfirmDialog
                    open={bulkDeleteOpen}
                    title={`删除选中的 ${selectedIds.length} 个网站？`}
                    description='删除后可在提示条上点「撤销」恢复；保存的账号密码会一并删除。'
                    confirmText='删除'
                    danger
                    onConfirm={bulkDelete}
                    onClose={() => setBulkDeleteOpen(false)}
                />

                {/* 标签管理：集中删标签，删掉即从所有卡片上摘掉 */}
                <Suspense fallback={null}>
                <TagManagerDialog
                    open={tagManagerOpen}
                    tags={allTags}
                    counts={tagCounts}
                    onDeleteTag={deleteTagWithUndo}
                    onClose={() => setTagManagerOpen(false)}
                />
                </Suspense>
            </Box>
        </ThemeProvider>
         </NotifyContext.Provider>
        </AppConfigProvider>
    );
}

export default App;
