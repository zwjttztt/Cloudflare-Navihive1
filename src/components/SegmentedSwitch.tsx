// src/components/SegmentedSwitch.tsx
// 紧凑分段控件：从一个小集合里挑**一个筛选值**（备份视图 / 回收站类型 / 附件筛选）。
//
// 为什么是 role="group" + aria-pressed，而不是 role="tab" + aria-selected：
//   1) 语义上这三处做的都是「从同一个集合里挑一个切片」，不是平级视图切换 ——
//      备份页 / 恢复页共享同一份 config / remoteFiles / selectedRemote / overwrite 状态
//      （BackupDialog 里全在一个组件内），回收站的「站点 / 分组」是 items.filter(...)
//      的两个切片。事实是筛同一个集合，分段控件比页签更贴事实。
//   2) 更实际的原因：原来那两条 MUI <Tabs> 根本没兑现 ARIA Tab 契约 ——
//      没有 role="tabpanel"、没有 aria-controls / id 配对、没有 roving tabindex，
//      只是「长得像 Tab 的 div」。继续挂 role="tab" 就是骗读屏。
//      改成一个按钮组 + 按下态（aria-pressed），读屏念出来是
//      「备份视图，切换按钮，已按下」，这才是这段界面真正的行为。
//
// 视觉：小号圆角胶囊，选中 = 强调色描边 + 淡底 + 深一档的文字色。
//   ⚠️ 选中文字必须是 --accent-on-wash，**不是** --accent：
//      --accent（亮色 #1976d2）压在 --accent-wash 淡底上实测 4.04:1，小字线是 4.5:1，
//      会直接让设置中心段的 audit:contrast 红掉（那段预算 0 处不合格）。
//      --accent-on-wash 亮色 #1565c0 = 5.04:1、暗色跟随 --accent-op = 8.04:1。
//      描边仍可用 --accent-op：那是图形（3:1 线），4.04 过关。
//
// ⚠️ 这里一个颜色字面量都不许写（tests/hardcodedColorGuard.test.ts 扫 src 全部 .ts(x)），
//    一律走 index.css 里的设计 token。
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";

/** 一档选项：`value` 是状态值，`label` 是给人看（和读屏念）的文字 */
export interface SegmentedOption<T extends string | number> {
    value: T;
    label: string;
}

export interface SegmentedSwitchProps<T extends string | number> {
    /** 当前选中的那一档 */
    value: T;
    options: SegmentedOption<T>[];
    onChange: (next: T) => void;
    /** 读屏念的分组名，如「备份视图」——按钮组自己没有可见标签，必须给它一个 */
    ariaLabel: string;
    /** 数据属性前缀："recycle-kind" → 每颗带 data-recycle-kind-option="group" */
    dataAttr: string;
    disabled?: boolean;
    sx?: SxProps<Theme>;
}

/**
 * 紧凑分段控件。受控组件：状态由调用方持有（`value` + `onChange`），
 * 这里不存任何内部状态 —— 面板的「命令面板直达恢复页」「恢复成功后不关中心」
 * 都靠调用方那份 `tab` 状态机，控件只管画和上报点击。
 */
export default function SegmentedSwitch<T extends string | number>({
    value,
    options,
    onChange,
    ariaLabel,
    dataAttr,
    disabled = false,
    sx,
}: SegmentedSwitchProps<T>) {
    // 基础布局（横排 / 换行 / 不参与 flex 压缩）在前，调用方的 sx 在后可以覆盖；
    // sx 允许是对象 / 数组 / 主题函数（MUI 的 SxProps 三种形态），统一摊成数组入口。
    const rootSx: SxProps<Theme> = [
        { display: "flex", gap: 0.5, flexWrap: "wrap", flexShrink: 0 },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
    ];

    return (
        <Box role='group' aria-label={ariaLabel} sx={rootSx}>
            {options.map(opt => {
                const active = opt.value === value;
                return (
                    <Box
                        key={String(opt.value)}
                        component='button'
                        type='button'
                        aria-pressed={active}
                        disabled={disabled}
                        onClick={() => onChange(opt.value)}
                        // 动态属性名不能直接写在 JSX 里，用计算键摊进来：
                        // data-<前缀>-option="<值>"，测试与 e2e 靠它定位某一档
                        {...{ [`data-${dataAttr}-option`]: String(opt.value) }}
                        sx={{
                            px: 1.25,
                            py: 0.4,
                            fontSize: 12,
                            lineHeight: 1.5,
                            borderRadius: 1.5,
                            cursor: "pointer",
                            appearance: "none",
                            font: "inherit",
                            border: active
                                ? "1px solid var(--accent-op)"
                                : "1px solid var(--neutral-border)",
                            bgcolor: active ? "var(--accent-wash)" : "transparent",
                            color: active ? "var(--accent-on-wash)" : "text.secondary",
                            transition:
                                "background-color var(--dur-fast) var(--ease-out), " +
                                "color var(--dur-fast) var(--ease-out)",
                            "&:hover": {
                                bgcolor: active ? "var(--accent-wash)" : "var(--neutral-hover)",
                            },
                        }}
                    >
                        {opt.label}
                    </Box>
                );
            })}
        </Box>
    );
}
