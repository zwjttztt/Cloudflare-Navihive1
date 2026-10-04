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
import { Component, Suspense, type ReactNode } from "react";
import { describeChunkFailure, looksLikeChunkLoadError } from "../utils/chunkFailure";

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    /** 每次重试 +1：key 变了才会真的重新挂载子树、重新发一次 import */
    attempt: number;
}

export default class ChunkBoundary extends Component<Props, State> {
    state: State = { error: null, attempt: 0 };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    private retry = () => {
        this.setState(prev => ({ error: null, attempt: prev.attempt + 1 }));
    };

    render() {
        const { error, attempt } = this.state;
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
