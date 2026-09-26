// src/components/ShortcutsDialog.tsx
// 快捷键说明表：按 ? 打开。
// 单独一个文件而不是塞进 App.tsx —— 顶栏和逻辑已经够长了，这类纯展示弹窗没有副作用，
// 适合按需加载（Suspense + lazy）。
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    IconButton,
    Typography,
    Table,
    TableBody,
    TableRow,
    TableCell,
    Chip,
    useMediaQuery,
    useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";

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

interface ShortcutsDialogProps {
    open: boolean;
    onClose: () => void;
}

export default function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
    const theme = useTheme();
    const isNarrow = useMediaQuery(theme.breakpoints.down("sm"));

    return (
        <Dialog open={open} onClose={onClose} maxWidth='xs' fullWidth>
            <DialogTitle
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 1,
                    px: 3,
                    pt: 2,
                    pb: 1,
                }}
            >
                <Typography variant='h6' component='div' fontWeight='600'>
                    键盘快捷键
                </Typography>
                <IconButton color='inherit' onClick={onClose} aria-label='关闭' size='small'>
                    <CloseIcon />
                </IconButton>
            </DialogTitle>

            <DialogContent sx={{ pt: "12px !important", pb: 1, px: 3 }}>
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
            </DialogContent>

            <DialogActions sx={{ px: 3, pb: 2.5 }}>
                <Button onClick={onClose} size='small'>
                    知道了
                </Button>
            </DialogActions>
        </Dialog>
    );
}
