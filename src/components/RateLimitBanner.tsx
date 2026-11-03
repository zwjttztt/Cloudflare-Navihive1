// src/components/RateLimitBanner.tsx
// 429 限流的倒计时提示条。
//
// 背景：服务端多处 429 早就回了 `Retry-After`（loginGuard / routes/public / routes/data
// 的写守卫），但那个头在 client 里读完就丢 —— 用户只看到一句「操作过于频繁」，
// 既不知道要等多久，也不知道等到了没有，只能反复点、反复撞同一堵墙（限流窗口还因此
// 被不断续期）。现在把秒数带到界面上，按秒倒计时，到 0 自动消失。
//
// 为什么是自订阅的小组件而不是放在 App 的状态里：与 401 的处置同一条理由 ——
// client 是纯传输层，只广播事件（transport.ts 的 notifyRateLimited），
// 谁想响应谁自己挂监听。这样这个提示条既能常驻根节点，也能在只渲染局部页面的
// 环境（审计页 / 分享页）里单独用，不必把 App 的状态机拖进来。
//
// ⚠️ 这个组件**默认渲染 null**（没有任何限流事件时不占位、不参与布局），
// 所以常驻挂载不会给首屏增加可见元素，也不会给无障碍审计添新节点。
import { useEffect, useState } from "react";
import { Alert, Button } from "@mui/material";
import { RATE_LIMITED_EVENT, type RateLimitedDetail } from "../API/transport";

export default function RateLimitBanner() {
    /** 倒计时终点（毫秒时间戳）。null = 当前没有限流提示，组件渲染 null */
    const [until, setUntil] = useState<number | null>(null);
    /** 还剩几秒（整秒，向上取整）。只为渲染，不参与判定 */
    const [remaining, setRemaining] = useState(0);

    // 订阅全局限流广播。取 Math.max 而不是直接覆盖：连续撞两次 429（比如用户
    // 在倒计时中途又点了别的按钮）时，服务端给的第二个窗口可能更短 ——
    // 直接覆盖会把倒计时**变短**，等于提示用户「现在可以重试了」而实际上还不行。
    useEffect(() => {
        if (typeof window === "undefined") return;
        const onRateLimited = (event: Event) => {
            const detail = (event as CustomEvent<RateLimitedDetail>).detail;
            const secs = detail?.retryAfter;
            // 认不出 / 非正数就当没收到：0 秒的提示条会立刻消失，纯粹闪一下
            if (typeof secs !== "number" || !Number.isFinite(secs) || secs <= 0) return;
            setUntil(prev => Math.max(prev ?? 0, Date.now() + secs * 1000));
        };
        window.addEventListener(RATE_LIMITED_EVENT, onRateLimited);
        return () => window.removeEventListener(RATE_LIMITED_EVENT, onRateLimited);
    }, []);

    // 1 秒一跳的倒计时。到 0 就把终点清空 —— 组件随之渲染 null 自动隐藏，
    // 不需要额外的「已过期」布尔量（两个状态描述同一件事迟早会不同步）。
    // ⚠️ 依赖是 until：新事件把终点往后推时，这个 effect 会重建定时器并从新值续算，
    // 不会出现「旧定时器按旧终点提前收尾」。
    useEffect(() => {
        if (until === null) return;
        const tick = () => {
            const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
            setRemaining(left);
            if (left === 0) setUntil(null);
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [until]);

    if (until === null) return null;

    return (
        <Alert
            severity='warning'
            role='status'
            aria-live='polite'
            action={
                // 到 0 组件就隐藏了，所以这枚按钮在可见期间恒为禁用 ——
                // 它的作用是让「还差多久」有个看得见的落点（读屏也会读到它），
                // 而不是真的提供一个立刻可点的重试入口（那正是限流要拦住的事）。
                <Button color='inherit' size='small' disabled={remaining > 0}>
                    重试
                </Button>
            }
            sx={{
                position: "fixed",
                // 压在既有 Snackbar 之上（Snackbar 贴底约 24px 高 48px），别互相遮住
                bottom: 88,
                left: 16,
                right: 16,
                // 宽屏上左右 16 会拉成一整条，加个上限居中
                maxWidth: 560,
                mx: "auto",
                // 与 OfflineBanner 同一档：snackbar 层，不要盖住弹窗（modal 更高）
                zIndex: t => t.zIndex.snackbar,
                borderRadius: "14px",
                boxShadow: "var(--glass-shadow-hover)",
            }}
        >
            {`操作过于频繁，请 ${remaining} 秒后再试`}
        </Alert>
    );
}
