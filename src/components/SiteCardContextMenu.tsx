// src/components/SiteCardContextMenu.tsx
// SiteCard 的右键 / 更多操作菜单（与卡片本体共用一套打开 / 复制 / 编辑 / 删除动作）。
//
// 为什么从 SiteCard 抽出来还单独懒加载：菜单用的是 MUI 的 Menu / Popover / Popper
// 一大家子（连同 @popperjs / @floating-ui），而它**只在右键或点「更多」时才出现**。
// 留在 SiteCard 里，这套机器就被焊进首屏关键路径——打包器把「懒弹窗也用」的 MUI
// 归成一个共享块，首屏组件一 import 它，整个块就被 modulepreload（2026-10-15 审计：
// 首屏白下 425KB / gzip 128KB 的弹窗代码，见 docs/site-audit-2026-10-15.md）。
// 抽成条件挂载的懒组件后，这套机器只在实际打开菜单时才下载。
import {
    Menu,
    MenuItem,
    ListItemIcon,
    ListItemText,
    Divider,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import PersonIcon from "@mui/icons-material/PersonOutlined";
import KeyIcon from "@mui/icons-material/Key";
import NotesIcon from "@mui/icons-material/Notes";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";

export interface SiteCardContextMenuProps {
    /** 菜单开不开（关的时候整个组件不挂载，见 SiteCard 里的条件渲染） */
    open: boolean;
    /** 右键时的落点；null 时菜单挂在左上角（MUI 行为，正常不会发生） */
    position: { left: number; top: number } | null;
    siteName: string;
    url?: string;
    username?: string;
    password?: string;
    starred: boolean;
    /** 链接健康巡检标记过「疑似失效」 */
    isDead: boolean;
    /** 用户手动标过「可访问」：豁免巡检，给重新检测的出口 */
    isWhitelisted: boolean;
    onClose: () => void;
    onOpen: () => void;
    onToggleStar: () => void;
    onQuickCopy: (event: React.MouseEvent, label: string, value?: string) => void;
    onMarkAlive: () => void;
    onRecheck: () => void;
    onNotes: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

export default function SiteCardContextMenu({
    open,
    position,
    siteName,
    url,
    username,
    password,
    starred,
    isDead,
    isWhitelisted,
    onClose,
    onOpen,
    onToggleStar,
    onQuickCopy,
    onMarkAlive,
    onRecheck,
    onNotes,
    onEdit,
    onDelete,
}: SiteCardContextMenuProps) {
    return (
        <Menu
            open={open}
            onClose={onClose}
            anchorReference='anchorPosition'
            anchorPosition={position ? { top: position.top, left: position.left } : undefined}
            slotProps={{ paper: { sx: { minWidth: 190, borderRadius: "14px" } } }}
            aria-label={`${siteName || "卡片"}操作菜单`}
        >
            <MenuItem onClick={onOpen} disabled={!url}>
                <ListItemIcon>
                    <OpenInNewIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>新标签打开</ListItemText>
            </MenuItem>
            <MenuItem
                onClick={() => {
                    onClose();
                    onToggleStar();
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
            <MenuItem onClick={e => onQuickCopy(e, "链接", url)} disabled={!url}>
                <ListItemIcon>
                    <LinkIcon sx={{
                        fontSize: 'small'
                    }} />
                </ListItemIcon>
                <ListItemText>复制链接</ListItemText>
            </MenuItem>
            {username && (
                <MenuItem onClick={e => onQuickCopy(e, "账号", username)}>
                    <ListItemIcon>
                        <PersonIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>复制账号</ListItemText>
                </MenuItem>
            )}
            {password && (
                <MenuItem onClick={e => onQuickCopy(e, "密码", password)}>
                    <ListItemIcon>
                        <KeyIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>复制密码</ListItemText>
                </MenuItem>
            )}
            {isDead && (
                <MenuItem onClick={onMarkAlive}>
                    <ListItemIcon>
                        <LinkOffIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>标记为可访问</ListItemText>
                </MenuItem>
            )}
            {/* 只在「之前标过可访问」时才给撤销入口：标过 = 已免探测，
                不给出口的话这条链接就永久脱离巡检了。 */}
            {isWhitelisted && (
                <MenuItem onClick={onRecheck}>
                    <ListItemIcon>
                        <LinkIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText>重新检测该站</ListItemText>
                </MenuItem>
            )}
            <Divider />
            <MenuItem onClick={onNotes}>
                <ListItemIcon>
                    <NotesIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>编辑备注</ListItemText>
            </MenuItem>
            <MenuItem onClick={onEdit}>
                <ListItemIcon>
                    <EditIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText>编辑</ListItemText>
            </MenuItem>
            <MenuItem onClick={onDelete} sx={{ color: "error.main" }}>
                <ListItemIcon>
                    <DeleteOutlineIcon fontSize='small' color='error' />
                </ListItemIcon>
                <ListItemText>删除</ListItemText>
            </MenuItem>
        </Menu>
    );
}
