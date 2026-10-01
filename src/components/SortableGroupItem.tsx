// src/components/SortableGroupItem.tsx
// 分组排序模式下的一行：拖拽手柄 + 分组名 + 上移/下移。
//
// 原来整张 Paper 既是拖拽区又是内容区 —— 触屏上想点「上移」会先被判定成拖拽，
// 键盘用户更是完全不知道要按空格拾起。现在：
//   • 只有左侧手柄带拖拽监听，其余区域是普通内容；
//   • 顺序调整另给一对上下按钮，不靠拖拽也能调，且到头自动禁用。
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GroupWithSites } from "../types";
import { Paper, Typography, Box, IconButton, Tooltip } from "@mui/material";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";

interface SortableGroupItemProps {
    id: string;
    group: GroupWithSites;
    /** 上移 / 下移一位（拖拽之外的一条路） */
    onNudge?: (groupId: string, delta: number) => void;
    isFirst?: boolean;
    isLast?: boolean;
}

export default function SortableGroupItem({
    id,
    group,
    onNudge,
    isFirst = false,
    isLast = false,
}: SortableGroupItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition: isDragging ? "none" : transition,
        zIndex: isDragging ? 9999 : 1,
        opacity: isDragging ? 0.8 : 1,
    };

    return (
        <Paper
            ref={setNodeRef}
            style={style}
            sx={{
                p: 2,
                borderRadius: "var(--radius-lg)",
                transition: isDragging ? "none !important" : "all 0.3s ease-in-out",
                border: "1px solid var(--border-default)",
                boxShadow: isDragging ? "var(--shadow-3)" : "var(--shadow-1)",
                ...(isDragging && {
                    outline: "2px solid",
                    outlineColor: "primary.main",
                    transform: "none",
                    "& *": {
                        transition: "none !important",
                    },
                }),
            }}
        >
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                {/* 拖拽只认这个手柄：其余区域留给用户点按钮、选文字 */}
                <IconButton
                    ref={setActivatorNodeRef}
                    className='nav-group-drag-handle'
                    {...attributes}
                    {...listeners}
                    aria-label={`拖动调整分组「${group.name}」的顺序，也可以用右侧的上下箭头`}
                    sx={{ cursor: isDragging ? "grabbing" : "grab" }}
                >
                    <DragIndicatorIcon sx={{ color: "primary.main", opacity: 0.8 }} />
                </IconButton>
                <Typography variant='h5' component='h2' fontWeight='600' color='text.primary'>
                    {group.name}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title='上移一位'>
                    {/* 用 span 包一层：disabled 的按钮收不到 hover，Tooltip 会失效 */}
                    <span>
                        <IconButton
                            className='nav-group-move-up'
                            aria-label={`把「${group.name}」上移一位`}
                            disabled={isFirst || !onNudge}
                            onClick={() => onNudge?.(id, -1)}
                        >
                            <ArrowUpwardIcon fontSize='small' />
                        </IconButton>
                    </span>
                </Tooltip>
                <Tooltip title='下移一位'>
                    <span>
                        <IconButton
                            className='nav-group-move-down'
                            aria-label={`把「${group.name}」下移一位`}
                            disabled={isLast || !onNudge}
                            onClick={() => onNudge?.(id, 1)}
                        >
                            <ArrowDownwardIcon fontSize='small' />
                        </IconButton>
                    </span>
                </Tooltip>
            </Box>
        </Paper>
    );
}
