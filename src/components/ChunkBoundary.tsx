// 懒加载块的错误边界：把「某个弹窗的代码没取到」拦在弹窗这一层。
//
// 背景：弹窗都是 lazy chunk，块取不到时 React.lazy 的 promise reject，
// 渲染期抛错会一路冒到最近的错误边界。而全站只有根上那一个（main.tsx 的 ErrorBoundary），
// 于是**断网时点开一个弹窗，整站会被换成「页面出了点问题」** ——
// 实际只是那一个弹窗的代码没下载下来，数据一条没丢，看着却像天塌了。
//
// 所以每个 lazy 浮层外面套一层这个：只影响它自己，文案按「是不是离线」分开说，
// 在线还给一个出口 —— 但那个出口是**刷新页面**，不是「重挂子树」（原因见 retry）。
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
    mounted: boolean;
}

/**
 * 清空 Cache Storage，然后重新加载页面。任何一步失败都继续往下走。
 *
 * 为什么必须是「刷新」而不是「重试」：
 *   `React.lazy` 把 `import()` 返回的 promise **缓存在组件对象上**（内部是个
 *   `_payload._status/_result`）。promise 一旦 reject，它就永久停在这个状态 ——
 *   再次渲染同一个 lazy 组件只会**原样把同一个错误再抛一次**，根本不会再发请求。
 *   所以「清掉 error 状态 + 换 key 重挂子树」这种重试在原理上就不可能成功：
 *   用户点一次、看到一模一样的错误、再点一次，还是那个错误。之前这里就是这么写的
 *   （甚至连注释都写反了，说「key 变了才会真的重新走一次 import」）。
 *   真要重新取那份代码，只能重新加载页面。
 *
 * 先清 Cache Storage 再刷：这类失败最常见的原因是「外壳还是旧版、chunk 已经换了
 * 名字」（站点刚更新），或者 SW 缓存里留了个指向已删 chunk 的旧外壳 —— 直接刷新
 * 有可能被同一份缓存再喂一次，清掉才真的回源。（与 public/boot-guard.js 的自救
 * 语义一致：它也是「清缓存 → 注销 SW → reload」，只是那一段连 bundle 都跑不起来。）
 *
 * 超时兜底同 boot-guard：清缓存本身卡住也不能让用户干等。
 */
const CACHE_CLEAR_DEADLINE_MS = 3000;

async function clearCachesAndReload(): Promise<void> {
    let done = false;
    // 用对象持有定时器 id：reloadOnce 要先定义才能交给 setTimeout，
    // 而它自己又需要能拿到那个 id 来 clearTimeout（顺序上互相依赖）
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const reloadOnce = () => {
        if (done) return;
        done = true;
        // 清掉兜底定时器：不让它把测试 / 页面多留 3 秒
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
        try {
            location.reload();
        } catch {
            /* 极少数环境禁止 reload：什么都做不了，保持原样 */
        }
    };
    // 到点直接刷：caches.keys() 在某些环境（隐私模式 / 配额异常）会挂住
    deadline.timer = setTimeout(reloadOnce, CACHE_CLEAR_DEADLINE_MS);
    try {
        if (typeof caches !== "undefined" && typeof caches.keys === "function") {
            const keys = await caches.keys();
            await Promise.all(
                keys.map(key =>
                    // 单个删不掉不影响别的，也不影响最后的刷新
                    caches.delete(key).catch(() => false)
                )
            );
        }
    } catch {
        // 打不开 Cache Storage：照样刷新，别把用户卡在错误面板上
    }
    reloadOnce();
}

export default class ChunkBoundary extends Component<Props, State> {
    state: State = {
        error: null,
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

    /**
     * 出口：清缓存 + 刷新页面。
     *
     * 注意这里**不**去 setState 清 error —— 页面马上就要重载了，清 state 只会
     * 让子树重新渲染一次、再把同一个被缓存的 rejected promise 抛一遍（见
     * clearCachesAndReload 的注释：React.lazy 的失败 promise 是永久缓存的）。
     */
    private retry = () => {
        void clearCachesAndReload();
    };

    render() {
        const { error, mounted } = this.state;
        // 卸载期间子树还在（动画要播完），只是外面这层不再主动留它
        if (!mounted) return null;
        if (!error) {
            return (
                // fallback 保持 null（2026-10-17 用户要求去除转圈）：三层预取把
                // 「点击时下载」提前到点击前，正常路径首开就是 0 请求、无需加载指示；
                // 真网抖动时宁可短暂空窗，也不闪转圈。
                <Suspense fallback={null}>
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
                    border: "1px solid var(--border-default, #d0d3d8)",
                    background: "var(--surface-raised, #fff)",
                    color: "var(--text-primary, #1f2329)",
                    fontSize: 14,
                    lineHeight: 1.7,
                }}
            >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{text.title}</div>
                <div style={{ color: "var(--text-secondary, #55595f)" }}>{text.hint}</div>
                {text.retryable && (
                    <button
                        onClick={this.retry}
                        style={{
                            marginTop: 10,
                            padding: "6px 14px",
                            fontSize: 14,
                            borderRadius: 8,
                            border: "1px solid var(--border-default, #d0d3d8)",
                            background: "var(--accent, #1976d2)",
                            color: "var(--on-accent, #fff)",
                            cursor: "pointer",
                        }}
                    >
                        刷新页面
                    </button>
                )}
            </div>
        );
    }
}
