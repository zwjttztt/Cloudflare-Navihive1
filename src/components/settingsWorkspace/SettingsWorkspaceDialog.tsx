// src/components/settingsWorkspace/SettingsWorkspaceDialog.tsx
// **共享的设置工作区外壳**：左栏分组导航 + 右栏面板 + 底部操作区。
//
// 为什么要抽它（2026-10-29 导航页「设置」统一弹窗）：导航页原来把十个动作
// 摊在一个下拉菜单里，点开各自是一个独立弹窗 —— 尺寸、标题栏、底部按钮文案
// 全都各不相同（宽度 xs/sm/md 三种、正文 padding px:3 / p:0 两种、完成按钮
// contained / outlined / text 三种）。现在统一成「一个中心弹窗 + 左栏换面板」，
// 外壳就是那个「所有中心共用的一份」：宽高、材质、滚动分区、关闭出口、
// 窄屏两步式导航都只在这里写一遍。
//
// 三条硬规则：
//   1. **关闭只有一个出口** `requestClose`：右上角 × / Esc / 点遮罩 全部走它，
//      有未保存草稿时它先弹站内确认（不用 window.confirm ——
//      tests/dialogConsistency.test.ts 盯着这个）。底栏「完成」已于 2026-10-31
//      撤掉：中心里的面板改完即生效，那个按钮实质是第二个关闭按钮。
//   2. **aria-labelledby 只能写在 slotProps.paper 上**：MUI 把 role=dialog /
//      aria-modal 放在 **paper 插槽**，写在 <Dialog> 顶层的 aria-* 会随
//      `{...other}` 落到父级 Modal 根，读屏拿不到弹窗名字
//      （components/StatsHubDialog.tsx 那处是需要避免的反例）。
//   3. **滚动分区**：外框 / 总标题 / 面板标题 / 底栏固定，左栏与右栏正文
//      各自 overflowY:auto —— 整个 paper 不滚，换面板时标题不会跟着跑。
//   4. **两种打开意图要分清**（R09）：`directPanel` 有值 = 命令指名直达某一屏，
//      窄屏跳过目录直接进面板；未传 = 普通打开，窄屏落在目录。外壳不靠「目标
//      面板是不是默认项」来猜意图，也不再每次打开都把步进按回目录。
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DialogCloseButton from "../DialogCloseButton";
import ConfirmDialogGate from "../ConfirmDialogGate";
import { dialogPaperTokens } from "../dialogShell";
import { WorkspaceNavSignalContext } from "./SettingsWorkspaceNav";
import { QUERY_BELOW_600 } from "../../theme/mediaQueries";

/**
 * 窄屏（<600px）走 MUI `Dialog fullScreen`，不是底部抽屉。
 *
 * 理由：这里的面板里有长表单、列表、备份恢复与账号管理，底部抽屉那 86~92dvh
 * 会被软键盘与二级确认弹窗持续挤压；fullScreen 仍保留 MUI Dialog 的
 * focus trap 与焦点归还，只是把纸面铺满一屏。
 */
const FULL_SCREEN_QUERY = QUERY_BELOW_600;

/** 窄屏两步式导航的两步：目录 / 面板 */
type MobileStep = "list" | "panel";

/**
 * 焦点接力的重试节奏（只用于窄屏两步式）。
 *
 * 弹窗内容是 MUI Portal 里**第二次提交**才挂上的（见组件里 findFocusTarget
 * 上方那段注释），所以第一次找必然落空。用 0ms 的宏任务补，而不是 rAF：
 * rAF 在后台标签页里会被挂起，切回来才补一下 —— 那时候用户早就自己点了。
 * 上限 30 次（≈ 一帧到两帧之内），超时就放弃：不跳焦点也比一直抢强。
 */
const FOCUS_RETRY_DELAY = 0;
const FOCUS_RETRY_LIMIT = 30;

export interface SettingsWorkspaceDialogProps {
    open: boolean;
    /** 统一关闭出口（× / Esc / 遮罩 / 底栏完成都调它） */
    onClose: () => void;
    /**
     * **本次打开的意图**：传了值 = 「目标直达某一屏」（窄屏跳过目录，直接进右栏
     * 面板，焦点落到面板标题）；不传 = 普通打开（窄屏落在目录，宽屏落在左栏第一项）。
     *
     * ⚠️ 为什么用「传不传」而不是「面板 id 等不等于默认项」来判：目标可以是
     * 「统计」，而「统计」正好是左栏第一项 —— 用「不等于默认项」去推断的话，
     * 命令点「查看统计」就会被当成普通打开，窄屏又落回目录（R09 的另一半）。
     * 意图必须由调用方**显式**说出来，外壳不猜。
     *
     * 值是目标面板 id：它同时是「又来了一个**不同的**直达请求」的判据 ——
     * 中心已经开着时再下一条命令，步进要跟着切过去。
     */
    directPanel?: string;
    /** 弹窗总标题。它同时是 aria-labelledby 指向的那个节点 */
    title: string;
    /** 左栏导航节点（SettingsWorkspaceNav） */
    nav: ReactNode;
    /** 右栏面板节点（SettingsWorkspacePanel） */
    children: ReactNode;
    /** 底部操作区节点。危险动作要带 `sx={{ mr: "auto" }}` 才会靠左 */
    actions?: ReactNode;
    /**
     * 有未保存的草稿：关闭前先弹站内确认。
     * 由面板（或中心弹窗）按自己的编辑状态传，外壳不猜。
     */
    dirty?: boolean;
    /** 确认弹窗里那句「要丢掉什么」的说明 */
    dirtyHint?: string;
    /**
     * 左栏宽度（桌面，px）。底部危险区条目多的中心可以调宽一点。
     *
     * 208 → **192**（2026-10-31，比原计划宽 16px，原因见下）。
     *
     * 账算过一遍（1440×950 实测）：左栏宽 W 之后，条目可用文字宽 =
     * W − 16（左栏 py 之外的 px:1）− 24（条目 px:1.5）− 18（图标）− 10（gap 1.25）。
     * 最长条目是「快捷键与操作帮助」8 个汉字，13.5px/字 = 108px：
     *   · W=176 → 可用 108px，**正好等于** 108 —— 实测真的折成了两行（行高 49 而非 36）；
     *   · W=192 → 可用 124px，留 16px 余量，不再依赖字体度量恰好对齐。
     * 176 省下的那 16px 换来一条折行的导航项，不值。
     */
    navWidth?: number;
    /** 桌面纸面高度（CSS 长度字符串） */
    height?: string;
}

export default function SettingsWorkspaceDialog({
    open,
    onClose,
    directPanel,
    title,
    nav,
    children,
    actions,
    dirty = false,
    dirtyHint = "这个面板里有改动还没保存，现在关闭会丢掉它们。",
    navWidth = 192,
    height = "min(720px, calc(100dvh - 48px))",
}: SettingsWorkspaceDialogProps) {
    // useId 而不是写死字符串：同一个中心可能被同时挂两份（桌面 / 移动入口），
    // 写死 id 会让两个 dialog 的 aria-labelledby 指向同一个节点。
    const titleId = useId();
    const fullScreen = useMediaQuery(FULL_SCREEN_QUERY, { noSsr: true });
    /**
     * 窄屏两步式的当前步。
     *
     * 初值跟着**打开意图**走：带目标直开就是「面板」，普通打开才是「目录」。
     * （挂载那一帧 open 一般已经是 true；open 先 false 后 true 的路径由下面的
     * effect 兜住，两条路都落在同一个判断上，不靠渲染顺序。）
     */
    const [mobileStep, setMobileStep] = useState<MobileStep>(() =>
        directPanel === undefined ? "list" : "panel"
    );
    const [confirmClose, setConfirmClose] = useState(false);

    /** 左栏 / 右栏的 DOM 入口：窄屏切步进之后要在这里找焦点落点 */
    const navRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    /**
     * 待接力的焦点（只在窄屏两步式里用）。
     *
     * 为什么用 ref 而不是 state：切步进的那一帧目标节点**还没挂上**，
     * 要等这一帧渲染完再找；用 ref 既不额外触发一次渲染，也不会把
     * 「焦点该去哪」这件事写进渲染结果里。
     */
    const pendingFocus = useRef<MobileStep | null>(null);
    /** 没跑完的焦点重试定时器（切步进 / 关闭 / 卸载都要把它清掉） */
    const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * 焦点接力：窄屏同一时刻只有一栏在 DOM 里，切那一步会把刚拿到焦点的元素
     * 卸载掉。不接力的话焦点掉到 <body>，键盘用户按 Tab 得从头重新走进弹窗。
     *
     * 为什么带重试、而不是「等下一次渲染再看」：弹窗内容走 MUI 的 Portal，
     * 它在 layout effect 里才拿到挂载点 —— 也就是说**第二次提交**才真的挂上
     * 左右两栏，而外壳自己不会因为这件事再渲染一次（那次重渲染发生在 Portal
     * 内部）。所以「这一帧找不到」是常态，必须自己补一帧，否则直达之后的焦点
     * 永远落不到标题上（实测：外壳 effect 跑的时候 panelRef 还是 null）。
     */
    const findFocusTarget = useCallback((where: MobileStep): HTMLElement | null => {
        if (where === "panel") {
            return (
                panelRef.current?.querySelector<HTMLElement>("[data-workspace-panel-title]") ?? null
            );
        }
        // 目录里「刚才那一屏」的条目：左栏用 aria-current 标着它。用渲染出来的
        // 事实比再传一个 activeId 进来更难失同步；当前项被左栏过滤挡掉时，
        // 退回目录里第一条（总比焦点掉到 body 强）。
        return (
            navRef.current?.querySelector<HTMLElement>('[data-workspace-nav][aria-current="true"]') ??
            navRef.current?.querySelector<HTMLElement>("[data-workspace-nav]") ??
            null
        );
    }, []);

    const clearFocusRetry = useCallback(() => {
        if (focusTimerRef.current !== null) {
            clearTimeout(focusTimerRef.current);
            focusTimerRef.current = null;
        }
    }, []);

    const runFocusRelay = useCallback(
        (where: MobileStep, attempt = 0) => {
            // 请求已被后来的操作取代（再切一步 / 关闭）就别再抢焦点了
            if (pendingFocus.current !== where) return;
            const el = findFocusTarget(where);
            if (el) {
                pendingFocus.current = null;
                el.focus();
                return;
            }
            // 放弃也是个正经结局：不跳焦点（焦点留在弹窗纸面上）好过一直抢
            if (attempt >= FOCUS_RETRY_LIMIT) {
                pendingFocus.current = null;
                return;
            }
            focusTimerRef.current = setTimeout(
                () => runFocusRelay(where, attempt + 1),
                FOCUS_RETRY_DELAY
            );
        },
        [findFocusTarget]
    );

    /** 请求把焦点送到某一栏（窄屏两步式专用；宽屏不调它） */
    const requestFocus = useCallback(
        (where: MobileStep) => {
            pendingFocus.current = where;
            clearFocusRetry();
            runFocusRelay(where);
        },
        [clearFocusRetry, runFocusRelay]
    );

    // 卸载时把没跑完的重试清掉：定时器不该在组件没了之后还去动 DOM
    useEffect(() => clearFocusRetry, [clearFocusRetry]);

    /**
     * 「这次打开」落在哪一步 —— 步进只由**打开时的意图**决定，不是每次渲染都重置。
     *
     * R09（窄屏命令直达被重置）的根因就是这里：原先写的是
     * `useEffect(() => { if (open) setMobileStep("list") }, [open])`，
     * 无条件把步进按回目录 —— 命令明明带了目标也照样被按回去，用户还得再点一次。
     * 现在：
     *   · directPanel 有值（目标直达）→ "panel"：窄屏直接进那一屏；
     *   · directPanel 未传（普通打开）→ "list"：窄屏落在目录（原行为不变）。
     *
     * 为什么要 openHandledRef 这一层：用户进面板后点「返回」回目录、再点别的条目
     * 进面板 —— 这一串操作里 open 从头到尾是 true。若 effect 每次都重设步进，
     * 「返回」会被立刻抹掉。所以用 ref 记住「这次打开已经定过步进了」，之后只有
     * **又来了一个不同的直达请求**（中心开着时再下一条命令）才切步进。
     * 重置逻辑因此跟着「本次打开」这个生命周期走，而不是每次渲染。
     */
    const openHandledRef = useRef(false);
    const lastDirectRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!open) {
            // 关着 = 这次打开已结束：清掉标记与没跑完的焦点重试
            openHandledRef.current = false;
            pendingFocus.current = null;
            clearFocusRetry();
            return;
        }
        const firstFrameOfThisOpen = !openHandledRef.current;
        const newDirectRequest =
            directPanel !== undefined && directPanel !== lastDirectRef.current;
        if (!firstFrameOfThisOpen && !newDirectRequest) return;
        openHandledRef.current = true;
        lastDirectRef.current = directPanel;
        setMobileStep(directPanel === undefined ? "list" : "panel");
        // 焦点接力只在窄屏做：宽屏两栏同时可见，跳焦点反而打断阅读
        if (fullScreen && directPanel !== undefined) requestFocus("panel");
    }, [open, directPanel, fullScreen, requestFocus, clearFocusRetry]);

    const requestClose = () => {
        if (dirty) {
            setConfirmClose(true);
            return;
        }
        onClose();
    };

    /** 面板 → 目录（窄屏那颗「全部选项」）：回目录，并把焦点交给刚才那一屏的条目 */
    const backToList = () => {
        if (fullScreen) requestFocus("list");
        setMobileStep("list");
    };

    const showNav = !fullScreen || mobileStep === "list";
    const showPanel = !fullScreen || mobileStep === "panel";
    const showActions = Boolean(actions) && showPanel;

    return (
        <Dialog
            open={open}
            onClose={requestClose}
            fullWidth
            maxWidth='md'
            fullScreen={fullScreen}
            slotProps={{
                // ⚠️ 无障碍：role=dialog / aria-modal 在 **paper** 上，
                // aria-labelledby 必须跟着写在这儿（写在 <Dialog> 顶层会落到 Modal 根）。
                paper: {
                    "aria-labelledby": titleId,
                    sx: {
                        // 纸面材质走全站唯一真源（圆角 / 底色 / 描边 / 阴影 / 模糊）
                        ...dialogPaperTokens,
                        // ⚠️ **这一个**纸面不要毛玻璃（2026-11，用户实测：切换左栏面板时
                        // 左缘冒出一抹白色圆角浮框）。必须写在这行 spread **之后**才生效：
                        // 同一份 sx 对象里后面的键覆盖前面的。
                        //
                        // 根因：dialogPaperTokens（以及 theme 的
                        // `MuiDialog.styleOverrides.paper`，取值同源）给的是
                        // `backdrop-filter: blur(14px) saturate(1.4)` + 半透明底
                        // `var(--surface-modal)`（= rgba(255,255,255,.94)）+ 22px 圆角。
                        // 换面板会把右栏子树整体重建，浏览器于是要把这块纸面提成独立
                        // 合成层、**重新采样一次背景**；重新采样那一帧里「半透明底 +
                        // 圆角边缘 + 底下 rgba(0,0,0,.52) 遮罩」三层没按顺序合成，
                        // 圆角外侧漏出后面的亮色页面 —— 肉眼就是左缘那一抹白色圆角浮框
                        // （只在切换的瞬间出现，切完就没了）。
                        //
                        // 修法：不透明底 + 显式关掉模糊。底色不透明 ⇒ 浏览器不需要为它
                        // 采样背景，也就没有「重新采样」那一帧，浮框消失；顺带视觉上更对：
                        // 设置中心是一整屏表单/列表，身后那层页面透出来只是噪音。
                        // 同一套规则**只加在这里**，全站弹窗的玻璃材质（dialogShell 与
                        // theme）不动 —— 别的弹窗没有「切面板重建整块纸面」这个动作。
                        //
                        // ⚠️ 底色必须是**不透明**色，别写回 `var(--surface-modal)`
                        // （0.94 alpha 会原样复发）。background.paper 亮 #fff / 暗 #121212，
                        // 都已是不透明色，跟着亮暗主题走。
                        backdropFilter: "none",
                        WebkitBackdropFilter: "none",
                        // 写成 sx 的主题回调（与 notes/NotesPageShell.tsx 同一写法），
                        // **不硬编码色值**：深色模式下必须有对应的不透明底，
                        // 写死 #fff 会得到白底配浅字。
                        backgroundColor: (t: { palette: { background: { paper: string } } }) =>
                            t.palette.background.paper,
                        // DialogCloseButton 是 absolute 定位，基准必须是纸面本身
                        position: "relative",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        // 外框自己不滚：滚动交给左栏与右栏正文（见上注第 3 条）
                        overflow: "hidden",
                        ...(fullScreen
                            ? {
                                  m: 0,
                                  width: "100%",
                                  maxWidth: "100%",
                                  height: "100%",
                                  maxHeight: "100%",
                                  borderRadius: 0,
                              }
                            : { height, maxHeight: height }),
                    },
                },
            }}
        >
            {/* 总标题：固定，不随面板滚动 */}
            <Box
                sx={{
                    position: "relative",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    // 48（原 56）：这一行现在只是「窗口标签」，不再和面板主标题
                    // 抢层级，压到 48 才配得上它降下来的字号（13/600）
                    minHeight: 48,
                    // py 1.5 → 0.5：窄屏第二步那颗「全部选项」minHeight 44，
                    // 48-44 只剩 4px，上下各给 4px（0.5）刚好不裁切 ——
                    // 留 12px（1.5）的话这一行会被顶到 68px，白占 20px 正文高度
                    py: 0.5,
                    pl: fullScreen ? 2 : 3,
                    // 右侧给关闭按钮留位（它 absolute 在 right:12，宽约 30）
                    pr: 7,
                }}
            >
                {fullScreen && mobileStep === "panel" && (
                    <Button
                        size='small'
                        startIcon={<ArrowBackIcon fontSize='small' />}
                        onClick={backToList}
                        data-workspace-back='1'
                        sx={{ minHeight: 44, flexShrink: 0 }}
                    >
                        全部选项
                    </Button>
                )}
                {/* 「设置」两个字是**窗口标签**，不是内容标题 —— 它下面那一行
                    （面板主标题 17/600）才是这一屏唯一的标题。同字号同字重会让
                    第一眼看到两层同级标题在打架，所以这里降到 13 + text.secondary，
                    字重保留 600（小一号但仍是「标签」，不会读成说明文字）。 */}
                <Typography
                    id={titleId}
                    component='h2'
                    noWrap
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        fontWeight: 600,
                        color: "text.secondary",
                    }}
                >
                    {title}
                </Typography>
                {/* 位置固定纸面右上；label 走中文（读屏会念出来） */}
                <DialogCloseButton onClose={requestClose} label='关闭' />
            </Box>

            {/* 主体：左栏导航 + 右栏面板 */}
            <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
                {showNav && (
                    <Box
                        ref={navRef}
                        sx={{
                            width: fullScreen ? "100%" : navWidth,
                            flexShrink: 0,
                            minHeight: 0,
                            display: "flex",
                            flexDirection: "column",
                            overflow: "hidden",
                            py: 1.5,
                            px: 1,
                            // 底色去掉（2026-10-31）：左栏原本是「浅灰底 + 右缝描边」，
                            // 底色与纸面只差 alpha 0.05，看不出层次，反而让右栏正文
                            // 显得像被贴上去的一块。现在只留右缝那一条 1px 结构线。
                            borderRight: fullScreen
                                ? "none"
                                : "1px solid var(--neutral-hover)",
                        }}
                    >
                        <WorkspaceNavSignalContext.Provider
                            // compact 由外壳算：只有这里知道是不是 fullScreen
                            value={{ onNavigate: () => setMobileStep("panel"), compact: !fullScreen }}
                        >
                            {nav}
                        </WorkspaceNavSignalContext.Provider>
                    </Box>
                )}
                {showPanel && (
                    <Box
                        ref={panelRef}
                        sx={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                        }}
                    >
                        {children}
                    </Box>
                )}
            </Box>

            {/* 底栏：固定。窄屏让开 iPhone 底部那道横条，软键盘弹起时仍可达 */}
            {showActions && (
                <Box
                    sx={{
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 1,
                        px: fullScreen ? 2 : 3,
                        pt: 1.5,
                        pb: fullScreen ? "calc(12px + env(safe-area-inset-bottom, 0px))" : 1.5,
                        // 上描边去掉（2026-10-31）：底栏与正文之间本来就有留白，
                        // 再加一条线就成了第 5 种分割手段。窄屏靠安全区留白本身
                        // 分隔即可，不画线。
                    }}
                >
                    {actions}
                </Box>
            )}

            {/* 未保存草稿的关闭确认：站内弹窗，不用 window.confirm */}
            <ConfirmDialogGate
                open={confirmClose}
                title='放弃未保存的改动？'
                description={dirtyHint}
                confirmText='放弃并关闭'
                cancelText='继续编辑'
                danger
                onConfirm={() => {
                    setConfirmClose(false);
                    onClose();
                }}
                onClose={() => setConfirmClose(false)}
            />
        </Dialog>
    );
}
