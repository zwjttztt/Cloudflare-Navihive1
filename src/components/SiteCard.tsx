// src/components/SiteCard.tsx
import { useState, useEffect, useMemo, memo, lazy, Suspense } from "react";
import { Site } from "../API/http";
// 卡片设置弹窗按需加载：只有点开某一张卡片时才需要它
const SiteSettingsModal = lazy(() => import("./SiteSettingsModal"));
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
// 引入Material UI组件
import {
    Card,
    CardContent,
    CardActionArea,
    Typography,
    Skeleton,
    IconButton,
    Box,
    Fade,
    Tooltip,
    Menu,
    MenuItem,
    ListItemIcon,
    ListItemText,
    Divider,
    useTheme,
    alpha,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import LinkIcon from "@mui/icons-material/Link";
import PersonIcon from "@mui/icons-material/Person";
import KeyIcon from "@mui/icons-material/Key";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import { useAppConfig } from "../context/AppConfigContext";
import { useNotify } from "../context/NotifyContext";
import { useUIPrefs } from "../context/UIPrefsContext";
import { resolveIconApiUrl } from "../utils/iconApi";
import {
    cacheIconBlob,
    iconCandidates,
    iconFallbackCandidates,
    readIconObjectUrl,
    readIconRecord,
    writeIconRecord,
} from "../utils/iconCache";
import { markLinkAlive } from "../utils/linkHealth";

interface SiteCardProps {
    site: Site;
    onUpdate: (updatedSite: Site) => void;
    onDelete: (siteId: number) => void;
    isEditMode?: boolean;
    index?: number;
    /** 搜索关键词，命中片段会高亮 */
    highlight?: string;
    /** 批量多选模式：点卡片变成勾选，不再打开网页 */
    selectMode?: boolean;
    selected?: boolean;
    onToggleSelect?: (siteId: number) => void;
}

// 图标取不到时，按站点名哈希出一个稳定的配色，避免所有占位块长得一模一样
const AVATAR_TONES = [
    { strong: "#1565C0", soft: "#90CAF9" },
    { strong: "#6A1B9A", soft: "#CE93D8" },
    { strong: "#00695C", soft: "#80CBC4" },
    { strong: "#C62828", soft: "#EF9A9A" },
    { strong: "#EF6C00", soft: "#FFCC80" },
    { strong: "#2E7D32", soft: "#A5D6A7" },
    { strong: "#4527A0", soft: "#B39DDB" },
    { strong: "#00838F", soft: "#80DEEA" },
];

const toneForName = (name: string) => {
    const str = name || "?";
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
};

/** 复制文本：优先用异步剪贴板 API，失败或无权限时降级到选中 + execCommand */
const copyText = async (text: string): Promise<boolean> => {
    if (!text) return false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 被浏览器策略拒绝时继续走降级方案
    }

    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
};

// 把命中的关键词片段包成 <mark>，未命中时原样输出
function Highlighted({ text, query }: { text: string; query?: string }) {
    if (!query) return <>{text}</>;

    const lower = text.toLowerCase();
    const key = query.toLowerCase();
    const hit = lower.indexOf(key);
    if (hit === -1) return <>{text}</>;

    return (
        <>
            {text.slice(0, hit)}
            <mark className='nav-hl'>{text.slice(hit, hit + query.length)}</mark>
            {text.slice(hit + query.length)}
        </>
    );
}

// 使用memo包装组件以减少不必要的重渲染
const SiteCard = memo(function SiteCard({
    site,
    onUpdate,
    onDelete,
    isEditMode = false,
    index = 0,
    highlight = "",
    selectMode = false,
    selected = false,
    onToggleSelect,
}: SiteCardProps) {
    const theme = useTheme();
    const { thumbApi, iconApi } = useAppConfig();
    const notify = useNotify();
    const { viewMode, density, recordVisit, deadLinks, setDeadLinks, isStarred, toggleStar, tags } =
        useUIPrefs();
    // 星标与标签都存本机（UIPrefs），和访问记录、折叠状态一样不进数据库
    const starred = isStarred(site.id);
    const siteTags = tags[String(site.id)] ?? [];
    const [showSettings, setShowSettings] = useState(false);
    // 右键菜单的锚点位置（null 表示未打开）
    const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

    // 版式与密度：编辑模式始终用标准卡片，避免拖拽时尺寸乱跳
    const isList = viewMode === "list" && !isEditMode;
    const isWall = viewMode === "wall" && !isEditMode;
    const isCompact = density === "compact";

    // 图标候选源：自带图标 → 图标 API → 根目录 favicon → 公共 favicon 服务，
    // 哪个先加载成功用哪个，失败的会记进本地缓存，下次直接跳过
    const primaryIcons = useMemo(() => iconCandidates(site, iconApi), [site.icon, site.url, iconApi]);
    // 兜底源（站点自己的 favicon.ico / 公共图标服务）只在主源全失败后才追加，
    // 平时每张卡片最多 2 个请求，几百张卡片也不会一上来就排出上千个
    const [fallbackAdded, setFallbackAdded] = useState(false);
    const iconSources = useMemo(
        () => (fallbackAdded ? [...primaryIcons, ...iconFallbackCandidates(site)] : primaryIcons),
        [primaryIcons, fallbackAdded, site.url]
    );
    const [iconIdx, setIconIdx] = useState(0);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [thumbError, setThumbError] = useState(false);
    const [thumbLoaded, setThumbLoaded] = useState(false);

    const iconError = iconIdx >= iconSources.length;
    const currentIcon = iconSources[iconIdx] ?? "";

    // 图标本体缓存：命中本地 blob 时直接用 objectURL，弱网 / 离线重开也能立刻显示
    const [iconObjectUrl, setIconObjectUrl] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        setIconObjectUrl(null);
        if (!currentIcon) return;
        void readIconObjectUrl(currentIcon).then(cached => {
            if (!cancelled && cached) setIconObjectUrl(cached);
        });
        return () => {
            cancelled = true;
        };
    }, [currentIcon]);

    // 缩略图：仅在「网站设置」里配了模板时才启用，避免默认请求第三方服务
    const thumbUrl = thumbApi.trim() ? resolveIconApiUrl(thumbApi, site.url || "") : "";
    const useThumb = Boolean(thumbUrl) && !thumbError && !isList && !isWall;

    // 缩略图地址变化时重置加载状态
    useEffect(() => {
        setThumbError(false);
        setThumbLoaded(false);
    }, [thumbUrl]);

    // 图标地址变化时重置加载状态：
    // 免刷新即时更新后，若图标由空改为有值，需要重新尝试加载，否则会一直显示首字母占位。
    // 同时查一遍本地缓存，把已知加载不出来的源直接跳过去。
    useEffect(() => {
        let cancelled = false;
        setImageLoaded(false);
        setFallbackAdded(false);
        setIconIdx(0);

        (async () => {
            for (let i = 0; i < primaryIcons.length; i++) {
                const record = await readIconRecord(primaryIcons[i]);
                if (record && !record.ok) continue; // 这个源以前失败过，跳过
                if (!cancelled) setIconIdx(i);
                return;
            }
            if (!cancelled) setIconIdx(primaryIcons.length); // 主源都失败过，等加载时再补兜底源
        })();

        return () => {
            cancelled = true;
        };
    }, [primaryIcons]);

    // 使用dnd-kit的useSortable hook
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: `site-${site.id || index}`,
        disabled: !isEditMode,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 9999 : "auto",
        opacity: isDragging ? 0.8 : 1,
        position: "relative" as const,
    };

    // 如果没有图标，使用首字母作为图标
    const fallbackIcon = site.name.charAt(0).toUpperCase();
    const tone = toneForName(site.name);
    const isDark = theme.palette.mode === "dark";

    // 处理设置按钮点击
    const handleSettingsClick = (e: React.MouseEvent) => {
        e.stopPropagation(); // 阻止卡片点击事件
        e.preventDefault(); // 防止默认行为
        setShowSettings(true);
    };

    // 处理关闭设置
    const handleCloseSettings = () => {
        setShowSettings(false);
    };

    // 处理卡片点击：卡片本体是真实的 <a target="_blank">，
    // 左键交给浏览器原生打开（中键则自动后台打开），这里只记录访问次数
    const handleCardClick = () => {
        // 多选模式下点卡片是「勾选」，不会被当成打开网页
        if (selectMode) return;
        if (!isEditMode && site.url) {
            recordVisit(site.id);
        }
    };

    // 多选模式：点卡片任意位置切换勾选（在事件冒泡到默认导航前拦下来）
    const handleShellClick = (e: React.MouseEvent) => {
        if (!selectMode || isEditMode) return;
        e.preventDefault();
        if (site.id != null) onToggleSelect?.(site.id);
    };

    // 鼠标中键点击 = 后台打开新标签页（浏览器原生行为，当前页不会被切走）
    const handleAuxClick = (e: React.MouseEvent) => {
        if (isEditMode || selectMode) return;
        if (e.button !== 1 || !site.url) return;
        recordVisit(site.id);
    };

    // 中键按下时屏蔽默认行为（Windows Chrome 的自动滚动），但不影响打开链接
    const handleMouseDown = (e: React.MouseEvent) => {
        if (isEditMode || e.button !== 1) return;
        e.preventDefault();
    };

    // 悬停快捷操作：复制类操作统一走顶部提示反馈
    const handleQuickCopy = async (
        e: React.MouseEvent,
        label: string,
        value?: string
    ) => {
        e.stopPropagation(); // 不要把点击冒泡给 CardActionArea，否则会顺带打开网页
        e.preventDefault();
        if (!value) {
            notify(`没有可复制的${label}`, "info");
            return;
        }
        const ok = await copyText(value);
        notify(ok ? `${label}已复制` : `复制失败，请手动复制`, ok ? "success" : "error");
    };

    // 右键菜单
    const handleContextMenu = (e: React.MouseEvent) => {
        if (isEditMode) return;
        e.preventDefault();
        setMenuPos({ left: e.clientX, top: e.clientY });
    };

    const closeMenu = () => setMenuPos(null);

    const handleMenuOpen = () => {
        closeMenu();
        recordVisit(site.id);
        window.open(site.url || "", "_blank");
    };

    const handleMenuEdit = () => {
        closeMenu();
        setShowSettings(true);
    };

    const handleMenuDelete = () => {
        closeMenu();
        if (site.id != null) {
            onDelete(site.id);
        }
    };

    // 只在真的存了账号/密码时才显示对应按钮
    const hasUsername = Boolean(site.username);
    const hasPassword = Boolean(site.password);

    // 处理图标加载错误：记下这个源不可用，换下一个候选
    const handleIconError = () => {
        if (currentIcon) void writeIconRecord(currentIcon, false);
        setImageLoaded(false);
        const next = iconIdx + 1;
        // 主源全部失败：这时才把兜底源接上来，继续从第一个兜底源开始试
        if (next >= iconSources.length && !fallbackAdded) setFallbackAdded(true);
        setIconIdx(next);
    };

    // 处理图片加载完成：记下这个源可用，并把图标本体存一份到本地（弱网/离线时直接命中）
    const handleImageLoad = () => {
        if (currentIcon) {
            void writeIconRecord(currentIcon, true);
            void cacheIconBlob(currentIcon);
        }
        setImageLoaded(true);
    };

    // 图标：加载失败或没有地址时，退化成按名称哈希配色的首字母块
    const renderAvatar = (mr: number | string = 1.5, size = 36) => {
        if (!iconError && currentIcon) {
            return (
                <Box
                    className='nav-card-icon'
                    position='relative'
                    mr={mr}
                    width={size}
                    height={size}
                    flexShrink={0}
                    sx={{
                        // 统一底板：浅色 logo 有边框托底不至于「消失」，深色 logo 也不会糊在一起
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "11px",
                        bgcolor: isDark ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.94)",
                        border: "1px solid",
                        borderColor: isDark ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.09)",
                        boxShadow: isDark ? "none" : "0 1px 3px rgba(15,23,42,0.08)",
                        transition: "transform .22s cubic-bezier(.22,.61,.36,1)",
                    }}
                >
                    <Skeleton
                        variant='rounded'
                        width={size - 12}
                        height={size - 12}
                        sx={{
                            display: !imageLoaded ? "block" : "none",
                            position: "absolute",
                            inset: 0,
                            margin: "auto",
                        }}
                    />
                    <Fade in={imageLoaded} timeout={400}>
                        <Box
                            component='img'
                            src={iconObjectUrl || currentIcon}
                            alt={site.name}
                            loading='lazy'
                            decoding='async'
                            sx={{
                                width: size - 12,
                                height: size - 12,
                                borderRadius: "6px",
                                objectFit: "contain",
                            }}
                            onError={handleIconError}
                            onLoad={handleImageLoad}
                        />
                    </Fade>
                </Box>
            );
        }

        return (
            <Box
                className='nav-card-icon'
                sx={{
                    width: size,
                    height: size,
                    mr: mr,
                    borderRadius: 1.5,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: size > 40 ? 20 : 15,
                    // 图标取不到时用站点名首字母顶上，底色做成同色系渐变，比纯色块耐看
                    background: `linear-gradient(135deg, ${alpha(
                        isDark ? tone.soft : tone.strong,
                        isDark ? 0.34 : 0.2
                    )} 0%, ${alpha(isDark ? tone.strong : tone.soft, isDark ? 0.16 : 0.08)} 100%)`,
                    color: isDark ? tone.soft : tone.strong,
                    border: "1px solid",
                    borderColor: alpha(isDark ? tone.soft : tone.strong, isDark ? 0.3 : 0.22),
                    transition: "transform .22s cubic-bezier(.22,.61,.36,1)",
                }}
            >
                {fallbackIcon}
            </Box>
        );
    };

    // 失效标记（打开时间与点击次数不再展示，避免卡片右侧信息过载）
    const isDead = Boolean(site.url && deadLinks[site.url]);

    const renderBadges = () => (
        <>
            {isDead && (
                <Tooltip title='链接可能已失效（点右键 → 复制链接确认）'>
                    <Box className='nav-dead-dot' aria-label='链接可能已失效'>
                        失效
                    </Box>
                </Tooltip>
            )}
        </>
    );

    // 标题
    const renderTitle = () => (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                minWidth: 0,
                flexShrink: 1,
            }}
        >
            <Typography
                className='nav-card-title'
                variant={isWall ? "caption" : "subtitle1"}
                fontWeight='medium'
                noWrap
                title={site.name}
                sx={{
                    fontSize: { xs: "0.875rem", sm: "1rem" },
                    transition: "color .2s ease",
                }}
            >
                <Highlighted text={site.name} query={highlight} />
            </Typography>
            {renderBadges()}
        </Box>
    );

    // 描述
    const renderDescription = () => (
        <Typography
            variant='body2'
            color='text.secondary'
            sx={{
                display: "-webkit-box",
                WebkitLineClamp: isCompact ? 2 : useThumb ? 2 : 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                flexGrow: 1,
                fontSize: { xs: "0.75rem", sm: "0.875rem" },
            }}
        >
            <Highlighted text={site.description || "暂无描述"} query={highlight} />
        </Typography>
    );

    // 键盘可达：卡片聚焦后回车/空格打开链接（方向键由 App 统一处理）
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (isEditMode) return;
        // 菜单键（或 Shift+F10）在光标元素的右下角打开右键菜单，
        // 让只用键盘的人也能拿到原来只有鼠标右键才有的那些操作
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenuPos({ left: rect.left + 12, top: rect.bottom - 8 });
            return;
        }
        // 多选模式下回车/空格同样是「勾选」
        if (selectMode) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (site.id != null) onToggleSelect?.(site.id);
            }
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); // 焦点在卡片外壳上，不会触发 <a> 的原生导航，这里手动打开
            if (!site.url) return;
            recordVisit(site.id);
            window.open(site.url, "_blank");
        }
    };

    // 网站设置按钮：放在 <a> 外面（a 里不能嵌交互元素），靠绝对定位回到右上角
    const renderSettingsButton = () =>
        !isEditMode &&
        !isList &&
        !isWall && (
            <IconButton
                className='nav-settings-btn'
                size='small'
                sx={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    minWidth: 32,
                    minHeight: 32,
                    p: 0,
                    bgcolor: "var(--glass-bg-hover)",
                    backdropFilter: "blur(6px)",
                    opacity: 0,
                    transition: "opacity .2s, background-color .2s",
                    zIndex: 2,
                    "&:hover": {
                        bgcolor: "action.selected",
                    },
                }}
                onClick={handleSettingsClick}
                aria-label='网站设置'
            >
                <SettingsIcon fontSize='small' />
            </IconButton>
        );

    // 这张卡片被判成失效链接时，右键菜单里给一条纠偏入口：
    // 标记后写入白名单，之后的批量检测会直接跳过它
    const handleMarkAlive = () => {
        closeMenu();
        if (!site.url) return;
        setDeadLinks(markLinkAlive(site.url));
        notify(`已把「${site.name || site.url}」标记为可访问`, "success");
    };

    // 星标按钮：加星后常显（并在分组里置顶），未加星时悬停才浮出
    const renderStarButton = () =>
        !isEditMode &&
        !isList &&
        !isWall &&
        // 多选模式下左上角让给勾选标记，避免两个圆形叠在一起
        !selectMode && (
            <IconButton
                className='nav-star-btn'
                data-starred={starred ? "true" : "false"}
                size='small'
                aria-label={starred ? "取消星标" : "加星标"}
                aria-pressed={starred}
                onClick={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    toggleStar(site.id);
                }}
                sx={{
                    position: "absolute",
                    top: 8,
                    left: 8,
                    // 原来 p 0.4 只有 21px，比 WCAG 2.5.8 的 24px 底线还小。
                    // 靠 padding 推尺寸在 MUI 里不稳（size='small' 会插一脚），
                    // 直接给死最小尺寸 + 内容居中
                    minWidth: 32,
                    minHeight: 32,
                    p: 0,
                    color: starred ? "var(--accent)" : "text.secondary",
                    bgcolor: "var(--glass-bg-hover)",
                    backdropFilter: "blur(6px)",
                    WebkitBackdropFilter: "blur(6px)",
                    transition: "opacity .2s, transform .2s, background-color .2s",
                    zIndex: 2,
                    "&:hover": { bgcolor: "action.selected" },
                }}
            >
                {starred ? (
                    <StarIcon className='nav-star-icon' sx={{ fontSize: 17 }} />
                ) : (
                    <StarBorderIcon sx={{ fontSize: 17 }} />
                )}
            </IconButton>
        );

    // 多选勾选标记：直接画在卡片左上角，比塞一个真复选框更轻，也不会抢走点击
    const renderSelectMark = () =>
        selectMode && (
            <Box
                className='nav-select-mark'
                data-selected={selected ? "true" : "false"}
                aria-hidden
                sx={{
                    position: "absolute",
                    top: 8,
                    left: 8,
                    width: 22,
                    height: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    zIndex: 3,
                    color: selected ? "var(--accent)" : "text.disabled",
                    bgcolor: selected ? "background.paper" : "rgba(127,127,127,0.16)",
                    boxShadow: selected ? "0 1px 6px rgba(15,23,42,0.2)" : "none",
                    transition: "all .18s cubic-bezier(.22,.61,.36,1)",
                }}
            >
                {selected ? (
                    <CheckCircleIcon sx={{ fontSize: 20 }} />
                ) : (
                    <RadioButtonUncheckedIcon sx={{ fontSize: 20 }} />
                )}
            </Box>
        );

    // 多选模式下的星标徽标：只展示状态、不响应点击（点击要留给勾选卡片）。
    // 已加星 = 主色实心星 + 淡主色底；未加星 = 极淡的描边星，让「有没有星」一眼可读。
    const renderStarBadge = () =>
        selectMode && (
            <Box
                className='nav-star-badge'
                data-starred={starred ? "true" : "false"}
                title={starred ? "已加星标" : "未加星标"}
                sx={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 22,
                    height: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    zIndex: 3,
                    pointerEvents: "none",
                    color: starred ? "var(--accent)" : "text.disabled",
                    bgcolor: starred ? "var(--glass-bg-hover)" : "rgba(127,127,127,0.12)",
                    boxShadow: starred ? "0 1px 6px rgba(15,23,42,0.18)" : "none",
                    opacity: starred ? 1 : 0.55,
                }}
            >
                {starred ? (
                    <StarIcon sx={{ fontSize: 15 }} />
                ) : (
                    <StarBorderIcon sx={{ fontSize: 15 }} />
                )}
            </Box>
        );

    // 卡片上的标签：只做展示（不抢点击），多了折叠成 +N
    const renderTagChips = () => {
        if (isEditMode || isWall || siteTags.length === 0) return null;
        const shown = siteTags.slice(0, isList ? 1 : 2);
        const rest = siteTags.length - shown.length;
        return (
            <Box
                className='nav-card-tags'
                sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.75 }}
            >
                {shown.map(tag => (
                    <Box key={tag} className='nav-tag-chip'>
                        {tag}
                    </Box>
                ))}
                {rest > 0 && <Box className='nav-tag-chip'>+{rest}</Box>}
            </Box>
        );
    };

    // 卡片本体做成真实的 <a>：左键普通新标签，中键由浏览器原生后台打开（不切走当前页）
    const linkProps = site.url
        ? {
              component: "a" as const,
              href: site.url,
              target: "_blank",
              rel: "noopener",
              tabIndex: -1,
          }
        : {};

    // 缩略图区块（加载失败时整块不渲染，回到只有图标的紧凑版式）
    const renderThumbnail = () => {
        if (!useThumb) return null;

        return (
            <Box
                sx={{
                    position: "relative",
                    height: 104,
                    flexShrink: 0,
                    bgcolor: "action.hover",
                    overflow: "hidden",
                }}
            >
                {!thumbLoaded && (
                    <Skeleton
                        variant='rectangular'
                        height={104}
                        sx={{ position: "absolute", inset: 0 }}
                    />
                )}
                <Box
                    component='img'
                    src={thumbUrl}
                    alt={`${site.name} 预览图`}
                    loading='lazy'
                    decoding='async'
                    onLoad={() => setThumbLoaded(true)}
                    onError={() => setThumbError(true)}
                    sx={{
                        width: "100%",
                        height: 104,
                        objectFit: "cover",
                        display: thumbLoaded ? "block" : "none",
                        transition: "transform .35s ease",
                    }}
                />
            </Box>
        );
    };

    // 悬停快捷操作条：复制链接 / 复制账号 / 复制密码
    // （打开动作已交给卡片本体：左键普通新标签，中键后台打开）
    // always=true 时（列表视图）常显，否则悬停才浮出
    const renderQuickActions = (always: boolean) => (
        <Box
            className={
                always ? "nav-card-actions nav-card-actions-always" : "nav-card-actions"
            }
            sx={{
                position: "absolute",
                right: 8,
                ...(always
                    ? { top: "50%", transform: "translateY(-50%)" }
                    : { bottom: 8 }),
                display: "flex",
                alignItems: "center",
                // 按钮本身放大到 ~30px 后，把按钮间距收一点，整条不至于占满卡片下沿
                gap: 0.1,
                p: 0.35,
                borderRadius: "12px",
                bgcolor: "var(--glass-bg-hover)",
                border: "1px solid var(--glass-border)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                boxShadow: "0 2px 10px rgba(15,23,42,0.14)",
                zIndex: 2,
            }}
        >
            <Tooltip title='复制链接'>
                <IconButton
                    size='small'
                    aria-label='复制链接'
                    onClick={e => handleQuickCopy(e, "链接", site.url)}
                    sx={{ minWidth: 32, minHeight: 32, p: 0 }}
                >
                    <LinkIcon sx={{ fontSize: 16 }} />
                </IconButton>
            </Tooltip>
            {hasUsername && (
                <Tooltip title='复制账号'>
                    <IconButton
                        size='small'
                        aria-label='复制账号'
                        onClick={e => handleQuickCopy(e, "账号", site.username)}
                        sx={{ minWidth: 32, minHeight: 32, p: 0 }}
                    >
                        <PersonIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                </Tooltip>
            )}
            {hasPassword && (
                <Tooltip title='复制密码'>
                    <IconButton
                        size='small'
                        aria-label='复制密码'
                        onClick={e => handleQuickCopy(e, "密码", site.password)}
                        sx={{ minWidth: 32, minHeight: 32, p: 0 }}
                    >
                        <KeyIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                </Tooltip>
            )}
        </Box>
    );

    // 毛玻璃 + 悬停微交互的外壳样式，各版式共用
    const cardSx = {
        height: "100%",
        display: "flex",
        flexDirection: "column" as const,
        borderRadius: "var(--card-radius)",
        overflow: "hidden",
        position: "relative" as const,
        border: "1px solid var(--glass-border)",
        background: "var(--glass-bg)",
        backdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
        WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(1.4)",
        boxShadow: "var(--glass-shadow)",
        transition:
            "transform .22s cubic-bezier(.22,.61,.36,1), box-shadow .22s ease, background .22s ease, border-color .22s ease",
        "&:hover": isEditMode
            ? {}
            : {
                  boxShadow: "var(--glass-shadow-hover)",
                  background: "var(--glass-bg-hover)",
                  borderColor: alpha(theme.palette.primary.main, 0.35),
                  "& .nav-card-icon": {
                      transform: "scale(1.08)",
                  },
                  "& .nav-card-title": {
                      color: "primary.main",
                  },
              },
    };

    // 卡片内容
    const cardContent = (
        <Box
            className='nav-card-in'
            data-nav-card={isEditMode ? undefined : "true"}
            data-dragging={isDragging ? "true" : "false"}
            data-site-id={site.id}
            tabIndex={isEditMode ? undefined : 0}
            data-hover-lift={isEditMode || selectMode ? undefined : ""}
            data-select-mode={selectMode ? "true" : "false"}
            data-selected={selected ? "true" : "false"}
            onKeyDown={handleKeyDown}
            onClick={handleShellClick}
            onAuxClick={handleAuxClick}
            onMouseDown={handleMouseDown}
            onContextMenu={handleContextMenu}
            sx={{
                height: "100%",
                position: "relative",
                borderRadius: "var(--card-radius)",
            }}
            style={{
                animationDelay: `${Math.min(index, 12) * 35}ms`,
                ["--nav-hover-lift" as string]: isList ? "translateX(3px)" : "translateY(-6px)",
            }}
        >
            <Card sx={cardSx}>
                {isEditMode ? (
                    <Box
                        sx={{
                            height: "100%",
                            p: { xs: 1.5, sm: 2 },
                            cursor: "grab",
                            display: "flex",
                            flexDirection: "column",
                        }}
                    >
                        <Box position='absolute' top={8} right={8}>
                            <DragIndicatorIcon fontSize='small' color='primary' />
                        </Box>
                        {/* 图标和名称 */}
                        <Box display='flex' alignItems='center' mb={1}>
                            {renderAvatar()}
                            {renderTitle()}
                        </Box>

                        {/* 描述 */}
                        {renderDescription()}
                    </Box>
                ) : isList ? (
                    // 紧凑列表：一行一个站点，一屏能看几十个
                    <Box
                        {...linkProps}
                        onClick={handleCardClick}
                        sx={{
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 1.5,
                            px: 1.5,
                            py: isCompact ? 0.5 : 1,
                            cursor: "pointer",
                            textDecoration: "none",
                            color: "inherit",
                        }}
                    >
                        {renderAvatar(0, isCompact ? 28 : 36)}
                        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                            {renderTitle()}
                            {renderTagChips()}
                            {!isCompact && (
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    noWrap
                                    sx={{ display: "block" }}
                                >
                                    <Highlighted
                                        text={site.description || site.url || ""}
                                        query={highlight}
                                    />
                                </Typography>
                            )}
                        </Box>
                    </Box>
                ) : isWall ? (
                    // 图标墙：只留图标 + 名字，密度最高
                    <CardActionArea
                        {...linkProps}
                        onClick={handleCardClick}
                        sx={{ height: "100%", textDecoration: "none", color: "inherit" }}
                    >
                        <Box
                            sx={{
                                p: isCompact ? 1 : 1.5,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 0.75,
                            }}
                        >
                            {renderAvatar(0, isCompact ? 40 : 48)}
                            <Typography
                                variant='caption'
                                noWrap
                                sx={{ maxWidth: "100%", fontSize: isCompact ? 10 : 12 }}
                            >
                                <Highlighted text={site.name} query={highlight} />
                            </Typography>
                        </Box>
                    </CardActionArea>
                ) : (
                    <CardActionArea
                        {...linkProps}
                        onClick={handleCardClick}
                        sx={{
                            height: "100%",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "stretch",
                            justifyContent: "flex-start",
                            textDecoration: "none",
                            color: "inherit",
                        }}
                    >
                        {renderThumbnail()}
                        <CardContent
                            sx={{
                                position: "relative",
                                flexGrow: 1,
                                display: "flex",
                                flexDirection: "column",
                                p: isCompact ? 1.25 : { xs: 1.5, sm: 2 },
                                "&:last-child": { pb: isCompact ? 1.25 : { xs: 1.5, sm: 2 } },
                            }}
                        >
                            {/* 图标和名称 */}
                            <Box display='flex' alignItems='center' mb={isCompact ? 0.5 : 1}>
                                {renderAvatar()}
                                {renderTitle()}
                            </Box>

                            {/* 描述 */}
                            {renderDescription()}
                            {/* 标签 */}
                            {renderTagChips()}
                        </CardContent>
                    </CardActionArea>
                )}
            </Card>

            {/* 网站设置按钮（放在链接外面，避免 a 里嵌交互元素） */}
            {!selectMode && renderSettingsButton()}

            {/* 星标与多选勾选都浮在卡片上，不进链接内部 */}
            {renderStarButton()}
            {renderSelectMark()}
            {renderStarBadge()}

            {/* 快捷操作条 */}
            {!isEditMode && !selectMode && renderQuickActions(isList)}
        </Box>
    );

    // 右键菜单（与卡片本体共用一套打开/复制/编辑/删除动作）
    const contextMenu = (
        <Menu
            open={menuPos !== null}
            onClose={closeMenu}
            anchorReference='anchorPosition'
            anchorPosition={menuPos ? { top: menuPos.top, left: menuPos.left } : undefined}
            slotProps={{ paper: { sx: { minWidth: 190, borderRadius: "14px" } } }}
            aria-label={`${site.name || "卡片"}操作菜单`}
        >
            <MenuItem onClick={handleMenuOpen} disabled={!site.url}>
                <ListItemIcon>
                    <OpenInNewIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>新标签打开</ListItemText>
            </MenuItem>
            <MenuItem
                onClick={() => {
                    closeMenu();
                    toggleStar(site.id);
                }}
            >
                <ListItemIcon>
                    {starred ? (
                        <StarIcon fontSize='small' sx={{ color: "var(--accent)" }} />
                    ) : (
                        <StarBorderIcon fontSize='small' />
                    )}
                </ListItemIcon>
                <ListItemText>{starred ? "取消星标" : "加星标置顶"}</ListItemText>
            </MenuItem>
            <MenuItem onClick={e => handleQuickCopy(e, "链接", site.url)} disabled={!site.url}>
                <ListItemIcon>
                    <LinkIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>复制链接</ListItemText>
            </MenuItem>
            {hasUsername && (
                <MenuItem onClick={e => handleQuickCopy(e, "账号", site.username)}>
                    <ListItemIcon>
                        <PersonIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>复制账号</ListItemText>
                </MenuItem>
            )}
            {hasPassword && (
                <MenuItem onClick={e => handleQuickCopy(e, "密码", site.password)}>
                    <ListItemIcon>
                        <KeyIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>复制密码</ListItemText>
                </MenuItem>
            )}
            {isDead && (
                <MenuItem onClick={handleMarkAlive}>
                    <ListItemIcon>
                        <LinkOffIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>标记为可访问</ListItemText>
                </MenuItem>
            )}
            <Divider />
            <MenuItem onClick={handleMenuEdit}>
                <ListItemIcon>
                    <EditIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>编辑</ListItemText>
            </MenuItem>
            <MenuItem onClick={handleMenuDelete} sx={{ color: "error.main" }}>
                <ListItemIcon>
                    <DeleteOutlineIcon fontSize='small' color='error' />
                </ListItemIcon>
                <ListItemText>删除</ListItemText>
            </MenuItem>
        </Menu>
    );

    if (isEditMode) {
        return (
            <>
                <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
                    {cardContent}
                </div>

                {showSettings && (
                    <Suspense fallback={null}>
                    <SiteSettingsModal
                        site={site}
                        onUpdate={onUpdate}
                        onDelete={onDelete}
                        onClose={handleCloseSettings}
                    />
                    </Suspense>
                )}
            </>
        );
    }

    return (
        <>
            {cardContent}
            {contextMenu}

            {showSettings && (
                <Suspense fallback={null}>
                <SiteSettingsModal
                    site={site}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onClose={handleCloseSettings}
                />
                </Suspense>
            )}
        </>
    );
});

export default SiteCard;
