// tests/statsDashboard.dom.test.tsx
// 统计看板（StatsDashboardDialog）渲染语义：
//   - 四个区块齐全，计数/Top 榜/健康列表按数据渲染；
//   - 30 天柱状图固定 30 根柱（SVG rect），空数据有占位文案；
//   - 接口失败显示错误文案而不是白屏。
// 图表是零依赖手写 SVG —— 这里同时守住「没人偷偷引入图表库」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import StatsDashboardDialog from "../src/components/StatsDashboardDialog";
import type { NavigationClient } from "../src/API/client";
import type { OpsStats } from "../src/API/methods/audit";
import type { OpsStatsResponse } from "../src/API/responses";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

const sample: OpsStats = {
    counts: { sites: 12, groups: 3, notes: 40, attachments: 7, attachmentBytes: 2048 * 1024 },
    auditDaily: Array.from({ length: 30 }, (_, i) => ({
        day: `2026-09-${String(12 + i).padStart(2, "0")}`,
        count: i === 29 ? 5 : i % 3,
    })),
    auditTopActions: [
        { action: "login", count: 20 },
        { action: "create-site", count: 4 },
    ],
    shareTop: [
        { kind: "group", title: "开发资源", views: 9 },
        { kind: "note", title: "读书笔记", views: 5 },
    ],
    health: {
        total: 3,
        deadCount: 1,
        deadLatest: [{ url: "https://dead.example", at: Date.UTC(2026, 9, 11) }],
    },
};

function makeClient(impl: () => Promise<OpsStatsResponse>): NavigationClient {
    return { getOpsStats: impl } as unknown as NavigationClient;
}

async function mount(client: NavigationClient) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <StatsDashboardDialog open onClose={() => { }} client={client} />
        );
    });
    // 数据在 effect 里异步拉：轮询到出现「内容概览」或错误文案为止（CI 慢机友好）。
    // ⚠️ MUI Dialog 传送门挂到 document.body，不在 host 里，必须查 document。
    const queryDialog = () => document.querySelector("[aria-label='统计看板']");
    for (let i = 0; i < 40; i++) {
        const text = queryDialog()?.textContent ?? "";
        if (text.includes("内容概览") || text.includes("仅站点所有者")) break;
        await new Promise(r => setTimeout(r, 25));
    }
    return queryDialog;
}

test("统计看板：四区块按数据渲染，柱状图 30 根柱", async () => {
    try {
        const queryDialog = await mount(makeClient(() => Promise.resolve({ success: true, stats: sample })));
        const dialog = queryDialog();
        assert.ok(dialog, "对话框应渲染且带 aria-label");
        const text = dialog!.textContent ?? "";
        assert.ok(text.includes("站点 12"), "内容概览应含站点计数");
        assert.ok(text.includes("附件 7（2.0 MB）"));
        assert.ok(text.includes("高频动作"));
        assert.ok(text.includes("login"));
        assert.ok(text.includes("分组 · 开发资源"), "分享 Top 应标注 kind 前缀");
        assert.ok(text.includes("笔记 · 读书笔记"));
        assert.ok(text.includes("疑似失效 1"));
        assert.ok(text.includes("https://dead.example"));
        const rects = dialog!.querySelectorAll("svg rect");
        assert.equal(rects.length, 30, "30 天柱状图固定 30 根柱");
    } finally {
        cleanup();
    }
});

test("统计看板：接口失败显示错误文案；空数据显示占位", async () => {
    try {
        const queryDialog = await mount(makeClient(() => Promise.reject(new Error("仅站点所有者可以查看统计看板"))));
        const text = queryDialog()?.textContent ?? "";
        assert.ok(text.includes("仅站点所有者可以查看统计看板"), "错误要可见，不能白屏");
        assert.ok(!text.includes("站点 12"));

        cleanup();
        const queryDialog2 = await mount(makeClient(() =>
            Promise.resolve({
                success: true,
                stats: {
                    counts: { sites: 0, groups: 0, notes: 0, attachments: 0, attachmentBytes: 0 },
                    auditDaily: Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, count: 0 })),
                    auditTopActions: [],
                    shareTop: [],
                    health: { total: 0, deadCount: 0, deadLatest: [] },
                } satisfies OpsStats,
            })
        ));
        const text2 = queryDialog2()?.textContent ?? "";
        assert.ok(text2.includes("近 30 天没有审计记录"));
        assert.ok(text2.includes("暂无数据"));
        assert.ok(text2.includes("还没有产生浏览的分享"));
    } finally {
        cleanup();
    }
});
