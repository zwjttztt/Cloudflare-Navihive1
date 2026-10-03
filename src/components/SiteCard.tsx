// src/components/SiteCard.tsx
import { useState, memo, lazy, Suspense } from "react";
import { Site } from "../API/http";
// 卡片设置弹窗按需加载：只有点开某一张卡片时才需要它
const SiteSettingsModal = lazy(() => import("./SiteSettingsModal"));
import SiteCardAvatar from "./SiteCardAvatar";
import { SiteCardTitle, SiteCardDescription } from "./SiteCardText";
import Highlighted from "./Highlighted";
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
import { useAppConfig } from "../context/appConfigStore";
import { useNotify } from "../context/NotifyContext";
import { canOpenSite, safeOpenSite } from "../utils/safeOpen";
import { useUIPrefsPrefs, useUIPrefsStable } from "../context/uiPrefsStore";
import { markLinkAlive } from "../utils/linkHealth";
import { useSiteIcon } from "../hooks/useSiteIcon";
import { useSiteThumb } from "../hooks/useSiteThumb";

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
    // 卡片不显示访问次数，所以只订阅「设置 + 写操作」和「星标 / 标签 / 死链」两份，
    // 不订阅访问统计 —— 以前每点一次卡片，几百张卡片都会因为那份状态变化重渲染一遍
    const { viewMode, density, recordVisit, setDeadLinks, toggleStar, iconPrivacy } =
        useUIPrefsStable();
    const { isStarred, tags, deadLinks } = useUIPrefsPrefs();
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

    // 图标候选源：自带图标 → 图标 API → 根目录 favicon → 公共图标服务，
    // 哪个先加载成功用哪个，失败的会记进本地缓存，下次直接跳过。
    // 状态机整个搬到了 hooks/useSiteIcon.ts（含「主源全挂才补兜底源」与 blob 借还），
    // 这里只拿结果 —— 它只读 site.icon / site.url，写成 [site] 的话改个备注
    // 也会把图标候选重算一遍。
    // 隐私模式：一个候选都不给，卡片直接用首字母块。
    // 取图标这件事本身就在告诉对方（以及公共图标服务）「有人在访问这个域名」，
    // 开了这个开关就彻底不发 —— 包括兜底源和缩略图。
    const {
        currentIcon,
        iconError,
        imageLoaded,
        iconObjectUrl,
        handleIconError,
        handleImageLoad,
    } = useSiteIcon({
        icon: site.icon,
        url: site.url,
        iconApi,
        privacy: iconPrivacy,
    });

    // 缩略图：仅在「网站设置」里配了模板时才启用，避免默认请求第三方服务。
    // 超时兜底（截图服务既不成功也不失败时别让骨架屏一直挂着）在 hooks/useSiteThumb.ts
    const { useThumb, thumbUrl, thumbLoaded, onLoad: onThumbLoad, onError: onThumbError } =
        useSiteThumb({
            thumbApi,
            siteUrl: site.url,
            enabled: !isList && !isWall,
            privacy: iconPrivacy,
        });

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
        safeOpenSite(site.url);
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

    // 图标：加载失败或没有地址时，退化成按名称哈希配色的首字母块
    // 图标那一块整套搬到了 components/SiteCardAvatar.tsx（两个分支形状完全不同，
    // 内联在这里时「取不到图标会长什么样」很难一眼看清）
    const renderAvatar = (mr: number | string = 1.5, size = 36) => (
        <SiteCardAvatar
            icon={currentIcon}
            iconError={iconError}
            imageLoaded={imageLoaded}
            iconObjectUrl={iconObjectUrl}
            onIconError={handleIconError}
            onImageLoad={handleImageLoad}
            siteName={site.name}
            fallbackChar={fallbackIcon}
            tone={tone}
            isDark={isDark}
            mr={mr}
            size={size}
        />
    );

    // 失效标记（打开时间与点击次数不再展示，避免卡片右侧信息过载）
    const isDead = Boolean(site.url && deadLinks[site.url]);

    const renderTitle = () => (
        <SiteCardTitle
            name={site.name}
            highlight={highlight}
            dead={isDead}
            compactTitle={isWall}
        />
    );

    // 描述
    const renderDescription = () => (
        <SiteCardDescription
            description={site.description}
            highlight={highlight}
            compact={isCompact}
            withThumb={useThumb}
        />
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
            safeOpenSite(site.url);
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
                    // 跟着右下角那条缩一档（32 → 28）：卡角上三个浮层控件尺寸拉齐，
                    // 紧凑密度下给下面的快捷条腾出竖直空间。小屏给 32（它上面的快捷条也是 32），
                    // 本来写 36 时窄屏只剩 1.1px 间隙，稍微长一点儿的描述就会碰上。
                    minWidth: { xs: 32, sm: 28 },
                    minHeight: { xs: 32, sm: 28 },
                    p: 0,
                    bgcolor: "var(--glass-bg-hover)",
                    backdropFilter: "blur(6px)",
                    // 注意：透明度不写在这里。sx 是 emotion 运行时注入的，会排在 index.css 之后，
                    // 同特异性下压过 CSS 的规则 —— 曾经这里写 opacity:0，导致触屏常显那套规则
                    // 只点亮了快捷条、设置按钮永远不显（CI 上就是这么红的）。统一交给 CSS 类管：
                    // 基础 0 / 悬停 1 / html.nav-touch 下 1
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

    // 星标按钮：加星后常显（并在分组里置顶），未加星时悬停才浮出。
    // 位置从左上角挪到右上角、紧挨「网站设置」左侧（right = 8 边距 + 28 按钮 + 6 间隙），
    // 两个都是本机操作、放一排更好找；左上角也腾出来只留给多选勾选标记。
    const renderStarButton = () =>
        !isEditMode &&
        !isList &&
        !isWall &&
        // 多选模式下不显示（那里用右上角的星标徽标表示状态，避免两个星标打架）
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
                    // 右边距 8 + 设置按钮宽度 + 6 间隙：小屏按钮是 32，所以跟着换档，
                    // 写死 42 的话小屏上会跟设置按钮压掉
                    right: { xs: 46, sm: 42 },
                    // 原来是 p 0.4 只有 21px，比 WCAG 2.5.8 的 24px 底线还小。
                    // 靠 padding 推尺寸在 MUI 里不稳（size='small' 会插一脚），
                    // 直接给死尺寸 + 内容居中；28 与右边设置按钮对齐，卡角三个浮层控件同尺寸
                    minWidth: { xs: 32, sm: 28 },
                    minHeight: { xs: 32, sm: 28 },
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
    // 兜底：库里的链接理论上都在保存/导入时规范化过了，但历史数据或手动改库可能混进奇怪的值，
    // 出 href 前再确认一次是 http(s)，否则干脆不给链接（宁可不能点，也不能点一下执行脚本）
    const linkProps = site.url && canOpenSite(site.url)
        ? {
              component: "a" as const,
              href: site.url,
              target: "_blank",
              // noreferrer 顺手也加上：外链不该带上本站地址
              rel: "noopener noreferrer",
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
                    onLoad={onThumbLoad}
                    onError={onThumbError}
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
                // 这一条原来按 32px 按钮 + 2.8px 内边距做，整条 39.6px：
                // 舒适密度（卡高 98）还留得住，紧凑密度（卡高 82）就直接顶到
                // 右上角的设置按钮上（实测重叠 1.6px），列表视图里更是比 38px 的行还高。
                // 收到 26px + 2px 内边距 = 整条 30px，各版式都留得出空隙，
                // 同时仍高于 WCAG 2.5.8 的 24px 底线（小屏上另给 32px 保触控）。
                gap: 0,
                p: 0.25,
                borderRadius: "10px",
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
                    sx={{ minWidth: { xs: 32, sm: 26 }, minHeight: { xs: 32, sm: 26 }, p: 0 }}
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
                        sx={{ minWidth: { xs: 32, sm: 26 }, minHeight: { xs: 32, sm: 26 }, p: 0 }}
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
                        sx={{ minWidth: { xs: 32, sm: 26 }, minHeight: { xs: 32, sm: 26 }, p: 0 }}
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
