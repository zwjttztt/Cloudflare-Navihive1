// src/components/MoreMenu.tsx
// 顶栏「更多选项」的下拉菜单。原来整块内联在 App.tsx 里（168 行），
// 拆出来之后 App 只负责把各个动作传进来，菜单本身的排版与分组顺序留在这里。
import { Menu, MenuItem, ListItemIcon, ListItemText, Divider } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import SortIcon from "@mui/icons-material/Sort";
import InstallDesktopIcon from "@mui/icons-material/InstallDesktop";
import StarIcon from "@mui/icons-material/Star";
import InsightsIcon from "@mui/icons-material/Insights";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import BookmarkAddedIcon from "@mui/icons-material/BookmarkAdded";
import SettingsBackupRestoreIcon from "@mui/icons-material/SettingsBackupRestore";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LogoutIcon from "@mui/icons-material/Logout";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";

export interface MoreMenuProps {
    anchorEl: HTMLElement | null;
    open: boolean;
    onClose: () => void;
    onOpenConfig: () => void;
    onStartGroupSort: () => void;
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
    /** 打开「账号管理」（账号密码 / 恢复密钥 / 邀请码 / 注销） */
    onOpenAccount: () => void;
}

export default function MoreMenu({
    anchorEl,
    open,
    onClose,
    onOpenConfig,
    onStartGroupSort,
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
    onOpenAccount,
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
                        {/* 账号管理：账号密码、恢复密钥、邀请码、注销账号都在这里，
                            不再混进「网站设置」（那里面管的是站点长什么样） */}
                        {isAuthenticated && (
                            <MenuItem
                                onClick={() => {
                                    onClose();
                                    onOpenAccount();
                                }}
                            >
                                <ListItemIcon>
                                    <ManageAccountsIcon fontSize='small' />
                                </ListItemIcon>
                                <ListItemText>账号管理</ListItemText>
                            </MenuItem>
                        )}
                        <MenuItem onClick={onStartGroupSort}>
                            <ListItemIcon>
                                <SortIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>编辑排序</ListItemText>
                        </MenuItem>
                        <Divider />
                        {/* 毛玻璃总开关已挪进「网站设置 → 背景与毛玻璃」，跟模糊强度滑块放在一起，
                            菜单本身也不再需要就地开关。 */}
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
                        {/* 备份与恢复其实是同一件事的两面（导出成文件 / 从文件还原），
                            合成一个入口，进去再选「备份」还是「恢复 / 导入」 */}
                        <MenuItem onClick={() => onOpenBackup(0)}>
                            <ListItemIcon>
                                <SettingsBackupRestoreIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText>数据备份</ListItemText>
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
