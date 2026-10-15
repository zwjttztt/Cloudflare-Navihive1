// 右下角的部署版本徽标：显示当前部署的版本号，悬浮提示完整版本与构建时间。
// 数据来自 utils/appVersion.ts（构建时烘进产物，形如 v0.1.0+c49c59f）。
//
// 显示只保留语义版本部分（v0.1.0）：右下角常驻一个小字，越短越不打扰；
// `+commit 短哈希 / 构建号` 那串是「较真的时候才看」的信息，收进 title 悬浮提示 ——
// 既满足「右下角只留 v0.1.0」，又不丢「每一次部署可区分」的能力。
//
// 设计取向：
// - **极低调**：小字号、text-muted 色、半透明 —— 它是给人查证用的，不是给人看的。
// - **pointer-events: none**：永远不挡右下角的点击（翻页按钮 / 返回顶部 / 悬浮操作）。
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
    // 只显示语义版本（v0.1.0）；+hash/构建号 进 title，需要时才看
    const visible = version.split("+")[0];
    return (
        <div
            style={badgeStyle}
            title={builtAt ? `部署版本 ${version} · 构建于 ${builtAt}` : `部署版本 ${version}`}
        >
            {visible}
        </div>
    );
}
