// 渲染兜底：React 组件树里任何一处抛错，默认行为是整棵树被卸载 → 纯白屏。
// 这里拦住异常，给一个能自助恢复的页面（重载 / 清理本机数据），而不是让人对着白屏发呆。
//
// 样式刻意放在 src/index.css 的 .eb-* 类里（而不是内联 style 对象）：
// 内联 style 在 index chunk 里占约 1.3 KB，而首屏 gzip 预算余量只有几十字节——
// 把样式搬进 CSS 后 index chunk 明显变小，反而给首屏腾出字节。
// 颜色全部走 index.css 的 token（--error-page-bg / --error-page-surface 是新增的
// **不透明**底色，现有 --surface-* 都是半透明，不能当满屏不透明底）。
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

        // 崩溃可能发生在 React 挂载前：此时 <html> 上还没有 .dark 类（boot-theme.js
        // 只写了 data-boot-theme），.dark 的 token 覆盖不生效。给外层 div 自己挂一个
        // .dark 类，让这颗子树的 token 走暗色值——这样即便 <html> 尚未挂主题类，
        // 深色模式下错误页也不会透出浏览器白底。
        const root = document.documentElement;
        const isDark =
            root.dataset.bootTheme === "dark" ||
            (root.dataset.bootTheme !== "light" &&
                typeof window.matchMedia === "function" &&
                window.matchMedia("(prefers-color-scheme: dark)").matches);

        return (
            <div className={isDark ? "dark eb-page" : "eb-page"}>
                <div className="eb-card" style={{ maxWidth: 560 }}>
                    <div className="eb-title">页面出了点问题</div>
                    <div className="eb-text">
                        界面渲染时抛出了一个异常，已经被拦下来，数据没有被写入服务器。
                        可以先重新加载；如果每次打开都崩，多半是本机保存的偏好或缓存坏了，
                        清理本机数据即可（站点数据在服务器，不会丢）。
                    </div>
                    <details className="eb-details">
                        <summary className="eb-summary">查看错误详情</summary>
                        <pre className="eb-pre">
                            {error.message}
                            {stack ? `\n${stack}` : ""}
                        </pre>
                    </details>
                    <div className="eb-actions">
                        <button onClick={this.reload} className="eb-btn eb-btn-primary">
                            重新加载
                        </button>
                        <button onClick={() => this.clearAndReload(false)} className="eb-btn">
                            清理本机数据并重载
                        </button>
                        <button
                            onClick={() => this.clearAndReload(true)}
                            className="eb-btn eb-btn-danger"
                        >
                            连登录一起清理
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
