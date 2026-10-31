// src/components/ShortcutsDialog.tsx
// 帮助弹窗：快捷键说明表（按 ? 也能开）+ 安装到桌面。
// 单独一个文件而不是塞进 App.tsx —— 顶栏和逻辑已经够长了，这类纯展示弹窗没有副作用，
// 适合按需加载（Suspense + lazy）。
// 「安装到桌面」原先在「更多选项」菜单里单占一项，2026-10-15 菜单瘦身时并入这里：
// 它和快捷键一样属于「一次性、找的时候才会找」的入口，挂在帮助里比单列一项好找。
//
// 2026-10-31：把内容抽成 `ShortcutsPanel`，让「更多选项」中心能内联这一屏
// （原来中心里是占位面板，点了关掉中心再开本弹窗）。弹窗本体保留，其它入口
// （键盘 ?）仍走它。
import {
    Box,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Typography,
    Table,
    TableBody,
    TableRow,
    TableCell,
    Chip,
    useMediaQuery,
    useTheme,
} from "@mui/material";
import InstallDesktopIcon from "@mui/icons-material/InstallDesktop";
import DialogCloseButton from "./DialogCloseButton";
import { dialogActionsSx, dialogTitleSx } from "./dialogShell";

interface Shortcut {
    keys: string[];
    desc: string;
    /** 分组标题行：keys 为空 */
    group?: boolean;
}

const IS_MAC =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");

/** Mac 上把 Ctrl 写成 ⌘，其它平台照旧 —— 提示对不上实际按不出来的键最招人烦 */
const mod = IS_MAC ? "⌘" : "Ctrl";

const SHORTCUTS: Shortcut[] = [
    { keys: [], desc: "搜索与命令", group: true },
    { keys: ["/"], desc: "聚焦搜索框" },
    { keys: [mod, "K"], desc: "打开命令面板" },
    { keys: ["Esc"], desc: "清空搜索 / 关闭弹窗" },

    { keys: [], desc: "打开网站", group: true },
    { keys: ["1", "…", "9"], desc: "打开当前分组第 N 张卡片（搜索时打开第 N 条结果）" },
    { keys: ["Enter"], desc: "打开正好聚焦着的卡片" },

    { keys: [], desc: "移动与编辑", group: true },
    { keys: ["←", "→", "↑", "↓"], desc: "在卡片之间移动焦点" },
    { keys: ["Tab", "Shift+Tab"], desc: "按顺序遍历可聚焦元素" },
    { keys: [mod, "Z"], desc: "撤销上一步操作" },
    { keys: [mod, "Shift", "Z"], desc: "重做" },

    { keys: [], desc: "其它", group: true },
    { keys: ["?"], desc: "显示这张快捷键表" },
];

export interface ShortcutsPanelProps {
    /** 浏览器真的给了安装事件时才显示「安装到桌面」
     * （Chrome/Edge 认为用户用得够多才会抛 beforeinstallprompt） */
    canInstall?: boolean;
    onInstallApp?: () => void;
}

/**
 * 中心面板用的业务体：只画内容。标题与关闭由外层 SettingsWorkspaceDialog 统一给，
 * 所以这里不重复放 DialogTitle / 「知道了」按钮，避免中心里套一个会关掉中心的弹窗。
 */
export function ShortcutsPanel({ canInstall = false, onInstallApp }: ShortcutsPanelProps) {
    const theme = useTheme();
    const isNarrow = useMediaQuery(theme.breakpoints.down("sm"));

    return (
        <Box>
            <Table size='small' aria-label='快捷键列表'>
                <TableBody>
                    {SHORTCUTS.map((item, index) =>
                        item.group ? (
                            <TableRow key={`g-${index}`}>
                                <TableCell
                                    colSpan={2}
                                    sx={{
                                        pt: index === 0 ? 0 : 1.5,
                                        pb: 0.5,
                                        border: 0,
                                        fontSize: 12,
                                        fontWeight: 700,
                                        letterSpacing: 0.4,
                                        color: "text.secondary",
                                    }}
                                >
                                    {item.desc}
                                </TableCell>
                            </TableRow>
                        ) : (
                            <TableRow key={item.desc}>
                                <TableCell
                                    sx={{
                                        border: 0,
                                        py: 0.5,
                                        pl: 0,
                                        width: isNarrow ? 96 : 132,
                                        verticalAlign: "top",
                                    }}
                                >
                                    <Typography
                                        component='span'
                                        sx={{
                                            display: "inline-flex",
                                            gap: 0.5,
                                            alignItems: "center",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        {item.keys.map((k, i) =>
                                            k === "…" ? (
                                                <Typography
                                                    key={i}
                                                    component='span'
                                                    sx={{ fontSize: 12, opacity: 0.6 }}
                                                >
                                                    …
                                                </Typography>
                                            ) : (
                                                <Chip
                                                    key={i}
                                                    label={k}
                                                    size='small'
                                                    variant='outlined'
                                                    sx={{
                                                        height: 20,
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        "& .MuiChip-label": {
                                                            px: 0.75,
                                                        },
                                                    }}
                                                />
                                            )
                                        )}
                                    </Typography>
                                </TableCell>
                                <TableCell
                                    sx={{
                                        border: 0,
                                        py: 0.5,
                                        pr: 0,
                                        fontSize: 13,
                                        verticalAlign: "top",
                                    }}
                                >
                                    {item.desc}
                                </TableCell>
                            </TableRow>
                        )
                    )}
                </TableBody>
            </Table>

            {/* 安装入口：只在浏览器给了安装事件时出现（见 props 说明）。
                原来在弹窗底部按钮区，内联进中心后放进内容底部，关中心的「完成」仍由外层给。 */}
            {canInstall && onInstallApp && (
                <Box sx={{ mt: 2 }}>
                    <Button
                        onClick={() => void onInstallApp()}
                        size='small'
                        startIcon={<InstallDesktopIcon fontSize='small' />}
                    >
                        安装到桌面
                    </Button>
                </Box>
            )}
        </Box>
    );
}

interface ShortcutsDialogProps {
    open: boolean;
    onClose: () => void;
    /** 浏览器真的给了安装事件时才显示「安装到桌面」
     * （Chrome/Edge 认为用户用得够多才会抛 beforeinstallprompt） */
    canInstall?: boolean;
    onInstallApp?: () => void;
}

export default function ShortcutsDialog({ open, onClose, canInstall = false, onInstallApp }: ShortcutsDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} maxWidth='xs' fullWidth>
            <DialogTitle sx={{ ...dialogTitleSx, justifyContent: "space-between" }}>
                <Typography component='div' sx={{
                    fontWeight: '600'
                }}>
                    帮助
                </Typography>
                {/* 换成全站统一的右上角「×」（位置 / Tooltip / aria-label="关闭" 统一） */}
                <DialogCloseButton onClose={onClose} />
            </DialogTitle>

            <DialogContent sx={{ pt: "12px !important", pb: 1, px: 3 }}>
                <ShortcutsPanel canInstall={canInstall} onInstallApp={onInstallApp} />
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button onClick={onClose} size='small'>
                    知道了
                </Button>
            </DialogActions>
        </Dialog>
    );
}
