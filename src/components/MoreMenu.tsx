// src/components/MoreMenu.tsx
// 顶栏「更多选项」的下拉菜单。
//
// 分区原则是「按用户来这里干什么」而不是「按功能写在哪个文件里」：
//   整理与数据 → 设置与账号 → 帮助与安装 → 会话（退出登录单独一区、沉底）。
// 每区一个轻量小标题，找东西不用整列扫一遍。浏览类偏好（最近访问置前）不在这儿，
// 它们属于「当下怎么看这个列表」，收进了顶栏的显示面板。
import { Menu, MenuItem, ListItemIcon, ListItemText, Divider, ListSubheader } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import SortIcon from "@mui/icons-material/Sort";
import InstallDesktopIcon from "@mui/icons-material/InstallDesktop";
import InsightsIcon from "@mui/icons-material/Insights";
import SettingsBackupRestoreIcon from "@mui/icons-material/SettingsBackupRestore";
import LogoutIcon from "@mui/icons-material/Logout";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import HistoryIcon from "@mui/icons-material/History";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import KeyboardIcon from "@mui/icons-material/Keyboard";

export interface MoreMenuProps {
    anchorEl: HTMLElement | null;
    open: boolean;
    onClose: () => void;
    onOpenConfig: () => void;
    onStartGroupSort: () => void;
    canInstall: boolean;
    onInstallApp: () => void;
    onOpenVisits: () => void;
    /** tab: 0 = 备份，1 = 恢复 / 导入 */
    onOpenBackup: (tab: number) => void;
    isAuthenticated: boolean;
    onLogout: () => void;
    /** 打开「账号与安全」（账号密码 / 恢复密钥 / 登录设备 / 注销） */
    onOpenAccount: () => void;
    /** 打开「AI 设置」（开关 / 模型服务 / 凭据 / 测试连接）—— 配置跟着登录账号走 */
    onOpenAiAssistant: () => void;
    /** 打开回收站（还原 / 彻底删除被软删除的站点、分组） */
    onOpenRecycle: () => void;
    /** 打开审计日志。仅站点所有者可用：不是所有者时整个入口不出现 */
    onOpenAudit: () => void;
    /** 当前登录者是否为站点所有者（决定「审计日志」入口是否出现） */
    isSiteOwner: boolean;
    /** 打开快捷键说明表（按 ? 也能开，菜单里补一个是为了让新用户与手机用户找得到） */
    onOpenShortcuts: () => void;
}

export default function MoreMenu({
    anchorEl,
    open,
    onClose,
    onOpenConfig,
    onStartGroupSort,
    canInstall,
    onInstallApp,
    onOpenVisits,
    onOpenBackup,
    isAuthenticated,
    onLogout,
    onOpenRecycle,
    onOpenAudit,
    onOpenAccount,
    onOpenAiAssistant,
    isSiteOwner,
    onOpenShortcuts,
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
            slotProps={{
                paper: {
                    sx: {
                        // 小标题把十几项切成四段，菜单长一点也看得清结构
                        "& .MuiListSubheader-root": {
                            fontSize: 11,
                            lineHeight: "24px",
                            color: "text.secondary",
                            bgcolor: "transparent",
                        },
                    },
                },
            }}
        >
            {/* 一、整理与数据：改结构的、看数据的、搬数据的都在这里，是菜单里最常用的半区 */}
            <ListSubheader>整理与数据</ListSubheader>
            <MenuItem
                onClick={() => {
                    onClose();
                    onStartGroupSort();
                }}
            >
                <ListItemIcon>
                    <SortIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>分组排序</ListItemText>
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
            {/* 备份 / 恢复 / 导入浏览器书签是同一件事的三个方向，合成一个入口，
                进去再选「备份」还是「恢复 / 导入」 */}
            <MenuItem
                onClick={() => {
                    onClose();
                    onOpenBackup(0);
                }}
            >
                <ListItemIcon>
                    <SettingsBackupRestoreIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>备份与恢复</ListItemText>
            </MenuItem>
            <MenuItem
                onClick={() => {
                    onClose();
                    onOpenRecycle();
                }}
            >
                <ListItemIcon>
                    <RestoreFromTrashIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>回收站</ListItemText>
            </MenuItem>
            {/* 审计日志只给站点所有者看：后端同样会挡（非 owner 一律 403），
                这里连入口都不显示，免得点进去只看到一句报错 */}
            {isSiteOwner && (
                <MenuItem
                    onClick={() => {
                        onClose();
                        onOpenAudit();
                    }}
                >
                    <ListItemIcon>
                        <HistoryIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>审计日志</ListItemText>
                </MenuItem>
            )}

            <Divider />

            {/* 二、设置与账号：改的是「这个站长什么样 / 我这个账号怎么登录」 */}
            <ListSubheader>设置与账号</ListSubheader>
            <MenuItem
                onClick={() => {
                    onClose();
                    onOpenConfig();
                }}
            >
                <ListItemIcon>
                    <SettingsIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>网站设置</ListItemText>
            </MenuItem>
            {/* 叫「AI 设置」而不是「AI 助手」：点进去是配置模型服务与凭据，
                不是能直接对话的助手界面 */}
            <MenuItem
                onClick={() => {
                    onClose();
                    onOpenAiAssistant();
                }}
            >
                <ListItemIcon>
                    <AutoAwesomeIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>AI 设置</ListItemText>
            </MenuItem>
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
                    <ListItemText>账号与安全</ListItemText>
                </MenuItem>
            )}

            <Divider />

            {/* 三、帮助与安装：一次性动作，出现条件还各不相同 */}
            <ListSubheader>帮助与安装</ListSubheader>
            <MenuItem
                onClick={() => {
                    onClose();
                    onOpenShortcuts();
                }}
            >
                <ListItemIcon>
                    <KeyboardIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>快捷键与操作帮助</ListItemText>
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

            {/* 四、会话：退出登录不是删除数据，但它是这一排里唯一的「离开当前状态」，
                单独一区 + error 色，避免和上面的数据操作混在一起误点 */}
            {isAuthenticated && (
                <>
                    <Divider />
                    <ListSubheader>会话</ListSubheader>
                    <MenuItem onClick={onLogout} sx={{ color: "error.main" }}>
                        <ListItemIcon sx={{ color: "error.main" }}>
                            <LogoutIcon fontSize='small' />
                        </ListItemIcon>
                        <ListItemText>退出登录</ListItemText>
                    </MenuItem>
                </>
            )}
        </Menu>
    );
}
