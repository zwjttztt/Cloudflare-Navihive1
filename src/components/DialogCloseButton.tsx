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
            {/* Tooltip 要求子元素能接住 ref 与事件；disabled 的 IconButton 事件会被吞掉，
                所以外层再垫一个 span，让禁用状态下提示照样能出来 */}
            <span>
                <IconButton
                    size='small'
                    aria-label={label}
                    onClick={onClose}
                    disabled={disabled}
                    data-dialog-close='1'
                    sx={{
                        position: "absolute",
                        right: 12,
                        top: 12,
                        ...sx,
                    }}
                >
                    <CloseIcon fontSize='small' />
                </IconButton>
            </span>
        </Tooltip>
    );
}
