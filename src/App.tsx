import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { NavigationClient } from "./API/client";
import { MockNavigationClient } from "./API/mock";
import { Site, Group, ExportData, BootstrapData, WebDavConfig, normalizeImportData } from "./API/http";
import { GroupWithSites } from "./types";
import { AppConfigProvider } from "./context/AppConfigContext";
import { NotifyContext } from "./context/NotifyContext";
import { useUIPrefs, RADIUS_PX } from "./context/UIPrefsContext";
import SiteCard from "./components/SiteCard";
import GroupNavRail from "./components/GroupNavRail";
import MobileTabBar from "./components/MobileTabBar";
import CommandPalette, { CommandItem } from "./components/CommandPalette";
import BookmarkImportDialog from "./components/BookmarkImportDialog";
import ScrollProgress from "./components/ScrollProgress";
import HeaderClock from "./components/HeaderClock";
import VisitsDialog from "./components/VisitsDialog";
import EmptyArt from "./components/EmptyArt";
import { readCollapsedGroupIds, setAllCollapsed } from "./utils/collapse";
import { probeLinks } from "./utils/linkHealth";
import { ParsedBookmarkGroup } from "./utils/bookmarks";
import { DEFAULT_ICON_API, resolveIconApiUrl } from "./utils/iconApi";
import { saveRememberedLogin, clearRememberedLogin } from "./utils/rememberedLogin";
import ThemeToggle from "./components/ThemeToggle";
import GroupCard from "./components/GroupCard";
import EditGroupDialog from "./components/EditGroupDialog";
import LoginForm from "./components/LoginForm";
import BackupDialog from "./components/BackupDialog";
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
    DialogContentText,
    DialogTitle,
    IconButton,
    Menu,
    MenuItem,
    Divider,
    ListItemIcon,
    ListItemText,
    Snackbar,
    Slider,
    Tooltip,
    InputAdornment,
    Skeleton,
    ToggleButton,
    ToggleButtonGroup,
    Popper,
    Paper,
    List,
    ListItemButton,
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
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import UnfoldLessIcon from "@mui/icons-material/UnfoldLess";
import InsightsIcon from "@mui/icons-material/Insights";

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

// 内置壁纸预设：既可以是渐变（直接作为 CSS background-image），也可以留空表示不用
const WALLPAPER_PRESETS = [
    { label: "晨雾", value: "linear-gradient(135deg,#e0eafc 0%,#cfdef3 100%)" },
    { label: "暮色", value: "linear-gradient(135deg,#ff9a9e 0%,#fad0c4 55%,#fad0c4 100%)" },
    { label: "极光", value: "linear-gradient(135deg,#0f2027 0%,#203a43 45%,#2c5364 100%)" },
    { label: "森林", value: "linear-gradient(135deg,#134e5e 0%,#71b280 100%)" },
    { label: "紫夜", value: "linear-gradient(135deg,#42275a 0%,#734b6d 100%)" },
    { label: "砂丘", value: "linear-gradient(135deg,#f6d365 0%,#fda085 100%)" },
];

// 判断一个背景值是不是 CSS 渐变（渐变可以直接当 background-image 用，图片要包 url()）
const isCssGradient = (value: string) => /^\s*(linear|radial|conic)-gradient\(/i.test(value);

// 取色器预设色：覆盖蓝/青/绿/橙/红/紫/靛/灰几种常用取向
const PRESET_ACCENTS = [
    "#1976d2",
    "#00838f",
    "#2e7d32",
    "#ed6c02",
    "#c62828",
    "#7b1fa2",
    "#5c6bc0",
    "#455a64",
];

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
        visits,
        recordVisit,
        clearVisits,
        radius,
        setRadius,
        fontScale,
        setFontScale,
        setDeadLinks,
        searchHistory,
        pushSearchHistory,
        clearSearchHistory,
    } = useUIPrefs();

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

    // 统一提示函数（引用稳定，便于被 memo 的子组件复用）
    // duration 可选：成功/信息类默认短暂停留 2.2s，错误类默认 6s（便于阅读），传入则覆盖
    const notify = useCallback(
        (message: string, severity: "success" | "error" | "info" = "info", duration?: number) => {
            setSnackbarMessage(message);
            setSnackbarSeverity(severity);
            setSnackbarDuration(duration ?? (severity === "error" ? 6000 : 2200));
            setSnackbarOpen(true);
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

    // 更新站点：保存成功后直接用（本地这份 + 服务端回显）更新本地状态，界面即时生效，不再刷新页面
    const handleSiteUpdate = useCallback(
        async (updatedSite: Site) => {
            try {
                if (!updatedSite.id) return;

                const saved = await api.updateSite(updatedSite.id, updatedSite);
                // id 以本地这份为准，避免个别后端实现回显的 id 不准确
                upsertSiteLocally({ ...updatedSite, ...(saved || {}), id: updatedSite.id });
                notify("卡片已更新", "success");
            } catch (error) {
                console.error("更新站点失败:", error);
                handleError("更新站点失败: " + (error as Error).message);
            }
        },
        [upsertSiteLocally, handleError, notify]
    );

    // 删除站点
    const handleSiteDelete = useCallback(
        async (siteId: number) => {
            try {
                await api.deleteSite(siteId);
                removeSiteLocally(siteId);
            } catch (error) {
                console.error("删除站点失败:", error);
                handleError("删除站点失败: " + (error as Error).message);
            }
        },
        [removeSiteLocally, handleError]
    );

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

    // 删除分组
    const handleGroupDelete = useCallback(
        async (groupId: number) => {
            try {
                await api.deleteGroup(groupId);
                setGroups(prev => {
                    const next = prev.filter(group => group.id !== groupId);
                    return next.length === prev.length ? prev : next;
                });
            } catch (error) {
                console.error("删除分组失败:", error);
                handleError("删除分组失败: " + (error as Error).message);
            }
        },
        [handleError]
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

        try {
            if (!newSite.name || !newSite.url) {
                handleError("站点名称和URL不能为空");
                return;
            }

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
            creatingSiteRef.current = false;
            setCreatingSite(false);
        }
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
        try {
            // 只提交有变化的配置，并并行写入，避免逐条等待
            const changed = Object.entries(tempConfigs).filter(([key, value]) => configs[key] !== value);
            await Promise.all(changed.map(([key, value]) => api.setConfig(key, value)));

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

    // 构造完整备份数据（分组 + 站点（含账号密码）+ 网站配置）
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
            version: "1.1",
            exportDate: new Date().toISOString(),
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

    // 导入/恢复数据：overwrite=true 覆盖恢复（服务端整体导入），false 合并追加
    const handleImportBackup = async (data: ExportData, overwrite: boolean) => {
        try {
            const normalized = normalizeImportData(data);

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
                    await api.createSite({
                        ...site,
                        id: undefined,
                        group_id: groupIdMap.get(site.group_id) ?? site.group_id,
                    } as Site);
                }

                for (const [key, value] of Object.entries(normalized.configs || {})) {
                    if (key !== "DB_INITIALIZED") {
                        await api.setConfig(key, value);
                    }
                }
            }

            // 恢复/导入是低频重操作，这里同步刷新一次（一次 bootstrap 请求）
            await fetchData();
        } catch (error) {
            console.error("导入数据失败:", error);
            handleError("导入数据失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    // 按关键词筛选：命中名称 / 描述 / 链接的卡片会被保留，分组名命中则整组保留
    const query = searchQuery.trim().toLowerCase();
    const filteredGroups = useMemo(() => {
        if (!query) return groups;

        return groups
            .map(group => {
                if (group.name.toLowerCase().includes(query)) return group;
                const sites = group.sites.filter(site => {
                    const haystack = `${site.name || ""} ${site.description || ""} ${site.url || ""}`;
                    return haystack.toLowerCase().includes(query);
                });
                return { ...group, sites };
            })
            .filter(group => group.sites.length > 0);
    }, [groups, query]);

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

    // 「最近访问」虚拟分组：按最近访问时间倒序（组内还会按 今天 / 昨天 / 更早 分小节）
    const favoritesGroup = useMemo(() => {
        const scored = groups
            .flatMap(group => group.sites)
            .map(site => ({ site, stat: visits[String(site.id)] }))
            .filter(item => item.stat && item.stat.count > 0)
            .sort((a, b) => b.stat!.last - a.stat!.last || b.stat!.count - a.stat!.count)
            .slice(0, 9)
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
        if (!favoritesEnabled || favoritesGroup.sites.length === 0) return filteredGroups;

        const favSites = query
            ? favoritesGroup.sites.filter(site =>
                  `${site.name || ""} ${site.description || ""} ${site.url || ""}`
                      .toLowerCase()
                      .includes(query)
              )
            : favoritesGroup.sites;

        if (favSites.length === 0) return filteredGroups;
        return [{ ...favoritesGroup, sites: favSites }, ...filteredGroups];
    }, [filteredGroups, favoritesGroup, favoritesEnabled, query]);

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
        const map = await probeLinks(urls, 5);
        setDeadLinks(map);
        const dead = Object.keys(map).length;
        notify(
            dead ? `检测完成，${dead} 个链接疑似失效` : "检测完成，所有链接都能访问",
            dead ? "info" : "success"
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
    // 直接读 localStorage 现算：菜单每次打开都会重渲染，所以拿到的永远是最新状态
    const collapseIds = new Set(readCollapsedGroupIds());
    const realGroups = groups.filter(g => typeof g.id === "number" && g.id > 0);
    const allGroupsCollapsed =
        realGroups.length > 0 && realGroups.every(g => collapseIds.has(String(g.id)));

    const toggleCollapseAll = useCallback(() => {
        const next = !allGroupsCollapsed; // true = 折叠全部
        setAllCollapsed(
            realGroups.map(g => g.id),
            next
        );
        notify(next ? "已折叠全部分组" : "已展开全部分组", "success");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allGroupsCollapsed, groups, notify]);

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
                id: "cmd-clear-visits",
                label: "清除访问记录",
                section: "操作",
                run: () => {
                    clearVisits();
                    notify("已清除访问记录", "success");
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
                    sx={{ width: "100%" }}
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
                            spacing={{ xs: 1, sm: 2 }} 
                            alignItems="center"
                            width={{ xs: '100%', sm: 'auto' }}
                            justifyContent={{ xs: 'center', sm: 'flex-end' }}
                            flexWrap="wrap"
                            sx={{ gap: { xs: 1, sm: 2 }, py: { xs: 1, sm: 0 } }}
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
                                            ? { xs: "100%", sm: 140, md: 170 }
                                            : { xs: "100%", sm: 180, md: 220 },
                                        bgcolor: headerCompact
                                            ? "var(--glass-bg-hover)"
                                            : "var(--glass-bg)",
                                        transition: "width .25s ease",
                                        backdropFilter: "blur(10px)",
                                        WebkitBackdropFilter: "blur(10px)",
                                        "& .MuiOutlinedInput-root": { borderRadius: "14px" },
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
                            {sortMode !== SortMode.None ? (
                                <>
                                    {sortMode === SortMode.GroupSort && (
                                        <Button
                                            variant='contained'
                                            color='primary'
                                            startIcon={<SaveIcon />}
                                            onClick={handleSaveGroupOrder}
                                            size="small"
                                            sx={{ 
                                                minWidth: 'auto',
                                                fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                            }}
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
                                            sx={{ 
                                                minWidth: 'auto',
                                                fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                            }}
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
                                        sx={{ 
                                            minWidth: 'auto',
                                            fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                        }}
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
                                        sx={{ 
                                            minWidth: 'auto',
                                            fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                        }}
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
                                        sx={{ 
                                            minWidth: 'auto',
                                            fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                        }}
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
                                        <MenuItem onClick={startGroupSort}>
                                            <ListItemIcon>
                                                <SortIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>编辑排序</ListItemText>
                                        </MenuItem>
                                        <MenuItem
                                            onClick={() => {
                                                handleMenuClose();
                                                toggleCollapseAll();
                                            }}
                                        >
                                            <ListItemIcon>
                                                {allGroupsCollapsed ? (
                                                    <UnfoldMoreIcon fontSize='small' />
                                                ) : (
                                                    <UnfoldLessIcon fontSize='small' />
                                                )}
                                            </ListItemIcon>
                                            <ListItemText>
                                                {allGroupsCollapsed ? "展开全部分组" : "折叠全部分组"}
                                            </ListItemText>
                                        </MenuItem>
                                        <MenuItem onClick={handleOpenConfig}>
                                            <ListItemIcon>
                                                <SettingsIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>网站设置</ListItemText>
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
                                        <MenuItem
                                            onClick={() => {
                                                clearVisits();
                                                notify("已清除访问记录", "success");
                                            }}
                                        >
                                            <ListItemIcon>
                                                <DeleteOutlineIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>清除访问记录</ListItemText>
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
                                        {isAuthenticated && (
                                            <>
                                                <Divider />
                                                <MenuItem
                                                    onClick={handleLogout}
                                                    sx={{ color: "error.main" }}
                                                >
                                                    <ListItemIcon sx={{ color: "error.main" }}>
                                                        <LogoutIcon fontSize='small' />
                                                    </ListItemIcon>
                                                    <ListItemText>退出登录</ListItemText>
                                                </MenuItem>
                                            </>
                                        )}
                                    </Menu>
                                </>
                            )}
                            {/* 视图版式与显示密度：只影响本机显示，不写入服务器 */}
                            {sortMode === SortMode.None && (
                                <>
                                    <ToggleButtonGroup
                                        size='small'
                                        exclusive
                                        value={viewMode}
                                        onChange={(_e, value) => value && setViewMode(value)}
                                        aria-label='视图切换'
                                        sx={{
                                            bgcolor: "var(--glass-bg)",
                                            borderRadius: "14px",
                                            "& .MuiToggleButton-root": {
                                                border: 0,
                                                px: 1,
                                                py: 0.4,
                                                borderRadius: "12px",
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

                                    <ToggleButtonGroup
                                        size='small'
                                        exclusive
                                        value={density}
                                        onChange={(_e, value) => value && setDensity(value)}
                                        aria-label='显示密度'
                                        sx={{
                                            bgcolor: "var(--glass-bg)",
                                            borderRadius: "14px",
                                            "& .MuiToggleButton-root": {
                                                border: 0,
                                                px: 1,
                                                py: 0.4,
                                                borderRadius: "12px",
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
                                </>
                            )}

                            <HeaderClock />
                            <ThemeToggle mode={themeMode} onToggle={toggleTheme} />
                        </Stack>
                    </Box>

                    {/* 搜索结果计数：搜索框在上方标题栏里，这里只保留一行轻提示 */}
                    {sortMode === SortMode.None && query && (
                        <Typography
                            variant='caption'
                            color='text.secondary'
                            sx={{ display: "block", mt: -3, mb: 3 }}
                        >
                            找到{" "}
                            {filteredGroups.reduce((sum, g) => sum + g.sites.length, 0)}{" "}
                            个匹配的网站
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
                                <Stack spacing={density === "compact" ? 3 : 5}>
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
                                            accentColor={configs[`group.color.${group.id}`]}
                                            onAccentChange={handleGroupAccentChange}
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
                                    {query && (
                                        <Button
                                            variant='outlined'
                                            size='small'
                                            sx={{ mt: 1 }}
                                            onClick={() => setSearchQuery("")}
                                        >
                                            清空搜索
                                        </Button>
                                    )}
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

                    {/* 新增站点对话框 */}
                    <Dialog 
                        open={openAddSite} 
                        onClose={handleCloseAddSite} 
                        maxWidth='md' 
                        fullWidth
                        PaperProps={{
                            sx: {
                                m: { xs: 2, sm: 'auto' },
                                width: { xs: 'calc(100% - 32px)', sm: 'auto' }
                            }
                        }}
                    >
                        <DialogTitle>
                            新增站点
                            <IconButton
                                aria-label='close'
                                onClick={handleCloseAddSite}
                                sx={{
                                    position: "absolute",
                                    right: 8,
                                    top: 8,
                                }}
                            >
                                <CloseIcon />
                            </IconButton>
                        </DialogTitle>
                        <DialogContent>
                            <DialogContentText sx={{ mb: 2 }}>请输入新站点的信息</DialogContentText>
                            <Stack spacing={2}>
                                <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
                                    <Box sx={{ flex: 1 }}>
                                        <TextField
                                            autoFocus
                                            margin='dense'
                                            id='site-name'
                                            name='name'
                                            label='站点名称'
                                            type='text'
                                            fullWidth
                                            variant='outlined'
                                            value={newSite.name}
                                            onChange={handleSiteInputChange}
                                        />
                                    </Box>
                                    <Box sx={{ flex: 1 }}>
                                        <TextField
                                            margin='dense'
                                            id='site-url'
                                            name='url'
                                            label='站点URL'
                                            type='url'
                                            fullWidth
                                            variant='outlined'
                                            value={newSite.url}
                                            onChange={handleSiteInputChange}
                                        />
                                    </Box>
                                </Box>
                                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                                    <TextField
                                        margin='dense'
                                        id='site-icon'
                                        name='icon'
                                        label='图标URL'
                                        type='url'
                                        fullWidth
                                        variant='outlined'
                                        value={newSite.icon}
                                        onChange={handleSiteInputChange}
                                        placeholder='填好站点URL后自动生成，也可点右侧按钮重新获取'
                                    />
                                    <Tooltip title='根据网站链接一键获取图标URL'>
                                        <span>
                                            <IconButton
                                                onClick={handleFetchNewSiteIcon}
                                                disabled={!newSite.url}
                                                aria-label='根据网站链接获取图标URL'
                                                sx={{ mt: 1 }}
                                            >
                                                <AutoFixHighIcon />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                </Box>
                                <TextField
                                    margin='dense'
                                    id='site-description'
                                    name='description'
                                    label='站点描述'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={newSite.description}
                                    onChange={handleSiteInputChange}
                                />
                                <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
                                    <Box sx={{ flex: 1 }}>
                                        <TextField
                                            margin='dense'
                                            id='site-username'
                                            name='username'
                                            label='网站账号'
                                            type='text'
                                            fullWidth
                                            variant='outlined'
                                            value={newSite.username || ""}
                                            onChange={handleSiteInputChange}
                                            autoComplete='off'
                                            placeholder='登录用户名 / 邮箱（可留空）'
                                        />
                                    </Box>
                                    <Box sx={{ flex: 1 }}>
                                        <TextField
                                            margin='dense'
                                            id='site-password'
                                            name='password'
                                            label='网站密码'
                                            type={showNewSitePassword ? "text" : "password"}
                                            fullWidth
                                            variant='outlined'
                                            value={newSite.password || ""}
                                            onChange={handleSiteInputChange}
                                            autoComplete='new-password'
                                            placeholder='登录密码（可留空）'
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
                                <TextField
                                    margin='dense'
                                    id='site-notes'
                                    name='notes'
                                    label='备注'
                                    type='text'
                                    fullWidth
                                    multiline
                                    rows={2}
                                    variant='outlined'
                                    value={newSite.notes}
                                    onChange={handleSiteInputChange}
                                />
                            </Stack>
                        </DialogContent>
                        <DialogActions sx={{ px: 3, pb: 3 }}>
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
                    <Dialog 
                        open={openConfig} 
                        onClose={handleCloseConfig} 
                        maxWidth='md' 
                        fullWidth
                        PaperProps={{
                            sx: {
                                m: { xs: 2, sm: 'auto' },
                                width: { xs: 'calc(100% - 32px)', sm: 'auto' }
                            }
                        }}
                    >
                        <DialogTitle>
                            网站设置
                            <IconButton
                                aria-label='close'
                                onClick={handleCloseConfig}
                                sx={{
                                    position: "absolute",
                                    right: 8,
                                    top: 8,
                                }}
                            >
                                <CloseIcon />
                            </IconButton>
                        </DialogTitle>
                        <DialogContent>
                            <DialogContentText sx={{ mb: 2 }}>
                                配置网站的基本信息和外观
                            </DialogContentText>
                            <Stack spacing={2.5}>
                                <TextField
                                    margin='dense'
                                    id='site-title'
                                    name='site.title'
                                    label='网站标题 (浏览器标签)'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.title"]}
                                    onChange={handleConfigInputChange}
                                />
                                <TextField
                                    margin='dense'
                                    id='site-name'
                                    name='site.name'
                                    label='网站名称 (显示在页面中)'
                                    type='text'
                                    fullWidth
                                    variant='outlined'
                                    value={tempConfigs["site.name"]}
                                    onChange={handleConfigInputChange}
                                />

                                {/* 主题配色：预设色 + 取色器，实时预览后点保存生效 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        主题配色
                                    </Typography>
                                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                                        {PRESET_ACCENTS.map(color => {
                                            const picked =
                                                (tempConfigs["site.primaryColor"] || "").toLowerCase() ===
                                                color.toLowerCase();
                                            return (
                                                <IconButton
                                                    key={color}
                                                    size='small'
                                                    aria-label={`使用配色 ${color}`}
                                                    aria-pressed={picked}
                                                    onClick={() => pickAccent(color)}
                                                    sx={{
                                                        width: 26,
                                                        height: 26,
                                                        minWidth: 26,
                                                        bgcolor: color,
                                                        border: "2px solid",
                                                        borderColor: picked ? "text.primary" : "transparent",
                                                        boxShadow: picked
                                                            ? `0 0 0 2px ${color}55`
                                                            : "0 1px 3px rgba(15,23,42,0.18)",
                                                        "&:hover": { bgcolor: color },
                                                    }}
                                                />
                                            );
                                        })}

                                        {/* 原生取色器：可任选任意颜色 */}
                                        <Box
                                            component='input'
                                            type='color'
                                            name='site.primaryColor'
                                            aria-label='自定义主色'
                                            value={
                                                /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(
                                                    tempConfigs["site.primaryColor"] || ""
                                                )
                                                    ? tempConfigs["site.primaryColor"]
                                                    : "#1976d2"
                                            }
                                            onChange={e => pickAccent(e.target.value)}
                                            sx={{
                                                width: 34,
                                                height: 26,
                                                p: 0,
                                                cursor: "pointer",
                                                bgcolor: "transparent",
                                                border: "1px solid",
                                                borderColor: "divider",
                                                borderRadius: 1,
                                            }}
                                        />

                                        <Button
                                            size='small'
                                            variant='text'
                                            onClick={() => pickAccent("")}
                                        >
                                            恢复默认
                                        </Button>
                                    </Box>
                                    <Typography variant='caption' color='text.secondary'>
                                        影响按钮、链接高亮、焦点环与卡片悬停色。留空则跟随默认蓝色（暗色模式自动切换）。
                                    </Typography>
                                </Box>

                                {/* 外观：圆角风格与字号档位，只影响本机显示 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        外观风格
                                    </Typography>
                                    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
                                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                                            <Typography variant='body2' sx={{ minWidth: 56 }}>
                                                圆角
                                            </Typography>
                                            <ToggleButtonGroup
                                                size='small'
                                                exclusive
                                                value={radius}
                                                onChange={(_e, value) => value && setRadius(value)}
                                                aria-label='圆角风格'
                                            >
                                                <ToggleButton value='soft' aria-label='圆润圆角'>
                                                    圆润
                                                </ToggleButton>
                                                <ToggleButton value='standard' aria-label='标准圆角'>
                                                    标准
                                                </ToggleButton>
                                                <ToggleButton value='sharp' aria-label='锐利圆角'>
                                                    锐利
                                                </ToggleButton>
                                            </ToggleButtonGroup>
                                        </Box>
                                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                                            <Typography variant='body2' sx={{ minWidth: 56 }}>
                                                字号
                                            </Typography>
                                            <ToggleButtonGroup
                                                size='small'
                                                exclusive
                                                value={fontScale}
                                                onChange={(_e, value) => value && setFontScale(value)}
                                                aria-label='字号档位'
                                            >
                                                <ToggleButton value='compact' aria-label='紧凑字号'>
                                                    紧凑
                                                </ToggleButton>
                                                <ToggleButton value='normal' aria-label='标准字号'>
                                                    标准
                                                </ToggleButton>
                                                <ToggleButton value='large' aria-label='宽松字号'>
                                                    宽松
                                                </ToggleButton>
                                            </ToggleButtonGroup>
                                        </Box>
                                    </Box>
                                    <Typography variant='caption' color='text.secondary'>
                                        这两项只存在本机，换设备或换浏览器不会跟随。
                                    </Typography>
                                </Box>

                                {/* 获取图标 API 设置 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        获取图标API设置
                                    </Typography>
                                    <TextField
                                        margin='dense'
                                        id='site-icon-api'
                                        name='site.iconApi'
                                        label='获取图标API URL'
                                        type='text'
                                        fullWidth
                                        variant='outlined'
                                        value={tempConfigs["site.iconApi"]}
                                        onChange={handleConfigInputChange}
                                        placeholder={DEFAULT_ICON_API}
                                        helperText='输入获取图标API的地址，使用 {domain} 作为域名占位符（例如 https://www.faviconextractor.com/favicon/{domain}?larger=true）'
                                    />
                                </Box>

                                {/* 站点缩略图设置 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        站点缩略图设置
                                    </Typography>
                                    <TextField
                                        margin='dense'
                                        id='site-thumb-api'
                                        name='site.thumbApi'
                                        label='缩略图API URL'
                                        type='text'
                                        fullWidth
                                        variant='outlined'
                                        value={tempConfigs["site.thumbApi"] || ""}
                                        onChange={handleConfigInputChange}
                                        placeholder='https://example.com/shot?url={url}'
                                        helperText='留空则不显示缩略图。可用占位符：{url} 完整链接、{domain} 域名、{origin} 协议+域名'
                                    />
                                </Box>

                                {/* 背景图片设置 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        背景图片设置
                                    </Typography>
                                    {/* 内置壁纸预设：点一下即用，也可以自己在下面填图片 URL */}
                                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
                                        {WALLPAPER_PRESETS.map(preset => {
                                            const picked =
                                                (tempConfigs["site.backgroundImage"] || "") ===
                                                preset.value;
                                            return (
                                                <Tooltip key={preset.label} title={preset.label}>
                                                    <IconButton
                                                        size='small'
                                                        aria-label={`使用壁纸 ${preset.label}`}
                                                        onClick={() =>
                                                            setTempConfigs(prev => ({
                                                                ...prev,
                                                                "site.backgroundImage":
                                                                    picked ? "" : preset.value,
                                                            }))
                                                        }
                                                        sx={{
                                                            width: 34,
                                                            height: 34,
                                                            background: preset.value,
                                                            border: "2px solid",
                                                            borderColor: picked
                                                                ? "text.primary"
                                                                : "transparent",
                                                            "&:hover": { background: preset.value },
                                                        }}
                                                    />
                                                </Tooltip>
                                            );
                                        })}
                                    </Box>
                                    <TextField
                                        margin='dense'
                                        id='site-background-image'
                                        name='site.backgroundImage'
                                        label='背景图片URL'
                                        type='text'
                                        fullWidth
                                        variant='outlined'
                                        value={tempConfigs["site.backgroundImage"]}
                                        onChange={handleConfigInputChange}
                                        placeholder='https://example.com/background.jpg'
                                        helperText='输入图片URL，留空则不使用背景图片（也可以直接用上面的预设壁纸）'
                                    />
                                    <Box sx={{ mt: 2 }}>
                                        <Typography variant='body2' color='text.secondary'>
                                            背景蒙版透明度:{" "}
                                            {Number(tempConfigs["site.backgroundMaskOpacity"]) || 0}
                                        </Typography>
                                        <Slider
                                            value={
                                                Number(tempConfigs["site.backgroundMaskOpacity"]) || 0
                                            }
                                            min={0}
                                            max={1}
                                            step={0.01}
                                            onChange={handleConfigSliderChange}
                                            aria-label='背景蒙版透明度'
                                            valueLabelDisplay='auto'
                                        />
                                        <Typography variant='caption' color='text.secondary'>
                                            值越大，背景图片越清晰，内容可能越难看清
                                        </Typography>
                                    </Box>
                                </Box>

                                {/* 毛玻璃强度 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        毛玻璃强度
                                    </Typography>
                                    <Typography variant='body2' color='text.secondary'>
                                        模糊半径: {tempGlassBlur}px（0 = 完全不模糊）
                                    </Typography>
                                    <Slider
                                        value={tempGlassBlur}
                                        min={0}
                                        max={24}
                                        step={1}
                                        onChange={handleGlassBlurChange}
                                        aria-label='毛玻璃强度'
                                        valueLabelDisplay='auto'
                                    />
                                    <Typography variant='caption' color='text.secondary'>
                                        数值越大越朦胧。内容看不清时调小，或直接拖到 0 关掉模糊。
                                    </Typography>
                                </Box>

                                {/* 管理员账号与密码 */}
                                <Box>
                                    <Typography variant='subtitle1' fontWeight='600' sx={{ mb: 1 }}>
                                        管理员账号与密码
                                    </Typography>
                                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 1 }}>
                                        凭据保存在数据库中，只有第一次部署才会使用默认账号密码，之后重新部署不会覆盖；留空表示不修改。
                                    </Typography>
                                    <TextField
                                        margin='dense'
                                        id='auth-username'
                                        label='管理员账号'
                                        type='text'
                                        fullWidth
                                        variant='outlined'
                                        value={authUsername}
                                        onChange={e => setAuthUsername(e.target.value)}
                                        placeholder='留空则不修改账号'
                                    />
                                    <TextField
                                        margin='dense'
                                        id='auth-current-password'
                                        label='当前密码'
                                        type='password'
                                        fullWidth
                                        variant='outlined'
                                        value={authCurrentPassword}
                                        onChange={e => setAuthCurrentPassword(e.target.value)}
                                        placeholder='修改账号或密码时必须填写'
                                    />
                                    <TextField
                                        margin='dense'
                                        id='auth-new-password'
                                        label='新密码'
                                        type='password'
                                        fullWidth
                                        variant='outlined'
                                        value={authNewPassword}
                                        onChange={e => setAuthNewPassword(e.target.value)}
                                        placeholder='留空则不修改密码'
                                    />
                                </Box>

                                <TextField
                                    margin='dense'
                                    id='site-custom-css'
                                    name='site.customCss'
                                    label='自定义CSS'
                                    type='text'
                                    fullWidth
                                    multiline
                                    rows={6}
                                    variant='outlined'
                                    value={tempConfigs["site.customCss"]}
                                    onChange={handleConfigInputChange}
                                    placeholder='/* 自定义样式 */\nbody { }'
                                />
                            </Stack>
                        </DialogContent>
                        <DialogActions sx={{ px: 3, pb: 3 }}>
                            <Button onClick={handleCloseConfig} variant='outlined'>
                                取消
                            </Button>
                            <Button onClick={handleSaveConfig} variant='contained' color='primary'>
                                保存设置
                            </Button>
                        </DialogActions>
                    </Dialog>

                    {/* 访问统计：本机热力图 + Top5 */}
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
                            notify("已清除访问记录", "success");
                        }}
                    />

                    {/* 数据备份与恢复对话框 */}
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
                        onNotify={notify}
                        onClose={handleCloseBackup}
                    />

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
                <CommandPalette
                    open={commandOpen}
                    onClose={() => setCommandOpen(false)}
                    commands={commands}
                />

                {/* 浏览器书签批量导入 */}
                <BookmarkImportDialog
                    open={bookmarkOpen}
                    onClose={() => setBookmarkOpen(false)}
                    onImport={importBookmarks}
                />
            </Box>
        </ThemeProvider>
         </NotifyContext.Provider>
        </AppConfigProvider>
    );
}

export default App;
