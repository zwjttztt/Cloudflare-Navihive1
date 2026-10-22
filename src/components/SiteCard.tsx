// src/components/SiteCard.tsx
import { useState, useEffect, memo, lazy, Suspense } from "react";
import { Site } from "../API/http";
import { prefetchChunk } from "../utils/lazyPrefetch";
// 卡片设置弹窗按需加载：只有点开某一张卡片时才需要它
const SiteSettingsModal = lazy(() => import("./SiteSettingsModal"));
// 右键 / 更多操作菜单按需加载：MUI Menu/Popover/Popper 不进首屏（见该文件顶部注释）
const SiteCardContextMenu = lazy(() => import("./SiteCardContextMenu"));
import SiteCardAvatar from "./SiteCardAvatar";
import { toneForName } from "../utils/siteAvatar";
import { densityMetrics } from "../utils/densityMetrics";
import { copyToClipboard as copyText } from "../utils/clipboard";
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
    useTheme,
    alpha,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import PersonIcon from "@mui/icons-material/PersonOutlined";
import KeyIcon from "@mui/icons-material/Key";
import { useAppConfig } from "../context/appConfigStore";
import { useNotify } from "../context/NotifyContext";
import { canOpenSite, safeOpenSite } from "../utils/safeOpen";
import { useUIPrefsPrefs, useUIPrefsStable } from "../context/uiPrefsStore";
import {
    isLinkWhitelisted,
    markLink,
    markLinkAlive,
    normalizeKey,
    probeLink,
    unmarkLinkAlive,
} from "../utils/linkHealth";
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
    // 三档的数值统一来自 utils/densityMetrics.ts（加第四档时只改那张表）
    const metrics = densityMetrics(density);

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
        iconWaiting,
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

    // 悬停/聚焦卡片设置按钮就预取设置弹窗块（2026-10-17 首开延迟排查）：
    // 首次点击不再现场等块下载。与上面的 lazy() 指向同一模块，不会重复下载。
    const prefetchSiteSettings = () => prefetchChunk("siteSettings", () => import("./SiteSettingsModal"));

    // 处理关闭设置
    const handleCloseSettings = () => {
        setShowSettings(false);
        // 这两个标志都只对「下一次打开」有效：不清的话，下次点「编辑」会被强制进放大窗，
        // 而且还会带着 notesOnly 变成「只剩备注窗」
        setOpenNotesAtMount(false);
        setNotesOnly(false);
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

    // 右键菜单展开时预取「编辑」的目标块（卡片设置弹窗）：
    // 用户看菜单的那几秒里，点「编辑」不用再现场等块（2026-10-17 首开延迟排查）
    useEffect(() => {
        if (menuPos !== null) prefetchSiteSettings();
    }, [menuPos]);

    const closeMenu = () => setMenuPos(null);

    const handleMenuOpen = () => {
        closeMenu();
        recordVisit(site.id);
        safeOpenSite(site.url);
    };

    const handleMenuEdit = () => {
        closeMenu();
        // 显式回到完整设置：万一上一次的 notesOnly 还没清干净，这里是最后一道保险
        setNotesOnly(false);
        setShowSettings(true);
    };

    // 右键「编辑备注」：直奔放大窗。
    // 用户既然点了备注，就不该先看到一整屏设置再自己找备注框。
    // 用一个「下次打开时」的标志而不是直接把 settings 打开 —— 设置弹窗是由
    // showSettings 条件渲染的，标志得由父级在打开那一刻传给 modal（见下面的
    // initiallyExpandNotes），因为 modal 内部的初始 state 只在挂载时读一次。
    const [openNotesAtMount, setOpenNotesAtMount] = useState(false);
    // 右键那条路**不要网站设置主窗**（notesOnly）：用户点的是「编辑备注」，
    // 先糊一整屏设置再让他自己找备注框，等于把三步做成五步。
    const [notesOnly, setNotesOnly] = useState(false);

    const handleMenuNotes = () => {
        closeMenu();
        setOpenNotesAtMount(true);
        setNotesOnly(true);
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
            iconWaiting={iconWaiting}
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
    // ⚠️ 失效 / 探测成功两张表都按归一化 URL 存键，查表必须用同一个键 ——
    // 否则「带尾斜杠 / 带锚点」的链接永远查不到已有记录。
    const isDead = Boolean(site.url && deadLinks[normalizeKey(site.url)]);
    // 用户是否标过「其实能访问」：标过的站批量检测直接跳过，菜单里给一条撤销入口
    const isWhitelisted = isLinkWhitelisted(site.url ?? "");

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
            compact={metrics.compactDescription}
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
                onPointerEnter={prefetchSiteSettings}
                onFocus={prefetchSiteSettings}
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

    // 反向纠偏：之前标过「可访问」的链接，重新纳入批量检测并立刻探一次。
    // 只在这条链接**在白名单里**时才出现 —— 平时菜单里不该多一条看了也没用的项。
    const handleRecheck = async () => {
        closeMenu();
        if (!site.url) return;
        // 先移出白名单并清掉两张时间戳表：不清的话会被「白名单豁免 / fresh 窗口」
        // 直接跳过，点了等于没点。
        setDeadLinks(unmarkLinkAlive(site.url));
        const alive = await probeLink(site.url);
        // 用 markLink（不是 markLinkAlive）：前者只记探测结果，后者会重新加回白名单 ——
        // 刚移出来又加回去，等于白撤销一次。探测结果照老规则走：
        // 第一次失败只记「疑似」，窗口内再失败一次才贴失效。
        setDeadLinks(markLink(site.url, alive));
        const label = site.name || site.url;
        if (alive) {
            notify(`「${label}」重新检测：可以访问`, "success");
        } else {
            notify(`「${label}」重新检测：这次没连上，再检测一次仍失败才会标失效`, "info");
        }
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
                    bgcolor: selected ? "background.paper" : "var(--neutral-hover)",
                    boxShadow: selected ? "var(--shadow-chip)" : "none",
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
                    bgcolor: starred ? "var(--glass-bg-hover)" : "var(--neutral-hover)",
                    boxShadow: starred ? "var(--shadow-chip)" : "none",
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

    // 悬停快捷操作条：复制账号 / 复制密码
    // （打开动作已交给卡片本体：左键普通新标签，中键后台打开）
    // always=true 时（列表视图）常显，否则悬停才浮出
    // 「复制链接」已移除（2026-10-17 用户要求）：点卡片本身就是打开链接，
    // 再给一个复制按钮只会让右下角这条更挤。
    // ⚠️ 调用点必须带 (hasUsername || hasPassword) 守卫：复制链接移除后它不再是
    // 「永远非空」的那一个，两个都没有时悬停会看到一个空的玻璃 pill。
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
                boxShadow: "var(--shadow-pop)",
                zIndex: 2,
            }}
        >
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
                        <Box
                            sx={{
                                position: 'absolute',
                                top: 8,
                                right: 8
                            }}>
                            <DragIndicatorIcon fontSize='small' color='primary' />
                        </Box>
                        {/* 图标和名称 */}
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                mb: 1
                            }}>
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
                            py: metrics.listPaddingY,
                            cursor: "pointer",
                            textDecoration: "none",
                            color: "inherit",
                        }}
                    >
                        {renderAvatar(0, metrics.listAvatar)}
                        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                            {renderTitle()}
                            {renderTagChips()}
                            {metrics.showListDescription && (
                                <Typography
                                    variant='caption'
                                    noWrap
                                    sx={{
                                        color: 'text.secondary',
                                        display: "block"
                                    }}>
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
                                p: metrics.wallPadding,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 0.75,
                            }}
                        >
                            {renderAvatar(0, metrics.wallAvatar)}
                            <Typography
                                variant='caption'
                                noWrap
                                sx={{ maxWidth: "100%", fontSize: metrics.wallFontSize }}
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
                                p: metrics.cardContentPadding,
                                "&:last-child": { pb: metrics.cardContentPadding },
                            }}
                        >
                            {/* 图标和名称 */}
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    mb: metrics.cardTitleGap
                                }}>
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
            {!isEditMode && !selectMode && (hasUsername || hasPassword) && renderQuickActions(isList)}
        </Box>
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
                        initiallyExpandNotes={openNotesAtMount}
                        notesOnly={notesOnly}
                    />
                    </Suspense>
                )}
            </>
        );
    }

    return (
        <>
            {cardContent}

            {/* 右键 / 更多操作菜单：抽成懒组件且只在打开时挂载 ——
                MUI 的 Menu/Popover/Popper 一大家子不该进首屏关键路径
                （见 SiteCardContextMenu 顶部注释与 docs/site-audit-2026-10-15.md） */}
            {menuPos !== null && (
                <Suspense fallback={null}>
                    <SiteCardContextMenu
                        open
                        position={menuPos}
                        siteName={site.name}
                        url={site.url}
                        username={site.username}
                        password={site.password}
                        starred={starred}
                        isDead={isDead}
                        isWhitelisted={isWhitelisted}
                        onClose={closeMenu}
                        onOpen={handleMenuOpen}
                        onToggleStar={() => toggleStar(site.id)}
                        onQuickCopy={handleQuickCopy}
                        onMarkAlive={handleMarkAlive}
                        onRecheck={handleRecheck}
                        onNotes={handleMenuNotes}
                        onEdit={handleMenuEdit}
                        onDelete={handleMenuDelete}
                    />
                </Suspense>
            )}

            {showSettings && (
                <Suspense fallback={null}>
                <SiteSettingsModal
                    site={site}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onClose={handleCloseSettings}
                    initiallyExpandNotes={openNotesAtMount}
                        notesOnly={notesOnly}
                />
                </Suspense>
            )}
        </>
    );
});

export default SiteCard;
