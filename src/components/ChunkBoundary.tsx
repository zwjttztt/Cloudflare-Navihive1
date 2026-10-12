// 懒加载块的错误边界：把「某个弹窗的代码没取到」拦在弹窗这一层。
//
// 背景：弹窗都是 lazy chunk，块取不到时 React.lazy 的 promise reject，
// 渲染期抛错会一路冒到最近的错误边界。而全站只有根上那一个（main.tsx 的 ErrorBoundary），
// 于是**断网时点开一个弹窗，整站会被换成「页面出了点问题」** ——
// 实际只是那一个弹窗的代码没下载下来，数据一条没丢，看着却像天塌了。
//
// 所以每个 lazy 浮层外面套一层这个：只影响它自己，文案按「是不是离线」分开说，
// 在线还给一个重试（attempt 变了才会真的重新挂载子树、重新走一次 import）。
//
// 两个刻意的取舍：
// 1. **不用 MUI**：它是首屏包里的静态 import，用 Alert/Button 实测会把首屏顶高 1.3 KB，
//    而首屏预算的余量就在 5% 边上。这里跟根上的 ErrorBoundary 一样用纯 DOM + 内联样式 ——
//    出错时才显示的界面，本来也不该为它往首屏里塞组件。
// 2. **把 <Suspense> 包进来**：用到它的地方原本都是 `<Suspense fallback={null}>`，
//    少一层嵌套也不容易漏 —— lazy 组件没有 Suspense 会在打开瞬间直接报错。
//
// ⚠️ 2026-10-12 补的 `when`：原来所有弹窗都是 `<ChunkBoundary><XDialog open={open}/>`，
//    **无条件渲染**。而 React.lazy 只要被渲染就会立刻去下载那个 chunk —— open 是 false
//    也照下不误。实测首屏因此多出 34 个请求 / 1.1 MB：所谓「lazy」只省了解析时间，
//    下载与请求一个没省（在这条每个请求 1~3 秒的链路上，请求数才是最贵的）。
//    给了 `when` 就只在为真时挂载子树，chunk 真正变成「打开才下载」。
import { Component, Suspense, type ReactNode } from "react";
import { describeChunkFailure, looksLikeChunkLoadError } from "../utils/chunkFailure";

/**
 * 关闭后延迟多久卸载。MUI 的 Dialog 退出过渡约 195ms，
 * 父级立刻卸载会把这段动画掐掉（窗口直接消失）。留 320ms 让它播完。
 */
const UNMOUNT_DELAY_MS = 320;

interface Props {
    children: ReactNode;
    /**
     * 有这个 prop 时才「按需挂载」：为真立刻挂载，转假后延迟一会儿再卸载。
     * 不传 = 常驻挂载（老行为），给那些**没有打开/关闭概念**的浮层用
     * （比如维护模式横幅，它要一直在才能自己轮询到维护状态）。
     */
    when?: boolean;
}

interface State {
    error: Error | null;
    /** 每次重试 +1：key 变了才会真的重新挂载子树、重新发一次 import */
    attempt: number;
    mounted: boolean;
}

export default class ChunkBoundary extends Component<Props, State> {
    state: State = {
        error: null,
        attempt: 0,
        // 不传 when 的老调用点保持常驻，避免改变它们现在的行为
        mounted: this.props.when === undefined ? true : this.props.when,
    };

    private unmountTimer: ReturnType<typeof setTimeout> | null = null;

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidUpdate(prevProps: Props) {
        const when = this.props.when;
        if (when === undefined) return;
        if (prevProps.when === when && this.unmountTimer === null) return;

        if (when && !this.state.mounted) {
            // 重新打开：把上一次的卸载倒计时取消，别让它把刚挂载的子树又卸掉
            if (this.unmountTimer !== null) {
                clearTimeout(this.unmountTimer);
                this.unmountTimer = null;
            }
            this.setState({ mounted: true });
            return;
        }
        if (!when && this.state.mounted && this.unmountTimer === null) {
            this.unmountTimer = setTimeout(() => {
                this.unmountTimer = null;
                this.setState({ mounted: false });
            }, UNMOUNT_DELAY_MS);
        }
    }

    componentWillUnmount() {
        if (this.unmountTimer !== null) clearTimeout(this.unmountTimer);
    }

    private retry = () => {
        this.setState(prev => ({ error: null, attempt: prev.attempt + 1 }));
    };

    render() {
        const { error, attempt, mounted } = this.state;
        // 卸载期间子树还在（动画要播完），只是外面这层不再主动留它
        if (!mounted) return null;
        if (!error) {
            return (
                <Suspense fallback={null} key={attempt}>
                    {this.props.children}
                </Suspense>
            );
        }

        const text = describeChunkFailure(
            typeof navigator !== "undefined" && navigator.onLine === false,
            looksLikeChunkLoadError(error)
        );

        return (
            <div
                role="alert"
                style={{
                    margin: 12,
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: "1px solid #e3e5e8",
                    background: "#fff",
                    color: "#1f2329",
                    fontSize: 14,
                    lineHeight: 1.7,
                }}
            >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{text.title}</div>
                <div style={{ color: "#55595f" }}>{text.hint}</div>
                {text.retryable && (
                    <button
                        onClick={this.retry}
                        style={{
                            marginTop: 10,
                            padding: "6px 14px",
                            fontSize: 14,
                            borderRadius: 8,
                            border: "1px solid #d0d3d8",
                            background: "#1976d2",
                            color: "#fff",
                            cursor: "pointer",
                        }}
                    >
                        重试
                    </button>
                )}
            </div>
        );
    }
}
