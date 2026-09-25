// src/context/OpenQueueContext.tsx
// 「待打开队列」：点卡片上的按钮只把链接攒进队列，当前页面完全不动，
// 攒够了再一键全部打开。
//
// 为什么不用「后台标签打开」：
// 浏览器刻意不允许脚本后台开标签 —— window.open() 在 Chrome 里一定会把新标签切到
// 前台，之后 win.blur() / window.focus() 都压不住；合成的中键点击（button=1）
// 在 Chrome 里同样不生效。所以唯一能确定不打断当前浏览的方式，就是把「打开」
// 这个动作延后到用户主动触发的那一刻。
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface QueuedSite {
    id: number;
    name: string;
    url: string;
}

interface OpenQueueValue {
    queue: QueuedSite[];
    enqueue: (site: QueuedSite) => void;
    remove: (id: number) => void;
    openAll: () => void;
    clear: () => void;
}

const defaultValue: OpenQueueValue = {
    queue: [],
    enqueue: () => {},
    remove: () => {},
    openAll: () => {},
    clear: () => {},
};

export const OpenQueueContext = createContext<OpenQueueValue>(defaultValue);

export const useOpenQueue = (): OpenQueueValue => useContext(OpenQueueContext);

export function OpenQueueProvider({ children }: { children: React.ReactNode }) {
    const [queue, setQueue] = useState<QueuedSite[]>([]);

    const enqueue = useCallback((site: QueuedSite) => {
        if (!site.url) return;
        setQueue(prev =>
            // 同一个站点重复点只会占位一次，避免误触堆一堆重复标签
            prev.some(item => item.id === site.id) ? prev : [...prev, site]
        );
    }, []);

    const remove = useCallback((id: number) => {
        setQueue(prev => prev.filter(item => item.id !== id));
    }, []);

    const clear = useCallback(() => setQueue([]), []);

    // 真正打开：这时切到新标签是用户主动点的，符合预期
    const openAll = useCallback(() => {
        setQueue(prev => {
            prev.forEach(item => {
                window.open(item.url, "_blank", "noopener,noreferrer");
            });
            return [];
        });
    }, []);

    const value = useMemo(
        () => ({ queue, enqueue, remove, openAll, clear }),
        [queue, enqueue, remove, openAll, clear]
    );

    return <OpenQueueContext.Provider value={value}>{children}</OpenQueueContext.Provider>;
}
