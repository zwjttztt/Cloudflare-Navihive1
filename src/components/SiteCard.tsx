// src/components/SiteCard.tsx
import { useState, useEffect, memo } from "react";
import { Site } from "../API/http";
import SiteSettingsModal from "./SiteSettingsModal";
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
    useTheme,
    alpha,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import LanguageIcon from "@mui/icons-material/Language";
import { useAppConfig } from "../context/AppConfigContext";
import { resolveIconApiUrl } from "../utils/iconApi";

interface SiteCardProps {
    site: Site;
    onUpdate: (updatedSite: Site) => void;
    onDelete: (siteId: number) => void;
    isEditMode?: boolean;
    index?: number;
    /** 搜索关键词，命中片段会高亮 */
    highlight?: string;
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
}: SiteCardProps) {
    const theme = useTheme();
    const { thumbApi } = useAppConfig();
    const [showSettings, setShowSettings] = useState(false);
    const [iconError, setIconError] = useState(!site.icon);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [thumbError, setThumbError] = useState(false);
    const [thumbLoaded, setThumbLoaded] = useState(false);

    // 缩略图：仅在「网站设置」里配了模板时才启用，避免默认请求第三方服务
    const thumbUrl = thumbApi.trim() ? resolveIconApiUrl(thumbApi, site.url || "") : "";
    const useThumb = Boolean(thumbUrl) && !thumbError;

    // 缩略图地址变化时重置加载状态
    useEffect(() => {
        setThumbError(false);
        setThumbLoaded(false);
    }, [thumbUrl]);

    // 图标地址变化时重置加载状态：
    // 免刷新即时更新后，若图标由空改为有值，需要重新尝试加载，否则会一直显示首字母占位
    useEffect(() => {
        setIconError(!site.icon);
        setImageLoaded(false);
    }, [site.icon]);

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

    // 处理卡片点击
    const handleCardClick = () => {
        if (!isEditMode && site.url) {
            window.open(site.url, "_blank");
        }
    };

    // 处理图标加载错误
    const handleIconError = () => {
        setIconError(true);
    };

    // 处理图片加载完成
    const handleImageLoad = () => {
        setImageLoaded(true);
    };

    // 图标：加载失败或没有地址时，退化成按名称哈希配色的首字母块
    const renderAvatar = () => {
        if (!iconError && site.icon) {
            return (
                <Box
                    className='nav-card-icon'
                    position='relative'
                    mr={1.5}
                    width={36}
                    height={36}
                    flexShrink={0}
                    sx={{
                        transition: "transform .22s cubic-bezier(.22,.61,.36,1)",
                    }}
                >
                    <Skeleton
                        variant='rounded'
                        width={36}
                        height={36}
                        sx={{
                            display: !imageLoaded ? "block" : "none",
                            position: "absolute",
                        }}
                    />
                    <Fade in={imageLoaded} timeout={400}>
                        <Box
                            component='img'
                            src={site.icon}
                            alt={site.name}
                            loading='lazy'
                            decoding='async'
                            sx={{
                                width: 36,
                                height: 36,
                                borderRadius: 1.5,
                                objectFit: "cover",
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
                    width: 36,
                    height: 36,
                    mr: 1.5,
                    borderRadius: 1.5,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: 15,
                    bgcolor: alpha(isDark ? tone.soft : tone.strong, isDark ? 0.22 : 0.12),
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

    // 标题
    const renderTitle = () => (
        <Typography
            className='nav-card-title'
            variant='subtitle1'
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
    );

    // 描述
    const renderDescription = () => (
        <Typography
            variant='body2'
            color='text.secondary'
            sx={{
                display: "-webkit-box",
                WebkitLineClamp: useThumb ? 2 : 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                flexGrow: 1,
                fontSize: { xs: "0.75rem", sm: "0.875rem" },
            }}
        >
            <Highlighted text={site.description || "暂无描述"} query={highlight} />
        </Typography>
    );

    // 键盘可达：回车/空格也能打开链接
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (isEditMode) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardClick();
        }
    };

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

    // 毛玻璃 + 悬停微交互的外壳样式，两种模式共用
    const cardSx = {
        height: "100%",
        display: "flex",
        flexDirection: "column" as const,
        borderRadius: "18px",
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
                  transform: "translateY(-6px)",
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
            sx={{
                height: "100%",
                position: "relative",
            }}
            style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
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
                ) : (
                    <CardActionArea
                        onClick={handleCardClick}
                        onKeyDown={handleKeyDown}
                        sx={{
                            height: "100%",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "stretch",
                            justifyContent: "flex-start",
                        }}
                    >
                        {renderThumbnail()}
                        <CardContent
                            sx={{
                                position: "relative",
                                flexGrow: 1,
                                display: "flex",
                                flexDirection: "column",
                                p: { xs: 1.5, sm: 2 },
                                "&:last-child": { pb: { xs: 1.5, sm: 2 } },
                            }}
                        >
                            {/* 图标和名称 */}
                            <Box display='flex' alignItems='center' mb={1}>
                                {renderAvatar()}
                                {renderTitle()}
                            </Box>

                            {/* 描述 */}
                            {renderDescription()}

                            {/* 设置按钮 */}
                            <IconButton
                                size='small'
                                sx={{
                                    position: "absolute",
                                    top: 8,
                                    right: 8,
                                    bgcolor: "var(--glass-bg-hover)",
                                    backdropFilter: "blur(6px)",
                                    opacity: 0,
                                    transition: "opacity .2s, background-color .2s",
                                    "&:hover": {
                                        bgcolor: "action.selected",
                                    },
                                    ".MuiCardActionArea-root:hover &": {
                                        opacity: 1,
                                    },
                                }}
                                onClick={handleSettingsClick}
                                aria-label='网站设置'
                            >
                                <SettingsIcon fontSize='small' />
                            </IconButton>
                        </CardContent>
                    </CardActionArea>
                )}
            </Card>

            {/* 链接提示：悬停时右下角浮出一个小地球 */}
            {!isEditMode && site.url && (
                <LanguageIcon
                    className='nav-card-link-hint'
                    sx={{
                        position: "absolute",
                        right: 10,
                        bottom: 10,
                        fontSize: 16,
                        color: "text.disabled",
                        opacity: 0,
                        transition: "opacity .2s ease",
                        pointerEvents: "none",
                        ".nav-card-in:hover &": {
                            opacity: 0.75,
                        },
                    }}
                />
            )}
        </Box>
    );

    if (isEditMode) {
        return (
            <>
                <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
                    {cardContent}
                </div>

                {showSettings && (
                    <SiteSettingsModal
                        site={site}
                        onUpdate={onUpdate}
                        onDelete={onDelete}
                        onClose={handleCloseSettings}
                    />
                )}
            </>
        );
    }

    return (
        <>
            {cardContent}

            {showSettings && (
                <SiteSettingsModal
                    site={site}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onClose={handleCloseSettings}
                />
            )}
        </>
    );
});

export default SiteCard;
