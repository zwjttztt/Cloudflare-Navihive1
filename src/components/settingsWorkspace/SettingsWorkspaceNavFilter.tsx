// src/components/settingsWorkspace/SettingsWorkspaceNavFilter.tsx
// 设置中心左栏那一条**搜索过滤**输入行（组件本身）。
//
// ── 它解决的不是「东西太多」──────────────────────────────────────────────
// 左栏只有 9 条，36px/条 ≈ 420px，一屏就能看全 —— 所以这里刻意做成
// **轻量、低调、不抢戏**的一行，而不是一张带标签/描边/帮助文字的正式表单控件：
// 它的价值是「我知道它叫什么，别让我逐行扫」。视觉上就是一颗放大镜 + 一句
// placeholder，没词的时候几乎看不见它，有词才亮出清除按钮。
//
// ── 为什么过滤住在左栏这条组件里（而不是外壳 / 面板 / 中心）──────────────
// 外壳（SettingsWorkspaceDialog）对 nav 的认知是一个**不透明的 ReactNode**，
// 它连 nav 里有几条、叫什么都不知道；要让它管过滤就得在 props 上开一串
// `filterable` / `filterValue` / `onFilterChange`，而外壳是所有中心共用的 ——
// 下一个中心接进来，第一件事就是继承一个「打字过滤什么都没发生」的空框。
// 所以：输入框、过滤、空态、播报，全部留在左栏内部，外壳零改动。
//
// ── 纯函数（filterNavGroups）为什么不在这里 ──────────────────────────────
// 见 navFilter.ts 文件头：混着导出组件和函数会触犯
// `react-refresh/only-export-components`，而且纯函数测试不该为此拉进 React/MUI。
// 本文件**只导出组件**，别再往这儿加 export function。
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import type { SxProps, Theme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";

export interface WorkspaceNavFilterProps {
    value: string;
    onChange: (value: string) => void;
    /** ↓：把焦点交给列表第一项（有命中时才有意义；空态时调用方自己会 no-op） */
    onArrowDown: () => void;
    sx?: SxProps<Theme>;
}

export default function WorkspaceNavFilter({
    value,
    onChange,
    onArrowDown,
    sx,
}: WorkspaceNavFilterProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        // ── Esc 分级：有词只清空、不关弹窗；没词一律不拦，交给 MUI 关弹窗 ──
        if (e.key === "Escape" && value) {
            // ⚠️ 必须 stopPropagation，**只 preventDefault 是无效的**。
            // 证据（MUI 9.5.0）：node_modules/@mui/material/Modal/useModal.js:107-119
            //   `// The handler doesn't take event.defaultPrevented into account:`
            //   …`if (event.key !== 'Escape' …) return;` → `onClose(event, 'escapeKeyDown')`
            // 也就是说 Modal 根那层的 React handler 只管「事件冒上来了没有」，
            // 完全不看 defaultPrevented。想让「清空搜索」不顺手把中心关掉，
            // 唯一的办法就是阻止冒泡。
            e.stopPropagation();
            e.preventDefault();
            onChange("");
            return;
        }
        if (e.key === "ArrowDown") {
            // ↓ 把焦点交给列表第一项：键盘用户不必 Tab 着穿过后面所有东西。
            // 刻意**不接管** ↑ / Enter：
            //   · ↑ 没有「上面一项」可去（输入框本身就在列表上面）；
            //   · 回车绑成「跳到第一项」既和 ↓ 重复，又容易在输入法确认时误触。
            e.preventDefault();
            onArrowDown();
        }
    };

    return (
        <TextField
            inputRef={inputRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            size='small'
            fullWidth
            placeholder='搜索设置'
            sx={sx}
            slotProps={{
                // ⚠️ 下面两个属性都必须挂在 **htmlInput**（原生 <input>）上：
                //   · 写在 <TextField> 顶层，MUI 会把 aria-label 摊到外层 FormControl
                //     那个 div 上 —— 读屏念的是 input，`input[aria-label=…]` 选择器
                //     也找不到它（本仓已踩过两次：MoveFolderDrawer / HeaderSearchBox
                //     里都有同款注释，别再踩第三次）；
                //   · onKeyDown 挂错层同样收不到：键事件是从 <input> 冒上来的，
                //     挂在别的槽位上要么根本不触发，要么晚于 Modal 那层。
                htmlInput: {
                    "aria-label": "搜索设置",
                    onKeyDown: handleKeyDown,
                },
                input: {
                    startAdornment: (
                        <InputAdornment position='start'>
                            <SearchIcon fontSize='small' sx={{ color: "text.disabled" }} />
                        </InputAdornment>
                    ),
                    endAdornment: value ? (
                        <InputAdornment position='end'>
                            <IconButton
                                size='small'
                                aria-label='清空搜索'
                                // 焦点不能甩掉：这颗按钮点完就消失，不拦住 mousedown
                                // 的话焦点会先掉回 body，键盘用户得从头 Tab 一遍。
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => {
                                    onChange("");
                                    inputRef.current?.focus();
                                }}
                            >
                                <CloseIcon fontSize='small' />
                            </IconButton>
                        </InputAdornment>
                    ) : null,
                },
            }}
        />
    );
}
