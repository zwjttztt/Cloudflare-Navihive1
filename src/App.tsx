import { useState, useEffect, useMemo, useRef } from "react";
import { NavigationClient } from "./API/client";
import { MockNavigationClient } from "./API/mock";
import { Site, Group, ExportData, BootstrapData, WebDavConfig, normalizeImportData } from "./API/http";
import { GroupWithSites } from "./types";
import ThemeToggle from "./components/ThemeToggle";
import GroupCard from "./components/GroupCard";
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
import BackupIcon from "@mui/icons-material/Backup";

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
};

// WebDAV 备份默认配置（保存在服务端 configs 表中，不会写入备份文件）
const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
    url: "",
    username: "",
    password: "",
    path: "navihive-backup",
};

// WebDAV 配置在 configs 表中的键名前缀
const WEBDAV_CONFIG_PREFIX = "webdav.";

function App() {
    // 主题模式状态
    const [darkMode, setDarkMode] = useState(() => {
        const savedTheme = localStorage.getItem("theme");
        if (savedTheme) {
            return savedTheme === "dark";
        }
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
    });

    // 创建Material UI主题
    const theme = useMemo(
        () =>
            createTheme({
                palette: {
                    mode: darkMode ? "dark" : "light",
                },
            }),
        [darkMode]
    );

    // 切换主题的回调函数
    const toggleTheme = () => {
        setDarkMode(!darkMode);
        localStorage.setItem("theme", !darkMode ? "dark" : "light");
    };

    const [groups, setGroups] = useState<GroupWithSites[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sortMode, setSortMode] = useState<SortMode>(SortMode.None);
    const [currentSortingGroupId, setCurrentSortingGroupId] = useState<number | null>(null);
    // 记录进入站点排序时每个站点所属的原始分组，用于保存时识别跨组移动
    const siteOriginalGroupRef = useRef<Map<number, number>>(new Map());

    // 新增认证状态
    const [isAuthChecking, setIsAuthChecking] = useState(true);
    const [isAuthRequired, setIsAuthRequired] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [loginLoading, setLoginLoading] = useState(false);

    // 配置状态
    const [configs, setConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);
    const [openConfig, setOpenConfig] = useState(false);
    const [tempConfigs, setTempConfigs] = useState<Record<string, string>>(DEFAULT_CONFIGS);

    // WebDAV 备份配置
    const [webdavConfig, setWebdavConfig] = useState<WebDavConfig>(DEFAULT_WEBDAV_CONFIG);

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
    const [newGroup, setNewGroup] = useState<Partial<Group>>({ name: "", order_num: 0 });
    const [newSite, setNewSite] = useState<Partial<Site>>({
        name: "",
        url: "",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
        group_id: 0,
    });

    // 新增菜单状态
    const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
    const openMenu = Boolean(menuAnchorEl);

    // 备份/恢复对话框状态
    const [openBackup, setOpenBackup] = useState(false);
    const [backupTab, setBackupTab] = useState(0);

    // 错误提示框状态
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState("");
    const [snackbarSeverity, setSnackbarSeverity] = useState<"success" | "error" | "info">("error");

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
    const handleLogin = async (username: string, password: string) => {
        try {
            setLoginLoading(true);
            setLoginError(null);

            // 调用登录接口（返回的是 LoginResponse 对象，必须判断 success 字段）
            const result = await api.login(username, password);

            if (result && result.success) {
                // 登录成功
                setIsAuthenticated(true);
                setIsAuthRequired(false);
                setLoginError(null);
                // 加载数据（一次 bootstrap 请求）
                await fetchData();
            } else {
                // 登录失败：账号或密码不对
                const message = result?.message || "用户名或密码错误";
                setLoginError(message);
                handleError(message);
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

    // 统一提示函数
    const notify = (message: string, severity: "success" | "error" | "info" = "info") => {
        setSnackbarMessage(message);
        setSnackbarSeverity(severity);
        setSnackbarOpen(true);
    };

    // 处理错误的函数
    const handleError = (errorMessage: string) => {
        notify(errorMessage, "error");
        console.error(errorMessage);
    };

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

    // 修改后的后台静默同步：界面先按本地状态立即更新，再悄悄拉一次最新数据，全程不出现加载转圈
    const syncInBackground = () => {
        void fetchData({ silent: true });
    };

    // ---- 本地状态更新（避免每次修改都整页重新加载） ----
    const upsertSiteLocally = (site: Site) => {
        setGroups(prev =>
            prev.map(group => {
                const exists = group.sites.some(item => item.id === site.id);

                if (group.id === site.group_id) {
                    const sites = exists
                        ? group.sites.map(item => (item.id === site.id ? { ...item, ...site } : item))
                        : [...group.sites, site];
                    return {
                        ...group,
                        sites: sites.sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)),
                    };
                }

                // 站点被移动到了其他分组：从原分组移除
                if (exists) {
                    return { ...group, sites: group.sites.filter(item => item.id !== site.id) };
                }
                return group;
            })
        );
    };

    const removeSiteLocally = (siteId: number) => {
        setGroups(prev =>
            prev.map(group => ({ ...group, sites: group.sites.filter(item => item.id !== siteId) }))
        );
    };

    // 更新站点
    const handleSiteUpdate = async (updatedSite: Site) => {
        try {
            if (updatedSite.id) {
                const saved = await api.updateSite(updatedSite.id, updatedSite);
                // 就地更新本地状态，界面即时生效，不再整页重新加载
                upsertSiteLocally(saved && saved.id !== undefined ? saved : updatedSite);
                syncInBackground();
            }
        } catch (error) {
            console.error("更新站点失败:", error);
            handleError("更新站点失败: " + (error as Error).message);
        }
    };

    // 删除站点
    const handleSiteDelete = async (siteId: number) => {
        try {
            await api.deleteSite(siteId);
            removeSiteLocally(siteId);
            syncInBackground();
        } catch (error) {
            console.error("删除站点失败:", error);
            handleError("删除站点失败: " + (error as Error).message);
        }
    };

    // 保存分组排序
    const handleSaveGroupOrder = async () => {
        try {
            console.log("保存分组顺序", groups);
            // 构造需要更新的分组顺序数据
            const groupOrders = groups.map((group, index) => ({
                id: group.id as number, // 断言id为number类型
                order_num: index,
            }));

            // 调用API更新分组顺序
            const result = await api.updateGroupOrder(groupOrders);

            if (result) {
                console.log("分组排序更新成功");
                // 排序结果已在本地生效，后台静默同步即可，不再整页转圈
                syncInBackground();
            } else {
                throw new Error("分组排序更新失败");
            }

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("更新分组排序失败:", error);
            handleError("更新分组排序失败: " + (error as Error).message);
        }
    };

    // 保存站点排序
    const handleSaveSiteOrder = async (groupId: number, sites: Site[]) => {
        try {
            console.log("保存站点排序", groupId, sites);

            // 构造需要更新的站点顺序数据
            const siteOrders = sites.map((site, index) => ({
                id: site.id as number,
                order_num: index,
            }));

            // 调用API更新站点顺序
            const result = await api.updateSiteOrder(siteOrders);

            if (result) {
                console.log("站点排序更新成功");
                // 排序结果已在本地生效，后台静默同步即可
                syncInBackground();
            } else {
                throw new Error("站点排序更新失败");
            }

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("更新站点排序失败:", error);
            handleError("更新站点排序失败: " + (error as Error).message);
        }
    };

    // 启动分组排序
    const startGroupSort = () => {
        console.log("开始分组排序");
        setSortMode(SortMode.GroupSort);
        setCurrentSortingGroupId(null);
    };

    // 启动站点排序
    const startSiteSort = (groupId: number) => {
        console.log("开始站点排序");
        setSortMode(SortMode.SiteSort);
        setCurrentSortingGroupId(groupId);
        // 记录每个站点当前的原始分组，用于保存时识别跨组移动
        const map = new Map<number, number>();
        groups.forEach(g => {
            g.sites.forEach(s => {
                if (s.id !== undefined) map.set(s.id, g.id as number);
            });
        });
        siteOriginalGroupRef.current = map;
    };

    // 取消排序
    const cancelSort = () => {
        setSortMode(SortMode.None);
        setCurrentSortingGroupId(null);
    };

    // 处理拖拽结束事件
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (!over) return;

        if (active.id !== over.id) {
            const oldIndex = groups.findIndex(group => group.id.toString() === active.id);
            const newIndex = groups.findIndex(group => group.id.toString() === over.id);

            if (oldIndex !== -1 && newIndex !== -1) {
                setGroups(arrayMove(groups, oldIndex, newIndex));
            }
        }
    };

    // 站点跨分组拖拽：同一分组内重排，跨分组则把卡片移动到目标分组
    const moveSiteAcrossGroups = (activeId: string, overId: string) => {
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

            const next = prev.map(g => ({ ...g, sites: [...g.sites] }));

            // 同一分组内重排
            if (activeContainerIdx === overContainerIdx) {
                const c = activeContainerIdx;
                const oldIndex = next[c].sites.findIndex(s => s.id === activeSiteId);
                const newIndex = Math.min(overIndex, next[c].sites.length - 1);
                next[c] = { ...next[c], sites: arrayMove(next[c].sites, oldIndex, newIndex) };
                return next;
            }

            // 跨分组移动：先移除，再插入目标分组，并更新 group_id
            const movedSite = { ...moved, group_id: prev[overContainerIdx].id as number };
            next[activeContainerIdx] = {
                ...next[activeContainerIdx],
                sites: next[activeContainerIdx].sites.filter(s => s.id !== activeSiteId),
            };
            const target = next[overContainerIdx].sites;
            const insertIdx = Math.min(overIndex, target.length);
            next[overContainerIdx] = {
                ...next[overContainerIdx],
                sites: [...target.slice(0, insertIdx), movedSite, ...target.slice(insertIdx)],
            };
            return next;
        });
    };

    const handleSiteSortDragOver = (event: DragOverEvent) => {
        const { active, over } = event;
        if (!over) return;
        moveSiteAcrossGroups(String(active.id), String(over.id));
    };

    const handleSiteSortDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over) return;
        moveSiteAcrossGroups(String(active.id), String(over.id));
    };

    // 保存站点排序（支持跨分组移动）
    const handleSaveSiteSort = async () => {
        try {
            const orders: { id: number; order_num: number }[] = [];
            const groupChanges: Site[] = [];
            groups.forEach(g => {
                g.sites.forEach((site, idx) => {
                    orders.push({ id: site.id as number, order_num: idx });
                    const orig = siteOriginalGroupRef.current.get(site.id as number);
                    if (orig !== undefined && orig !== g.id) {
                        groupChanges.push({ ...site, group_id: g.id, order_num: idx });
                    }
                });
            });

            if (orders.length > 0) {
                const ok = await api.updateSiteOrder(orders);
                if (!ok) throw new Error("更新排序失败");
            }
            for (const sc of groupChanges) {
                const ok = await api.updateSite(sc.id as number, {
                    group_id: sc.group_id,
                    order_num: sc.order_num,
                });
                if (!ok) throw new Error("更新分组失败");
            }

            syncInBackground();
            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("保存站点排序失败:", error);
            handleError("保存站点排序失败: " + (error as Error).message);
        }
    };

    // 新增分组相关函数
    const handleOpenAddGroup = () => {
        setNewGroup({ name: "", order_num: groups.length });
        setOpenAddGroup(true);
    };

    const handleCloseAddGroup = () => {
        setOpenAddGroup(false);
    };

    const handleGroupInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setNewGroup({
            ...newGroup,
            [e.target.name]: e.target.value,
        });
    };

    const handleCreateGroup = async () => {
        try {
            if (!newGroup.name) {
                handleError("分组名称不能为空");
                return;
            }

            const created = await api.createGroup(newGroup as Group);
            // 服务端返回新建分组，直接追加到本地列表，无需重新加载
            if (created && created.id !== undefined) {
                setGroups(prev => [...prev, { ...created, id: created.id as number, sites: [] }]);
            }
            syncInBackground();
            handleCloseAddGroup();
            setNewGroup({ name: "", order_num: 0 }); // 重置表单
        } catch (error) {
            console.error("创建分组失败:", error);
            handleError("创建分组失败: " + (error as Error).message);
        }
    };

    // 新增站点相关函数
    const handleOpenAddSite = (groupId: number) => {
        const group = groups.find(g => g.id === groupId);
        const maxOrderNum = group?.sites.length
            ? Math.max(...group.sites.map(s => s.order_num)) + 1
            : 0;

        setNewSite({
            name: "",
            url: "",
            icon: "",
            description: "",
            notes: "",
            group_id: groupId,
            order_num: maxOrderNum,
        });

        setOpenAddSite(true);
    };

    const handleCloseAddSite = () => {
        setOpenAddSite(false);
    };

    const handleSiteInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setNewSite({
            ...newSite,
            [e.target.name]: e.target.value,
        });
    };

    const handleCreateSite = async () => {
        try {
            if (!newSite.name || !newSite.url) {
                handleError("站点名称和URL不能为空");
                return;
            }

            const created = await api.createSite(newSite as Site);
            // 服务端返回新建站点，直接插入本地列表，界面立即出现新卡片
            if (created && created.id !== undefined) {
                upsertSiteLocally(created);
            }
            syncInBackground();
            handleCloseAddSite();
        } catch (error) {
            console.error("创建站点失败:", error);
            handleError("创建站点失败: " + (error as Error).message);
        }
    };

    // 配置相关函数
    const handleOpenConfig = () => {
        setTempConfigs({ ...configs });
        setOpenConfig(true);
    };

    const handleCloseConfig = () => {
        setOpenConfig(false);
    };

    const handleConfigInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setTempConfigs({
            ...tempConfigs,
            [e.target.name]: e.target.value,
        });
    };

    const handleSaveConfig = async () => {
        try {
            // 只提交有变化的配置，并并行写入，避免逐条等待
            const changed = Object.entries(tempConfigs).filter(([key, value]) => configs[key] !== value);
            await Promise.all(changed.map(([key, value]) => api.setConfig(key, value)));

            // 更新配置状态
            setConfigs({ ...tempConfigs });
            handleCloseConfig();
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
                <LoginForm onLogin={handleLogin} loading={loginLoading} error={loginError} />
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

    // 更新分组
    const handleGroupUpdate = async (updatedGroup: Group) => {
        try {
            if (updatedGroup.id) {
                await api.updateGroup(updatedGroup.id, updatedGroup);
                setGroups(prev =>
                    prev.map(group => (group.id === updatedGroup.id ? { ...group, ...updatedGroup } : group))
                );
                syncInBackground();
            }
        } catch (error) {
            console.error("更新分组失败:", error);
            handleError("更新分组失败: " + (error as Error).message);
        }
    };

    // 删除分组
    const handleGroupDelete = async (groupId: number) => {
        try {
            await api.deleteGroup(groupId);
            setGroups(prev => prev.filter(group => group.id !== groupId));
            syncInBackground();
        } catch (error) {
            console.error("删除分组失败:", error);
            handleError("删除分组失败: " + (error as Error).message);
        }
    };

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />

            {/* 错误提示 Snackbar */}
            <Snackbar
                open={snackbarOpen}
                autoHideDuration={6000}
                onClose={handleCloseSnackbar}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
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

            <Box
                sx={{
                    minHeight: "100vh",
                    bgcolor: "background.default",
                    color: "text.primary",
                    transition: "all 0.3s ease-in-out",
                }}
            >
                <Container
                    maxWidth='lg'
                    sx={{
                        py: 4,
                        px: { xs: 2, sm: 3, md: 4 },
                    }}
                >
                    <Box
                        sx={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            mb: 5,
                            flexDirection: { xs: "column", sm: "row" },
                            gap: { xs: 2, sm: 0 }
                        }}
                    >
                        <Typography
                            variant='h3'
                            component='h1'
                            fontWeight='bold'
                            color='text.primary'
                            sx={{ 
                                fontSize: { xs: '1.75rem', sm: '2.125rem', md: '3rem' },
                                textAlign: { xs: 'center', sm: 'left' }
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
                                        variant='contained'
                                        color='secondary'
                                        startIcon={<BackupIcon />}
                                        onClick={() => handleOpenBackup(0)}
                                        size="small"
                                        sx={{ 
                                            minWidth: 'auto',
                                            fontSize: { xs: '0.75rem', sm: '0.875rem' }
                                        }}
                                    >
                                        备份
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
                                        open={openMenu}
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
                                        <MenuItem onClick={handleOpenConfig}>
                                            <ListItemIcon>
                                                <SettingsIcon fontSize='small' />
                                            </ListItemIcon>
                                            <ListItemText>网站设置</ListItemText>
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
                            <ThemeToggle darkMode={darkMode} onToggle={toggleTheme} />
                        </Stack>
                    </Box>

                    {loading && (
                        <Box
                            sx={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                height: "200px",
                            }}
                        >
                            <CircularProgress size={60} thickness={4} />
                        </Box>
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
                                    onDragOver={handleSiteSortDragOver}
                                    onDragEnd={handleSiteSortDragEnd}
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
                                </DndContext>
                            ) : (
                                <Stack spacing={5}>
                                    {groups.map(group => (
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
                                        />
                                    ))}
                                </Stack>
                            )}
                        </Box>
                    )}

                    {/* 新增分组对话框 */}
                    <Dialog
                        open={openAddGroup}
                        onClose={handleCloseAddGroup}
                        maxWidth='sm'
                        fullWidth
                        PaperProps={{
                            sx: {
                                m: { xs: 2, sm: 'auto' },
                                width: { xs: 'calc(100% - 32px)', sm: 'auto' }
                            }
                        }}
                    >
                        <DialogTitle>
                            新增分组
                            <IconButton
                                aria-label='close'
                                onClick={handleCloseAddGroup}
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
                            <DialogContentText sx={{ mb: 2 }}>请输入新分组的信息</DialogContentText>
                            <TextField
                                autoFocus
                                margin='dense'
                                id='group-name'
                                name='name'
                                label='分组名称'
                                type='text'
                                fullWidth
                                variant='outlined'
                                value={newGroup.name}
                                onChange={handleGroupInputChange}
                                sx={{ mb: 2 }}
                            />
                        </DialogContent>
                        <DialogActions sx={{ px: 3, pb: 3 }}>
                            <Button onClick={handleCloseAddGroup} variant='outlined'>
                                取消
                            </Button>
                            <Button onClick={handleCreateGroup} variant='contained' color='primary'>
                                创建
                            </Button>
                        </DialogActions>
                    </Dialog>

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
                                />
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
                            <Button onClick={handleCreateSite} variant='contained' color='primary'>
                                创建
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
                            <Stack spacing={2}>
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

                    {/* 数据备份与恢复对话框 */}
                    <BackupDialog
                        open={openBackup}
                        initialTab={backupTab}
                        client={api}
                        webdavConfig={webdavConfig}
                        onSaveWebdavConfig={handleSaveWebdavConfig}
                        onBuildExportData={buildExportData}
                        onDownloadLocal={handleDownloadLocal}
                        onImportData={handleImportBackup}
                        onNotify={notify}
                        onClose={handleCloseBackup}
                    />

                </Container>
            </Box>
        </ThemeProvider>
    );
}

export default App;
