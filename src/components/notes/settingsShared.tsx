// src/components/notes/settingsShared.tsx
// 记事本设置弹窗的共享小组件（2026-10-24 从 NotesSettingsDialog.tsx 拆出）。
//
// 为什么单独一个文件：这几个件被六个设置页（外观/编辑器/数据/同步/分享/备份）
// 共用，留在主文件里会让「拆页」变成「把依赖一起剪不断」。放这里之后，
// 每个设置页 import 自己那一份，主文件只剩框架与分发。

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { fmtBytes as fmtBytesImpl, fmtDateTime } from "../../utils/format";

export function SettingRow({
    label,
    description,
    children,
}: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                py: 1.25,
                borderBottom: "1px solid var(--neutral-hover)",
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant='body2'>{label}</Typography>
                {description && (
                    <Typography variant='caption' color='text.secondary' sx={{ display: "block", mt: 0.25 }}>
                        {description}
                    </Typography>
                )}
            </Box>
            <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 0.75 }}>{children}</Box>
        </Box>
    );
}

/** 附件字节数 → 人类可读（数据页「附件占用」用） */
export function fmtBytes(n: number): string {
    return fmtBytesImpl(n);
}

/** 时间戳 →「2026-10-08 14:30」。兼容数字与字符串（D1 里两种都可能出现）。
 *  空 / 非法值返回 ""；复用 format.ts 的共享解析器，顺手修掉 Safari 的空格时间串坑。 */
export function fmtTime(value: number | string | null | undefined): string {
    if (value == null) return "";
    return fmtDateTime(value, { style: "compact", fallback: "" });
}

/** 一组互斥的小段选择（暖纸/纯白 那种样式）：选中项描强调色 */
export function SegOptions<T extends string>({
    value,
    options,
    onChange,
    dataKey,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    dataKey: string;
}) {
    return (
        <Box sx={{ display: "flex", gap: 0.5 }}>
            {options.map(opt => {
                const active = opt.value === value;
                return (
                    <Box
                        key={opt.value}
                        component='button'
                        type='button'
                        data-setting={`${dataKey}:${opt.value}`}
                        onClick={() => onChange(opt.value)}
                        sx={{
                            px: 1.25,
                            py: 0.4,
                            fontSize: 12,
                            borderRadius: "var(--notes-radius-chip, 8px)",
                            cursor: "pointer",
                            appearance: "none",
                            font: "inherit",
                            // 设置项是**操作件**（P1-4 方案 B）：可点 → 操作色。
                            // 这一层在弹窗里、portal 到 body，本来就不吃记事本根节点的红棕；
                            // 写 --accent-op 是把「操作」这件事显式写死，别再靠 DOM 位置侥幸。
                            border: active ? "1px solid var(--accent-op)" : "1px solid var(--neutral-border)",
                            bgcolor: active ? "var(--accent-wash)" : "transparent",
                            color: active ? "var(--accent-op)" : "text.secondary",
                        }}
                    >
                        {opt.label}
                    </Box>
                );
            })}
        </Box>
    );
}
