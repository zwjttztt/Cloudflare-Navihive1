// src/components/MoreMenu.tsx
// 顶栏「更多选项」的下拉菜单。原来整块内联在 App.tsx 里（168 行），
// 拆出来之后 App 只负责把各个动作传进来，菜单本身的排版与分组顺序留在这里。
import { Menu, MenuItem, ListItemIcon, ListItemText, Divider, Switch } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import SortIcon from "@mui/icons-material/Sort";
import BlurOnIcon from "@mui/icons-material/BlurOn";
import BlurOffIcon from "@mui/icons-material/BlurOff";
import InstallDesktopIcon from "@mui/icons-material/InstallDesktop";
import StarIcon from "@mui/icons-material/Star";
import InsightsIcon from "@mui/icons-material/Insights";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import BookmarkAddedIcon from "@mui/icons-material/BookmarkAdded";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LogoutIcon from "@mui/icons-material/Logout";

export interface MoreMenuProps {
    anchorEl: HTMLElement | null;
    open: boolean;
    onClose: () => void;
    onOpenConfig: () => void;
    onStartGroupSort: () => void;
    glassEffects: boolean;
    onGlassEffectsChange: (enabled: boolean) => void;
    canInstall: boolean;
    onInstallApp: () => void;
    favoritesEnabled: boolean;
    onFavoritesEnabledChange: (enabled: boolean) => void;
    onOpenVisits: () => void;
    onOpenShortcuts: () => void;
    /** tab: 0 = 导出，1 = 导入 */
    onOpenBackup: (tab: number) => void;
    onOpenBookmark: () => void;
    onRunLinkCheck: () => void;
    onClearVisits: () => void;
    isAuthenticated: boolean;
    onLogout: () => void;
}

export default function MoreMenu({
    anchorEl,
    open,
    onClose,
    onOpenConfig,
    onStartGroupSort,
    glassEffects,
    onGlassEffectsChange,
    canInstall,
    onInstallApp,
    favoritesEnabled,
    onFavoritesEnabledChange,
    onOpenVisits,
    onOpenShortcuts,
    onOpenBackup,
    onOpenBookmark,
    onRunLinkCheck,
    onClearVisits,
    isAuthenticated,
    onLogout,
}: MoreMenuProps) {
    return (
                    <Menu
                        id='navigation-menu'
                        anchorEl={anchorEl}
                        // 排序模式里「更多选项」按钮会被卸载，anchor 失效时菜单会飘到左上角，这里直接不渲染
                        open={open}
                        onClose={onClose}
                        MenuListProps={{
                            "aria-labelledby": "navigation-button",
                        }}
                    >
                        {/* 菜单顺序：常用配置 → 浏览偏好 → 数据管理 → 有破坏性的操作沉底，
                            中间用分隔线分组，找东西不用整列扫一遍 */}
                        <MenuItem onClick={onOpenConfig}>
                            <ListItemIcon>
                                <SettingsIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>网站设置</ListItemText>
                        </MenuItem>
                        <MenuItem onClick={onStartGroupSort}>
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
                            onClick={() => onGlassEffectsChange(!glassEffects)}
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
                                onChange={e => onGlassEffectsChange(e.target.checked)}
                                // 挡掉冒泡，否则点开关会同时触发菜单项的 onClick，切两下等于没切
                                onClick={e => e.stopPropagation()}
                                inputProps={{ "aria-label": "毛玻璃特效" }}
                            />
                        </MenuItem>
                        {/* 装到桌面：只有浏览器真的给了安装事件时才出现
                            （Chrome/Edge 认为用户用得够多才会抛 beforeinstallprompt） */}
                        {canInstall && (
                            <MenuItem
                                onClick={() => {
                                    onClose();
                                    void onInstallApp();
                                }}
                            >
                                <ListItemIcon>
                                    <InstallDesktopIcon fontSize='small' />
                                </ListItemIcon>
                                <ListItemText>安装到桌面</ListItemText>
                            </MenuItem>
                        )}
                        <MenuItem
                            onClick={() =>
                                onFavoritesEnabledChange(!favoritesEnabled)
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
                                onClose();
                                onOpenVisits();
                            }}
                        >
                            <ListItemIcon>
                                <InsightsIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>访问统计</ListItemText>
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                onClose();
                                onOpenShortcuts();
                            }}
                        >
                            <ListItemIcon>
                                <KeyboardIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>键盘快捷键</ListItemText>
                        </MenuItem>
                        <Divider />
                        <MenuItem onClick={() => onOpenBackup(0)}>
                            <ListItemIcon>
                                <FileDownloadIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>导出数据</ListItemText>
                        </MenuItem>
                        <MenuItem onClick={() => onOpenBackup(1)}>
                            <ListItemIcon>
                                <FileUploadIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>导入数据</ListItemText>
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                onClose();
                                onOpenBookmark();
                            }}
                        >
                            <ListItemIcon>
                                <BookmarkAddedIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>导入浏览器书签</ListItemText>
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                onClose();
                                void onRunLinkCheck();
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
                                onClearVisits();
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
                                onClick={onLogout}
                                sx={{ color: "error.main" }}
                            >
                                <ListItemIcon sx={{ color: "error.main" }}>
                                    <LogoutIcon fontSize='small' />
                                </ListItemIcon>
                                <ListItemText>退出登录</ListItemText>
                            </MenuItem>
                        )}
                    </Menu>
    );
}
