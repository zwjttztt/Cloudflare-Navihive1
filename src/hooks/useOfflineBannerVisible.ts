import { useEffect, useState } from "react";
import { failedMutations, subscribe } from "../API/offlineQueue";

/**
 * 「断网提示那条横幅该不该挂上」。
 *
 * 抽出来是为了让 OfflineBanner 本身能**懒加载**：它只在断网、刚恢复联网、
 * 或者有同步失败项时才看得见，其余时候渲染出来也是 null —— 却一直躺在首屏包里
 * （实测 3.7 KB）。首屏预算当时只剩 4% 出头的余量，这是最干净的一刀。
 *
 * 判断刻意**只升不降**：一旦挂上就不再卸载。
 * 横幅自己还有「刚恢复联网」那 2.6 秒的收尾动画，中途卸载会把动画掐掉；
 * 而已经加载过的块再留着也不占首屏。代价只是「经历过一次断网之后这次会话里
 * 它一直在」，换来的是不用在这里复刻那套计时逻辑。
 */
export function useOfflineBannerVisible(): boolean {
    const [visible, setVisible] = useState(
        () =>
            (typeof navigator !== "undefined" && navigator.onLine === false) ||
            failedMutations().length > 0
    );

    // 队列里出现失败项：它们必须让用户看得见，悄悄丢掉等于骗人「都同步好了」
    useEffect(
        () =>
            subscribe(() => {
                if (failedMutations().length > 0) setVisible(true);
            }),
        []
    );

    useEffect(() => {
        if (typeof window === "undefined") return;
        const show = () => setVisible(true);
        window.addEventListener("offline", show);
        return () => window.removeEventListener("offline", show);
    }, []);

    return visible;
}
