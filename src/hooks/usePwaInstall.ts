// PWA 安装：Chrome/Edge 会在用户「可能愿意安装」时抛出 beforeinstallprompt，
// 我们把它拦下来存着，等到用户主动点「安装到桌面」再弹出原生安装提示。
// 不拦的话这个事件只会在页面加载时随机出现一次，用户往往还没反应过来就错过了。
import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** 是否已经是「安装后的”独立窗口”形态」（桌面图标打开 / iOS 主屏） */
function detectStandalone(): boolean {
    if (typeof window === "undefined") return false;
    const standalone =
        window.matchMedia?.("(display-mode: standalone)").matches ||
        // iOS Safari 至今不支持 display-mode，只认这个私有属性
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return !!standalone;
}

export function usePwaInstall() {
    const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
    const [isStandalone, setIsStandalone] = useState(detectStandalone);

    useEffect(() => {
        const onPrompt = (e: Event) => {
            // 必须阻止默认行为，否则浏览器自己立刻弹一次就没了
            e.preventDefault();
            setPromptEvent(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => {
            setPromptEvent(null);
            setIsStandalone(true);
        };
        const onDisplayChange = () => setIsStandalone(detectStandalone());

        window.addEventListener("beforeinstallprompt", onPrompt);
        window.addEventListener("appinstalled", onInstalled);
        window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", onDisplayChange);
        return () => {
            window.removeEventListener("beforeinstallprompt", onPrompt);
            window.removeEventListener("appinstalled", onInstalled);
            window.matchMedia?.("(display-mode: standalone)").removeEventListener?.("change", onDisplayChange);
        };
    }, []);

    const promptInstall = useCallback(async () => {
        if (!promptEvent) return false;
        try {
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            setPromptEvent(null);
            return choice?.outcome === "accepted";
        } catch {
            setPromptEvent(null);
            return false;
        }
    }, [promptEvent]);

    return {
        // 浏览器给了安装事件、且当前还不是独立窗口时才给入口
        canInstall: !!promptEvent && !isStandalone,
        isStandalone,
        promptInstall,
    };
}
