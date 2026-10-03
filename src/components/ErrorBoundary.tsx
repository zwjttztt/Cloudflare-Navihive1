// 渲染兜底：React 组件树里任何一处抛错，默认行为是整棵树被卸载 → 纯白屏。
// 这里拦住异常，给一个能自助恢复的页面（重载 / 清理本机数据），而不是让人对着白屏发呆。
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../utils/errorReporter";
import { clearLocalAppData } from "../utils/localAppData";

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    stack: string;
}

export default class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, stack: "" };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        reportError(error, {
            source: "render",
            context: { componentStack: info.componentStack },
        });
        this.setState({ stack: info.componentStack || "" });
    }

    private reload = () => {
        window.location.reload();
    };

    private clearAndReload = (includeAuth: boolean) => {
        clearLocalAppData(includeAuth);
        window.location.reload();
    };

    render() {
        const { error, stack } = this.state;
        if (!error) return this.props.children;

        return (
            <div
                style={{
                    minHeight: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#f4f5f7",
                    color: "#1f2329",
                    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
                    padding: 24,
                }}
            >
                <div
                    style={{
                        maxWidth: 560,
                        background: "#fff",
                        border: "1px solid #e3e5e8",
                        borderRadius: 16,
                        padding: "28px 28px 24px",
                        boxShadow: "0 8px 32px rgba(0,0,0,.08)",
                    }}
                >
                    <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                        页面出了点问题
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.7, color: "#55595f" }}>
                        界面渲染时抛出了一个异常，已经被拦下来，数据没有被写入服务器。
                        可以先重新加载；如果每次打开都崩，多半是本机保存的偏好或缓存坏了，
                        清理本机数据即可（站点数据在服务器，不会丢）。
                    </div>
                    <details style={{ marginTop: 14 }}>
                        <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7076" }}>
                            查看错误详情
                        </summary>
                        <pre
                            style={{
                                marginTop: 10,
                                maxHeight: 200,
                                overflow: "auto",
                                background: "#f6f7f9",
                                border: "1px solid #eceef1",
                                borderRadius: 10,
                                padding: 12,
                                fontSize: 12,
                                lineHeight: 1.6,
                                color: "#8a3b3b",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                            }}
                        >
                            {error.message}
                            {stack ? `\n${stack}` : ""}
                        </pre>
                    </details>
                    <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
                        <button
                            onClick={this.reload}
                            style={{
                                padding: "8px 16px",
                                fontSize: 14,
                                borderRadius: 10,
                                border: "1px solid #d0d3d8",
                                background: "#1976d2",
                                color: "#fff",
                                cursor: "pointer",
                            }}
                        >
                            重新加载
                        </button>
                        <button
                            onClick={() => this.clearAndReload(false)}
                            style={{
                                padding: "8px 16px",
                                fontSize: 14,
                                borderRadius: 10,
                                border: "1px solid #d0d3d8",
                                background: "#fff",
                                color: "#1f2329",
                                cursor: "pointer",
                            }}
                        >
                            清理本机数据并重载
                        </button>
                        <button
                            onClick={() => this.clearAndReload(true)}
                            style={{
                                padding: "8px 16px",
                                fontSize: 14,
                                borderRadius: 10,
                                border: "1px solid #d0d3d8",
                                background: "#fff",
                                color: "#8a3b3b",
                                cursor: "pointer",
                            }}
                        >
                            连登录一起清理
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
