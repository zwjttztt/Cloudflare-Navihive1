// 右下角的部署版本徽标：显示当前部署的版本号（形如 v0.1.0+c49c59f），
// 悬浮提示构建时间。数据来自 utils/appVersion.ts（构建时烘进产物）。
//
// 设计取向：
// - **极低调**：小字号、text-muted 色、半透明 —— 它是给人查证用的，不是给人看的。
// - **pointer-events: none**：永远不挡右下角的点击（翻页按钮 / 返回顶部 / 悬浮操作），
//   想看构建时间用鼠标悬停是不行的了 —— 折衷是把它做成纯展示，构建时间直接并进
//   可见的 title 对屏幕阅读器友好，肉眼需要时在设置里也有（将来）。
// - **zIndex 压到 1**：任何弹窗 / 抽屉都该盖过它。
// - 颜色走 --text-muted：亮暗两套主题（index.css 的 .dark）自动跟随。
// - 版本号为空（开发模式没烘 define）就不渲染，开发时右下角不显示杂物。

import type { CSSProperties } from "react";
import { appVersion, buildTime } from "../utils/appVersion";

const badgeStyle: CSSProperties = {
    position: "fixed",
    right: 10,
    bottom: 6,
    zIndex: 1,
    fontSize: 11,
    lineHeight: 1.4,
    color: "var(--text-muted)",
    opacity: 0.75,
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

export default function BuildBadge({
    version = appVersion(),
    builtAt = buildTime(),
}: {
    /** 惰性默认值：单测里可以直接传，不走构建期 define */
    version?: string;
    builtAt?: string;
}) {
    if (!version) return null;
    return (
        <div
            style={badgeStyle}
            title={builtAt ? `部署版本 ${version} · 构建于 ${builtAt}` : `部署版本 ${version}`}
        >
            {version}
        </div>
    );
}
