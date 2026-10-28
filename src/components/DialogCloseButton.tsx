// src/components/DialogCloseButton.tsx
// 弹窗右上角那枚「×」：全站统一一份，别再每个弹窗各抄一遍。
//
// 为什么要有这个文件：32 个弹窗里有 8 个压根没有 ×（只能按 Esc 或点遮罩才能关），
// 有 × 的那十几个又各写各的 —— 尺寸、位置、aria-label 三种写法，其中两处还是
// 英文 aria-label='close'，读屏念出来是英文。统一之后：
//   · 位置固定 paper 右上（paper 自身 position:relative，绝对定位就落在纸面里）
//   · aria-label 走中文，Tooltip 复用同一个文案
//   · 危险操作进行中可 disabled，避免「点关闭」和「正在提交」打架
import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

export interface DialogCloseButtonProps {
    onClose: () => void;
    /** 无障碍标签与悬浮提示共用；默认「关闭」，列表类弹窗可写「关闭审计日志」这种更具体的 */
    label?: string;
    disabled?: boolean;
    /** 额外样式（个别弹窗标题区被自定义布局挤过，用它微调右侧距离） */
    sx?: object;
}

export default function DialogCloseButton({
    onClose,
    label = "关闭",
    disabled,
    sx,
}: DialogCloseButtonProps) {
    return (
        <Tooltip title={label}>
            {/* tooltip 的锚点是**这层 Box**（Tooltip 的直接子元素），所以绝对定位
                必须写在这里，不能写在里面的 IconButton 上：

                ⚠️ 2026-10-28 的坑：定位原先写在 IconButton 上、外层 span 是 inline
                静态元素 —— span 里唯一的子元素被抽出了文档流，span 自己就塌成 0×0，
                而且停在**文档流原处**（标题文字右边）。于是「悬浮关闭键」时提示
                出现在标题行中间，离按钮几百像素（用户报「文字提示位置错误」）。

                这层还顺带解决另一件事：Tooltip 的子元素要能接住 ref 与鼠标事件，
                而 disabled 的 IconButton 会把事件吞掉 —— 垫一层 Box，禁用状态下
                提示照样能出来。 */}
            <Box
                component='span'
                sx={{
                    position: "absolute",
                    right: 12,
                    top: 12,
                    display: "inline-flex",
                    ...sx,
                }}
            >
                <IconButton
                    size='small'
                    aria-label={label}
                    onClick={onClose}
                    disabled={disabled}
                    data-dialog-close='1'
                >
                    <CloseIcon fontSize='small' />
                </IconButton>
            </Box>
        </Tooltip>
    );
}
