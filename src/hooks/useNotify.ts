// 全局提示条（Snackbar）的状态与 notify 函数。
//
// 从 App.tsx 里挪出来的原因：这六个 setState 和 notify 被几十个地方依赖，
// 每次改提示条都要在那个四千行的文件里翻。抽出来之后 App 只负责渲染 <Snackbar />。
import { useCallback, useState } from "react";
import type { NotifyAction } from "../context/NotifyContext";

export type NotifySeverity = "success" | "error" | "info";

export function useNotify() {
    const [open, setOpen] = useState(false);
    const [message, setMessage] = useState("");
    const [severity, setSeverity] = useState<NotifySeverity>("error");
    const [duration, setDuration] = useState(6000);
    const [action, setAction] = useState<NotifyAction | null>(null);
    // 读屏专用：提示条会自动消失，这里留一份纯文本供屏幕阅读器播报
    const [liveMessage, setLiveMessage] = useState("");

    const notify = useCallback(
        (
            text: string,
            level: NotifySeverity = "info",
            ms?: number,
            act?: NotifyAction
        ) => {
            setMessage(text);
            setSeverity(level);
            setDuration(ms ?? (level === "error" ? 6000 : 2200));
            setAction(act ?? null);
            setOpen(true);
            // 播报完就把文本清掉：这个区域视觉上不可见，但 innerText 里能捞到，
            // 留着会让「页面上还有没有某条提示」这类判断失真
            setLiveMessage(text);
            window.setTimeout(() => {
                setLiveMessage(prev => (prev === text ? "" : prev));
            }, 1500);
        },
        []
    );

    const close = useCallback(() => setOpen(false), []);

    return {
        notify,
        close,
        open,
        message,
        severity,
        duration,
        action,
        liveMessage,
    };
}
