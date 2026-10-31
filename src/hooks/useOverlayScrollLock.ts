// src/hooks/useOverlayScrollLock.ts
//
// 全站弹层背景滚动锁 —— 单一、全局的管理者。
//
// 为什么需要它：
//   本 app 的滚动容器是 viewport（html）。useThemeController 把 MUI 的
//   disableScrollLock 全局设成 true（第 113-114 / 139-141 / 226 行），等于彻底
//   关掉了 MUI 内置滚动锁。而 MUI 内置锁锁的是 body，对这种「html 的 overflow 传播到
//   viewport」的滚动本来就锁不住。结果：每个弹层（32+ 个 Dialog / Drawer / Menu /
//   Popover，含设置弹窗）打开时背景页面都能被滚轮滚动。
//
// 方案：
//   用一个长期驻留的 MutationObserver 盯着 document.body（MUI 把弹层 portal 到 body，
//   subtree 覆盖任意深度），一旦发现 / 消失任意弹层根节点，就对 documentElement（html）
//   做「overflow:hidden + 等宽 padding 补偿」。html 的 overflow 会传播到 viewport，
//   从而停掉页面滚动。
//
// 关键约束 —— 只碰 documentElement（html），绝不碰 document.body：
//   - 笔记页的 lightbox 仍锁 document.body（另一个元素），两者互不污染各自记录的 prev。
//
// 宽度与白边的账（v23.3.1 修正，来自用户实测两张截图）：
//   index.css 在 html 上声明了 scrollbar-gutter: stable，而 overflow:hidden 后 html
//   仍是滚动容器，**stable 槽位继续预留**（只是刻度没了）。如果再像传统做法那样
//   补 padding-right，就成了「空槽 + padding」双份白边：遮罩旁多出一条白条，
//   且内容整体左移一个滚动条宽（「导航站」三个字开合弹层前后会跳）。
//   所以上锁时要同时把 html 的 scrollbar-gutter 临时改成 auto（不再预留槽位），
//   再 overflow:hidden + padding-right = 滚动条宽：内容宽度前后逐位相等
//   （不位移、不撞 900px 断点重排），空槽也不再存在，遮罩铺满整个视口。
//   解锁时三项（overflow / padding / gutter）全部原样还原。
//
// 所有权规则（防「永久锁死」回归）：html 的 overflow 还有另一位所有者 ——
//   记事本页面（NotesPageShell 是 position:fixed 的普通 div，**不是** MUI Modal，
//   本 observer 看不见它）靠自带的 useScrollLock 同步锁 html+body。所以本锁上锁
//   瞬间如果发现 overflow 已经是 hidden，就只跟随、不接管：解锁时不写回，把还原权
//   留给真正的所有者。否则会把别人记录的 prev 污染成 "hidden"——记事本先卸载、
//   observer 随后才解锁的那一拍，我们就会把 "hidden" 写回 html，整站永久锁死。
//   守卫：tests/overlayScrollLock.dom.test.tsx 的「与其他锁共存」用例。
//
// 故意排除 .MuiTooltip-popper：tooltip 是轻量提示，不该锁背景滚动。
import { useEffect } from "react";

/** 命中即视为「有弹层在场」的根节点选择器。tooltip 不在其列。 */
const OVERLAY_SELECTOR =
    ".MuiModal-root, .MuiDrawer-root, .MuiPopover-root, .MuiMenu-root";

/** 当前文档里是否存在任意一个需要锁背景的弹层根节点。 */
function hasOverlay(): boolean {
    return !!document.querySelector(OVERLAY_SELECTOR);
}

/**
 * 挂载后常驻一个 observer，随宿主（App）生命周期存在，统一管理所有弹层对
 * documentElement 的 overflow 锁定 / 还原。
 */
export function useOverlayScrollLock(): void {
    useEffect(() => {
        const root = document.documentElement;

        // 是否处于上锁态。用普通对象即可：整个 effect 生命周期内它只被本闭包内的
        // sync / applyUnlock 读写，不需要跨渲染持久。
        const lockedRef = { current: false };
        // 上锁瞬间记录的内联样式，用于解锁后原样还原（绝不无脑写 ""，
        // 以免抹掉别处改过的 html 内联样式）。gutter 走 setProperty，免得依赖
        // TS lib.dom 里 scrollbarGutter 映射的可用性。
        const prevRef = { overflow: "", paddingRight: "", gutter: "" };
        // false = 上锁时 html 已被别的所有者（记事本 useScrollLock）锁着，
        // 我们只跟随；解锁时不碰 overflow，所有权归原主。
        let ownsOverflow = false;

        const applyUnlock = () => {
            if (!lockedRef.current) return;
            if (ownsOverflow) {
                root.style.overflow = prevRef.overflow;
            }
            root.style.paddingRight = prevRef.paddingRight;
            root.style.setProperty("scrollbar-gutter", prevRef.gutter);
            lockedRef.current = false;
        };

        const sync = () => {
            const present = hasOverlay();
            if (present && !lockedRef.current) {
                // 滚动条宽度必须在改样式**之前**量（改完就没有滚动条可量了）；
                // jsdom 下 innerWidth 与 clientWidth 恒等，bar=0，不补 padding。
                const bar = window.innerWidth - root.clientWidth;
                prevRef.overflow = root.style.overflow;
                prevRef.paddingRight = root.style.paddingRight;
                prevRef.gutter = root.style.getPropertyValue("scrollbar-gutter");
                // 已是 hidden 说明别的所有者在锁：只跟随不接管（见头部所有权规则）。
                ownsOverflow = root.style.overflow !== "hidden";
                // 先把 stable 槽位收掉再锁，padding 只补一次 —— 见头部「宽度与白边的账」
                root.style.setProperty("scrollbar-gutter", "auto");
                root.style.overflow = "hidden";
                if (bar > 0) {
                    root.style.paddingRight = `${bar}px`;
                }
                lockedRef.current = true;
            } else if (!present && lockedRef.current) {
                applyUnlock();
            }
        };

        // 初始化跑一次：弹层可能在 hook 挂载时已经存在（热重载 / 嵌套渲染顺序），
        // 不能等 observer 第一次回调才锁。
        sync();

        const observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            // 卸载时若仍处于上锁态，还原一次；已解锁再调也安全（applyUnlock 有护栏）。
            applyUnlock();
        };
    }, []);
}
