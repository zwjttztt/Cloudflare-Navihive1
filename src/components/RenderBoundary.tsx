// 局部渲染兜底：把「某一块崩了」拦在这一块，而不是整页变错误页。
//
// 为什么需要它（2026-10-28）：全站唯一一个错误边界在 main.tsx 的根上。站点列表
// （SiteListBody）与登录页都在根的**下方、且中间没有别的边界**，所以一次渲染期抛错
// ——比如某个 site.tags 不是数组、`site.tags.map(...)` 直接炸——会一路冒到根，
// 整页被换成「页面出了点问题」。用户因此连「去记事本」这种自救入口都点不到，
// 而问题其实只出在一张卡片上。
//
// ⚠️ 为什么不复用 ChunkBoundary：它的文案是照着「chunk 没下载下来」写的
// （「这块内容没加载出来」+ 重试重新 import），对渲染期异常是误导 —— 用户会去查网络，
// 而真正的原因是一条脏数据。两件事的处置方式也不同：chunk 失败重试有意义，
// 渲染失败重试多半要连同页面状态一起重置。
//
// ⚠️ 为什么不用 MUI：这个组件会被 App.tsx 静态 import，直接进首屏包。首屏预算
// （tests/bundleBudget.test.ts）只剩 4.8% 余量，实测引一个 Button 就是 1 KB 级别的涨幅；
// 而它是**出错时才显示**的界面，不该为它在首屏里塞组件。跟根上的 ErrorBoundary、
// ChunkBoundary 同一条技术路线：纯 DOM + 内联样式。
// 颜色一律取 index.css 的 CSS 变量（tests/hardcodedColorGuard.test.ts 是棘轮守卫，
// 新文件里出现任何颜色字面量都会直接红），这样亮暗两套主题都跟得上。
//
// ⚠️ 面板样式在 `panelStyles.ts`，与 `SiteListErrorState.tsx`（加载失败那块）**同源**。
//    改字号 / 按钮 / 文字色请改那个共用文件；这里只保留两处**语义上不同**的覆盖：
//    中性色描边 + 内凹底色（「渲染崩了」是中性故障），而加载失败那块是警示色虚线。
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../utils/errorReporter";
import { PANEL_BODY, PANEL_BOX, PANEL_BUTTON, PANEL_TITLE } from "./panelStyles";

interface Props {
    /** 这段界面叫什么（只用于兜底文案与上报），比如「站点列表」「登录页」 */
    label: string;
    children: ReactNode;
    /**
     * 「重试」要做的事。不传就等于「整页重载」。
     *
     * ⚠️ 返回 Promise 时这里会**等它落地再清 error**，调用点自己拿捏：
     * 渲染崩溃时子树已经被卸载，若在数据还没换掉时就清 error，会用**原地不动的那份
     * 脏数据**立刻重挂子树，同一处再炸一次 —— 用户得连点两次才有一次真正生效。
     * 真正的 onReset 应该是「换掉数据 / 重置状态」，而不是「再渲染一遍试试」。
     */
    onReset?: () => void | Promise<void>;
}

interface State {
    error: Error | null;
}

export default class RenderBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // 走全站统一的上报出口（清洗 / 截断 / sendBeacon 都在 utils/errorReporter.ts，
        // 这里只负责把字段喂进去，别再自己 console.error 一份）。
        // label 必须带上：根边界只会看到一条 "render"，不带 label 就分不清是
        // 登录页崩了还是站点列表崩了 —— 而那两件事的排查方向完全不同。
        reportError(error, {
            source: "render",
            context: { boundary: "render", label: this.props.label, componentStack: info.componentStack },
        });
    }

    private retry = () => {
        const { onReset } = this.props;
        if (!onReset) {
            window.location.reload();
            return;
        }
        const clear = () => this.setState({ error: null });
        // onReset 自己负责报错；这里只保证 error 一定被清掉，否则按钮按下去毫无反应
        void Promise.resolve(onReset())
            .catch(() => undefined)
            .then(clear);
    };

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        return (
            <div
                role="alert"
                style={{
                    ...PANEL_BOX,
                    // 与 SiteListErrorState 的唯一视觉差异：中性描边 + 内凹底色。
                    // 「界面渲染时抛了异常」是个中性故障（代码问题），不是警示状态。
                    border: "1px solid var(--neutral-hairline)",
                    background: "var(--surface-inset)",
                }}
            >
                <div style={PANEL_TITLE}>{this.props.label}这块出了点问题</div>
                <div style={PANEL_BODY}>
                    界面渲染时抛了个异常，已经被拦在这里，其他部分照常可用，数据也没有写入服务器。
                </div>
                <button type="button" onClick={this.retry} style={PANEL_BUTTON}>
                    重试
                </button>
            </div>
        );
    }
}
