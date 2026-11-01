// src/components/settingsWorkspace/SettingsWorkspaceNavFilter.tsx
// 设置中心左栏那一条**搜索过滤**输入行 + 它的纯函数。
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
// ── 这个文件为什么单独拆出来 ────────────────────────────────────────────
// ① 纯函数 `filterNavGroups` 要能脱离 React 单测（不挂 DOM、毫秒级）；
// ② 它被 `SettingsWorkspaceNav` 静态引用，而后者是**中心懒加载块**里的模块
//    （见 tests/navigationCenterLazyGuard.test.ts 的 CENTER_MODULES）——
//    拆开之后这条守卫也能顺带看住这个新文件，防止有人把它静态拉进首屏。
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import type { SxProps, Theme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
// type-only：编译期擦除，不会在 Nav ↔ Filter 之间留下运行期循环依赖
import type { WorkspaceNavGroup, WorkspaceNavItem } from "./SettingsWorkspaceNav";

/** 归一化：去首尾空白 + 转小写。中文没有大小写，但中文输入法常带全角空格。 */
const norm = (s: string): string => s.trim().toLowerCase();

/** 一条条目是否命中关键词（q 已经是 norm 过的） */
function matches(item: WorkspaceNavItem, q: string): boolean {
    // searchText 是调用方（导航中心）拼好的搜索面：名称 + 别名 + 一行说明。
    // 没传的中心退化成「只按名称搜」—— 导航组件不认识 model.ts 里有几个字段。
    return norm(item.searchText ?? item.label).includes(q);
}

/**
 * 按关键词过滤分组。**纯函数**，可以脱离 React 单测。
 *
 * 三个刻意的行为：
 *   1. 空词（含纯空格）**原样返回传入的那个数组引用** —— 引用相等意味着
 *      `useMemo` 的下游不会因为「清空搜索」而白重渲染一次，也意味着
 *      「清空 = 回到原样」是可以被 `===` 断言钉住的；
 *   2. 过滤后空掉的分组整组丢弃：一个只有 `aria-label` 没有子项的
 *      `role="group"`，读屏会念「数据与活动，分组」然后什么都没有 ——
 *      比不渲染更迷惑；
 *   3. **先 filter 再交给调用方 map**（调用方拿到的已经是过滤后的数组）：
 *      分组之间那条 1px 分割线是按 `index > 0` 画的，下标必须是过滤后的，
 *      否则第一个可见分组会带着一条分割线、上面什么都没有。
 */
export function filterNavGroups(
    groups: WorkspaceNavGroup[],
    keyword: string
): WorkspaceNavGroup[] {
    const q = norm(keyword);
    if (!q) return groups;
    return groups
        .map(group => ({ ...group, items: group.items.filter(item => matches(item, q)) }))
        .filter(group => group.items.length > 0);
}

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
